"use client"

import type { SquigNode } from "../types"
import { applyOp } from "../ops/apply-op"
import { seedFromId } from "../ops/context"
import type { Doc, Op, OpContext } from "../ops/types"
import { sameValue } from "../ops/value"
import { validDocument } from "./validate"
import {
  applyIntentTransition,
  captureIntentTransition,
  intentTransitionChanges,
  loadPendingIntents,
  savePendingIntents,
  type IntentTransition,
} from "./journal"
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
import { isServerChatFrame } from "./chat-protocol"
import { handleServerChatFrame, resetChatClient, setChatRevision, setChatTransport } from "./chat-client"

export type { ClientOpCommand, ServerOpMessage, SnapshotMessage } from "./protocol"

const LOCAL_WORKER_URL = "http://127.0.0.1:8787"
export const MAX_CONNECTED_HISTORY = 100
export const MAX_CONNECTED_HISTORY_BYTES = 2 * 1024 * 1024

const CLIENT_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => { throw new Error("Synced operations must carry resolved ids") },
  seed: seedFromId,
}

interface PendingCommand { ops: Op[]; clientSeq: number; blocked: boolean; intent: IntentTransition }
interface PreSnapshotIntent { transition: IntentTransition; ops?: Op[] }

export interface SyncError {
  code: "command_too_large" | "server_rejected"
  message: string
  retryable: true
}

export interface SquigSyncCoreOptions {
  clientId: string
  initialDoc: Doc
  initialPendingIntents?: IntentTransition[]
  send(message: ClientOpCommand | { type: "resync"; clientId: string }): void
  show(doc: Doc): void
  onError?(error: SyncError | null): void
  onPendingIntents?(intents: IntentTransition[]): void
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
  const positions = new Map(working.map((id, index) => [id, index]))
  const ops: Op[] = []
  for (let target = 0; target < wanted.length; target++) {
    const nodeId = wanted[target]
    let index = positions.get(nodeId) ?? -1
    while (index > target) {
      ops.push({ t: "reorder", ids: [nodeId], to: "backward" })
      const displaced = working[index - 1]
      ;[working[index - 1], working[index]] = [working[index], working[index - 1]]
      positions.set(nodeId, index - 1)
      positions.set(displaced, index)
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

function transitionBytes(entries: readonly IntentTransition[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength
}

function boundedHistory(entries: readonly IntentTransition[]): IntentTransition[] {
  const bounded = entries.slice(-MAX_CONNECTED_HISTORY)
  while (bounded.length && transitionBytes(bounded) > MAX_CONNECTED_HISTORY_BYTES) bounded.shift()
  return bounded
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
  private readonly onPendingIntents?: SquigSyncCoreOptions["onPendingIntents"]
  private baseDoc: Doc = { nodes: {}, order: [] }
  private visibleDoc: Doc
  private serverRev = 0
  private acceptedClientSeq = 0
  private nextClientSeq = 1
  private pending: PendingCommand[] = []
  private inFlight: number | null = null
  private history: IntentTransition[] = []
  private redoHistory: IntentTransition[] = []
  private preSnapshotIntents: PreSnapshotIntent[]
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
    this.onPendingIntents = options.onPendingIntents
    this.preSnapshotIntents = cloneWire(options.initialPendingIntents ?? []).map((transition) => ({ transition }))
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
      const localIntents = this.preSnapshotIntents
      this.preSnapshotIntents = []
      this.pending = []
      this.nextClientSeq = message.acceptedClientSeq + 1
      this.visibleDoc = cloneWire(message.doc)
      let rebasedDoc = cloneWire(message.doc)
      if (!localIntents.length && message.rev === 0 && empty(message.doc) && !empty(this.initialDoc)) {
        rebasedDoc = cloneWire(this.initialDoc)
      }
      const rebasedHistory: IntentTransition[] = []
      for (const intent of localIntents) {
        const before = rebasedDoc
        let next: Doc
        try {
          next = intent.ops
            ? applyOps(rebasedDoc, intent.ops)
            : applyIntentTransition(rebasedDoc, intent.transition)
        } catch {
          continue
        }
        if (!validDocument(next)) continue
        if (!sameValue(rebasedDoc, next)) {
          if (intent.ops) rebasedHistory.push(captureIntentTransition(before, next))
          rebasedDoc = next
        }
      }
      const rebasedOps = diffDocs(message.doc, rebasedDoc)
      if (rebasedOps.length) {
        this.enqueue(rebasedOps, message.doc)
      }
      this.history = boundedHistory(rebasedHistory)
      this.redoHistory = []
      this.rebuildVisible()
      this.present()
      this.persistPendingIntents()
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
    this.persistPendingIntents()
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
    this.persistPendingIntents()
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
    return this.performUndo()
  }

  redo(): boolean {
    return this.performRedo()
  }

  retry(): boolean {
    if (!this.ready || !this.error) return false
    const wanted = this.visibleDoc
    this.pending = []
    this.inFlight = null
    this.nextClientSeq = this.acceptedClientSeq + 1
    this.clearError()
    const retryOps = diffDocs(this.baseDoc, wanted)
    if (retryOps.length) this.enqueue(retryOps, this.baseDoc)
    this.rebuildVisible()
    this.persistPendingIntents()
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
      historyBytes: transitionBytes(this.history),
      historyChanges: this.history.reduce((total, entry) => total + intentTransitionChanges(entry), 0),
      ready: this.ready,
      error: this.error,
    }
  }

  private recordLocal(forwardOps: Op[], docBefore: Doc) {
    const next = applyOps(docBefore, forwardOps)
    const declarativeOps = diffDocs(docBefore, next)
    if (!declarativeOps.length) return this.present()
    const transition = captureIntentTransition(docBefore, next)
    this.visibleDoc = next
    this.show(cloneWire(next))
    this.history = boundedHistory([...this.history, transition])
    this.redoHistory = []
    if (!this.ready) {
      this.preSnapshotIntents.push({ transition, ops: declarativeOps })
      this.persistPendingIntents()
      return
    }
    this.enqueue(declarativeOps, docBefore)
  }

  private performUndo(): boolean {
    const entry = this.history.pop()
    if (!entry) return false
    const ops = diffDocs(this.visibleDoc, applyIntentTransition(this.visibleDoc, entry, "backward"))
    if (!ops.length) return true
    this.redoHistory = boundedHistory([...this.redoHistory, entry])
    this.applyLocalCommand(ops)
    return true
  }

  private performRedo(): boolean {
    const entry = this.redoHistory.pop()
    if (!entry) return false
    const ops = diffDocs(this.visibleDoc, applyIntentTransition(this.visibleDoc, entry, "forward"))
    if (!ops.length) return true
    this.history = boundedHistory([...this.history, entry])
    this.applyLocalCommand(ops)
    return true
  }

  private applyLocalCommand(ops: Op[]) {
    if (!ops.length) return
    const before = this.visibleDoc
    this.visibleDoc = applyOps(before, ops)
    const declarativeOps = diffDocs(before, this.visibleDoc)
    if (!declarativeOps.length) return
    const transition = captureIntentTransition(before, this.visibleDoc)
    this.show(cloneWire(this.visibleDoc))
    if (!this.ready) {
      this.preSnapshotIntents.push({ transition, ops: declarativeOps })
      this.persistPendingIntents()
    } else this.enqueue(declarativeOps, before)
  }

  private enqueue(ops: Op[], startDoc: Doc) {
    if (!ops.length) return
    let intermediate = cloneWire(startDoc)
    for (const chunk of chunkCommands(ops, this.clientId, this.nextClientSeq, this.serverRev)) {
      const next = applyOps(intermediate, chunk.ops)
      const intent = captureIntentTransition(intermediate, next)
      this.pending.push({ ops: chunk.ops, clientSeq: this.nextClientSeq++, blocked: chunk.blocked, intent })
      intermediate = next
      if (chunk.blocked) this.fail({ code: "command_too_large", message: "This edit is too large to sync in one safe command. It remains visible locally; reduce it and retry.", retryable: true })
    }
    this.persistPendingIntents()
    this.flush()
  }

  private persistPendingIntents() {
    const intents = this.ready
      ? this.pending.map((command) => command.intent)
      : this.preSnapshotIntents.map((intent) => intent.transition)
    this.onPendingIntents?.(cloneWire(intents))
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
export function startSquigSync(options: { clientId?: string } = {}): () => void {
  const workerUrl = configuredWorkerUrl()
  if (!workerUrl) return () => undefined

  const clientId = options.clientId ?? PAGE_CLIENT_ID
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
      initialPendingIntents: loadPendingIntents(docId),
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
      onPendingIntents(intents) {
        if (!savePendingIntents(docId, intents) && activeDocId === docId) {
          useSquig.getState().setNotice("Pending offline edits are too large for the recovery journal. Keep this tab open and reconnect before closing it.")
        }
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
    opened.addEventListener("open", () => {
      if (sessionGeneration !== generation) return
      session.setTransportOpen(true)
      setChatTransport((frame) => opened.send(JSON.stringify(frame)))
    })
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
        setChatRevision((message as SnapshotMessage).rev)
        setConnectedHistoryController({ undo: () => session.undo(), redo: () => session.redo() })
        useSquig.setState({ past: [], future: [] })
        void updateIndex("save")
        void refreshIndex()
      } else if (type === "op") {
        session.handleServerOp(message as ServerOpMessage)
        setChatRevision(session.inspect().serverRev)
        if ((message as ServerOpMessage).by === clientId || (message as ServerOpMessage).by.startsWith("agent:")) void updateIndex("save")
      } else if (isServerChatFrame(message)) {
        handleServerChatFrame(message)
      }
    })
    opened.addEventListener("error", () => {
      if (sessionGeneration === generation) setConnectedPersistenceMode(false)
    })
    opened.addEventListener("close", () => {
      session.setTransportOpen(false)
      if (socket === opened) {
        socket = null
        setChatTransport(null)
      }
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
      resetChatClient()
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
    resetChatClient()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    for (const session of cores.values()) session.setTransportOpen(false)
    socket?.close(1000, "Page closed")
  }
}
