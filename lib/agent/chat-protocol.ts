import type { Op } from "../ops/types"
import type { Viewport } from "../types"

export const CHAT_MODELS = ["default", "kimi", "strong"] as const
export type ChatModelChoice = (typeof CHAT_MODELS)[number]

interface RevisionedTurnFrame { turnId: string; clientRev: number }

export interface ChatStartFrame extends RevisionedTurnFrame {
  type: "chat.start"
  prompt: string
  review: boolean
  model?: ChatModelChoice
  selection?: string[]
  viewport?: Viewport
  viewportWidth?: number
  viewportHeight?: number
}

export interface ReviewAcceptFrame extends RevisionedTurnFrame { type: "review.accept" }
export interface ReviewRejectFrame extends RevisionedTurnFrame { type: "review.reject" }
export interface AgentUndoFrame extends RevisionedTurnFrame { type: "agent.undo" }
export type ClientChatFrame = ChatStartFrame | ReviewAcceptFrame | ReviewRejectFrame | AgentUndoFrame

export interface ChatDeltaFrame { type: "chat.delta"; turnId: string; delta: string }
export interface ChatToolFrame { type: "chat.tool"; turnId: string; name: string; summary: string; affected: string[] }
export interface ReviewPendingFrame {
  type: "review.pending"
  turnId: string
  baseRev: number
  ops: Op[]
  affected: string[]
  message: string
  model: string
}
export interface ChatCompletedFrame {
  type: "chat.completed"
  turnId: string
  rev: number
  status: "completed" | "pending" | "accepted" | "rejected" | "undone"
  model?: string
  affected: string[]
}

export function isUndoableAgentCompletion(frame: ChatCompletedFrame): boolean {
  return (frame.status === "completed" || frame.status === "accepted") && frame.affected.length > 0
}
export interface SelectionSetFrame { type: "selection.set"; turnId: string; rev: number; ids: string[] }
export interface ChatErrorFrame {
  type: "chat.error"
  turnId: string
  rev: number
  code: "invalid" | "stale_revision" | "stale_review" | "turn_in_progress" | "not_found" | "undo_conflict" | "model_error" | "tool_error"
  message: string
}
export type ServerChatFrame = ChatDeltaFrame | ChatToolFrame | ReviewPendingFrame | ChatCompletedFrame | SelectionSetFrame | ChatErrorFrame

export function isServerChatFrame(value: unknown): value is ServerChatFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  return typeof type === "string" && ["chat.delta", "chat.tool", "review.pending", "chat.completed", "selection.set", "chat.error"].includes(type)
}
