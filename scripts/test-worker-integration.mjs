import { spawn, spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { resolve } from "node:path"

const { SquigSyncCore } = await import("../lib/agent/sync.ts")

const project = resolve(import.meta.dirname, "..")
const persistDir = resolve(project, ".wrangler/state/phase4-integration")
const port = 8789
const origin = `http://127.0.0.1:${port}`
const BUTTON_PROMPT = "insert a button at 100,100"
const LANDING_PROMPT = "build a landing page with nav, hero, three feature cards, pricing, footer"
let worker = null
let fatal = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function shape(id, x) {
  let seed = 2166136261
  for (const char of id) {
    seed ^= char.charCodeAt(0)
    seed = Math.imul(seed, 16777619)
  }
  return { id, seed: seed >>> 0, type: "shape", shape: "rect", fill: "none", x, y: 0, w: 20, h: 20 }
}

class CoreClient {
  constructor(docId, clientId) {
    this.docId = docId
    this.clientId = clientId
    this.doc = { nodes: {}, order: [] }
    this.messages = []
    this.waiters = new Set()
    this.socket = null
    this.dropOwnEcho = false
    this.core = new SquigSyncCore({
      clientId,
      initialDoc: this.doc,
      send: (message) => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
      },
      show: (doc) => { this.doc = clone(doc) },
    })
  }

  async open() {
    const url = new URL(`/agents/squig-doc/${encodeURIComponent(this.docId)}`, origin)
    url.protocol = "ws:"
    url.searchParams.set("clientId", this.clientId)
    const socket = new WebSocket(url)
    this.socket = socket
    const opened = new Promise((resolveOpen, reject) => {
      socket.addEventListener("open", () => {
        this.core.setTransportOpen(true)
        resolveOpen()
      }, { once: true })
      socket.addEventListener("error", () => reject(new Error(`WebSocket ${this.clientId} failed to open`)), { once: true })
    })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.type === "string" && message.type.startsWith("cf_agent_")) fatal = new Error(`Competing Agents SDK frame received: ${message.type}`)
      const chatFrame = ["chat.delta", "chat.tool", "review.pending", "chat.completed", "selection.set", "chat.error"].includes(message.type)
      if (message.type !== "snapshot" && message.type !== "op" && !chatFrame) fatal = new Error(`Unexpected WebSocket frame: ${message.type}`)
      this.messages.push(message)
      if (message.type === "snapshot") this.core.handleSnapshot(message)
      else if (message.type === "op") {
        if (this.dropOwnEcho && message.by === this.clientId) this.dropOwnEcho = false
        else this.core.handleServerOp(message)
      }
      for (const wake of this.waiters) wake()
    })
    socket.addEventListener("close", () => this.core.setTransportOpen(false), { once: true })
    const cursor = this.messages.length
    await opened
    await this.waitForMessage((message) => message.type === "snapshot", cursor)
    return this
  }

  waitForState(predicate, timeout = 2000) {
    return new Promise((resolveWait, reject) => {
      const inspect = () => {
        if (fatal) return finish(() => reject(fatal))
        if (predicate(this.core.inspect())) finish(resolveWait)
      }
      const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${this.clientId} state`))), timeout)
      const finish = (done) => {
        clearTimeout(timer)
        this.waiters.delete(inspect)
        done()
      }
      this.waiters.add(inspect)
      inspect()
    })
  }

  waitForMessage(predicate, after = 0, timeout = 2000) {
    return new Promise((resolveWait, reject) => {
      const inspect = () => {
        if (fatal) return finish(() => reject(fatal))
        const found = this.messages.slice(after).find(predicate)
        if (found) finish(() => resolveWait(found))
      }
      const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${this.clientId} message`))), timeout)
      const finish = (done) => {
        clearTimeout(timer)
        this.waiters.delete(inspect)
        done()
      }
      this.waiters.add(inspect)
      inspect()
    })
  }

  async close() {
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    await new Promise((resolveClose) => {
      socket.addEventListener("close", resolveClose, { once: true })
      socket.close(1000, "integration reconnect")
    })
    if (this.socket === socket) this.socket = null
  }

  send(frame) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error(`${this.clientId} is not connected`)
    this.socket.send(JSON.stringify(frame))
  }
}

async function waitForWorker() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (worker?.exitCode !== null) throw new Error(`wrangler dev exited early\n${worker.output}`)
    try {
      const response = await fetch(`${origin}/healthz`)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`wrangler dev did not become ready\n${worker?.output ?? ""}`)
}

async function startWorker() {
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--var", "ENVIRONMENT:local", "--var", "SQUIG_FAKE_MODEL:true", "--port", String(port), "--inspector-port", String(port + 1000), "--persist-to", persistDir, "--log-level", "error", "--show-interactive-dev-session=false"], {
    cwd: project,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.output = ""
  child.stdout.on("data", (chunk) => { child.output = (child.output + chunk).slice(-12_000) })
  child.stderr.on("data", (chunk) => { child.output = (child.output + chunk).slice(-12_000) })
  worker = child
  await waitForWorker()
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return
  const child = worker
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop() }, 5000)
    child.once("exit", () => { clearTimeout(timer); resolveStop() })
    child.kill("SIGTERM")
  })
}

async function waitConverged(clients, rev) {
  await Promise.all(clients.map((client) => client.waitForState((state) => state.serverRev === rev && state.pending.length === 0)))
  assert(clients.every((client) => JSON.stringify(client.doc) === JSON.stringify(clients[0].doc)), `clients did not converge at rev ${rev}`)
}

async function openPair(docId, prefix) {
  return Promise.all([new CoreClient(docId, `${prefix}-a`).open(), new CoreClient(docId, `${prefix}-b`).open()])
}

async function startChat(client, frame) {
  const cursor = client.messages.length
  client.send(frame)
  return {
    cursor,
    completed: await client.waitForMessage((message) => message.type === "chat.completed" && message.turnId === frame.turnId, cursor, 5000),
  }
}

async function run() {
  assert(persistDir.endsWith("/.wrangler/state/phase4-integration"), "Refusing to clear an unexpected persistence path")
  rmSync(persistDir, { recursive: true, force: true })
  const migration = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DOCS_DB", "--local", "--persist-to", persistDir], { cwd: project, env: process.env, encoding: "utf8" })
  if (migration.status !== 0) throw new Error(`Local D1 migration failed\n${migration.stdout}\n${migration.stderr}`)

  await startWorker()

  const badDocsOrigin = await fetch(`${origin}/api/docs`, { headers: { Origin: "https://evil.example" } })
  const badAgentOrigin = await fetch(`${origin}/agents/squig-doc/security-check`, { headers: { Origin: "https://evil.example" } })
  assert(badDocsOrigin.status === 403 && badAgentOrigin.status === 403, "disallowed Origin reached a protected route")
  assert((await fetch(`${origin}/api/docs`)).ok, "ENVIRONMENT=local did not allow local unauthenticated docs access")
  for (const appOrigin of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    const docs = await fetch(`${origin}/api/docs`, { headers: { Origin: appOrigin } })
    const preflight = await fetch(`${origin}/api/docs`, { method: "OPTIONS", headers: { Origin: appOrigin, "Access-Control-Request-Method": "PUT" } })
    assert(docs.ok && docs.headers.get("Access-Control-Allow-Origin") === appOrigin, `local docs rejected ${appOrigin}`)
    assert(preflight.status === 204 && preflight.headers.get("Access-Control-Allow-Origin") === appOrigin && preflight.headers.get("Access-Control-Allow-Credentials") === "true", `local preflight rejected ${appOrigin}`)
  }

  const docId = "phase3-two-client-proof"
  const [a, b] = await Promise.all([new CoreClient(docId, "integration-a").open(), new CoreClient(docId, "integration-b").open()])
  assert(a.core.inspect().serverRev === 0 && b.core.inspect().serverRev === 0, "new proof document did not start at rev 0")

  const gapCursor = a.messages.length
  a.socket.send(JSON.stringify({ type: "op", ops: [{ t: "add", node: shape("gap", -10) }], clientRev: 0, clientId: a.clientId, clientSeq: 2 }))
  const gap = await a.waitForMessage((message) => message.type === "snapshot" && message.reason === "sequence_gap", gapCursor)
  assert(gap.rev === 0 && gap.acceptedClientSeq === 0, "sequence gap changed durable state")

  await new Promise((resolveWait) => setTimeout(resolveWait, 750))
  const convergenceStarted = Date.now()
  for (let index = 1; index <= 5; index++) {
    const rev = a.core.inspect().serverRev
    assert(rev === b.core.inspect().serverRev, "clients did not begin contention from one revision")
    const aOps = index < 5 ? [{ t: "add", node: shape(`a${index}`, index * 40) }] : [{ t: "flip", ids: ["a1"], axis: "x" }]
    a.core.localOperations(aOps)
    b.core.localOperations([{ t: "add", node: shape(`b${index}`, index * 40 + 20) }])
    await waitConverged([a, b], rev + 2)
  }
  const convergenceMs = Date.now() - convergenceStarted
  assert(convergenceMs <= 2000, `two-client convergence took ${convergenceMs}ms`)
  assert(a.core.inspect().serverRev === 10 && b.core.inspect().serverRev === 10, "expected exact ten-revision total order")
  assert(a.doc.nodes.a1.flipX === true, "own non-idempotent echo was applied twice")
  assert([a, b].some((client) => client.messages.some((message) => message.type === "snapshot" && message.reason === "stale_revision")), "contention did not exercise stale-revision rebase")

  const duplicateCursor = a.messages.length
  a.socket.send(JSON.stringify({ type: "op", ops: [{ t: "flip", ids: ["a1"], axis: "x" }], clientRev: 8, clientId: a.clientId, clientSeq: 5 }))
  const duplicate = await a.waitForMessage((message) => message.type === "snapshot" && message.reason === "duplicate", duplicateCursor)
  assert(duplicate.rev === 10 && duplicate.acceptedClientSeq === 5 && duplicate.doc.nodes.a1.flipX === true, "duplicate resend changed authoritative state")

  const reconnect = new CoreClient("phase3-lost-echo", "same-page-client")
  await reconnect.open()
  reconnect.dropOwnEcho = true
  reconnect.core.localOperations([{ t: "add", node: shape("survives-reconnect", 0) }])
  await reconnect.waitForMessage((message) => message.type === "op" && message.by === reconnect.clientId)
  assert(reconnect.core.inspect().pending.length === 1, "lost echo did not leave a pending command")
  await reconnect.close()
  const reconnectCursor = reconnect.messages.length
  await reconnect.open()
  await reconnect.waitForState((state) => state.serverRev === 1 && state.pending.length === 0)
  assert(reconnect.messages.slice(reconnectCursor).some((message) => message.type === "snapshot" && message.acceptedClientSeq === 1), "same logical page did not recover its accepted sequence")
  assert(reconnect.doc.order.join(",") === "survives-reconnect", "reconnect snapshot did not preserve the lost-echo edit")

  const [undoA, undoB] = await Promise.all([new CoreClient("phase3-undo-isolation", "undo-a").open(), new CoreClient("phase3-undo-isolation", "undo-b").open()])
  undoA.core.localOperations([{ t: "add", node: shape("only-a", 0) }])
  await waitConverged([undoA, undoB], 1)
  undoB.core.localOperations([{ t: "add", node: shape("only-b", 40) }])
  await waitConverged([undoA, undoB], 2)
  undoA.core.undo()
  await waitConverged([undoA, undoB], 3)
  assert(undoA.doc.order.join(",") === "only-b", "SquigSyncCore undo erased the other client's accepted edit")

  const renamed = await fetch(`${origin}/api/docs/${docId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename", name: "Phase 3 proof" }) })
  const saved = await fetch(`${origin}/api/docs/${docId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", name: "Phase 3 proof saved" }) })
  assert(renamed.ok && saved.ok, "D1 rename/save projection failed")
  const index = await fetch(`${origin}/api/docs`).then((response) => response.json())
  assert(index.docs.some((doc) => doc.id === docId && doc.name === "Phase 3 proof saved"), "D1 docs index did not reflect rename/save")

  await Promise.all([a.close(), b.close(), reconnect.close(), undoA.close(), undoB.close()])
  await stopWorker()
  await startWorker()
  const persisted = await new CoreClient(docId, "integration-after-restart").open()
  assert(persisted.core.inspect().serverRev === 10 && JSON.stringify(persisted.doc) === JSON.stringify(duplicate.doc), "Durable state did not survive wrangler restart")
  const persistedIndex = await fetch(`${origin}/api/docs`).then((response) => response.json())
  assert(persistedIndex.docs.some((doc) => doc.id === docId && doc.name === "Phase 3 proof saved"), "D1 index did not survive wrangler restart")
  await persisted.close()

  const [chatA, chatB] = await openPair("phase4-button", "chat")
  const chatBCursor = chatB.messages.length
  const button = await startChat(chatA, { type: "chat.start", turnId: "button-turn", clientRev: 0, prompt: BUTTON_PROMPT, review: false, model: "default", selection: [] })
  assert(button.completed.status === "completed" && button.completed.rev === 1, "fake button turn did not commit exactly one revision")
  await waitConverged([chatA, chatB], 1)
  const buttonNodes = chatA.doc.order.map((id) => chatA.doc.nodes[id]).filter((node) => node.type === "component" && node.kind === "button")
  const buttonNode = buttonNodes[0]
  assert(chatA.doc.order.length === 1 && buttonNodes.length === 1 && buttonNode?.x === 100 && buttonNode?.y === 100, "fake model did not insert exactly one total button at 100,100")
  assert(chatA.messages.slice(button.cursor).some((message) => message.type === "selection.set" && message.ids.includes(buttonNode.id)), "requester did not receive agent selection")
  assert(!chatB.messages.slice(chatBCursor).some((message) => message.type === "selection.set"), "non-requester received selection.set")
  const chatDuplicateCursor = chatA.messages.length
  chatA.send({ type: "chat.start", turnId: "button-turn", clientRev: 0, prompt: BUTTON_PROMPT, review: false, model: "default", selection: [] })
  await chatA.waitForMessage((message) => message.type === "chat.completed" && message.turnId === "button-turn", chatDuplicateCursor)
  assert(chatA.core.inspect().serverRev === 1, "idempotent turn replay created another revision")
  const undoCursor = chatA.messages.length
  chatA.send({ type: "agent.undo", turnId: "button-turn", clientRev: 1 })
  await chatA.waitForMessage((message) => message.type === "chat.completed" && message.turnId === "button-turn" && message.status === "undone", undoCursor)
  await waitConverged([chatA, chatB], 2)
  assert(chatA.doc.order.length === 0, "safe agent undo did not restore the pre-turn document")

  const [reviewA, reviewB] = await openPair("phase4-review-accept", "review")
  const reviewCursor = reviewA.messages.length
  const reviewBCursor = reviewB.messages.length
  reviewA.send({ type: "chat.start", turnId: "review-accept", clientRev: 0, prompt: BUTTON_PROMPT, review: true, model: "default", selection: [] })
  const pending = await reviewA.waitForMessage((message) => message.type === "review.pending" && message.turnId === "review-accept", reviewCursor, 5000)
  assert(reviewA.core.inspect().serverRev === 0 && reviewA.doc.order.length === 0 && pending.ops.length === 1, "pending review changed the serialized document")
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  assert(!reviewB.messages.slice(reviewBCursor).some((message) => message.type === "review.pending"), "non-requester received review.pending")
  for (const type of ["review.accept", "review.reject"]) {
    const unauthorizedCursor = reviewB.messages.length
    reviewB.send({ type, turnId: "review-accept", clientRev: 0 })
    await reviewB.waitForMessage((message) => message.type === "chat.error" && message.turnId === "review-accept" && message.code === "not_found", unauthorizedCursor)
    assert(reviewA.core.inspect().serverRev === 0 && reviewA.doc.order.length === 0, `non-requester ${type} changed pending review state`)
  }
  await Promise.all([reviewA.close(), reviewB.close()])
  await stopWorker()
  await startWorker()
  const [reviewReloadA, reviewReloadB] = await openPair("phase4-review-accept", "review")
  const recovered = await reviewReloadA.waitForMessage((message) => message.type === "review.pending" && message.turnId === "review-accept", 0, 5000)
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  assert(recovered.baseRev === 0 && recovered.ops.length === 1, "owning tab did not recover pending review after restart")
  assert(!reviewReloadB.messages.some((message) => message.type === "review.pending"), "other client recovered someone else's pending review")
  const acceptCursor = reviewReloadA.messages.length
  const acceptedBCursor = reviewReloadB.messages.length
  reviewReloadA.send({ type: "review.accept", turnId: "review-accept", clientRev: 0 })
  await reviewReloadA.waitForMessage((message) => message.type === "chat.completed" && message.status === "accepted", acceptCursor)
  await waitConverged([reviewReloadA, reviewReloadB], 1)
  assert(reviewReloadA.doc.order.length === 1, "accepted review did not commit")
  assert(reviewReloadA.messages.slice(acceptCursor).some((message) => message.type === "selection.set" && message.ids.length === 1), "review owner did not receive accepted selection")
  assert(!reviewReloadB.messages.slice(acceptedBCursor).some((message) => message.type === "selection.set"), "non-requester received accepted review selection")

  const [rejectA, rejectB] = await openPair("phase4-review-reject", "reject")
  const rejectedPendingCursor = rejectA.messages.length
  rejectA.send({ type: "chat.start", turnId: "review-reject", clientRev: 0, prompt: BUTTON_PROMPT, review: true, model: "default", selection: [] })
  await rejectA.waitForMessage((message) => message.type === "review.pending", rejectedPendingCursor, 5000)
  const rejectCursor = rejectA.messages.length
  rejectA.send({ type: "review.reject", turnId: "review-reject", clientRev: 0 })
  await rejectA.waitForMessage((message) => message.type === "chat.completed" && message.status === "rejected", rejectCursor)
  assert(rejectA.core.inspect().serverRev === 0 && rejectA.doc.order.length === 0, "rejected review changed the document")

  const [staleA, staleB] = await openPair("phase4-review-stale", "stale")
  const stalePendingCursor = staleA.messages.length
  staleA.send({ type: "chat.start", turnId: "review-stale", clientRev: 0, prompt: BUTTON_PROMPT, review: true, model: "default", selection: [] })
  await staleA.waitForMessage((message) => message.type === "review.pending", stalePendingCursor, 5000)
  staleB.core.localOperations([{ t: "add", node: shape("human-change", 0) }])
  await waitConverged([staleA, staleB], 1)
  const staleAcceptCursor = staleA.messages.length
  staleA.send({ type: "review.accept", turnId: "review-stale", clientRev: 1 })
  await staleA.waitForMessage((message) => message.type === "chat.error" && message.code === "stale_review", staleAcceptCursor)
  assert(staleA.doc.order.join(",") === "human-change", "stale review modified the document")

  const [conflictA, conflictB] = await openPair("phase4-undo-conflict", "conflict")
  await startChat(conflictA, { type: "chat.start", turnId: "contested-turn", clientRev: 0, prompt: BUTTON_PROMPT, review: false, model: "default", selection: [] })
  await waitConverged([conflictA, conflictB], 1)
  conflictB.core.localOperations([{ t: "add", node: shape("after-agent", 0) }])
  await waitConverged([conflictA, conflictB], 2)
  const conflictCursor = conflictA.messages.length
  conflictA.send({ type: "agent.undo", turnId: "contested-turn", clientRev: 2 })
  await conflictA.waitForMessage((message) => message.type === "chat.error" && message.code === "undo_conflict", conflictCursor)
  assert(conflictA.core.inspect().serverRev === 2 && conflictA.doc.order.length === 2, "contested undo changed the document")

  const [noOpA, noOpB] = await openPair("phase4-no-op", "noop")
  const noOp = await startChat(noOpA, { type: "chat.start", turnId: "noop-turn", clientRev: 0, prompt: "describe the empty canvas", review: false, model: "default", selection: [] })
  assert(noOp.completed.rev === 0 && noOp.completed.affected.length === 0 && noOpA.doc.order.length === 0 && noOpB.doc.order.length === 0, "completed no-op turn became undoable document work")

  const [landingA, landingB] = await openPair("phase4-landing", "landing")
  const landingBCursor = landingB.messages.length
  const landing = await startChat(landingA, { type: "chat.start", turnId: "landing-turn", clientRev: 0, prompt: LANDING_PROMPT, review: false, model: "default", selection: [] })
  assert(landing.completed.rev === 1, "multi-round landing turn used more than one revision")
  await waitConverged([landingA, landingB], 1)
  const kinds = landingA.doc.order.map((id) => landingA.doc.nodes[id]).filter((node) => node.type === "component").map((node) => node.kind)
  assert(kinds.length === 7 && kinds.filter((kind) => kind === "navbar").length === 1 && kinds.filter((kind) => kind === "hero").length === 1 && kinds.filter((kind) => kind === "card").length === 3 && kinds.filter((kind) => kind === "pricing-block").length === 1 && kinds.filter((kind) => kind === "footer").length === 1, `landing fixture was not the exact seven semantic nodes: ${kinds.join(",")}`)
  assert(landingA.messages.slice(landing.cursor).filter((message) => message.type === "chat.tool").map((message) => message.name).join(",") === "list_components,batch", "landing fixture did not use the deterministic multi-round tool sequence")
  const landingSelection = landingA.messages.slice(landing.cursor).find((message) => message.type === "selection.set")
  assert(landingSelection?.ids.length === 7 && landingA.doc.order.every((id) => landingSelection.ids.includes(id)), "landing requester selection did not contain all seven affected nodes")
  assert(!landingB.messages.slice(landingBCursor).some((message) => message.type === "selection.set"), "landing non-requester received selection.set")

  await Promise.all([chatA.close(), chatB.close(), reviewReloadA.close(), reviewReloadB.close(), rejectA.close(), rejectB.close(), staleA.close(), staleB.close(), conflictA.close(), conflictB.close(), noOpA.close(), noOpB.close(), landingA.close(), landingB.close()])

  assert(!fatal, fatal?.message ?? "protocol failure")
  console.log(JSON.stringify({
    ok: true,
    twoClientOps: 10,
    finalRev: 10,
    convergenceMs,
    staleRevisionRebase: "production core converged",
    reconnectSnapshot: "same logical page recovered lost echo",
    duplicateResend: "no revision increment",
    frameworkFrames: 0,
    connectedUndo: "SquigSyncCore preserved remote edit",
    security: "both loopback origins/preflights allowed locally; foreign docs and agent origins rejected",
    wranglerRestart: "state and D1 persisted",
    fakeButton: "one revision at 100,100; requester-only selection",
    review: "pending doc unchanged; owner-only recovery/control/selection, accept, reject, and stale refusal passed",
    agentUndo: "exact restore passed; contested undo refused",
    noOp: "zero revision and no affected nodes",
    landingFixture: "nav, hero, three features, pricing, footer in one multi-round revision",
  }, null, 2))
}

try { await run() } finally { await stopWorker() }
