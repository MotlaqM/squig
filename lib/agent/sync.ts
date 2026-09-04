"use client"

import type { SquigNode } from "../types"
import { applyOp } from "../ops/apply-op"
import { seedFromId } from "../ops/context"
import type { Doc, Op, OpContext } from "../ops/types"
import { sameValue } from "../ops/value"
import { validDocument } from "./validate"
import {
  applyAuthoritativeDocument,
  isAuthoritativeDocumentUpdate,
  isDocumentEditActive,
  setConnectedHistoryController,
  setConnectedPersistenceMode,
  subscribeDocumentEdits,
  syncRemoteFiles,
  useSquig,
} from "../store"
import {
  COMMAND_SIZE_RESERVE_BYTES,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_OPS,
  wireBytes,
  type ClientOpCommand,
  type ServerOpMessage,
  type SnapshotMessage,
} from "./protocol"

export type { ClientOpCommand, ServerOpMessage, SnapshotMessage } from "./protocol"

const LOCAL_WORKER_URL = "http://127.0.0.1:8787"
export const MAX_CONNECTED_HISTORY = 100
export const MAX_QUEUED_HISTORY_ACTIONS = 100

const CLIENT_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => { throw new Error("Synced operations must carry resolved ids") },
  seed: seedFromId,
}

interface PendingCommand { ops: Op[]; clientSeq: number; blocked: boolean }
interface HistoryEntry { before: Doc; after: Doc }
type HistoryAction = "undo" | "redo"

export interface SyncError {
  code: "command_too_large" | "server_rejected"
  message: string
  retryable: true
}

export interface SquigSyncCoreOptions {
  clientId: string
  initialDoc: Doc
  send(message: ClientOpCommand | { type: "resync"; clientId: string }): void
  show(doc: Doc): void
  onError?(error: SyncError | null): void
}

function cloneWire<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function applyOps(doc: Doc, ops: readonly Op[]): Doc {
  return ops.reduce((current, op) => applyOp(current, op, CLIENT_CONTEXT).doc, doc)
}

function hasDeletedKeys(before: SquigNode, after: SquigNode): boolean {
  const target = after as unknown as Record<string, unknown>
  return Object.keys(before).some((key) => (before as unknown as Record<string, unknown>)[key] !== undefined && target[key] === undefined)
}

function patchTo(before: SquigNode, after: SquigNode): Partial<SquigNode> {
  const left = before as unknown as Record<string, unknown>
  const right = after as unknown as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(right)
      .filter((key) => right[key] !== undefined && !sameValue(left[key], right[key]))
      .map((key) => [key, right[key]])
  ) as Partial<SquigNode>
}

function restoreOrder(current: readonly string[], wanted: readonly string[]): Op[] {
  const working = [...current]
  const ops: Op[] = []
  for (let target = 0; target < wanted.length; target++) {
    const nodeId = wanted[target]
    let index = working.indexOf(nodeId)
    while (index > target) {
      ops.push({ t: "reorder", ids: [nodeId], to: "backward" })
      ;[working[index - 1], working[index]] = [working[index], working[index - 1]]
      index--
    }
  }
  return ops
}

/** Build JSON-safe operations that turn one immutable document into another. */
export function diffDocs(before: Doc, after: Doc): Op[] {
  if (sameValue(before, after)) return []
  const ops: Op[] = []
  let working = before
  const apply = (next: Op[]) => {
    const wire = cloneWire(next)
    ops.push(...wire)
    working = applyOps(working, wire)
  }
  const removed = working.order.filter((nodeId) => !after.nodes[nodeId])
  if (removed.length) apply([{ t: "remove", ids: removed }])
  const added = after.order.filter((nodeId) => !working.nodes[nodeId])
  if (added.length) {
    const ordered = [...added].sort((left, right) => Number(after.nodes[left].type === "arrow") - Number(after.nodes[right].type === "arrow"))
    apply(ordered.map((nodeId) => ({ t: "add", node: after.nodes[nodeId] })))
  }
  for (let pass = 0; pass < 3; pass++) {
    const mismatched = after.order.filter((nodeId) => working.nodes[nodeId] && !sameValue(working.nodes[nodeId], after.nodes[nodeId]))
    if (!mismatched.length) break
    const replace = mismatched.filter((nodeId) => hasDeletedKeys(working.nodes[nodeId], after.nodes[nodeId]))
    if (replace.length) {
      apply([{ t: "remove", ids: replace }])
      const ordered = [...replace].sort((left, right) => Number(after.nodes[left].type === "arrow") - Number(after.nodes[right].type === "arrow"))
      apply(ordered.map((nodeId) => ({ t: "add", node: after.nodes[nodeId] })))
    }
    const patches = Object.fromEntries(
      mismatched
        .filter((nodeId) => !replace.includes(nodeId) && working.nodes[nodeId])
        .map((nodeId) => [nodeId, patchTo(working.nodes[nodeId], after.nodes[nodeId])])
        .filter(([, value]) => Object.keys(value).length)
    )
    if (Object.keys(patches).length) apply([{ t: "updateMany", patches }])
  }
  apply(restoreOrder(working.order, after.order))
  if (!sameValue(working, after)) throw new Error("Document change could not be represented as Squig operations")
  return ops
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Revert only document fields that still equal the result of the original edit. */
export function conditionalTransitionOps(current: Doc, expected: Doc, wanted: Doc): Op[] {
  const nodes: Record<string, SquigNode> = { ...current.nodes }
  const nodeIds = new Set([...Object.keys(expected.nodes), ...Object.keys(wanted.nodes)])

  for (const nodeId of nodeIds) {
    const currentNode = current.nodes[nodeId]
    const expectedNode = expected.nodes[nodeId]
    const wantedNode = wanted.nodes[nodeId]
    if (expectedNode && !wantedNode) {
      if (currentNode && sameValue(currentNode, expectedNode)) delete nodes[nodeId]
      continue
    }
    if (!expectedNode && wantedNode) {
      if (!currentNode) nodes[nodeId] = cloneWire(wantedNode)
      continue
    }
    if (!currentNode || !expectedNode || !wantedNode) continue

    const next = { ...currentNode } as unknown as Record<string, unknown>
    const currentRecord = currentNode as unknown as Record<string, unknown>
    const expectedRecord = expectedNode as unknown as Record<string, unknown>
    const wantedRecord = wantedNode as unknown as Record<string, unknown>
    const fields = new Set([...Object.keys(expectedRecord), ...Object.keys(wantedRecord)])
    for (const field of fields) {
      const currentHas = hasOwn(currentRecord, field)
      const expectedHas = hasOwn(expectedRecord, field)
      if (currentHas !== expectedHas || (currentHas && !sameValue(currentRecord[field], expectedRecord[field]))) continue
      if (hasOwn(wantedRecord, field)) next[field] = cloneWire(wantedRecord[field])
      else delete next[field]
    }
    nodes[nodeId] = next as unknown as SquigNode
  }

  const completeOrder = (sameValue(current.order, expected.order) ? wanted.order : current.order)
    .filter((nodeId) => !!nodes[nodeId])
  const ordered = new Set(completeOrder)
  for (const source of [current.order, wanted.order, Object.keys(nodes)]) {
    for (const nodeId of source) {
      if (nodes[nodeId] && !ordered.has(nodeId)) {
        completeOrder.push(nodeId)
        ordered.add(nodeId)
      }
    }
  }
  return diffDocs(current, { nodes, order: completeOrder })
}

function empty(doc: Doc): boolean { return doc.order.length === 0 && Object.keys(doc.nodes).length === 0 }

export function isSnapshotMessage(value: unknown): value is SnapshotMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<SnapshotMessage>
  return message.type === "snapshot" &&
    Number.isInteger(message.rev) && (message.rev ?? -1) >= 0 &&
    Number.isInteger(message.acceptedClientSeq) && (message.acceptedClientSeq ?? -1) >= 0 &&
    validDocument(message.doc)
}

/** Split reducer batches without changing the meaning of individual operations. */
export function transportOps(ops: readonly Op[]): Op[] {
  return cloneWire(ops).flatMap((op): Op[] => {
    if (op.t === "updateMany") {
      return Object.entries(op.patches).map(([id, patch]) => ({ t: "update", id, patch }))
    }
    if (op.t === "remove" && op.ids.length > MAX_COMMAND_OPS) {
      const split: Op[] = []
      for (let index = 0; index < op.ids.length; index += MAX_COMMAND_OPS) {
        split.push({ ...op, ids: op.ids.slice(index, index + MAX_COMMAND_OPS) })
      }
      return split
    }
    return [op]
  })
}

export interface CommandChunk { ops: Op[]; blocked: boolean }

/** Greedily pack operations using the actual protocol envelope and UTF-8 size. */
export function chunkCommands(ops: readonly Op[], clientId: string, firstClientSeq: number, clientRev: number): CommandChunk[] {
  const limit = MAX_COMMAND_BYTES - COMMAND_SIZE_RESERVE_BYTES
  const chunks: CommandChunk[] = []
  let current: Op[] = []
  const fits = (candidate: Op[], sequence: number) =>
    candidate.length <= MAX_COMMAND_OPS &&
    wireBytes({ type: "op", ops: candidate, clientRev, clientId, clientSeq: sequence } satisfies ClientOpCommand) <= limit

  for (const op of transportOps(ops)) {
    const sequence = firstClientSeq + chunks.length
    if (fits([...current, op], sequence)) {
      current.push(op)
      continue
    }
    if (current.length) {
      chunks.push({ ops: current, blocked: false })
      current = []
    }
    const nextSequence = firstClientSeq + chunks.length
    if (fits([op], nextSequence)) current = [op]
    else chunks.push({ ops: [op], blocked: true })
  }
  if (current.length) chunks.push({ ops: current, blocked: false })
  return chunks
}

/** Revision/sequence coordinator; browser wiring is deliberately kept below it. */
export class SquigSyncCore {
  private readonly clientId: string
  private readonly initialDoc: Doc
  private readonly send: SquigSyncCoreOptions["send"]
  private readonly show: SquigSyncCoreOptions["show"]
  private readonly onError?: SquigSyncCoreOptions["onError"]
  private baseDoc: Doc = { nodes: {}, order: [] }
  private visibleDoc: Doc
  private serverRev = 0
  private acceptedClientSeq = 0
  private nextClientSeq = 1
  private pending: PendingCommand[] = []
  private inFlight: number | null = null
  private history: HistoryEntry[] = []
  private redoHistory: HistoryEntry[] = []
  private preSnapshotGroups: Op[][] = []
  private historyRequests: HistoryAction[] = []
  private ready = false
  private transportOpen = false
  private paused = false
  private error: SyncError | null = null

  constructor(options: SquigSyncCoreOptions) {
    this.clientId = options.clientId
    this.initialDoc = cloneWire(options.initialDoc)
    this.visibleDoc = cloneWire(options.initialDoc)
    this.send = options.send
    this.show = options.show
    this.onError = options.onError
  }

  setTransportOpen(open: boolean) {
    this.transportOpen = open
    if (!open) this.inFlight = null
    else this.flush()
  }

  handleSnapshot(message: SnapshotMessage): boolean {
    if (!isSnapshotMessage(message)) return false
    const first = !this.ready
    this.ready = true
    this.baseDoc = cloneWire(message.doc)
    this.serverRev = message.rev
    this.acceptedClientSeq = message.acceptedClientSeq
    this.inFlight = null
    if (first) {
      const localGroups = this.preSnapshotGroups
      this.preSnapshotGroups = []
      this.pending = []
      this.nextClientSeq = message.acceptedClientSeq + 1
      this.visibleDoc = cloneWire(message.doc)
      let rebasedDoc = cloneWire(message.doc)
      if (message.rev === 0 && empty(message.doc) && !empty(this.initialDoc)) {
        const bootstrap = diffDocs(message.doc, this.initialDoc)
        this.enqueue(bootstrap)
        rebasedDoc = applyOps(rebasedDoc, bootstrap)
      }
      const rebasedHistory: HistoryEntry[] = []
      for (const ops of localGroups) {
        const next = applyOps(rebasedDoc, ops)
        if (!sameValue(rebasedDoc, next)) {
          rebasedHistory.push({ before: rebasedDoc, after: next })
          this.enqueue(ops)
          rebasedDoc = next
        }
      }
      this.history = rebasedHistory.slice(-MAX_CONNECTED_HISTORY)
      this.redoHistory = []
      this.rebuildVisible()
      this.present()
      this.drainHistoryRequests()
      this.flush()
      return true
    }

    this.pending = this.pending.filter((command) => command.clientSeq > message.acceptedClientSeq)
    this.pending.forEach((command, index) => { command.clientSeq = message.acceptedClientSeq + index + 1 })
    this.nextClientSeq = message.acceptedClientSeq + this.pending.length + 1
    if (message.reason === "invalid") {
      this.fail({ code: "server_rejected", message: "The server rejected this edit. Your local document is preserved; retry will rebuild it against the latest snapshot.", retryable: true })
    } else this.clearError()
    this.rebuildVisible()
    this.drainHistoryRequests()
    this.flush()
    return true
  }

  handleServerOp(message: ServerOpMessage) {
    if (!this.ready || message.rev <= this.serverRev) return
    if (message.rev !== this.serverRev + 1) {
      this.send({ type: "resync", clientId: this.clientId })
      return
    }
    this.baseDoc = applyOps(this.baseDoc, message.ops)
    this.serverRev = message.rev
    if (message.by === this.clientId) {
      const head = this.pending[0]
      if (!head || head.clientSeq !== message.clientSeq) {
        this.send({ type: "resync", clientId: this.clientId })
        return
      }
      this.pending.shift()
      this.acceptedClientSeq = message.clientSeq
      this.inFlight = null
      this.clearError()
    }
    this.rebuildVisible()
    this.drainHistoryRequests()
    this.flush()
  }

  localDocumentChanged(next: Doc) {
    const before = this.visibleDoc
    const forwardOps = diffDocs(before, next)
    if (!forwardOps.length) return this.present()
    this.recordLocal(forwardOps, before)
  }

  /** Rebase one real store gesture over remote operations accepted during that gesture. */
  localDocumentGesture(docBefore: Doc, docAfter: Doc) {
    const forwardOps = diffDocs(docBefore, docAfter)
    if (!forwardOps.length) return this.present()
    this.recordLocal(forwardOps, this.visibleDoc)
  }

  localOperations(ops: Op[]) {
    if (!ops.length) return
    const wire = cloneWire(ops)
    const before = this.visibleDoc
    if (sameValue(before, applyOps(before, wire))) return
    this.recordLocal(wire, before)
  }

  undo(): boolean {
    if (!this.ready || this.paused) return this.queueHistory("undo")
    return this.performUndo()
  }

  redo(): boolean {
    if (!this.ready || this.paused) return this.queueHistory("redo")
    return this.performRedo()
  }

  retry(): boolean {
    if (!this.ready || !this.error) return false
    const wanted = this.visibleDoc
    this.pending = []
    this.inFlight = null
    this.nextClientSeq = this.acceptedClientSeq + 1
    this.clearError()
    this.enqueue(diffDocs(this.baseDoc, wanted))
    this.rebuildVisible()
    this.drainHistoryRequests()
    this.flush()
    return !this.paused
  }

  present() { this.show(cloneWire(this.visibleDoc)) }

  inspect() {
    return {
      baseDoc: this.baseDoc,
      visibleDoc: this.visibleDoc,
      serverRev: this.serverRev,
      acceptedClientSeq: this.acceptedClientSeq,
      pending: this.pending.map((command) => ({ ...command })),
      inFlight: this.inFlight,
      historyDepth: this.history.length,
      redoDepth: this.redoHistory.length,
      queuedHistoryActions: [...this.historyRequests],
      ready: this.ready,
      error: this.error,
    }
  }

  private recordLocal(forwardOps: Op[], docBefore: Doc) {
    const next = applyOps(docBefore, forwardOps)
    this.visibleDoc = next
    this.show(cloneWire(next))
    this.history.push({ before: cloneWire(docBefore), after: cloneWire(next) })
    this.history = this.history.slice(-MAX_CONNECTED_HISTORY)
    this.redoHistory = []
    if (!this.ready) {
      this.preSnapshotGroups.push(forwardOps)
      return
    }
    this.enqueue(forwardOps)
  }

  private queueHistory(action: HistoryAction): boolean {
    if (this.historyRequests.length < MAX_QUEUED_HISTORY_ACTIONS) this.historyRequests.push(action)
    return true
  }

  private drainHistoryRequests() {
    while (this.ready && !this.paused && !this.pending.length && this.inFlight === null && this.historyRequests.length) {
      const action = this.historyRequests.shift()!
      if (action === "undo") this.performUndo()
      else this.performRedo()
    }
  }

  private performUndo(): boolean {
    const entry = this.history.pop()
    if (!entry) return false
    const ops = conditionalTransitionOps(this.visibleDoc, entry.after, entry.before)
    if (!ops.length) return true
    this.redoHistory.push(entry)
    this.redoHistory = this.redoHistory.slice(-MAX_CONNECTED_HISTORY)
    this.applyLocalCommand(ops)
    return true
  }

  private performRedo(): boolean {
    const entry = this.redoHistory.pop()
    if (!entry) return false
    const ops = conditionalTransitionOps(this.visibleDoc, entry.before, entry.after)
    if (!ops.length) return true
    this.history.push(entry)
    this.history = this.history.slice(-MAX_CONNECTED_HISTORY)
    this.applyLocalCommand(ops)
    return true
  }

  private applyLocalCommand(ops: Op[]) {
    if (!ops.length) return
    this.visibleDoc = applyOps(this.visibleDoc, ops)
    this.show(cloneWire(this.visibleDoc))
    if (!this.ready) this.preSnapshotGroups.push(ops)
    else this.enqueue(ops)
  }

  private enqueue(ops: Op[]) {
    if (!ops.length) return
    for (const chunk of chunkCommands(ops, this.clientId, this.nextClientSeq, this.serverRev)) {
      this.pending.push({ ops: chunk.ops, clientSeq: this.nextClientSeq++, blocked: chunk.blocked })
      if (chunk.blocked) this.fail({ code: "command_too_large", message: "This edit is too large to sync in one safe command. It remains visible locally; reduce it and retry.", retryable: true })
    }
    this.flush()
  }

  private rebuildVisible() {
    const rebuilt = this.pending.reduce((doc, command) => applyOps(doc, command.ops), this.baseDoc)
    if (!sameValue(rebuilt, this.visibleDoc)) {
      this.visibleDoc = rebuilt
      this.show(cloneWire(rebuilt))
    }
  }

  private fail(error: SyncError) {
    this.error = error
    this.paused = true
    this.onError?.(error)
  }

  private clearError() {
    if (!this.error && !this.paused) return
    this.error = null
    this.paused = false
    this.onError?.(null)
  }

  private flush() {
    if (!this.ready || !this.transportOpen || this.inFlight !== null || !this.pending.length || this.paused) return
    const command = this.pending[0]
    if (command.blocked) return
    this.inFlight = command.clientSeq
    this.send({ type: "op", ops: command.ops, clientRev: this.serverRev, clientId: this.clientId, clientSeq: command.clientSeq })
  }
}

/** A new JavaScript page realm gets a new id; reconnects reuse the captured value. */
export function createPageClientId(): string { return crypto.randomUUID() }
const PAGE_CLIENT_ID = createPageClientId()

function configuredWorkerUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SQUIG_WORKER_URL?.trim()
  if (configured) return configured.replace(/\/$/, "")
  return ["localhost", "127.0.0.1"].includes(window.location.hostname) ? LOCAL_WORKER_URL : null
}

function wsUrl(workerUrl: string, docId: string, clientId: string): string {
  const url = new URL(`/agents/squig-doc/${encodeURIComponent(docId)}`, workerUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("clientId", clientId)
  return url.toString()
}

interface RemoteDoc { id: string; name: string; updatedAt: number }

/** Start browser sync when configured; without a Worker URL the drawer remains offline-first. */
export function startSquigSync(): () => void {
  const workerUrl = configuredWorkerUrl()
  if (!workerUrl) return () => undefined

  const clientId = PAGE_CLIENT_ID
  let disposed = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let activeDocId = useSquig.getState().docId
  let generation = 0

  const cores = new Map<string, SquigSyncCore>()
  const coreFor = (docId: string) => {
    const existing = cores.get(docId)
    if (existing) return existing
    const state = useSquig.getState()
    const created = new SquigSyncCore({
      clientId,
      initialDoc: { nodes: state.nodes, order: state.order },
      send(message) {
        if (activeDocId === docId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      },
      show(doc) {
        if (activeDocId !== docId || isDocumentEditActive()) return
        applyAuthoritativeDocument(doc)
      },
      onError(error) {
        if (activeDocId === docId && error) useSquig.getState().setNotice(`${error.message} Reconnect or save again to retry.`)
      },
    })
    cores.set(docId, created)
    return created
  }
  let core = coreFor(activeDocId)

  const updateIndex = async (action: "rename" | "save") => {
    const state = useSquig.getState()
    if (state.docId !== activeDocId) return
    try {
      await fetch(`${workerUrl}/api/docs/${encodeURIComponent(state.docId)}`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: state.fileName }),
      })
    } catch { /* D1 is a projection; Durable Object and local state stay authoritative. */ }
  }
  const refreshIndex = async () => {
    try {
      const response = await fetch(`${workerUrl}/api/docs`, { credentials: "include" })
      if (!response.ok) return
      const body = await response.json() as { docs?: RemoteDoc[] }
      if (Array.isArray(body.docs)) syncRemoteFiles(body.docs)
    } catch { /* Offline fallback keeps the local drawer usable. */ }
  }

  const scheduleReconnect = (session: SquigSyncCore, sessionGeneration: number) => {
    if (!disposed && sessionGeneration === generation) {
      reconnectTimer = setTimeout(() => connect(session, sessionGeneration), 500)
    }
  }
  const connect = (session = core, sessionGeneration = generation) => {
    if (disposed) return
    let opened: WebSocket
    try {
      opened = new WebSocket(wsUrl(workerUrl, activeDocId, clientId))
    } catch {
      setConnectedPersistenceMode(false)
      scheduleReconnect(session, sessionGeneration)
      return
    }
    socket = opened
    opened.addEventListener("open", () => { if (sessionGeneration === generation) session.setTransportOpen(true) })
    opened.addEventListener("message", (event) => {
      if (sessionGeneration !== generation || typeof event.data !== "string") return
      let message: unknown
      try { message = JSON.parse(event.data) } catch { return }
      const type = (message as { type?: unknown })?.type
      if (typeof type === "string" && type.startsWith("cf_agent_")) {
        console.error("Squig sync rejected an unexpected Agents SDK protocol frame")
        opened.close(1002, "Unexpected framework protocol")
        return
      }
      if (type === "snapshot") {
        if (!session.handleSnapshot(message as SnapshotMessage)) {
          if (sessionGeneration === generation) setConnectedPersistenceMode(false)
          opened.close(1002, "Invalid snapshot")
          return
        }
        setConnectedPersistenceMode(true)
        setConnectedHistoryController({ undo: () => session.undo(), redo: () => session.redo() })
        useSquig.setState({ past: [], future: [] })
        void updateIndex("save")
        void refreshIndex()
      } else if (type === "op") {
        session.handleServerOp(message as ServerOpMessage)
        if ((message as ServerOpMessage).by === clientId) void updateIndex("save")
      }
    })
    opened.addEventListener("error", () => {
      if (sessionGeneration === generation) setConnectedPersistenceMode(false)
    })
    opened.addEventListener("close", () => {
      session.setTransportOpen(false)
      if (socket === opened) socket = null
      if (sessionGeneration === generation) setConnectedPersistenceMode(false)
      scheduleReconnect(session, sessionGeneration)
    })
  }

  const unsubscribeEdits = subscribeDocumentEdits((event) => {
    if (event.docId !== activeDocId) return
    if (event.type === "commit") core.localDocumentGesture(event.before, event.after)
    else core.present()
  })
  const unsubscribe = useSquig.subscribe((state, previous) => {
    if (state.docId !== previous.docId) {
      core.setTransportOpen(false)
      generation++
      setConnectedPersistenceMode(false)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      const previousSocket = socket
      socket = null
      previousSocket?.close(1000, "Document changed")
      activeDocId = state.docId
      setConnectedHistoryController(null)
      core = coreFor(activeDocId)
      connect(core, generation)
      return
    }
    if (!isAuthoritativeDocumentUpdate() && !isDocumentEditActive() && (state.nodes !== previous.nodes || state.order !== previous.order)) {
      core.localDocumentChanged({ nodes: state.nodes, order: state.order })
    }
    if (state.fileName !== previous.fileName) void updateIndex("rename")
    if (state.saveFlash !== previous.saveFlash) {
      core.retry()
      void updateIndex("save")
    }
  })

  connect()
  return () => {
    disposed = true
    unsubscribe()
    unsubscribeEdits()
    setConnectedHistoryController(null)
    setConnectedPersistenceMode(false)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    for (const session of cores.values()) session.setTransportOpen(false)
    socket?.close(1000, "Page closed")
  }
}
