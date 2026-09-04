// Agent state is stored as one SQLite value. Keep headroom below Cloudflare's
// 2 MB key/value and row limit for the framework's own envelope.
export const MAX_AGENT_STATE_BYTES = 1_750_000

export function serializedAgentStateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function assertAgentStateBudget(value: unknown): void {
  const bytes = serializedAgentStateBytes(value)
  if (bytes > MAX_AGENT_STATE_BYTES) {
    throw new RangeError(`Agent state exceeds the ${MAX_AGENT_STATE_BYTES}-byte persistence budget`)
  }
}
