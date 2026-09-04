import { spawn, spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { resolve } from "node:path"

const { SquigSyncCore } = await import("../lib/agent/sync.ts")

const project = resolve(import.meta.dirname, "..")
const persistDir = resolve(project, ".wrangler/state/phase3-integration")
const port = 8789
const origin = `http://127.0.0.1:${port}`
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
      if (message.type !== "snapshot" && message.type !== "op") fatal = new Error(`Unexpected WebSocket frame: ${message.type}`)
      this.messages.push(message)
      if (message.type === "snapshot") this.core.handleSnapshot(message)
      else if (this.dropOwnEcho && message.by === this.clientId) this.dropOwnEcho = false
      else this.core.handleServerOp(message)
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
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--var", "ENVIRONMENT:local", "--port", String(port), "--inspector-port", String(port + 1000), "--persist-to", persistDir, "--log-level", "error", "--show-interactive-dev-session=false"], {
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

async function run() {
  assert(persistDir.endsWith("/.wrangler/state/phase3-integration"), "Refusing to clear an unexpected persistence path")
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
  }, null, 2))
}

try { await run() } finally { await stopWorker() }
