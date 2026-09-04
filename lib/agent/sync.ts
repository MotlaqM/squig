"use client"

import type { SquigNode } from "../types"
import { applyOp } from "../ops/apply-op"
import { seedFromId } from "../ops/context"
import { invert } from "../ops/invert"
import type { Doc, Op, OpContext } from "../ops/types"
import { sameValue } from "../ops/value"
import { setConnectedHistoryController, syncRemoteFiles, useSquig } from "../store"

const CLIENT_ID_KEY = "squig:sync-client-id"
const LOCAL_WORKER_URL = "http://127.0.0.1:8787"

const CLIENT_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => {
    throw new Error("Synced operations must carry resolved ids")
  },
  seed: seedFromId,
}

export interface ClientOpCommand {
  type: "op"
  ops: Op[]
  clientRev: number
  clientId: string
  clientSeq: number
}

export interface SnapshotMessage {
  type: "snapshot"
  doc: Doc
  rev: number
  acceptedClientSeq: number
  reason?: "duplicate" | "invalid" | "sequence_gap" | "stale_revision" | "resync"
}

export interface ServerOpMessage {
  type: "op"
  ops: Op[]
  rev: number
  by: string
  clientSeq: number
}

interface PendingCommand {
  ops: Op[]
  clientSeq: number
}

interface HistoryEntry {
  forwardOps: Op[]
  inverseOps: Op[]
}

export interface SquigSyncCoreOptions {
  clientId: string
  initialDoc: Doc
  send(message: ClientOpCommand | { type: "resync"; clientId: string }): void
  show(doc: Doc): void
}

function cloneWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

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

/** Build a JSON-safe atomic command that turns one immutable document into another. */
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

function inverseBatch(forwardOps: readonly Op[], docBefore: Doc): Op[] {
  let current = docBefore
  const raw: Op[][] = []
  for (const op of forwardOps) {
    raw.push(invert(op, current))
    current = applyOp(current, op, CLIENT_CONTEXT).doc
  }
  const restored = applyOps(current, raw.reverse().flat())
  return diffDocs(current, restored)
}

function empty(doc: Doc): boolean {
  return doc.order.length === 0 && Object.keys(doc.nodes).length === 0
}

/** Revision/sequence coordinator; browser wiring is deliberately kept below it. */
export class SquigSyncCore {
  private readonly clientId: string
  private readonly send: SquigSyncCoreOptions["send"]
  private readonly show: SquigSyncCoreOptions["show"]
  private baseDoc: Doc = { nodes: {}, order: [] }
  private visibleDoc: Doc
  private serverRev = 0
  private acceptedClientSeq = 0
  private nextClientSeq = 1
  private pending: PendingCommand[] = []
  private inFlight: number | null = null
  private history: HistoryEntry[] = []
  private redoHistory: HistoryEntry[] = []
  private undoRequested = false
  private ready = false
  private transportOpen = false

  constructor(options: SquigSyncCoreOptions) {
    this.clientId = options.clientId
    this.visibleDoc = options.initialDoc
    this.send = options.send
    this.show = options.show
  }

  setTransportOpen(open: boolean) {
    this.transportOpen = open
    if (!open) this.inFlight = null
    else this.flush()
  }

  handleSnapshot(message: SnapshotMessage) {
    const first = !this.ready
    this.ready = true
    this.baseDoc = cloneWire(message.doc)
    this.serverRev = message.rev
    this.acceptedClientSeq = message.acceptedClientSeq
    this.pending = this.pending.filter((command) => command.clientSeq > message.acceptedClientSeq)
    if (message.reason === "invalid" && this.pending[0]?.clientSeq === message.acceptedClientSeq + 1) {
      this.pending.shift()
    }
    this.pending.forEach((command, index) => { command.clientSeq = message.acceptedClientSeq + index + 1 })
    this.nextClientSeq = message.acceptedClientSeq + this.pending.length + 1
    this.inFlight = null

    if (first && message.rev === 0 && empty(message.doc) && !empty(this.visibleDoc) && this.pending.length === 0) {
      const upload = diffDocs(message.doc, this.visibleDoc)
      if (upload.length) this.enqueue(upload)
    } else {
      this.rebuildVisible()
    }
    this.flush()
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
    }
    this.rebuildVisible()
    if (!this.pending.length && this.undoRequested) {
      this.undoRequested = false
      this.performUndo()
    }
    this.flush()
  }

  localDocumentChanged(next: Doc) {
    if (!this.ready) {
      this.visibleDoc = next
      return
    }
    const before = this.visibleDoc
    const forwardOps = diffDocs(before, next)
    this.visibleDoc = next
    if (!forwardOps.length) return
    this.history.push({ forwardOps, inverseOps: inverseBatch(forwardOps, before) })
    this.redoHistory = []
    this.enqueue(forwardOps)
  }

  /** Submit already-resolved semantic operations, useful to operation-producing callers and protocol tests. */
  localOperations(ops: Op[]) {
    if (!this.ready || !ops.length) return
    const before = this.visibleDoc
    const wire = cloneWire(ops)
    const next = applyOps(before, wire)
    if (sameValue(before, next)) return
    this.visibleDoc = next
    this.show(next)
    this.history.push({ forwardOps: wire, inverseOps: inverseBatch(wire, before) })
    this.redoHistory = []
    this.enqueue(wire)
  }

  undo(): boolean {
    if (!this.ready) return false
    if (this.pending.length || this.inFlight !== null) {
      this.undoRequested = true
      return true
    }
    this.performUndo()
    return true
  }

  redo(): boolean {
    if (!this.ready) return false
    if (this.pending.length || this.inFlight !== null) return true
    const entry = this.redoHistory.pop()
    if (!entry) return true
    this.history.push(entry)
    this.applyLocalCommand(entry.forwardOps)
    return true
  }

  inspect() {
    return {
      baseDoc: this.baseDoc,
      visibleDoc: this.visibleDoc,
      serverRev: this.serverRev,
      acceptedClientSeq: this.acceptedClientSeq,
      pending: this.pending.map((command) => ({ ...command })),
      inFlight: this.inFlight,
      historyDepth: this.history.length,
    }
  }

  private performUndo() {
    const entry = this.history.pop()
    if (!entry) return
    this.redoHistory.push(entry)
    this.applyLocalCommand(entry.inverseOps)
  }

  private applyLocalCommand(ops: Op[]) {
    if (!ops.length) return
    this.visibleDoc = applyOps(this.visibleDoc, ops)
    this.show(this.visibleDoc)
    this.enqueue(ops)
  }

  private enqueue(ops: Op[]) {
    if (!ops.length) return
    const wire = cloneWire(ops)
    this.pending.push({ ops: wire, clientSeq: this.nextClientSeq++ })
    this.flush()
  }

  private rebuildVisible() {
    const rebuilt = this.pending.reduce((doc, command) => applyOps(doc, command.ops), this.baseDoc)
    if (!sameValue(rebuilt, this.visibleDoc)) {
      this.visibleDoc = rebuilt
      this.show(rebuilt)
    }
  }

  private flush() {
    if (!this.ready || !this.transportOpen || this.inFlight !== null || !this.pending.length) return
    const command = this.pending[0]
    this.inFlight = command.clientSeq
    this.send({
      type: "op",
      ops: command.ops,
      clientRev: this.serverRev,
      clientId: this.clientId,
      clientSeq: command.clientSeq,
    })
  }
}

function perTabClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(CLIENT_ID_KEY, created)
  return created
}

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

interface RemoteDoc {
  id: string
  name: string
  updatedAt: number
}

/** Start browser sync when configured; without a Worker URL the existing drawer remains the offline implementation. */
export function startSquigSync(): () => void {
  const workerUrl = configuredWorkerUrl()
  if (!workerUrl) return () => undefined

  const clientId = perTabClientId()
  let disposed = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let suppressStore = false
  let activeDocId = useSquig.getState().docId
  let generation = 0

  const show = (doc: Doc) => {
    suppressStore = true
    const state = useSquig.getState()
    const selection = state.selection.filter((nodeId) => doc.nodes[nodeId])
    useSquig.setState({ nodes: doc.nodes, order: doc.order, selection, selectionGroupId: null })
    suppressStore = false
    useSquig.getState().saveNow()
  }

  const createCore = () => new SquigSyncCore({
      clientId,
      initialDoc: { nodes: useSquig.getState().nodes, order: useSquig.getState().order },
      send(message) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      },
      show,
    })
  let core = createCore()

  const updateIndex = async (action: "rename" | "save") => {
    const state = useSquig.getState()
    if (state.docId !== activeDocId) return
    try {
      await fetch(`${workerUrl}/api/docs/${encodeURIComponent(state.docId)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: state.fileName }),
      })
    } catch {
      // D1 is a projection. The Durable Object and local file remain authoritative.
    }
  }

  const refreshIndex = async () => {
    try {
      const response = await fetch(`${workerUrl}/api/docs`, { credentials: "include" })
      if (!response.ok) return
      const body = await response.json() as { docs?: RemoteDoc[] }
      if (Array.isArray(body.docs)) syncRemoteFiles(body.docs)
    } catch {
      // Offline fallback keeps the local drawer usable.
    }
  }

  const connect = (session = core, sessionGeneration = generation) => {
    if (disposed) return
    const opened = new WebSocket(wsUrl(workerUrl, activeDocId, clientId))
    socket = opened
    opened.addEventListener("open", () => {
      if (sessionGeneration === generation) session.setTransportOpen(true)
    })
    opened.addEventListener("message", (event) => {
      if (sessionGeneration !== generation) return
      if (typeof event.data !== "string") return
      let message: unknown
      try { message = JSON.parse(event.data) } catch { return }
      const type = (message as { type?: unknown })?.type
      if (typeof type === "string" && type.startsWith("cf_agent_")) {
        console.error("Squig sync rejected an unexpected Agents SDK protocol frame")
        opened.close(1002, "Unexpected framework protocol")
        return
      }
      if (type === "snapshot") {
        session.handleSnapshot(message as SnapshotMessage)
        setConnectedHistoryController({ undo: () => session.undo(), redo: () => session.redo() })
        useSquig.setState({ past: [], future: [] })
        void updateIndex("save")
        void refreshIndex()
      } else if (type === "op") {
        session.handleServerOp(message as ServerOpMessage)
        if ((message as ServerOpMessage).by === clientId) void updateIndex("save")
      }
    })
    opened.addEventListener("close", () => {
      session.setTransportOpen(false)
      if (socket === opened) socket = null
      if (!disposed && sessionGeneration === generation) {
        reconnectTimer = setTimeout(() => connect(session, sessionGeneration), 500)
      }
    })
  }

  const unsubscribe = useSquig.subscribe((state, previous) => {
    if (state.docId !== previous.docId) {
      generation++
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      const previousSocket = socket
      socket = null
      previousSocket?.close(1000, "Document changed")
      activeDocId = state.docId
      setConnectedHistoryController(null)
      core = createCore()
      connect(core, generation)
      return
    }
    if (!suppressStore && (state.nodes !== previous.nodes || state.order !== previous.order)) {
      core.localDocumentChanged({ nodes: state.nodes, order: state.order })
    }
    if (state.fileName !== previous.fileName) void updateIndex("rename")
    if (state.saveFlash !== previous.saveFlash) void updateIndex("save")
  })

  connect()
  return () => {
    disposed = true
    unsubscribe()
    setConnectedHistoryController(null)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    socket?.close(1000, "Page closed")
  }
}
