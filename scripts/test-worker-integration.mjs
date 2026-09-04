import { spawn, spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { resolve } from "node:path"

const project = resolve(import.meta.dirname, "..")
const persistDir = resolve(project, ".wrangler/state/phase3-integration")
const port = 8789
const origin = `http://127.0.0.1:${port}`
let worker = null
let fatal = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function shape(id, x) {
  let seed = 2166136261
  for (const char of id) {
    seed ^= char.charCodeAt(0)
    seed = Math.imul(seed, 16777619)
  }
  return { id, seed: seed >>> 0, type: "shape", shape: "rect", fill: "none", x, y: 0, w: 20, h: 20 }
}

function applyOps(doc, ops) {
  const next = clone(doc)
  for (const op of ops) {
    if (op.t === "add" && !next.nodes[op.node.id]) {
      next.nodes[op.node.id] = clone(op.node)
      next.order.push(op.node.id)
    } else if (op.t === "remove") {
      for (const id of op.ids) delete next.nodes[id]
      next.order = next.order.filter((id) => !op.ids.includes(id))
    } else if (op.t === "flip") {
      for (const id of op.ids) {
        if (next.nodes[id]) next.nodes[id][op.axis === "x" ? "flipX" : "flipY"] = !next.nodes[id][op.axis === "x" ? "flipX" : "flipY"]
      }
    } else if (op.t === "update") {
      if (next.nodes[op.id]) next.nodes[op.id] = { ...next.nodes[op.id], ...clone(op.patch) }
    } else if (op.t === "updateMany") {
      for (const [id, patch] of Object.entries(op.patches)) if (next.nodes[id]) next.nodes[id] = { ...next.nodes[id], ...clone(patch) }
    } else {
      throw new Error(`Integration reducer does not cover ${op.t}`)
    }
  }
  return next
}

class Client {
  constructor(docId, clientId) {
    this.clientId = clientId
    this.seq = 0
    this.rev = 0
    this.doc = { nodes: {}, order: [] }
    this.messages = []
    this.waiters = new Set()
    const url = new URL(`/agents/squig-doc/${encodeURIComponent(docId)}`, origin)
    url.protocol = "ws:"
    url.searchParams.set("clientId", clientId)
    this.socket = new WebSocket(url)
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.type === "string" && message.type.startsWith("cf_agent_")) {
        fatal = new Error(`Competing Agents SDK frame received: ${message.type}`)
      }
      if (message.type !== "snapshot" && message.type !== "op") {
        fatal = new Error(`Unexpected WebSocket frame: ${message.type}`)
      }
      if (message.type === "snapshot") {
        this.rev = message.rev
        this.doc = clone(message.doc)
      } else if (message.type === "op") {
        assert(message.rev === this.rev + 1, `${clientId} received non-contiguous rev ${message.rev} after ${this.rev}`)
        this.rev = message.rev
        this.doc = applyOps(this.doc, message.ops)
      }
      this.messages.push(message)
      for (const wake of this.waiters) wake()
    })
  }

  async ready() {
    await Promise.all([
      new Promise((resolve, reject) => {
        this.socket.addEventListener("open", resolve, { once: true })
        this.socket.addEventListener("error", () => reject(new Error(`WebSocket ${this.clientId} failed to open`)), { once: true })
      }),
      this.waitFor((message) => message.type === "snapshot"),
    ])
    return this
  }

  send(ops, options = {}) {
    const clientSeq = options.clientSeq ?? ++this.seq
    const clientRev = options.clientRev ?? this.rev
    this.socket.send(JSON.stringify({ type: "op", ops, clientRev, clientId: this.clientId, clientSeq }))
    return { clientSeq, clientRev }
  }

  waitFor(predicate, after = 0, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const inspect = () => {
        if (fatal) return finish(() => reject(fatal))
        const found = this.messages.slice(after).find(predicate)
        if (found) finish(() => resolve(found))
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

  close() {
    this.socket.close(1000, "integration complete")
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`wrangler dev did not become ready\n${worker?.output ?? ""}`)
}

async function startWorker() {
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port + 1000), "--persist-to", persistDir, "--log-level", "error", "--show-interactive-dev-session=false"], {
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolveStop()
    }, 5000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolveStop()
    })
    child.kill("SIGTERM")
  })
}

async function accepted(sender, receivers, ops) {
  const target = sender.rev + 1
  const cursors = receivers.map((client) => client.messages.length)
  sender.send(ops)
  await Promise.all(receivers.map((client, index) => client.waitFor((message) => message.type === "op" && message.rev === target, cursors[index])))
  assert(receivers.every((client) => client.rev === target), `clients did not reach rev ${target}`)
}

async function run() {
  assert(persistDir.endsWith("/.wrangler/state/phase3-integration"), "Refusing to clear an unexpected persistence path")
  rmSync(persistDir, { recursive: true, force: true })
  const migration = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DOCS_DB", "--local", "--persist-to", persistDir], {
    cwd: project,
    env: process.env,
    encoding: "utf8",
  })
  if (migration.status !== 0) throw new Error(`Local D1 migration failed\n${migration.stdout}\n${migration.stderr}`)

  await startWorker()

  const docId = "phase3-two-client-proof"
  const [a, b] = await Promise.all([new Client(docId, "integration-a").ready(), new Client(docId, "integration-b").ready()])
  assert(a.rev === 0 && b.rev === 0, "new proof document did not start at rev 0")

  const gapCursor = a.messages.length
  a.socket.send(JSON.stringify({ type: "op", ops: [{ t: "add", node: shape("gap", -10) }], clientRev: 0, clientId: a.clientId, clientSeq: 2 }))
  const gap = await a.waitFor((message) => message.type === "snapshot" && message.reason === "sequence_gap", gapCursor)
  assert(gap.rev === 0 && gap.acceptedClientSeq === 0, "sequence gap changed durable state")

  // The connection remains live after an idle period through the SDK's hibernating WebSocket path.
  await new Promise((resolveWait) => setTimeout(resolveWait, 750))
  const convergenceStarted = Date.now()
  for (let index = 1; index <= 5; index++) {
    const aOps = index < 5
      ? [{ t: "add", node: shape(`a${index}`, index * 40) }]
      : [{ t: "flip", ids: ["a1"], axis: "x" }]
    await accepted(a, [a, b], aOps)
    await accepted(b, [a, b], [{ t: "add", node: shape(`b${index}`, index * 40 + 20) }])
  }
  const convergenceMs = Date.now() - convergenceStarted
  assert(convergenceMs <= 2000, `two-client convergence took ${convergenceMs}ms`)
  assert(a.rev === 10 && b.rev === 10, `expected exact rev 10, got ${a.rev}/${b.rev}`)
  assert(JSON.stringify(a.doc) === JSON.stringify(b.doc), "two clients did not converge to the same document")
  assert(a.doc.nodes.a1.flipX === true, "non-idempotent flip did not apply exactly once")

  const duplicateCursor = a.messages.length
  a.send([{ t: "flip", ids: ["a1"], axis: "x" }], { clientSeq: 5, clientRev: 8 })
  const duplicate = await a.waitFor((message) => message.type === "snapshot" && message.reason === "duplicate", duplicateCursor)
  assert(duplicate.rev === 10 && duplicate.acceptedClientSeq === 5, "duplicate resend changed revision or client head")
  assert(duplicate.doc.nodes.a1.flipX === true, "duplicate resend applied a non-idempotent op twice")

  const reconnect = await new Client(docId, "integration-reconnect").ready()
  assert(reconnect.rev === 10 && JSON.stringify(reconnect.doc) === JSON.stringify(a.doc), "reconnect snapshot did not match converged document")

  const renamed = await fetch(`${origin}/api/docs/${docId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rename", name: "Phase 3 proof" }),
  })
  assert(renamed.ok, `D1 rename projection failed (${renamed.status})`)
  const saved = await fetch(`${origin}/api/docs/${docId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "save", name: "Phase 3 proof saved" }),
  })
  assert(saved.ok, `D1 save projection failed (${saved.status})`)
  const index = await fetch(`${origin}/api/docs`).then((response) => response.json())
  assert(index.docs.some((doc) => doc.id === docId && doc.name === "Phase 3 proof saved"), "D1 docs index did not reflect rename/save")

  const undoDoc = "phase3-undo-isolation"
  const [undoA, undoB] = await Promise.all([new Client(undoDoc, "undo-a").ready(), new Client(undoDoc, "undo-b").ready()])
  await accepted(undoA, [undoA, undoB], [{ t: "add", node: shape("only-a", 0) }])
  await accepted(undoB, [undoA, undoB], [{ t: "add", node: shape("only-b", 40) }])
  await accepted(undoA, [undoA, undoB], [{ t: "remove", ids: ["only-a"] }])
  assert(undoA.doc.order.join(",") === "only-b" && JSON.stringify(undoA.doc) === JSON.stringify(undoB.doc), "A undo erased B's accepted edit")

  a.close(); b.close(); reconnect.close(); undoA.close(); undoB.close()
  await stopWorker()

  await startWorker()
  const persisted = await new Client(docId, "integration-after-restart").ready()
  assert(persisted.rev === 10 && JSON.stringify(persisted.doc) === JSON.stringify(duplicate.doc), "Durable state did not survive wrangler restart")
  const persistedIndex = await fetch(`${origin}/api/docs`).then((response) => response.json())
  assert(persistedIndex.docs.some((doc) => doc.id === docId && doc.name === "Phase 3 proof saved"), "D1 index did not survive wrangler restart")
  persisted.close()

  assert(!fatal, fatal?.message ?? "protocol failure")
  console.log(JSON.stringify({
    ok: true,
    twoClientOps: 10,
    finalRev: 10,
    convergenceMs,
    reconnectSnapshot: "matched",
    duplicateResend: "no revision increment",
    frameworkFrames: 0,
    connectedUndo: "preserved remote edit",
    wranglerRestart: "state and D1 persisted",
  }, null, 2))
}

try {
  await run()
} finally {
  await stopWorker()
}
