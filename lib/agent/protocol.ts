import type { Doc, Op } from "../ops/types"

/** Keep application messages well below the platform's 32 MiB WebSocket cap. */
export const MAX_COMMAND_BYTES = 1_000_000
export const COMMAND_SIZE_RESERVE_BYTES = 4_096
export const MAX_COMMAND_OPS = 100
export const MAX_CLIENT_HEADS = 256

export interface ClientHead { seq: number; rev: number }

/** Retain the most recently accepted clients by authoritative revision. */
export function boundClientHeads(heads: Record<string, ClientHead>): Record<string, ClientHead> {
  return Object.fromEntries(
    Object.entries(heads)
      .sort((left, right) => right[1].rev - left[1].rev || right[1].seq - left[1].seq || left[0].localeCompare(right[0]))
      .slice(0, MAX_CLIENT_HEADS)
  )
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

export function wireBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
