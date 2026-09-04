import type { ChatModelChoice } from "../lib/agent/chat-protocol"
import type { ServerToolDefinition } from "../lib/agent/server-tools"

export const MODEL_DEFAULT = "@cf/zai-org/glm-5.3-flash" as const
export const MODEL_KIMI = "@cf/moonshotai/kimi-k2.6" as const
export const MODEL_STRONG = "anthropic/claude-sonnet-5" as const
export type SquigModel = typeof MODEL_DEFAULT | typeof MODEL_KIMI | typeof MODEL_STRONG

export const SYSTEM_PROMPT = `You edit a Squig napkin-style wireframing canvas through deterministic tools. Coordinates are canvas pixels from the top-left and y grows downward. Read the document before changing existing work. Call list_components before inserting an unfamiliar kind. Prefer batch for multi-step edits so one user request stays one atomic turn. Use exact tool arguments; never put natural-language instructions inside a tool. Keep layouts simple, spaced, and low fidelity. When finished, briefly say what changed.`

export interface FunctionToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ModelReply { content: string; toolCalls: FunctionToolCall[] }
type UnknownRecord = Record<string, unknown>
export interface ModelEnv {
  AI: Ai
  AI_GATEWAY_ID: string
  SQUIG_FAKE_MODEL: string
  ENVIRONMENT: string
}

export function resolveModel(choice: ChatModelChoice | undefined): SquigModel {
  if (choice === "kimi") return MODEL_KIMI
  if (choice === "strong") return MODEL_STRONG
  return MODEL_DEFAULT
}

function lastUserText(messages: readonly ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? ""
}

function fakeReply(messages: readonly ModelMessage[]): ModelReply {
  const prompt = lastUserText(messages).trim().toLowerCase()
  const toolResults = messages.filter((message) => message.role === "tool").length
  if (prompt === "build a landing page with nav, hero, three feature cards, pricing, footer") {
    if (toolResults === 0) {
      return { content: "", toolCalls: [{ id: "fake-catalogue", type: "function", function: { name: "list_components", arguments: JSON.stringify({ category: "blocks" }) } }] }
    }
    if (toolResults === 1) {
      const specs = [
        ["navbar", 0, 80], ["hero", 140, 80], ["card", 520, 80], ["card", 520, 360],
        ["card", 520, 640], ["pricing-block", 860, 80], ["footer", 1300, 80],
      ] as const
      return {
        content: "",
        toolCalls: [{
          id: "fake-landing-batch",
          type: "function",
          function: {
            name: "batch",
            arguments: JSON.stringify({ ops: specs.map(([kind, y, x]) => ({ name: "insert_component", arguments: { kind, x, y } })) }),
          },
        }],
      }
    }
    return { content: "Built a seven-node landing page with a nav, hero, three features, pricing, and footer.", toolCalls: [] }
  }
  if (prompt === "insert a button at 100,100" && toolResults === 0) {
    return { content: "", toolCalls: [{ id: "fake-button", type: "function", function: { name: "insert_component", arguments: JSON.stringify({ kind: "button", x: 100, y: 100 }) } }] }
  }
  if (prompt === "lock the selected node" && toolResults === 0) {
    return { content: "", toolCalls: [{ id: "fake-lock", type: "function", function: { name: "lock", arguments: JSON.stringify({ ids: "selection" }) } }] }
  }
  if (prompt === "lock the selected node" && toolResults > 0) return { content: "Locked the selected node.", toolCalls: [] }
  if (toolResults > 0) return { content: "Added the requested button at 100, 100.", toolCalls: [] }
  return { content: "I’m ready to edit the canvas.", toolCalls: [] }
}

function openAiReply(value: unknown): ModelReply {
  if (!value || typeof value !== "object") throw new Error("Model returned no response object")
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices.length) throw new Error("Model returned no choices")
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== "object") throw new Error("Model returned no assistant message")
  const raw = message as { content?: unknown; tool_calls?: unknown }
  const content = typeof raw.content === "string" ? raw.content : ""
  if (raw.tool_calls === undefined) return { content, toolCalls: [] }
  if (!Array.isArray(raw.tool_calls)) throw new Error("Model tool_calls was not an array")
  const toolCalls = raw.tool_calls.map((call, index): FunctionToolCall => {
    if (!call || typeof call !== "object") throw new Error(`Invalid model tool call ${index}`)
    const candidate = call as { id?: unknown; type?: unknown; function?: unknown }
    const fn = candidate.function as { name?: unknown; arguments?: unknown } | undefined
    if (candidate.type !== "function" || typeof candidate.id !== "string" || !candidate.id || typeof fn?.name !== "string" || typeof fn.arguments !== "string") throw new Error(`Invalid model tool call ${index}`)
    return { id: candidate.id, type: "function", function: { name: fn.name, arguments: fn.arguments } }
  })
  return { content, toolCalls }
}

function anthropicMessages(messages: readonly ModelMessage[]) {
  const converted: { role: "user" | "assistant"; content: string | UnknownRecord[] }[] = []
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content })
    } else if (message.role === "assistant") {
      const content: UnknownRecord[] = []
      if (message.content) content.push({ type: "text", text: message.content })
      for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown })
      converted.push({ role: "assistant", content })
    } else if (message.role === "tool") {
      const result = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }
      const prior = converted.at(-1)
      if (prior?.role === "user" && Array.isArray(prior.content)) prior.content.push(result)
      else converted.push({ role: "user", content: [result] })
    }
  }
  return converted
}

function anthropicReply(value: unknown): ModelReply {
  if (!value || typeof value !== "object") throw new Error("Model returned no response object")
  const blocks = (value as { content?: unknown }).content
  if (!Array.isArray(blocks)) throw new Error("Anthropic model returned no content")
  const text: string[] = []
  const toolCalls: FunctionToolCall[] = []
  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== "object") throw new Error(`Invalid Anthropic content block ${index}`)
    const candidate = block as UnknownRecord
    if (candidate.type === "text" && typeof candidate.text === "string") text.push(candidate.text)
    else if (candidate.type === "tool_use" && typeof candidate.id === "string" && typeof candidate.name === "string" && candidate.input && typeof candidate.input === "object" && !Array.isArray(candidate.input)) {
      toolCalls.push({ id: candidate.id, type: "function", function: { name: candidate.name, arguments: JSON.stringify(candidate.input) } })
    } else throw new Error(`Invalid Anthropic content block ${index}`)
  }
  return { content: text.join(""), toolCalls }
}

export async function runSquigModel(
  env: ModelEnv,
  model: SquigModel,
  messages: ModelMessage[],
  tools: ServerToolDefinition[],
  turnId: string
): Promise<ModelReply> {
  if (env.ENVIRONMENT === "local" && env.SQUIG_FAKE_MODEL === "true") return fakeReply(messages)
  const options = { gateway: { id: env.AI_GATEWAY_ID, skipCache: true, collectLog: false, metadata: { turnId } } }
  if (model === MODEL_STRONG) {
    const response = await env.AI.run(MODEL_STRONG, {
      system: SYSTEM_PROMPT,
      messages: anthropicMessages(messages),
      max_tokens: 1200,
      tools: tools.map(({ function: definition }) => ({ name: definition.name, description: definition.description, input_schema: definition.parameters })),
    }, options)
    return anthropicReply(response)
  }
  const input: ChatCompletionsInput = {
    messages,
    tools: tools.map(({ function: definition }) => ({
      type: "function" as const,
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as Record<string, unknown>,
      },
    })),
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_tokens: 1200,
  }
  const response = model === MODEL_DEFAULT
    ? await env.AI.run(MODEL_DEFAULT, input, options)
    : await env.AI.run(MODEL_KIMI, input, options)
  return openAiReply(response)
}
