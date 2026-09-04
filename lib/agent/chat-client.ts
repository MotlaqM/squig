"use client"

import { useSyncExternalStore } from "react"
import type { ClientChatFrame, ReviewPendingFrame, ServerChatFrame } from "./chat-protocol"
import { applyOps } from "../ops/invert"
import { seedFromId } from "../ops/context"
import type { Doc, OpContext } from "../ops/types"
import { useSquig } from "../store"

interface EventEntry { seq: number; frame: ServerChatFrame }
export interface ChatSnapshot { connected: boolean; rev: number; resetEpoch: number; events: EventEntry[] }
export interface ReviewPreview { turnId: string; baseRev: number; doc: Doc; affected: string[] }

const CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => { throw new Error("Preview operations carry resolved ids") },
  seed: seedFromId,
}

let snapshot: ChatSnapshot = { connected: false, rev: 0, resetEpoch: 0, events: [] }
let preview: ReviewPreview | null = null
let sequence = 0
let transport: ((frame: ClientChatFrame) => void) | null = null
const chatListeners = new Set<() => void>()
const previewListeners = new Set<() => void>()

function emitChat() { chatListeners.forEach((listener) => listener()) }
function emitPreview() { previewListeners.forEach((listener) => listener()) }

export function setChatTransport(next: ((frame: ClientChatFrame) => void) | null) {
  transport = next
  if (snapshot.connected === !!next) return
  snapshot = { ...snapshot, connected: !!next }
  emitChat()
}

export function setChatRevision(rev: number) {
  const clearPreview = preview && preview.baseRev !== rev
  snapshot = { ...snapshot, rev }
  if (clearPreview) { preview = null; emitPreview() }
  emitChat()
}

export function resetChatClient() {
  snapshot = { connected: false, rev: 0, resetEpoch: snapshot.resetEpoch + 1, events: [] }
  preview = null
  sequence = 0
  transport = null
  emitChat()
  emitPreview()
}

/** Dependency-free state seam for reset and panel protocol tests. */
export function inspectChatClient(): ChatSnapshot { return snapshot }

export function handleServerChatFrame(frame: ServerChatFrame) {
  if (frame.type === "selection.set") useSquig.getState().setSelection(frame.ids)
  if (frame.type === "review.pending") setPreview(frame)
  if (frame.type === "chat.completed" && frame.status !== "pending" && preview?.turnId === frame.turnId) {
    preview = null
    emitPreview()
  }
  snapshot = { ...snapshot, events: [...snapshot.events, { seq: ++sequence, frame }].slice(-100) }
  emitChat()
}

function setPreview(frame: ReviewPendingFrame) {
  const state = useSquig.getState()
  try {
    preview = {
      turnId: frame.turnId,
      baseRev: frame.baseRev,
      doc: applyOps({ nodes: state.nodes, order: state.order }, frame.ops, CONTEXT),
      affected: frame.affected,
    }
  } catch {
    preview = null
  }
  emitPreview()
}

export function sendChatFrame(frame: ClientChatFrame): boolean {
  if (!transport) return false
  transport(frame)
  return true
}

export function useAgentChat(): ChatSnapshot {
  return useSyncExternalStore(
    (listener) => { chatListeners.add(listener); return () => chatListeners.delete(listener) },
    () => snapshot,
    () => ({ connected: false, rev: 0, resetEpoch: 0, events: [] })
  )
}

export function useReviewPreview(): ReviewPreview | null {
  return useSyncExternalStore(
    (listener) => { previewListeners.add(listener); return () => previewListeners.delete(listener) },
    () => preview,
    () => null
  )
}
