// Phase 3 client protocol: optimistic replay, idempotent recovery and local-only undo.

;(globalThis as { window?: unknown }).window = {
  location: { hostname: "test.invalid" },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
const local = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => void local.set(key, value),
  removeItem: (key: string) => void local.delete(key),
}
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => local.get(`session:${key}`) ?? null,
  setItem: (key: string, value: string) => void local.set(`session:${key}`, value),
  removeItem: (key: string) => void local.delete(`session:${key}`),
}

const { SquigSyncCore, diffDocs } = await import("../lib/agent/sync.ts")
const { applyOp } = await import("../lib/ops/apply-op.ts")
const { seedFromId } = await import("../lib/ops/context.ts")
const { sameValue } = await import("../lib/ops/value.ts")
import type { Doc, Op, OpContext } from "../lib/ops/types.ts"
import type { ShapeNode, TextNode } from "../lib/types.ts"

const context: OpContext = { getDef: () => undefined, nanoid: () => { throw new Error("resolved ids only") }, seed: seedFromId }
const shape = (id: string, x: number): ShapeNode => ({ id, seed: seedFromId(id), type: "shape", shape: "rect", fill: "none", x, y: 0, w: 20, h: 20 })
const apply = (doc: Doc, ops: readonly Op[]) => ops.reduce((current, op) => applyOp(current, op, context).doc, doc)

let passed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail = "") {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
}

// A non-idempotent flip is visible immediately, then its own echo only advances the base.
{
  const original: Doc = { nodes: { a: shape("a", 0) }, order: ["a"] }
  const sent: Array<{ type: string }> = []
  let shown = original
  const core = new SquigSyncCore({ clientId: "client-a", initialDoc: original, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })
  const flip: Op = { t: "flip", ids: ["a"], axis: "x" }
  core.localOperations([flip])
  check("own echo: optimistic flip is applied", shown.nodes.a.flipX === true)
  core.handleServerOp({ type: "op", ops: [flip], rev: 1, by: "client-a", clientSeq: 1 })
  check("own echo: non-idempotent op is not applied twice", core.inspect().visibleDoc.nodes.a.flipX === true)
  check("own echo: authoritative revision is contiguous", core.inspect().serverRev === 1 && core.inspect().pending.length === 0)
}

// Client A's connected undo emits an inverse command after B's accepted edit and preserves B.
{
  const empty: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string }> = []
  let shown = empty
  const core = new SquigSyncCore({ clientId: "client-a", initialDoc: empty, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: empty, rev: 0, acceptedClientSeq: 0 })
  const addA: Op = { t: "add", node: shape("a", 0) }
  core.localOperations([addA])
  core.handleServerOp({ type: "op", ops: [addA], rev: 1, by: "client-a", clientSeq: 1 })
  const addB: Op = { t: "add", node: shape("b", 40) }
  core.handleServerOp({ type: "op", ops: [addB], rev: 2, by: "client-b", clientSeq: 1 })
  check("undo isolation: remote edit is visible", shown.order.join(",") === "a,b")
  core.undo()
  const undo = sent.at(-1) as { type: "op"; ops: Op[]; clientRev: number; clientSeq: number }
  check("undo isolation: inverse uses normal revision stream", undo.type === "op" && undo.clientRev === 2 && undo.clientSeq === 2)
  check("undo isolation: only A's node is removed optimistically", shown.order.join(",") === "b")
  core.handleServerOp({ type: "op", ops: undo.ops, rev: 3, by: "client-a", clientSeq: 2 })
  check("undo isolation: B survives authoritative undo", core.inspect().baseDoc.order.join(",") === "b")
}

// invert(remove-many) needs several operations; they travel as one atomic command/revision.
{
  const original: Doc = { nodes: { a: shape("a", 0), b: shape("b", 30), c: shape("c", 60) }, order: ["a", "b", "c"] }
  const sent: Array<{ type: string }> = []
  const core = new SquigSyncCore({ clientId: "client-a", initialDoc: original, send: (message) => sent.push(message), show: () => undefined })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })
  const remove: Op = { t: "remove", ids: ["a", "c"] }
  core.localOperations([remove])
  core.handleServerOp({ type: "op", ops: [remove], rev: 1, by: "client-a", clientSeq: 1 })
  core.undo()
  const undo = sent.at(-1) as { type: "op"; ops: Op[]; clientRev: number }
  check("atomic inverse: several reducer ops share one command", undo.ops.length > 1 && undo.clientRev === 1, `ops=${undo.ops.length}`)
  core.handleServerOp({ type: "op", ops: undo.ops, rev: 2, by: "client-a", clientSeq: 2 })
  check("atomic inverse: restored document is exact", sameValue(core.inspect().visibleDoc, original))
}

// Reconnect snapshot confirms an accepted command whose echo was lost, so it is not replayed.
{
  const original: Doc = { nodes: { a: shape("a", 0) }, order: ["a"] }
  const sent: Array<{ type: string }> = []
  const core = new SquigSyncCore({ clientId: "client-a", initialDoc: original, send: (message) => sent.push(message), show: () => undefined })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })
  const flip: Op = { t: "flip", ids: ["a"], axis: "x" }
  core.localOperations([flip])
  const accepted = apply(original, [flip])
  core.setTransportOpen(false)
  core.handleSnapshot({ type: "snapshot", doc: accepted, rev: 1, acceptedClientSeq: 1, reason: "duplicate" })
  core.setTransportOpen(true)
  check("reconnect: accepted sequence drops pending resend", core.inspect().pending.length === 0)
  check("reconnect: accepted non-idempotent op remains single", core.inspect().visibleDoc.nodes.a.flipX === true)
}

// A deleted optional field is represented without undefined, so JSON round-trips exactly.
{
  const linked: TextNode = { id: "t", seed: 1, type: "text", text: "link", fontSize: 18, x: 0, y: 0, w: 40, h: 24, link: "https://example.com" }
  const unlinked: TextNode = { ...linked }
  delete unlinked.link
  const before: Doc = { nodes: { t: linked }, order: ["t"] }
  const after: Doc = { nodes: { t: unlinked }, order: ["t"] }
  const ops = diffDocs(before, after)
  const wire = JSON.parse(JSON.stringify(ops)) as Op[]
  check("serializable ops: undefined never appears on the wire", !JSON.stringify(ops).includes("undefined"))
  check("serializable ops: deletion round-trips exactly", sameValue(apply(before, wire), after))
}

if (failures.length) {
  console.error(`sync: ${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`sync: ${passed} passed`)
}
