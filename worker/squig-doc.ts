import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents"
import { nanoid } from "nanoid"
import { z } from "zod"
import { CHAT_MODELS, isReviewCapability, type ChatCompletedFrame, type ChatErrorFrame, type ChatResetFrame, type ReviewIdentityFrame, type ReviewPendingFrame } from "../lib/agent/chat-protocol"
import { boundedToolResultMessage } from "../lib/agent/model-context-budget"
import { boundClientHeads, MAX_COMMAND_BYTES, MAX_COMMAND_OPS, type ClientHead } from "../lib/agent/protocol"
import { compactInverseOps, createServerToolDraft, executeServerTool, SERVER_TOOL_DEFINITIONS, type ServerToolDraft } from "../lib/agent/server-tools"
import { assertAgentStateBudget } from "../lib/agent/state-budget"
import { validDocument } from "../lib/agent/validate"
import { seedFromId } from "../lib/ops/context"
import { applyOps } from "../lib/ops/invert"
import type { Doc, Op, OpContext } from "../lib/ops/types"
import { resolveModel, runSquigModel, SYSTEM_PROMPT, type ModelMessage, type SquigModel } from "./model"

const MAX_LEDGER_TURNS = 32
const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_CALLS = 64

interface AgentTurnRecord {
  turnId: string
  baseRev: number
  committedRev: number
  status: "committed" | "rejected" | "undone"
  completion: "completed" | "accepted" | "rejected" | "undone"
  model: SquigModel
  inverseOps: Op[]
  affected: string[]
}

interface PendingReview {
  turnId: string
  reviewOwnerId: string
  baseRev: number
  model: SquigModel
  ops: Op[]
  inverseOps: Op[]
  affected: string[]
  selection: string[]
  message: string
}

export interface SquigDocState extends Doc {
  rev: number
  clientHeads: Record<string, ClientHead>
  agentTurns: AgentTurnRecord[]
  pendingReview?: PendingReview
}

interface SquigConnectionState { clientId: string; reviewOwnerId: string | null; reviewReady: boolean }
type SnapshotReason = "duplicate" | "invalid" | "sequence_gap" | "stale_revision" | "resync"

const id = z.string().min(1).max(128)
const ids = z.array(id).max(10_000)
const patch = z.record(z.string(), z.unknown())
const finite = z.number().finite()
const opSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("add"), node: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ t: z.literal("update"), id, patch }).strict(),
  z.object({ t: z.literal("updateMany"), patches: z.record(z.string(), patch) }).strict(),
  z.object({ t: z.literal("remove"), ids }).strict(),
  z.object({ t: z.literal("reorder"), ids, to: z.enum(["front", "back", "forward", "backward"]) }).strict(),
  z.object({ t: z.literal("group"), ids, groupId: id }).strict(),
  z.object({ t: z.literal("ungroup"), ids }).strict(),
  z.object({ t: z.literal("align"), ids, edge: z.enum(["left", "hcenter", "right", "top", "vcenter", "bottom"]) }).strict(),
  z.object({ t: z.literal("distribute"), ids, axis: z.enum(["h", "v"]) }).strict(),
  z.object({ t: z.literal("flip"), ids, axis: z.enum(["x", "y"]) }).strict(),
  z.object({ t: z.literal("lock"), ids, locked: z.boolean() }).strict(),
  z.object({ t: z.literal("duplicate"), ids, offset: z.tuple([finite, finite]), idMap: z.record(z.string(), id) }).strict(),
  z.object({ t: z.literal("placeRelative"), id, anchor: id, side: z.enum(["below", "above", "left", "right"]), gap: finite.optional(), align: z.enum(["start", "center", "end"]).optional() }).strict(),
  z.object({ t: z.literal("stack"), ids, axis: z.enum(["h", "v"]), gap: finite.optional() }).strict(),
  z.object({ t: z.literal("matchSize"), ids, to: id, dims: z.enum(["w", "h", "both"]) }).strict(),
])
const commandSchema = z.object({
  type: z.literal("op"), ops: z.array(opSchema).min(1).max(MAX_COMMAND_OPS), clientRev: z.number().int().nonnegative(),
  clientId: id, clientSeq: z.number().int().positive(),
}).strict()
const resyncSchema = z.object({ type: z.literal("resync"), clientId: id }).strict()
const viewportSchema = z.object({ x: finite, y: finite, zoom: finite.positive() }).strict()
const chatStartSchema = z.object({
  type: z.literal("chat.start"), turnId: id, clientRev: z.number().int().nonnegative(), prompt: z.string().trim().min(1).max(8_000),
  review: z.boolean(), model: z.enum(CHAT_MODELS).optional(), selection: ids.optional(), viewport: viewportSchema.optional(),
  viewportWidth: finite.positive().max(20_000).optional(), viewportHeight: finite.positive().max(20_000).optional(),
}).strict()
const reviewSchema = z.object({ type: z.enum(["review.accept", "review.reject"]), turnId: id, clientRev: z.number().int().nonnegative() }).strict()
const undoSchema = z.object({ type: z.literal("agent.undo"), turnId: id, clientRev: z.number().int().nonnegative() }).strict()
const reviewResumeSchema = z.object({ type: z.literal("review.resume"), reviewOwnerId: z.string().uuid().optional() }).strict()

const REDUCER_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => { throw new Error("All operation identities must be resolved before commit") },
  seed: seedFromId,
}

function emptyState(): SquigDocState {
  return { nodes: {}, order: [], rev: 0, clientHeads: {}, agentTurns: [] }
}

function validBaseState(value: unknown): value is Omit<SquigDocState, "agentTurns"> & { agentTurns?: AgentTurnRecord[] } {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SquigDocState>
  if (!state.nodes || !Array.isArray(state.order) || !Number.isInteger(state.rev) || (state.rev ?? -1) < 0) return false
  if (!state.clientHeads || typeof state.clientHeads !== "object" || Array.isArray(state.clientHeads)) return false
  if (!validDocument({ nodes: state.nodes, order: state.order })) return false
  return Object.values(state.clientHeads).every((head) => !!head && Number.isInteger(head.seq) && head.seq >= 0 && Number.isInteger(head.rev) && head.rev >= 0 && head.rev <= state.rev!)
}

function queryClientId(request: Request): string | null {
  const candidate = new URL(request.url).searchParams.get("clientId")
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : null
}

function sameCapability(provided: string, expected: string): boolean {
  const encoder = new TextEncoder()
  const providedBytes = encoder.encode(provided)
  const expectedBytes = encoder.encode(expected)
  if (providedBytes.byteLength !== expectedBytes.byteLength) return false
  // Workers extends SubtleCrypto with a synchronous constant-time comparison.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }
  return subtle.timingSafeEqual(providedBytes.buffer, expectedBytes.buffer)
}

function boundedTurns(turns: AgentTurnRecord[]): AgentTurnRecord[] {
  return turns.slice(-MAX_LEDGER_TURNS)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

function finalRequesterSelection(draft: ServerToolDraft): string[] {
  const wanted = new Set([...draft.affected, ...draft.selection])
  return draft.doc.order.filter((nodeId) => wanted.has(nodeId))
}

class ToolExecutionError extends Error {}

export class SquigDoc extends Agent<Env, SquigDocState> {
  initialState = emptyState()
  static options = { sendIdentityOnConnect: false }
  private readonly activeTurns = new Set<string>()

  onStart() {
    if (!validBaseState(this.state)) {
      this.setState(emptyState())
      return
    }
    const turns = Array.isArray(this.state.agentTurns) ? this.state.agentTurns : []
    const pending = this.state.pendingReview as (PendingReview & { reviewOwnerId?: unknown }) | undefined
    const pendingReview = pending && isReviewCapability(pending.reviewOwnerId) ? pending : undefined
    if (turns !== this.state.agentTurns || pendingReview !== pending) {
      this.setState({ ...this.state, agentTurns: turns, pendingReview })
    }
  }

  shouldSendProtocolMessages() { return false }

  onConnect(connection: Connection, context: ConnectionContext) {
    const clientId = queryClientId(context.request)
    if (!clientId) {
      connection.close(1008, "A valid clientId is required")
      return
    }
    connection.setState({ clientId, reviewOwnerId: null, reviewReady: false } satisfies SquigConnectionState)
    this.sendSnapshot(connection, clientId)
  }

  async onMessage(connection: Connection, message: WSMessage) {
    const clientId = this.connectionClientId(connection)
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_COMMAND_BYTES) {
      this.sendSnapshot(connection, clientId, "invalid")
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(message) } catch {
      this.sendSnapshot(connection, clientId, "invalid")
      return
    }

    const resume = reviewResumeSchema.safeParse(parsed)
    if (resume.success) {
      this.handleReviewResume(connection, resume.data.reviewOwnerId)
      return
    }
    if (!this.connectionReviewReady(connection)) {
      connection.close(1008, "Review handshake required")
      return
    }

    const resync = resyncSchema.safeParse(parsed)
    if (resync.success) {
      this.sendSnapshot(connection, clientId, resync.data.clientId === clientId ? "resync" : "invalid")
      return
    }
    const command = commandSchema.safeParse(parsed)
    if (command.success) {
      this.handleClientOps(connection, clientId, command.data)
      return
    }
    const start = chatStartSchema.safeParse(parsed)
    if (start.success) {
      await this.handleChatStart(connection, start.data)
      return
    }
    const review = reviewSchema.safeParse(parsed)
    if (review.success) {
      if (review.data.type === "review.accept") this.handleReviewAccept(connection, review.data.turnId, review.data.clientRev)
      else this.handleReviewReject(connection, review.data.turnId, review.data.clientRev)
      return
    }
    const undo = undoSchema.safeParse(parsed)
    if (undo.success) {
      this.handleAgentUndo(connection, undo.data.turnId, undo.data.clientRev)
      return
    }
    this.sendError(connection, "invalid", "Invalid Squig command", typeof parsed === "object" && parsed ? String((parsed as { turnId?: unknown }).turnId ?? "invalid") : "invalid")
  }

  private handleClientOps(connection: Connection, clientId: string, command: z.infer<typeof commandSchema>) {
    if (command.clientId !== clientId) { this.sendSnapshot(connection, clientId, "invalid"); return }
    const state = this.state
    const prior = state.clientHeads[clientId] ?? { seq: 0, rev: 0 }
    if (command.clientSeq <= prior.seq) { this.sendSnapshot(connection, clientId, "duplicate"); return }
    if (command.clientSeq !== prior.seq + 1) { this.sendSnapshot(connection, clientId, "sequence_gap"); return }
    if (command.clientRev !== state.rev) { this.sendSnapshot(connection, clientId, "stale_revision"); return }
    let doc: Doc = { nodes: state.nodes, order: state.order }
    try { doc = applyOps(doc, command.ops as Op[], REDUCER_CONTEXT) } catch { this.sendSnapshot(connection, clientId, "invalid"); return }
    if (!validDocument(doc)) { this.sendSnapshot(connection, clientId, "invalid"); return }
    const rev = state.rev + 1
    const invalidated = state.pendingReview ? {
      turnId: state.pendingReview.turnId,
      baseRev: state.pendingReview.baseRev,
      committedRev: rev,
      status: "rejected" as const,
      completion: "rejected" as const,
      model: state.pendingReview.model,
      inverseOps: [],
      affected: state.pendingReview.affected,
    } : null
    const next: SquigDocState = {
      ...state, nodes: doc.nodes, order: doc.order, rev,
      clientHeads: boundClientHeads({ ...state.clientHeads, [clientId]: { seq: command.clientSeq, rev } }),
      ...(invalidated ? { pendingReview: undefined, agentTurns: boundedTurns([...state.agentTurns, invalidated]) } : {}),
    }
    if (!this.persistState(next)) { this.sendSnapshot(connection, clientId, "invalid"); return }
    this.broadcast(JSON.stringify({ type: "op", ops: command.ops, rev, by: clientId, clientSeq: command.clientSeq }))
    if (invalidated && state.pendingReview) this.rotateInvalidatedReviewOwner(state.pendingReview.reviewOwnerId, this.completedFrame(invalidated))
  }

  private handleReviewResume(connection: Connection, presented?: string) {
    if (this.connectionReviewReady(connection)) return
    const pending = this.state.pendingReview
    const resumesPending = !!presented && !!pending && sameCapability(presented, pending.reviewOwnerId)
    const reviewOwnerId = resumesPending && pending ? pending.reviewOwnerId : crypto.randomUUID()
    connection.setState({ clientId: this.connectionClientId(connection), reviewOwnerId, reviewReady: true } satisfies SquigConnectionState)
    connection.send(JSON.stringify({ type: "review.identity", reviewOwnerId } satisfies ReviewIdentityFrame))
    connection.send(JSON.stringify({ type: "chat.reset", rev: this.state.rev } satisfies ChatResetFrame))
    if (resumesPending && pending) connection.send(JSON.stringify(this.pendingFrame(pending)))
  }

  private async handleChatStart(connection: Connection, command: z.infer<typeof chatStartSchema>) {
    const reviewOwnerId = this.connectionReviewOwnerId(connection)
    const existing = this.state.agentTurns.find((turn) => turn.turnId === command.turnId)
    if (existing) { this.sendCompleted(connection, existing); return }
    if (this.state.pendingReview?.turnId === command.turnId) {
      if (this.state.pendingReview.reviewOwnerId !== reviewOwnerId) { this.sendError(connection, "not_found", "Pending review not found", command.turnId); return }
      connection.send(JSON.stringify(this.pendingFrame(this.state.pendingReview)))
      return
    }
    if (this.state.pendingReview) { this.sendError(connection, "turn_in_progress", "Finish the pending review first", command.turnId); return }
    if (this.activeTurns.size) { this.sendError(connection, "turn_in_progress", "Another agent turn is already running", command.turnId); return }
    if (command.clientRev !== this.state.rev) { this.sendError(connection, "stale_revision", "The canvas changed; retry from the current revision", command.turnId); return }

    const baseRev = this.state.rev
    const baseDoc: Doc = { nodes: this.state.nodes, order: this.state.order }
    const model = resolveModel(command.model)
    let draft = createServerToolDraft(baseDoc, command.selection ?? [])
    const messages: ModelMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: command.prompt }]
    let answer = ""
    let toolCalls = 0
    this.activeTurns.add(command.turnId)
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply = await runSquigModel(this.env, model, messages, SERVER_TOOL_DEFINITIONS, command.turnId)
        if (reply.content) {
          answer += reply.content
          connection.send(JSON.stringify({ type: "chat.delta", turnId: command.turnId, delta: reply.content }))
        }
        messages.push({ role: "assistant", content: reply.content || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) })
        if (!reply.toolCalls.length) break
        toolCalls += reply.toolCalls.length
        if (toolCalls > MAX_TOOL_CALLS) throw new ToolExecutionError("The model requested too many tools")
        for (const call of reply.toolCalls) {
          let args: unknown
          try { args = JSON.parse(call.function.arguments) } catch { throw new ToolExecutionError(`Invalid arguments for ${call.function.name}`) }
          try {
            const executed = executeServerTool(draft, call.function.name, args, {
              allocateId: (doc) => { let next = nanoid(8); while (doc.nodes[next]) next = nanoid(8); return next },
              environment: { viewport: command.viewport, viewportWidth: command.viewportWidth, viewportHeight: command.viewportHeight },
            })
            const toolMessage = boundedToolResultMessage(messages, call.id, executed.outcome)
            draft = executed.draft
            connection.send(JSON.stringify({ type: "chat.tool", turnId: command.turnId, name: call.function.name, summary: executed.outcome.summary, affected: executed.outcome.affected }))
            messages.push(toolMessage)
          } catch (error) {
            throw new ToolExecutionError(`${call.function.name}: ${errorMessage(error)}`)
          }
        }
        if (round === MAX_TOOL_ROUNDS - 1) throw new ToolExecutionError("The model did not finish within the tool limit")
      }
      if (this.state.rev !== baseRev) { this.sendError(connection, "stale_revision", "The canvas changed while the turn was running; nothing was committed", command.turnId); return }
      const message = answer || (draft.ops.length ? "Prepared the requested canvas changes." : "No canvas changes were needed.")
      const selection = finalRequesterSelection(draft)
      if (command.review && draft.ops.length) {
        const pending: PendingReview = {
          turnId: command.turnId, reviewOwnerId, baseRev, model, ops: draft.ops, inverseOps: compactInverseOps(draft.inverseOps),
          affected: draft.affected, selection, message,
        }
        if (!this.persistState({ ...this.state, pendingReview: pending })) {
          this.sendError(connection, "tool_error", "The prepared review is too large to persist safely", command.turnId)
          return
        }
        connection.send(JSON.stringify(this.pendingFrame(pending)))
        connection.send(JSON.stringify({ type: "chat.completed", turnId: command.turnId, rev: baseRev, status: "pending", model, affected: pending.affected } satisfies ChatCompletedFrame))
        return
      }
      this.commitAgentTurn(connection, {
        turnId: command.turnId, baseRev, committedRev: baseRev + (draft.ops.length ? 1 : 0), status: "committed",
        completion: "completed", model, inverseOps: compactInverseOps(draft.inverseOps), affected: draft.affected,
      }, draft.doc, draft.ops, selection)
    } catch (error) {
      this.sendError(connection, error instanceof ToolExecutionError ? "tool_error" : "model_error", errorMessage(error), command.turnId)
    } finally {
      this.activeTurns.delete(command.turnId)
    }
  }

  private handleReviewAccept(connection: Connection, turnId: string, clientRev: number) {
    const existing = this.state.agentTurns.find((turn) => turn.turnId === turnId)
    if (existing) { this.sendCompleted(connection, existing); return }
    const pending = this.state.pendingReview
    if (!pending || pending.turnId !== turnId) { this.sendError(connection, "not_found", "Pending review not found", turnId); return }
    if (pending.reviewOwnerId !== this.connectionReviewOwnerId(connection)) { this.sendError(connection, "not_found", "Pending review not found", turnId); return }
    if (clientRev !== this.state.rev) { this.sendError(connection, "stale_revision", "The canvas revision is stale", turnId); return }
    if (pending.baseRev !== this.state.rev) { this.sendError(connection, "stale_review", "The canvas changed after this review was prepared", turnId); return }
    let doc: Doc
    try { doc = applyOps({ nodes: this.state.nodes, order: this.state.order }, pending.ops, REDUCER_CONTEXT) } catch {
      this.sendError(connection, "tool_error", "Pending review operations are invalid", turnId)
      return
    }
    if (!validDocument(doc)) { this.sendError(connection, "tool_error", "Pending review produced an invalid document", turnId); return }
    this.commitAgentTurn(connection, {
      turnId, baseRev: pending.baseRev, committedRev: this.state.rev + 1, status: "committed", completion: "accepted",
      model: pending.model, inverseOps: pending.inverseOps, affected: pending.affected,
    }, doc, pending.ops, pending.selection, true)
  }

  private handleReviewReject(connection: Connection, turnId: string, clientRev: number) {
    const existing = this.state.agentTurns.find((turn) => turn.turnId === turnId)
    if (existing) { this.sendCompleted(connection, existing); return }
    const pending = this.state.pendingReview
    if (!pending || pending.turnId !== turnId) { this.sendError(connection, "not_found", "Pending review not found", turnId); return }
    if (pending.reviewOwnerId !== this.connectionReviewOwnerId(connection)) { this.sendError(connection, "not_found", "Pending review not found", turnId); return }
    if (clientRev !== this.state.rev) { this.sendError(connection, "stale_revision", "The canvas revision is stale", turnId); return }
    const record: AgentTurnRecord = {
      turnId, baseRev: pending.baseRev, committedRev: this.state.rev, status: "rejected", completion: "rejected",
      model: pending.model, inverseOps: [], affected: pending.affected,
    }
    if (!this.persistState({ ...this.state, pendingReview: undefined, agentTurns: boundedTurns([...this.state.agentTurns, record]) })) {
      this.sendError(connection, "tool_error", "The rejected review could not be persisted safely", turnId)
      return
    }
    this.broadcast(JSON.stringify(this.completedFrame(record)))
  }

  private handleAgentUndo(connection: Connection, turnId: string, clientRev: number) {
    if (clientRev !== this.state.rev) { this.sendError(connection, "stale_revision", "The canvas revision is stale", turnId); return }
    const index = this.state.agentTurns.findIndex((turn) => turn.turnId === turnId)
    const turn = this.state.agentTurns[index]
    if (!turn || turn.status === "rejected") { this.sendError(connection, "not_found", "Committed agent turn not found", turnId); return }
    if (turn.status === "undone") { this.sendCompleted(connection, turn); return }
    if (this.state.rev !== turn.committedRev || !turn.inverseOps.length) { this.sendError(connection, "undo_conflict", "The canvas changed after this agent turn", turnId); return }
    let doc: Doc
    try { doc = applyOps({ nodes: this.state.nodes, order: this.state.order }, turn.inverseOps, REDUCER_CONTEXT) } catch {
      this.sendError(connection, "tool_error", "Agent undo operations are invalid", turnId)
      return
    }
    if (!validDocument(doc)) { this.sendError(connection, "tool_error", "Agent undo produced an invalid document", turnId); return }
    const rev = this.state.rev + 1
    const undone: AgentTurnRecord = { ...turn, status: "undone", completion: "undone", committedRev: rev, inverseOps: [] }
    const turns = [...this.state.agentTurns]
    turns[index] = undone
    if (!this.persistState({ ...this.state, nodes: doc.nodes, order: doc.order, rev, agentTurns: turns })) {
      this.sendError(connection, "tool_error", "Agent undo is too large to persist safely", turnId)
      return
    }
    this.broadcast(JSON.stringify({ type: "op", ops: turn.inverseOps, rev, by: `agent:${turnId}`, clientSeq: 0 }))
    connection.send(JSON.stringify({ type: "selection.set", turnId, rev, ids: [] }))
    this.broadcast(JSON.stringify(this.completedFrame(undone)))
  }

  private commitAgentTurn(connection: Connection, record: AgentTurnRecord, doc: Doc, ops: Op[], selection: string[], accepted = false) {
    const state = this.state
    const rev = record.committedRev
    if (!validDocument(doc)) { this.sendError(connection, "tool_error", "Agent turn produced an invalid document", record.turnId); return }
    const next: SquigDocState = {
      ...state, nodes: doc.nodes, order: doc.order, rev, pendingReview: undefined,
      agentTurns: boundedTurns([...state.agentTurns, record]),
    }
    if (!this.persistState(next)) { this.sendError(connection, "tool_error", "Agent turn is too large to persist safely", record.turnId); return }
    if (ops.length) this.broadcast(JSON.stringify({ type: "op", ops, rev, by: `agent:${record.turnId}`, clientSeq: 0 }))
    connection.send(JSON.stringify({ type: "selection.set", turnId: record.turnId, rev, ids: selection }))
    const completed = this.completedFrame(record)
    if (accepted) this.broadcast(JSON.stringify(completed))
    else connection.send(JSON.stringify(completed))
  }

  private completedFrame(turn: AgentTurnRecord): ChatCompletedFrame {
    return { type: "chat.completed", turnId: turn.turnId, rev: turn.committedRev, status: turn.completion, model: turn.model, affected: turn.affected }
  }

  private sendCompleted(connection: Connection, turn: AgentTurnRecord) { connection.send(JSON.stringify(this.completedFrame(turn))) }

  private pendingFrame(pending: PendingReview): ReviewPendingFrame {
    return { type: "review.pending", turnId: pending.turnId, baseRev: pending.baseRev, ops: pending.ops, affected: pending.affected, message: pending.message, model: pending.model }
  }

  private sendError(connection: Connection, code: ChatErrorFrame["code"], message: string, turnId: string) {
    connection.send(JSON.stringify({ type: "chat.error", turnId, rev: this.state.rev, code, message } satisfies ChatErrorFrame))
  }

  private persistState(next: SquigDocState): boolean {
    try { assertAgentStateBudget(next) } catch { return false }
    this.setState(next)
    return true
  }

  private connectionClientId(connection: Connection): string {
    return (connection.state as SquigConnectionState | null)?.clientId ?? "invalid-client"
  }

  private connectionReviewOwnerId(connection: Connection): string {
    return (connection.state as SquigConnectionState | null)?.reviewOwnerId ?? "invalid-review-owner"
  }

  private connectionReviewReady(connection: Connection): boolean {
    return (connection.state as SquigConnectionState | null)?.reviewReady === true
  }

  private rotateInvalidatedReviewOwner(reviewOwnerId: string, frame: ChatCompletedFrame) {
    for (const connection of this.getConnections<SquigConnectionState>()) {
      if (!connection.state?.reviewReady || connection.state.reviewOwnerId !== reviewOwnerId) continue
      const nextReviewOwnerId = crypto.randomUUID()
      connection.setState({ ...connection.state, reviewOwnerId: nextReviewOwnerId })
      connection.send(JSON.stringify({ type: "review.identity", reviewOwnerId: nextReviewOwnerId } satisfies ReviewIdentityFrame))
      connection.send(JSON.stringify(frame))
    }
  }

  private sendSnapshot(connection: Connection, clientId: string, reason?: SnapshotReason) {
    const state = this.state
    connection.send(JSON.stringify({
      type: "snapshot", doc: { nodes: state.nodes, order: state.order }, rev: state.rev,
      acceptedClientSeq: state.clientHeads[clientId]?.seq ?? 0, ...(reason ? { reason } : {}),
    }))
  }
}
