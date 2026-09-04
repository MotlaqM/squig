/** Structural equality for the shallow immutable document model. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameValue(value, b[index]))
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => sameValue(left[key], right[key]))
}
