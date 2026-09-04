// Phase 3 client protocol: optimistic replay, idempotent recovery and local-only undo.

const windowListeners = new Map<string, Array<(event: { key?: string | null; newValue?: string | null }) => void>>()
;(globalThis as { window?: unknown }).window = {
  location: { hostname: "test.invalid" },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener(type: string, listener: (event: { key?: string | null; newValue?: string | null }) => void) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
  },
  removeEventListener() {},
}
;(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  documentElement: { style: { setProperty() {} }, dataset: {} },
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

const { SquigSyncCore, chunkCommands, createPageClientId, diffDocs } = await import("../lib/agent/sync.ts")
const { MAX_CLIENT_HEADS, MAX_COMMAND_BYTES, boundClientHeads, wireBytes } = await import("../lib/agent/protocol.ts")
const { requestSecurity } = await import("../worker/security.ts")
const {
  applyAuthoritativeDocument,
  setConnectedHistoryController,
  setConnectedPersistenceMode,
  subscribeDocumentEdits,
  syncRemoteFiles,
  useSquig,
} = await import("../lib/store.ts")
const { applyOp } = await import("../lib/ops/apply-op.ts")
const { seedFromId } = await import("../lib/ops/context.ts")
const { sameValue } = await import("../lib/ops/value.ts")
import type { Doc, Op, OpContext } from "../lib/ops/types.ts"
import type { ShapeNode, TextNode } from "../lib/types.ts"

const context: OpContext = { getDef: () => undefined, nanoid: () => { throw new Error("resolved ids only") }, seed: seedFromId }
const shape = (id: string, x: number): ShapeNode => ({ id, seed: seedFromId(id), type: "shape", shape: "rect", fill: "none", x, y: 0, w: 20, h: 20 })
const textNode = (id: string, text: string): TextNode => ({ id, seed: seedFromId(id), type: "text", text, fontSize: 18, x: 0, y: 0, w: 40, h: 24 })
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

// A duplicated browser tab gets a fresh page identity; reconnects retain the id captured by that page.
{
  const firstPage = createPageClientId()
  const duplicatedPage = createPageClientId()
  check("page identity: independently initialized pages cannot collide", firstPage !== duplicatedPage)
  check("page identity: no id is persisted in sessionStorage", ![...local.keys()].some((key) => key.includes("sync-client-id")))
}

// Edits made before the first snapshot are replayed over, rather than erased by, a non-empty server doc.
{
  const initial: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string; ops?: Op[]; clientRev?: number }> = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "pre-snapshot", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.localOperations([{ t: "add", node: shape("local-before-snapshot", 20) }])
  const server: Doc = { nodes: { server: shape("server", 0) }, order: ["server"] }
  core.handleSnapshot({ type: "snapshot", doc: server, rev: 7, acceptedClientSeq: 0 })
  check("pre-snapshot: local input is rebased over server state", shown.order.join(",") === "server,local-before-snapshot")
  check("pre-snapshot: rebased command starts at authoritative rev", sent.at(-1)?.clientRev === 7)
}

// One gesture may span transport chunks, while remaining one bounded local undo entry.
{
  const ops: Op[] = Array.from({ length: 205 }, (_, index) => ({ t: "add", node: shape(`bulk-${index}`, index) }))
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const core = new SquigSyncCore({ clientId: "bulk", initialDoc: { nodes: {}, order: [] }, send: (message) => sent.push(message), show: () => undefined })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: { nodes: {}, order: [] }, rev: 0, acceptedClientSeq: 0 })
  core.localOperations(ops)
  check("chunking: over 100 ops becomes three commands", core.inspect().pending.length === 3)
  check("chunking: every command respects operation limit", core.inspect().pending.every((command) => command.ops.length <= 100))
  check("chunking: one gesture remains one undo step", core.inspect().historyDepth === 1)
  for (let index = 0; index < 3; index++) {
    const command = sent[index]
    core.handleServerOp({ type: "op", ops: command.ops!, rev: index + 1, by: "bulk", clientSeq: command.clientSeq! })
  }
  check("chunking: all chunks converge", core.inspect().baseDoc.order.length === 205 && core.inspect().pending.length === 0)
}

// UTF-8 payload packing splits safe operations, and an indivisible oversized edit stays visible and retryable.
{
  const initial: Doc = { nodes: { a: textNode("a", "a"), b: textNode("b", "b") }, order: ["a", "b"] }
  const largeOps: Op[] = [
    { t: "update", id: "a", patch: { text: "x".repeat(550_000) } },
    { t: "update", id: "b", patch: { text: "y".repeat(550_000) } },
  ]
  const chunks = chunkCommands(largeOps, "payload", 1, 0)
  check("payload: near-limit operations are split", chunks.length === 2 && chunks.every((chunk) => !chunk.blocked))
  check("payload: every emitted envelope is within the worker limit", chunks.every((chunk, index) => wireBytes({ type: "op", ops: chunk.ops, clientRev: 0, clientId: "payload", clientSeq: index + 1 }) <= MAX_COMMAND_BYTES))

  const sent: unknown[] = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "oversized", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0 })
  core.localOperations([{ t: "update", id: "a", patch: { text: "z".repeat(MAX_COMMAND_BYTES + 10_000) } }])
  check("payload: indivisible oversized edit remains visible", shown.nodes.a.type === "text" && shown.nodes.a.text.length > MAX_COMMAND_BYTES)
  check("payload: oversized edit is retained and surfaced", core.inspect().pending.length === 1 && core.inspect().error?.code === "command_too_large" && sent.length === 0)
}

// A server rejection cannot discard the pending local command or replace its visible result.
{
  const initial: Doc = { nodes: {}, order: [] }
  let shown = initial
  const core = new SquigSyncCore({ clientId: "rejected", initialDoc: initial, send: () => undefined, show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0 })
  core.localOperations([{ t: "add", node: shape("kept", 0) }])
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0, reason: "invalid" })
  check("rejection: pending command is not removed", core.inspect().pending.length === 1)
  check("rejection: authoritative snapshot does not erase local state", shown.order.join(",") === "kept")
  check("rejection: recoverable error is exposed", core.inspect().error?.retryable === true)
}

// The production store transaction/controller path emits one gesture and no cancelled gesture.
{
  const original: Doc = { nodes: { store: shape("store", 0) }, order: ["store"] }
  useSquig.setState({ nodes: original.nodes, order: original.order, selection: ["store"], past: [], future: [], transforming: false })
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const core = new SquigSyncCore({
    clientId: "store-client",
    initialDoc: original,
    send: (message) => sent.push(message),
    show: (doc) => useSquig.setState({ nodes: doc.nodes, order: doc.order }),
  })
  const unsubscribe = subscribeDocumentEdits((event) => event.type === "commit" ? core.localDocumentGesture(event.before, event.after) : core.present())
  setConnectedHistoryController({ undo: () => core.undo(), redo: () => core.redo() })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })

  const store = useSquig.getState()
  store.checkpoint()
  store.setTransforming(true)
  store.updateNode("store", { x: 10 }, { checkpoint: false })
  store.updateNode("store", { x: 20 }, { checkpoint: false })
  store.setTransforming(false)
  check("store gesture: repeated notifications become one command", sent.length === 1 && core.inspect().historyDepth === 1)
  const gesture = sent[0]
  core.handleServerOp({ type: "op", ops: gesture.ops!, rev: 1, by: "store-client", clientSeq: gesture.clientSeq! })

  const beforeCancel = sent.length
  useSquig.getState().checkpoint()
  useSquig.getState().setTransforming(true)
  useSquig.getState().updateNode("store", { x: 999 }, { checkpoint: false })
  useSquig.getState().revertToCheckpoint()
  useSquig.getState().setTransforming(false)
  check("store gesture: Escape cancellation sends no command", sent.length === beforeCancel && useSquig.getState().nodes.store.x === 20)

  useSquig.getState().undo()
  const undo = sent.at(-1)!
  check("store controller: connected undo invokes core", sent.length === beforeCancel + 1 && useSquig.getState().nodes.store.x === 0)
  core.handleServerOp({ type: "op", ops: undo.ops!, rev: 2, by: "store-client", clientSeq: undo.clientSeq! })
  unsubscribe()
  setConnectedHistoryController(null)
}

// Connected history and Durable Object replay heads are bounded.
{
  const core = new SquigSyncCore({ clientId: "bounded-history", initialDoc: { nodes: {}, order: [] }, send: () => undefined, show: () => undefined })
  core.handleSnapshot({ type: "snapshot", doc: { nodes: {}, order: [] }, rev: 0, acceptedClientSeq: 0 })
  for (let index = 0; index < 115; index++) core.localOperations([{ t: "add", node: shape(`history-${index}`, index) }])
  check("history: connected undo stack is bounded", core.inspect().historyDepth === 100)
  const heads = Object.fromEntries(Array.from({ length: MAX_CLIENT_HEADS + 44 }, (_, index) => [`page-${index}`, { seq: 1, rev: index }]))
  const bounded = boundClientHeads(heads)
  check("client heads: durable replay window is bounded", Object.keys(bounded).length === MAX_CLIENT_HEADS)
  check("client heads: newest replay heads are retained", !!bounded[`page-${MAX_CLIENT_HEADS + 43}`] && !bounded["page-0"])
}

// Remote D1 rows survive ordinary local saves and localStorage index events.
{
  local.clear()
  useSquig.setState({ hydrated: false, files: [], nodes: {}, order: [], past: [], future: [], stale: false })
  useSquig.getState().hydrate()
  syncRemoteFiles([{ id: "remote-row", name: "Remote", updatedAt: 50 }])
  useSquig.setState({ docId: "local-row", fileName: "Local", nodes: { local: shape("local", 0) }, order: ["local"] })
  useSquig.getState().saveNow()
  check("drawer: local save retains remote D1 row", useSquig.getState().files.some((file) => file.id === "remote-row"))
  local.set("squig:files:v1", JSON.stringify([{ id: "other-local", name: "Other", updatedAt: 60 }]))
  for (const listener of windowListeners.get("storage") ?? []) listener({ key: "squig:files:v1", newValue: local.get("squig:files:v1") })
  check("drawer: storage event retains remote D1 row", useSquig.getState().files.some((file) => file.id === "remote-row"))

  setConnectedPersistenceMode(true)
  useSquig.setState({ stale: true })
  applyAuthoritativeDocument({ nodes: { authoritative: shape("authoritative", 0) }, order: ["authoritative"] })
  check("persistence: authoritative snapshot bypasses offline stale guard", !useSquig.getState().stale && useSquig.getState().order[0] === "authoritative")
  setConnectedPersistenceMode(false)
  syncRemoteFiles([])
}

// Local development stays usable, while production rejects missing Access identity and foreign origins.
{
  const allowed = "https://squig.example.com"
  check("security: local mode permits an unauthenticated local request", requestSecurity(new Request("http://worker/api/docs"), { ENVIRONMENT: "local", APP_ORIGIN: allowed }) === null)
  check("security: production fails closed without Access identity", requestSecurity(new Request("https://worker/api/docs"), { ENVIRONMENT: "production", APP_ORIGIN: allowed })?.status === 401)
  check("security: docs origin is rejected", requestSecurity(new Request("https://worker/api/docs", { headers: { Origin: "https://evil.example" } }), { ENVIRONMENT: "production", APP_ORIGIN: allowed })?.status === 403)
  check("security: authenticated allowed origin passes", requestSecurity(new Request("https://worker/agents/squig-doc/x", { headers: { Origin: allowed, "Cf-Access-Authenticated-User-Email": "person@example.com" } }), { ENVIRONMENT: "production", APP_ORIGIN: allowed }) === null)
}

if (failures.length) {
  console.error(`sync: ${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`sync: ${passed} passed`)
}
