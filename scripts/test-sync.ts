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

const {
  MAX_CONNECTED_HISTORY_BYTES,
  SquigSyncCore,
  chunkCommands,
  createPageClientId,
  diffDocs,
  startSquigSync,
} = await import("../lib/agent/sync.ts")
const {
  MAX_PENDING_INTENT_COMMANDS,
  PENDING_INTENT_JOURNAL_VERSION,
  captureIntentTransition,
  loadPendingIntents,
  pendingIntentJournalKey,
  savePendingIntents,
} = await import("../lib/agent/journal.ts")
const { MAX_CLIENT_HEADS, MAX_COMMAND_BYTES, boundClientHeads, wireBytes } = await import("../lib/agent/protocol.ts")
const { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NODES, serializedDocumentBytes, validDocument } = await import("../lib/agent/validate.ts")
const { requestSecurity } = await import("../worker/security.ts")
const {
  DOCUMENT_EDIT_FALLBACK_MS,
  applyAuthoritativeDocument,
  isConnectedPersistenceMode,
  isDocumentEditActive,
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

// A same-field collaborator write cannot be overwritten by an older client's undo.
{
  const original: Doc = { nodes: { shared: shape("shared", 0) }, order: ["shared"] }
  const sentA: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const sentB: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const coreA = new SquigSyncCore({ clientId: "same-field-a", initialDoc: original, send: (message) => sentA.push(message), show: () => undefined })
  const coreB = new SquigSyncCore({ clientId: "same-field-b", initialDoc: original, send: (message) => sentB.push(message), show: () => undefined })
  for (const core of [coreA, coreB]) {
    core.setTransportOpen(true)
    core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })
  }
  coreA.localOperations([{ t: "update", id: "shared", patch: { x: 10 } }])
  const byA = sentA[0]
  for (const core of [coreA, coreB]) core.handleServerOp({ type: "op", ops: byA.ops!, rev: 1, by: "same-field-a", clientSeq: byA.clientSeq! })
  coreB.localOperations([{ t: "update", id: "shared", patch: { x: 20 } }])
  const byB = sentB[0]
  for (const core of [coreA, coreB]) core.handleServerOp({ type: "op", ops: byB.ops!, rev: 2, by: "same-field-b", clientSeq: byB.clientSeq! })
  const beforeUndoCommands = sentA.length
  coreA.undo()
  check("conditional undo: later collaborator field value remains visible", coreA.inspect().visibleDoc.nodes.shared.x === 20 && coreB.inspect().visibleDoc.nodes.shared.x === 20)
  check("conditional undo: conflicting inverse is safely refused", sentA.length === beforeUndoCommands && coreA.inspect().pending.length === 0)
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

// Pending intent storage is versioned, bounded, malformed-data safe, and document-scoped.
{
  local.clear()
  const before: Doc = { nodes: { shared: shape("shared", 0) }, order: ["shared"] }
  const after: Doc = { nodes: { shared: shape("shared", 10) }, order: ["shared"] }
  const intent = captureIntentTransition(before, after)
  check("intent journal: current version round-trips", PENDING_INTENT_JOURNAL_VERSION === 2 && savePendingIntents("journal-a", [intent]) && sameValue(loadPendingIntents("journal-a"), [intent]))
  check("intent journal: one document cannot read another document's intent", loadPendingIntents("journal-b").length === 0)
  local.set(pendingIntentJournalKey("journal-b"), JSON.stringify({ version: 2, docId: "journal-b", intents: [{ nodes: [{ nope: true }] }] }))
  check("intent journal: malformed entries fail closed", loadPendingIntents("journal-b").length === 0 && !local.has(pendingIntentJournalKey("journal-b")))
  const tooMany = Array.from({ length: MAX_PENDING_INTENT_COMMANDS + 1 }, () => intent)
  check("intent journal: command count is bounded", !savePendingIntents("journal-c", tooMany) && loadPendingIntents("journal-c").length === 0)
}

// A relative reorder accepted before a lost acknowledgement is not replayed on a fresh page.
{
  local.clear()
  const docId = "lost-ack-reorder"
  const original: Doc = { nodes: { a: shape("a", 0), b: shape("b", 30), c: shape("c", 60) }, order: ["a", "b", "c"] }
  const oldPageId = createPageClientId()
  const oldSent: Array<{ type: string; ops?: Op[] }> = []
  const oldCore = new SquigSyncCore({
    clientId: oldPageId,
    initialDoc: original,
    send: (message) => oldSent.push(message),
    show: () => undefined,
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  oldCore.setTransportOpen(true)
  oldCore.handleSnapshot({ type: "snapshot", doc: original, rev: 5, acceptedClientSeq: 0 })
  oldCore.localOperations([{ t: "reorder", ids: ["c"], to: "backward" }])
  const accepted = apply(original, oldSent[0].ops!)
  oldCore.setTransportOpen(false)

  const newPageId = createPageClientId()
  const newSent: Array<{ type: string }> = []
  let shown = accepted
  const newCore = new SquigSyncCore({
    clientId: newPageId,
    initialDoc: accepted,
    initialPendingIntents: loadPendingIntents(docId),
    send: (message) => newSent.push(message),
    show: (doc) => { shown = doc },
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  newCore.setTransportOpen(true)
  newCore.handleSnapshot({ type: "snapshot", doc: accepted, rev: 6, acceptedClientSeq: 0 })
  check("lost ack reorder: restart uses a genuinely new page identity", oldPageId !== newPageId)
  check("lost ack reorder: authoritative accepted order is not applied twice", shown.order.join(",") === "a,c,b" && accepted.order.join(",") === "a,c,b")
  check("lost ack reorder: accepted transition is dropped without another command", newSent.length === 0 && loadPendingIntents(docId).length === 0)
}

// A collaborator's later scalar value wins over an accepted-but-unacknowledged journal transition.
{
  local.clear()
  const docId = "lost-ack-scalar"
  const original: Doc = { nodes: { shared: shape("shared", 0) }, order: ["shared"] }
  const oldPageId = createPageClientId()
  const oldSent: Array<{ type: string; ops?: Op[] }> = []
  const oldCore = new SquigSyncCore({
    clientId: oldPageId,
    initialDoc: original,
    send: (message) => oldSent.push(message),
    show: () => undefined,
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  oldCore.setTransportOpen(true)
  oldCore.handleSnapshot({ type: "snapshot", doc: original, rev: 5, acceptedClientSeq: 0 })
  oldCore.localOperations([{ t: "update", id: "shared", patch: { x: 10 } }])
  const accepted = apply(original, oldSent[0].ops!)
  const collaborated = apply(accepted, [{ t: "update", id: "shared", patch: { x: 20 } }])
  oldCore.setTransportOpen(false)

  const newPageId = createPageClientId()
  const newSent: Array<{ type: string }> = []
  let shown = accepted
  const newCore = new SquigSyncCore({
    clientId: newPageId,
    initialDoc: accepted,
    initialPendingIntents: loadPendingIntents(docId),
    send: (message) => newSent.push(message),
    show: (doc) => { shown = doc },
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  newCore.setTransportOpen(true)
  newCore.handleSnapshot({ type: "snapshot", doc: collaborated, rev: 7, acceptedClientSeq: 0 })
  check("lost ack conflict: restart uses a genuinely new page identity", oldPageId !== newPageId)
  check("lost ack conflict: collaborator scalar remains authoritative", shown.nodes.shared.x === 20 && newSent.length === 0)
  check("lost ack conflict: conflicting stale transition is cleared", loadPendingIntents(docId).length === 0)
}

// A partially accepted chunked reorder resumes from the authoritative intermediate order.
{
  local.clear()
  const docId = "lost-ack-chunked-reorder"
  const ids = Array.from({ length: 205 }, (_, index) => `chunk-order-${index}`)
  const original: Doc = {
    nodes: Object.fromEntries(ids.map((id, index) => [id, shape(id, index)])),
    order: ids,
  }
  const intended = apply(original, [{ t: "reorder", ids: [ids.at(-1)!], to: "back" }])
  const oldPageId = createPageClientId()
  const oldSent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const oldCore = new SquigSyncCore({
    clientId: oldPageId,
    initialDoc: original,
    send: (message) => oldSent.push(message),
    show: () => undefined,
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  oldCore.setTransportOpen(true)
  oldCore.handleSnapshot({ type: "snapshot", doc: original, rev: 5, acceptedClientSeq: 0 })
  oldCore.localOperations([{ t: "reorder", ids: [ids.at(-1)!], to: "back" }])
  const originalChunks = oldCore.inspect().pending.map((command) => command.ops)
  check("partial lost ack: 205-node reorder is split 100/100/4", originalChunks.map((ops) => ops.length).join(",") === "100,100,4")
  check("partial lost ack: journal retains every ordered chunk transition", loadPendingIntents(docId).length === 3)

  let serverDoc = apply(original, originalChunks[0])
  oldCore.setTransportOpen(false)
  const newPageId = createPageClientId()
  const newSent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  let shown = serverDoc
  const newCore = new SquigSyncCore({
    clientId: newPageId,
    initialDoc: serverDoc,
    initialPendingIntents: loadPendingIntents(docId),
    send: (message) => newSent.push(message),
    show: (doc) => { shown = doc },
    onPendingIntents: (intents) => void savePendingIntents(docId, intents),
  })
  newCore.setTransportOpen(true)
  newCore.handleSnapshot({ type: "snapshot", doc: serverDoc, rev: 6, acceptedClientSeq: 0 })
  check("partial lost ack: restart uses a genuinely new page identity", oldPageId !== newPageId)
  check("partial lost ack: accepted first chunk is not resent", newCore.inspect().pending.length === 2 && newSent.length === 1 && sameValue(newSent[0].ops, originalChunks[1]))
  check("partial lost ack: optimistic replay reaches the intended final order", sameValue(shown.order, intended.order))

  for (let index = 0; index < 2; index++) {
    const command = newSent[index]
    serverDoc = apply(serverDoc, command.ops!)
    newCore.handleServerOp({ type: "op", ops: command.ops!, rev: 7 + index, by: newPageId, clientSeq: command.clientSeq! })
  }
  check("partial lost ack: only the remaining 100/4 chunks are transmitted", newSent.map((command) => command.ops?.length).join(",") === "100,4" && sameValue(newSent[1].ops, originalChunks[2]))
  check("partial lost ack: resumed chunks converge and clear the journal", sameValue(serverDoc, intended) && sameValue(newCore.inspect().baseDoc, intended) && newCore.inspect().pending.length === 0 && loadPendingIntents(docId).length === 0)
}

// A semantically invalid restored transition cannot discard a valid edit made by the new page.
{
  const original: Doc = { nodes: { base: shape("base", 0) }, order: ["base"] }
  const malformed = {
    nodes: [{
      kind: "patch" as const,
      id: "base",
      fields: [{ key: "x", before: { present: true, value: 0 }, after: { present: true, value: null } }],
    }],
  }
  const restored = [malformed]
  const sent: Array<{ type: string; ops?: Op[] }> = []
  let shown = original
  const core = new SquigSyncCore({ clientId: "malformed-restore", initialDoc: original, initialPendingIntents: restored, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.localOperations([{ t: "add", node: shape("live", 30) }])
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 3, acceptedClientSeq: 0 })
  check("restored isolation: invalid restored state is discarded with real document validation", shown.nodes.base.x === 0)
  check("restored isolation: valid current-page pre-snapshot edit remains pending", shown.order.join(",") === "base,live" && sent.length === 1 && sent[0].ops?.some((op) => op.t === "add" && op.node.id === "live") === true)
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

// A pre-snapshot edit gets a new inverse from the authoritative pre-state, not the stale local cache.
{
  const initial: Doc = { nodes: { shared: shape("shared", 0) }, order: ["shared"] }
  const server: Doc = { nodes: { shared: shape("shared", 5) }, order: ["shared"] }
  const sent: Array<{ type: string; ops?: Op[]; clientRev?: number; clientSeq?: number }> = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "pre-snapshot-inverse", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.localOperations([{ t: "update", id: "shared", patch: { x: 10 } }])
  core.handleSnapshot({ type: "snapshot", doc: server, rev: 7, acceptedClientSeq: 0 })
  const forward = sent.at(-1)!
  core.handleServerOp({ type: "op", ops: forward.ops!, rev: 8, by: "pre-snapshot-inverse", clientSeq: forward.clientSeq! })
  core.undo()
  const undo = sent.at(-1)!
  check("pre-snapshot history: undo restores the authoritative pre-state", shown.nodes.shared.x === 5)
  check("pre-snapshot history: rebased inverse travels through the revision stream", undo.clientRev === 8 && (undo.ops?.[0] as { patch?: { x?: number } })?.patch?.x === 5)
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
  core.undo()
  check("payload: undo immediately cancels an oversized visible mutation", sameValue(shown, initial) && core.inspect().pending.length === 2)
  core.retry()
  check("payload: cancelled oversized intent recovers without recreating it", sameValue(core.inspect().visibleDoc, initial) && core.inspect().pending.length === 0 && core.inspect().error === null)
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

// Rejected edit, undo, and later edit retain their chronological user intent through retry.
{
  const initial: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "rejected-order", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0 })
  core.localOperations([{ t: "add", node: shape("b", 0) }])
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0, reason: "invalid" })
  core.undo()
  core.localOperations([{ t: "add", node: shape("c", 30) }])
  check("rejected ordering: visible intent is C before retry", shown.order.join(",") === "c" && core.inspect().pending.length === 3)
  core.retry()
  const retry = sent.at(-1)!
  check("rejected ordering: retry sends only the final declarative intent", retry.ops?.length === 1 && retry.ops[0].t === "add" && retry.ops[0].node.id === "c")
  core.handleServerOp({ type: "op", ops: retry.ops!, rev: 1, by: "rejected-order", clientSeq: retry.clientSeq! })
  check("rejected ordering: retry converges to C without resurrecting B", core.inspect().baseDoc.order.join(",") === "c")
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

  useSquig.getState().checkpoint()
  useSquig.getState().updateNode("store", { x: 30 }, { checkpoint: false })
  const beforeImmediateUndo = sent.length
  useSquig.getState().undo()
  const deferredForward = sent.at(-1)!
  check("store controller: immediate undo first commits a timer-backed edit", sent.length === beforeImmediateUndo + 1 && deferredForward.clientSeq === 3)
  core.handleServerOp({ type: "op", ops: deferredForward.ops!, rev: 3, by: "store-client", clientSeq: deferredForward.clientSeq! })
  const deferredUndo = sent.at(-1)!
  check("store controller: queued immediate undo reverses the committed edit", sent.length === beforeImmediateUndo + 2 && useSquig.getState().nodes.store.x === 0)
  core.handleServerOp({ type: "op", ops: deferredUndo.ops!, rev: 4, by: "store-client", clientSeq: deferredUndo.clientSeq! })
  unsubscribe()
  setConnectedHistoryController(null)
}

// Closing a no-op gesture re-presents a remote edit that arrived while the store hid it.
{
  const original: Doc = { nodes: { noop: shape("noop", 0) }, order: ["noop"] }
  useSquig.setState({ docId: "noop-doc", nodes: original.nodes, order: original.order, selection: [], past: [], future: [], transforming: false })
  const core = new SquigSyncCore({
    clientId: "noop-local",
    initialDoc: original,
    send: () => undefined,
    show: (doc) => {
      if (!isDocumentEditActive()) useSquig.setState({ nodes: doc.nodes, order: doc.order })
    },
  })
  const unsubscribe = subscribeDocumentEdits((event) => event.type === "commit" ? core.localDocumentGesture(event.before, event.after) : core.present())
  core.handleSnapshot({ type: "snapshot", doc: original, rev: 0, acceptedClientSeq: 0 })
  useSquig.getState().checkpoint()
  core.handleServerOp({ type: "op", ops: [{ t: "update", id: "noop", patch: { x: 45 } }], rev: 1, by: "noop-remote", clientSeq: 1 })
  check("no-op gesture: remote presentation is hidden only while the edit is active", useSquig.getState().nodes.noop.x === 0)
  useSquig.getState().commitCheckpoint()
  check("no-op gesture: close re-presents the accepted remote edit", useSquig.getState().nodes.noop.x === 45)
  unsubscribe()
}

// A deferred edit is closed against its originating file before any store-owned document transition.
{
  const events: Array<{ type: string; docId: string; before: Doc; after?: Doc }> = []
  const unsubscribe = subscribeDocumentEdits((event) => events.push(event))
  useSquig.setState({ docId: "origin-doc", nodes: { origin: shape("origin", 0) }, order: ["origin"], past: [], future: [], transforming: false })
  useSquig.getState().checkpoint()
  useSquig.getState().updateNode("origin", { x: 25 }, { checkpoint: false })
  useSquig.getState().newFile()
  check("document transition: deferred edit commits to its originating id", events.length === 1 && events[0].type === "commit" && events[0].docId === "origin-doc" && events[0].after?.nodes.origin.x === 25)

  const timerDocId = useSquig.getState().docId
  useSquig.setState({ nodes: { timed: shape("timed", 0) }, order: ["timed"], past: [], future: [] })
  useSquig.getState().checkpoint()
  useSquig.getState().updateNode("timed", { x: 40 }, { checkpoint: false })
  const beforeTimer = events.length
  await new Promise((resolve) => setTimeout(resolve, DOCUMENT_EDIT_FALLBACK_MS + 75))
  check("gesture fallback: store-only close leaves network budget below one second", DOCUMENT_EDIT_FALLBACK_MS <= 500 && events.length === beforeTimer + 1 && events.at(-1)?.docId === timerDocId)
  unsubscribe()
}

// Undo is an immediate optimistic intent, ordered between an unacknowledged edit and the next edit.
{
  const initial: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "history-order", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0 })
  core.localOperations([{ t: "add", node: shape("a", 0) }])
  core.undo()
  check("history order: undo before acknowledgement updates the visible document immediately", shown.order.length === 0)
  core.localOperations([{ t: "add", node: shape("b", 30) }])
  check("history order: a later edit follows the undo optimistically", shown.order.join(",") === "b" && core.inspect().pending.length === 3)
  for (let rev = 1; rev <= 3; rev++) {
    const command = sent[rev - 1]
    core.handleServerOp({ type: "op", ops: command.ops!, rev, by: "history-order", clientSeq: command.clientSeq! })
  }
  check("history order: edit, undo, edit converges in intent order", core.inspect().baseDoc.order.join(",") === "b" && core.inspect().pending.length === 0)
}

// The same intent order is preserved while the transport is offline after a valid connection.
{
  const initial: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  let shown = initial
  const core = new SquigSyncCore({ clientId: "offline-history", initialDoc: initial, send: (message) => sent.push(message), show: (doc) => { shown = doc } })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 4, acceptedClientSeq: 0 })
  core.setTransportOpen(false)
  core.localOperations([{ t: "add", node: shape("a", 0) }])
  core.undo()
  core.localOperations([{ t: "add", node: shape("b", 30) }])
  check("offline history: edit, undo, edit remains visible in order", shown.order.join(",") === "b" && core.inspect().pending.length === 3 && sent.length === 0)
  core.setTransportOpen(true)
  for (let rev = 5; rev <= 7; rev++) {
    const command = sent[rev - 5]
    core.handleServerOp({ type: "op", ops: command.ops!, rev, by: "offline-history", clientSeq: command.clientSeq! })
  }
  check("offline history: queued intents converge after reconnect", core.inspect().baseDoc.order.join(",") === "b" && core.inspect().pending.length === 0)
}

// A paused undo occupies the intent stream behind an in-flight undo and queued redo.
{
  const initial: Doc = { nodes: {}, order: [] }
  const sent: Array<{ type: string; ops?: Op[]; clientSeq?: number }> = []
  const core = new SquigSyncCore({ clientId: "paused-history", initialDoc: initial, send: (message) => sent.push(message), show: () => undefined })
  core.setTransportOpen(true)
  core.handleSnapshot({ type: "snapshot", doc: initial, rev: 0, acceptedClientSeq: 0 })
  for (const [index, id] of ["a", "b"].entries()) {
    core.localOperations([{ t: "add", node: shape(id, index * 30) }])
    const command = sent.at(-1)!
    core.handleServerOp({ type: "op", ops: command.ops!, rev: index + 1, by: "paused-history", clientSeq: command.clientSeq! })
  }
  core.undo()
  core.redo()
  core.handleSnapshot({ type: "snapshot", doc: { nodes: { a: shape("a", 0), b: shape("b", 30) }, order: ["a", "b"] }, rev: 2, acceptedClientSeq: 2, reason: "invalid" })
  core.undo()
  check("paused history: undo follows earlier undo and redo intent", core.inspect().pending.map((command) => command.ops[0].t).join(",") === "remove,add,remove" && core.inspect().visibleDoc.order.join(",") === "a")
  core.retry()
  const retriedUndo = sent.at(-1)!
  check("paused history: retry preserves the chronological net result", core.inspect().visibleDoc.order.join(",") === "a" && retriedUndo.clientSeq === 3)
  core.handleServerOp({ type: "op", ops: retriedUndo.ops!, rev: 3, by: "paused-history", clientSeq: retriedUndo.clientSeq! })
  check("paused history: FIFO retry converges", core.inspect().baseDoc.order.join(",") === "a")
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

// History retains only changed field values, even when the document contains multi-megabyte data.
{
  const large: Doc = {
    nodes: { blob: textNode("blob", "x".repeat(4_000_000)), edited: shape("edited", 0) },
    order: ["blob", "edited"],
  }
  const core = new SquigSyncCore({ clientId: "compact-history", initialDoc: large, send: () => undefined, show: () => undefined })
  core.handleSnapshot({ type: "snapshot", doc: large, rev: 0, acceptedClientSeq: 0 })
  for (let x = 1; x <= 100; x++) core.localOperations([{ t: "update", id: "edited", patch: { x } }])
  const inspected = core.inspect()
  check("compact history: repeated one-field edits retain one changed field each", inspected.historyDepth === 100 && inspected.historyChanges === 100)
  check("compact history: multi-megabyte untouched content is not duplicated into history", inspected.historyBytes < 50_000, `bytes=${inspected.historyBytes}`)
}

// Large reorder history obeys an aggregate byte budget and keeps retained undo correct.
{
  const order = Array.from({ length: 10_000 }, (_, index) => `r${index}`)
  const nodes = Object.fromEntries(order.map((id, index) => [id, { ...shape(id, index), seed: index + 1 }]))
  const largeOrderDoc: Doc = { nodes, order }
  const core = new SquigSyncCore({ clientId: "bounded-order-history", initialDoc: largeOrderDoc, send: () => undefined, show: () => undefined })
  core.handleSnapshot({ type: "snapshot", doc: largeOrderDoc, rev: 0, acceptedClientSeq: 0 })
  let beforeRetainedUndo = order
  for (let index = 0; index < 24; index++) {
    beforeRetainedUndo = [...core.inspect().visibleDoc.order]
    core.localOperations([{ t: "reorder", ids: ["r9999"], to: "backward" }])
  }
  const inspected = core.inspect()
  check("order history: repeated 10k-id reorders stay within the aggregate byte budget", inspected.historyBytes <= MAX_CONNECTED_HISTORY_BYTES && inspected.historyDepth > 0 && inspected.historyDepth < 24, `bytes=${inspected.historyBytes},depth=${inspected.historyDepth}`)
  core.undo()
  check("order history: newest retained reorder remains undoable", sameValue(core.inspect().visibleDoc.order, beforeRetainedUndo))
}

// Full-document validation stays correct at the advertised limit without quadratic membership scans.
{
  const order = Array.from({ length: MAX_DOCUMENT_NODES }, (_, index) => `large-${index}`)
  const nodes = Object.fromEntries(order.map((id, index) => [id, { ...shape(id, index), seed: index + 1 }]))
  check("document validation: accepts a valid 10k-node document", validDocument({ nodes, order }))
  check("document validation: rejects duplicate z-order ids", !validDocument({ nodes, order: [...order.slice(0, -1), order[0]] }))
  const overLimitId = "large-over-limit"
  check("document validation: rejects documents above the 10k-node limit", !validDocument({ nodes: { ...nodes, [overLimitId]: shape(overLimitId, 0) }, order: [...order, overLimitId] }))

  const cumulativeOrder = Array.from({ length: 53 }, (_, index) => `bytes-${index}`)
  const cumulativeNodes = Object.fromEntries(cumulativeOrder.map((id) => [id, textNode(id, "x".repeat(600_000))]))
  const cumulativeDoc = { nodes: cumulativeNodes, order: cumulativeOrder }
  check("document validation: cumulative serialized bytes exceed the conservative snapshot cap", serializedDocumentBytes(cumulativeDoc) > MAX_DOCUMENT_BYTES)
  check("document validation: rejects a cumulatively oversized snapshot document", !validDocument(cumulativeDoc))
}

// Authoritative persistence begins only after a valid snapshot and ends with the transport.
{
  const previousWorkerUrl = process.env.NEXT_PUBLIC_SQUIG_WORKER_URL
  const previousWebSocket = globalThis.WebSocket
  const previousFetch = globalThis.fetch
  process.env.NEXT_PUBLIC_SQUIG_WORKER_URL = "http://127.0.0.1:8787"
  globalThis.fetch = (async () => Response.json({ docs: [] })) as typeof fetch

  class FailingSocket {
    constructor() { throw new Error("worker unavailable") }
  }
  setConnectedPersistenceMode(false)
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FailingSocket
  const stopFailed = startSquigSync()
  check("persistence lease: failed startup retains the offline stale guard", !isConnectedPersistenceMode())
  stopFailed()

  class FakeSocket extends EventTarget {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    static instances: FakeSocket[] = []
    readyState = 0
    readonly url: string
    readonly sent: string[] = []
    constructor(url: string) {
      super()
      this.url = url
      FakeSocket.instances.push(this)
    }
    send(value: string) { this.sent.push(value) }
    open() {
      this.readyState = FakeSocket.OPEN
      this.dispatchEvent(new Event("open"))
    }
    message(value: unknown) {
      const event = new Event("message")
      Object.defineProperty(event, "data", { value: JSON.stringify(value) })
      this.dispatchEvent(event)
    }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return
      this.readyState = FakeSocket.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
  const stopConnected = startSquigSync()
  const socket = FakeSocket.instances.at(-1)!
  socket.open()
  check("persistence lease: an open socket without a snapshot stays offline-guarded", !isConnectedPersistenceMode())
  const snapshotDoc = { nodes: useSquig.getState().nodes, order: useSquig.getState().order }
  socket.message({ type: "snapshot", doc: snapshotDoc, rev: 0, acceptedClientSeq: 0 })
  check("persistence lease: a valid authoritative snapshot enables connected writes", isConnectedPersistenceMode())
  socket.close()
  check("persistence lease: transport close restores the offline stale guard", !isConnectedPersistenceMode())
  stopConnected()

  // A ready document keeps its offline pending intent when another file is
  // opened and routes it only through that document's next connection.
  FakeSocket.instances = []
  local.clear()
  setConnectedPersistenceMode(false)
  const offlineDocId = "offline-existing-revision"
  const remoteOfflineDoc: Doc = { nodes: { offline: shape("offline", 0) }, order: ["offline"] }
  useSquig.setState({ docId: offlineDocId, fileName: "Offline A", nodes: remoteOfflineDoc.nodes, order: remoteOfflineDoc.order, files: [], past: [], future: [], stale: false, hydrated: true })
  useSquig.getState().saveNow()
  const stopSwitching = startSquigSync()
  const firstA = FakeSocket.instances.at(-1)!
  firstA.open()
  firstA.message({ type: "snapshot", doc: remoteOfflineDoc, rev: 5, acceptedClientSeq: 0 })
  firstA.close()
  useSquig.getState().checkpoint()
  useSquig.getState().updateNode("offline", { x: 10 }, { checkpoint: false })
  useSquig.getState().commitCheckpoint()
  useSquig.getState().saveNow()
  useSquig.getState().newFile()
  const otherDocId = useSquig.getState().docId
  const socketB = FakeSocket.instances.at(-1)!
  socketB.open()
  useSquig.getState().openFile(offlineDocId)
  const secondA = FakeSocket.instances.at(-1)!
  secondA.open()
  secondA.message({ type: "snapshot", doc: remoteOfflineDoc, rev: 5, acceptedClientSeq: 0 })
  const resumed = secondA.sent.map((value) => JSON.parse(value) as { type: string; ops?: Op[]; clientId?: string; clientSeq?: number }).findLast((message) => message.type === "op")
  check("document sessions: offline edit survives a switch from a nonzero revision", !!resumed && (resumed.ops?.[0] as { patch?: { x?: number } })?.patch?.x === 10)
  check("document sessions: pending edit is never sent through the other document", !socketB.sent.some((value) => (JSON.parse(value) as { type?: string }).type === "op") && otherDocId !== offlineDocId)
  secondA.message({ type: "op", ops: resumed!.ops, rev: 6, by: resumed!.clientId, clientSeq: resumed!.clientSeq })
  check("document sessions: reopened document converges without losing the offline edit", useSquig.getState().docId === offlineDocId && useSquig.getState().nodes.offline.x === 10)
  stopSwitching()

  // Tear down the entire sync runtime, then construct a new one as a reloaded
  // page would. Only the separate intent journal bridges the two lifetimes.
  FakeSocket.instances = []
  local.clear()
  setConnectedPersistenceMode(false)
  const restartDocId = "offline-page-restart"
  const restartRemote: Doc = { nodes: { restart: shape("restart", 0) }, order: ["restart"] }
  useSquig.setState({ docId: restartDocId, fileName: "Restart A", nodes: restartRemote.nodes, order: restartRemote.order, files: [], past: [], future: [], stale: false, hydrated: true })
  useSquig.getState().saveNow()
  const beforeRestartPageId = createPageClientId()
  const stopBeforeRestart = startSquigSync({ clientId: beforeRestartPageId })
  const beforeRestart = FakeSocket.instances.at(-1)!
  beforeRestart.open()
  beforeRestart.message({ type: "snapshot", doc: restartRemote, rev: 5, acceptedClientSeq: 0 })
  beforeRestart.close()
  useSquig.getState().checkpoint()
  useSquig.getState().updateNode("restart", { x: 10 }, { checkpoint: false })
  useSquig.getState().commitCheckpoint()
  useSquig.getState().saveNow()
  check("page restart journal: offline intent is persisted outside the document", loadPendingIntents(restartDocId).length === 1)
  stopBeforeRestart()

  const socketCountBeforeNewStart = FakeSocket.instances.length
  const afterRestartPageId = createPageClientId()
  const stopAfterRestart = startSquigSync({ clientId: afterRestartPageId })
  const afterRestart = FakeSocket.instances.at(-1)!
  check("page restart journal: a new page identity opens a new transport", beforeRestartPageId !== afterRestartPageId && FakeSocket.instances.length === socketCountBeforeNewStart + 1)
  afterRestart.open()
  afterRestart.message({ type: "snapshot", doc: restartRemote, rev: 5, acceptedClientSeq: 0 })
  const replayed = afterRestart.sent.map((value) => JSON.parse(value) as { type: string; ops?: Op[]; clientId?: string; clientSeq?: number }).findLast((message) => message.type === "op")
  check("page restart journal: remote rev 5 snapshot replays cached x=10 intent", !!replayed && (replayed.ops?.[0] as { patch?: { x?: number } })?.patch?.x === 10 && useSquig.getState().nodes.restart.x === 10)
  afterRestart.message({ type: "op", ops: replayed!.ops, rev: 6, by: replayed!.clientId, clientSeq: replayed!.clientSeq })
  check("page restart journal: acknowledgement clears the persisted intent", loadPendingIntents(restartDocId).length === 0)
  stopAfterRestart()

  ;(globalThis as { WebSocket?: unknown }).WebSocket = previousWebSocket
  globalThis.fetch = previousFetch
  if (previousWorkerUrl === undefined) delete process.env.NEXT_PUBLIC_SQUIG_WORKER_URL
  else process.env.NEXT_PUBLIC_SQUIG_WORKER_URL = previousWorkerUrl
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

// Local origins remain convenient, while production trusts only a verified Access application JWT.
{
  const allowed = "https://squig.example.com"
  const issuer = `https://unit-${crypto.randomUUID()}.cloudflareaccess.com`
  const audience = "unit-application-audience"
  const nowMs = 1_800_000_000_000
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair
  const otherKeys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
  Object.assign(publicJwk, { alg: "RS256", kid: "access-key", use: "sig" })
  const fetchJwks = (async () => Response.json({ keys: [publicJwk] })) as typeof fetch
  const encodePart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const signToken = async (payload: Record<string, unknown>, privateKey = keys.privateKey) => {
    const header = encodePart({ alg: "RS256", kid: "access-key", typ: "JWT" })
    const body = encodePart(payload)
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${body}`))
    return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`
  }
  const env = { ENVIRONMENT: "production", APP_ORIGIN: allowed, ACCESS_TEAM_DOMAIN: issuer, ACCESS_APPLICATION_AUD: audience }
  const claims = { iss: issuer, aud: [audience], exp: Math.floor(nowMs / 1000) + 300, nbf: Math.floor(nowMs / 1000) - 1, email: "Person@Example.com" }
  const validToken = await signToken(claims)
  const accepted = await requestSecurity(new Request("https://worker/agents/squig-doc/x", {
    headers: { Origin: allowed, "Cf-Access-Jwt-Assertion": validToken, "Cf-Access-Authenticated-User-Email": "spoofed@example.com" },
  }), env, { fetch: fetchJwks, now: () => nowMs })
  check("security: verified JWT supplies the owner instead of the spoofable identity header", !(accepted instanceof Response) && accepted.owner === "person@example.com")

  const missing = await requestSecurity(new Request("https://worker/api/docs", { headers: { "Cf-Access-Authenticated-User-Email": "person@example.com" } }), env, { fetch: fetchJwks, now: () => nowMs })
  check("security: production fails closed when only the identity header is present", missing instanceof Response && missing.status === 401)
  const nullParts = await requestSecurity(new Request("https://worker/api/docs", { headers: { "Cf-Access-Jwt-Assertion": "bnVsbA.bnVsbA.eA" } }), env, { fetch: fetchJwks, now: () => nowMs })
  check("security: null JWT header and payload fail closed without throwing", nullParts instanceof Response && nullParts.status === 401)
  for (const [name, token] of [
    ["issuer", await signToken({ ...claims, iss: "https://other.cloudflareaccess.com" })],
    ["audience", await signToken({ ...claims, aud: ["other-audience"] })],
    ["expiry", await signToken({ ...claims, exp: Math.floor(nowMs / 1000) - 1 })],
    ["signature", await signToken(claims, otherKeys.privateKey)],
  ] as const) {
    const decision = await requestSecurity(new Request("https://worker/api/docs", { headers: { "Cf-Access-Jwt-Assertion": token } }), env, { fetch: fetchJwks, now: () => nowMs })
    check(`security: rejects invalid ${name}`, decision instanceof Response && decision.status === 401)
  }

  const preflight = await requestSecurity(new Request("https://worker/api/docs", { method: "OPTIONS", headers: { Origin: allowed } }), env)
  const foreignPreflight = await requestSecurity(new Request("https://worker/api/docs", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env)
  const originlessPreflight = await requestSecurity(new Request("https://worker/api/docs", { method: "OPTIONS" }), env)
  check("security: exact production origin may preflight without a JWT", !(preflight instanceof Response) && preflight.preflight)
  check("security: foreign and originless production preflights fail closed", foreignPreflight instanceof Response && foreignPreflight.status === 403 && originlessPreflight instanceof Response && originlessPreflight.status === 403)

  const localEnv = { ENVIRONMENT: "local", APP_ORIGIN: "http://localhost:3000" }
  const localHost = await requestSecurity(new Request("http://worker/api/docs", { headers: { Origin: "http://localhost:3000" } }), localEnv)
  const localIp = await requestSecurity(new Request("http://worker/api/docs", { headers: { Origin: "http://127.0.0.1:3000" } }), localEnv)
  const localForeign = await requestSecurity(new Request("http://worker/api/docs", { headers: { Origin: "http://127.0.0.1:3001" } }), localEnv)
  check("security: local mode accepts both exact loopback spellings", !(localHost instanceof Response) && !(localIp instanceof Response))
  check("security: local mode still rejects a different origin", localForeign instanceof Response && localForeign.status === 403)
}

if (failures.length) {
  console.error(`sync: ${failures.length} failed, ${passed} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`sync: ${passed} passed`)
}
