import { validNode } from "../clipboard-payload"
import type { Doc } from "../ops/types"
import { sameValue } from "../ops/value"

export const MAX_DOCUMENT_NODES = 10_000
// Leave 2 MiB of headroom for the snapshot envelope below Workers' 32 MiB
// WebSocket message ceiling.
export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024

export function serializedDocumentBytes(value: Doc): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** Validate a complete wire document in one pass over nodes and z-order. */
export function validDocument(value: unknown): value is Doc {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<Doc>
  if (!candidate.nodes || typeof candidate.nodes !== "object" || Array.isArray(candidate.nodes) || !Array.isArray(candidate.order)) return false

  const keys = Object.keys(candidate.nodes)
  if (keys.length > MAX_DOCUMENT_NODES || candidate.order.length !== keys.length) return false

  try {
    if (serializedDocumentBytes(candidate as Doc) > MAX_DOCUMENT_BYTES) return false
  } catch {
    return false
  }

  const ordered = new Set<string>()
  for (const nodeId of candidate.order) {
    if (typeof nodeId !== "string" || ordered.has(nodeId) || !Object.hasOwn(candidate.nodes, nodeId)) return false
    ordered.add(nodeId)
  }

  for (const nodeId of keys) {
    if (!ordered.has(nodeId)) return false
    const raw = candidate.nodes[nodeId]
    const clean = validNode(structuredClone(raw))
    if (clean === null || clean.id !== nodeId || !sameValue(clean, raw)) return false
  }
  return true
}
