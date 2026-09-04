export const MAX_MODEL_CONTEXT_BYTES = 256 * 1024

export interface ModelToolResultMessage {
  role: "tool"
  tool_call_id: string
  content: string
}

export function boundedToolResultMessage(
  messages: readonly unknown[],
  toolCallId: string,
  outcome: unknown
): ModelToolResultMessage {
  const message: ModelToolResultMessage = {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(outcome),
  }
  const bytes = new TextEncoder().encode(JSON.stringify([...messages, message])).byteLength
  if (bytes > MAX_MODEL_CONTEXT_BYTES) {
    throw new RangeError(`Model context exceeds the ${MAX_MODEL_CONTEXT_BYTES}-byte tool-result budget`)
  }
  return message
}
