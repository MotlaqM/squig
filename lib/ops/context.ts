/** Stable rough-render seed derived from an identity already carried by an op. */
export function seedFromId(id = "node"): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
