import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents"
import { z } from "zod"
import { validDocument } from "../lib/agent/validate"
import { applyOp } from "../lib/ops/apply-op"
import { seedFromId } from "../lib/ops/context"
import type { Doc, Op, OpContext } from "../lib/ops/types"
import { boundClientHeads, MAX_COMMAND_BYTES, MAX_COMMAND_OPS, type ClientHead } from "../lib/agent/protocol"

export interface SquigDocState extends Doc {
  rev: number
  clientHeads: Record<string, ClientHead>
}

interface SquigConnectionState {
  clientId: string
}

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
  type: z.literal("op"),
  ops: z.array(opSchema).min(1).max(MAX_COMMAND_OPS),
  clientRev: z.number().int().nonnegative(),
  clientId: id,
  clientSeq: z.number().int().positive(),
}).strict()

const resyncSchema = z.object({ type: z.literal("resync"), clientId: id }).strict()

const REDUCER_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => {
    throw new Error("All operation identities must be resolved by the client")
  },
  seed: seedFromId,
}

function emptyState(): SquigDocState {
  return { nodes: {}, order: [], rev: 0, clientHeads: {} }
}

function validState(value: unknown): value is SquigDocState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SquigDocState>
  if (!state.nodes || !Array.isArray(state.order) || !Number.isInteger(state.rev) || (state.rev ?? -1) < 0) return false
  if (!state.clientHeads || typeof state.clientHeads !== "object" || Array.isArray(state.clientHeads)) return false
  if (!validDocument({ nodes: state.nodes, order: state.order })) return false
  return Object.values(state.clientHeads).every(
    (head) => !!head && Number.isInteger(head.seq) && head.seq >= 0 && Number.isInteger(head.rev) && head.rev >= 0 && head.rev <= state.rev!
  )
}

function clientIdFrom(request: Request): string | null {
  const candidate = new URL(request.url).searchParams.get("clientId")
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : null
}

export class SquigDoc extends Agent<Env, SquigDocState> {
  initialState = emptyState()

  static options = { sendIdentityOnConnect: false }

  onStart() {
    if (!validState(this.state)) this.setState(emptyState())
  }

  shouldSendProtocolMessages() {
    return false
  }

  onConnect(connection: Connection, context: ConnectionContext) {
    const clientId = clientIdFrom(context.request)
    if (!clientId) {
      connection.close(1008, "A valid clientId is required")
      return
    }
    connection.setState({ clientId } satisfies SquigConnectionState)
    this.sendSnapshot(connection, clientId)
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_COMMAND_BYTES) {
      this.sendSnapshot(connection, this.connectionClientId(connection), "invalid")
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      this.sendSnapshot(connection, this.connectionClientId(connection), "invalid")
      return
    }

    const resync = resyncSchema.safeParse(parsed)
    if (resync.success) {
      const clientId = this.connectionClientId(connection)
      this.sendSnapshot(connection, clientId, resync.data.clientId === clientId ? "resync" : "invalid")
      return
    }

    const command = commandSchema.safeParse(parsed)
    const connectionClientId = this.connectionClientId(connection)
    if (!command.success || command.data.clientId !== connectionClientId) {
      this.sendSnapshot(connection, connectionClientId, "invalid")
      return
    }

    const state = this.state
    const prior = state.clientHeads[connectionClientId] ?? { seq: 0, rev: 0 }
    if (command.data.clientSeq <= prior.seq) {
      this.sendSnapshot(connection, connectionClientId, "duplicate")
      return
    }
    if (command.data.clientSeq !== prior.seq + 1) {
      this.sendSnapshot(connection, connectionClientId, "sequence_gap")
      return
    }
    if (command.data.clientRev !== state.rev) {
      this.sendSnapshot(connection, connectionClientId, "stale_revision")
      return
    }

    let doc: Doc = { nodes: state.nodes, order: state.order }
    try {
      for (const op of command.data.ops) doc = applyOp(doc, op as Op, REDUCER_CONTEXT).doc
    } catch {
      this.sendSnapshot(connection, connectionClientId, "invalid")
      return
    }
    if (!validDocument(doc)) {
      this.sendSnapshot(connection, connectionClientId, "invalid")
      return
    }

    const rev = state.rev + 1
    this.setState({
      nodes: doc.nodes,
      order: doc.order,
      rev,
      clientHeads: boundClientHeads({
        ...state.clientHeads,
        [connectionClientId]: { seq: command.data.clientSeq, rev },
      }),
    })
    this.broadcast(JSON.stringify({
      type: "op",
      ops: command.data.ops,
      rev,
      by: connectionClientId,
      clientSeq: command.data.clientSeq,
    }))
  }

  private connectionClientId(connection: Connection): string {
    const state = connection.state as SquigConnectionState | null
    return state?.clientId ?? "invalid-client"
  }

  private sendSnapshot(connection: Connection, clientId: string, reason?: SnapshotReason) {
    const state = this.state
    connection.send(JSON.stringify({
      type: "snapshot",
      doc: { nodes: state.nodes, order: state.order },
      rev: state.rev,
      acceptedClientSeq: state.clientHeads[clientId]?.seq ?? 0,
      ...(reason ? { reason } : {}),
    }))
  }
}
