"use client"

import type { Op } from "../ops/types"

export const PENDING_INTENT_JOURNAL_VERSION = 1
export const MAX_PENDING_INTENT_DOCUMENTS = 40
export const MAX_PENDING_INTENT_COMMANDS = 100
export const MAX_PENDING_INTENT_OPS = 10_000
export const MAX_PENDING_INTENT_BYTES = 2 * 1024 * 1024

const INDEX_KEY = "squig:sync-intents:v1"
const KEY_PREFIX = "squig:sync-intents:v1:"
const OP_TYPES = new Set([
  "add", "update", "updateMany", "remove", "reorder", "group", "ungroup", "align",
  "distribute", "flip", "lock", "duplicate", "placeRelative", "stack", "matchSize",
])

interface StoredIntentJournal {
  version: 1
  docId: string
  intents: Op[][]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function plausibleOp(value: unknown): value is Op {
  if (!isRecord(value) || typeof value.t !== "string" || !OP_TYPES.has(value.t)) return false
  switch (value.t) {
    case "add": return isRecord(value.node) && typeof value.node.id === "string" && typeof value.node.type === "string"
    case "update": return typeof value.id === "string" && isRecord(value.patch)
    case "updateMany": return isRecord(value.patches) && Object.values(value.patches).every(isRecord)
    case "remove":
    case "ungroup": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string")
    case "reorder": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && ["front", "back", "forward", "backward"].includes(String(value.to))
    case "group": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && typeof value.groupId === "string"
    case "align": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && ["left", "hcenter", "right", "top", "vcenter", "bottom"].includes(String(value.edge))
    case "distribute": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && ["h", "v"].includes(String(value.axis))
    case "flip": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && ["x", "y"].includes(String(value.axis))
    case "lock": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && typeof value.locked === "boolean"
    case "duplicate": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && Array.isArray(value.offset) && value.offset.length === 2 && value.offset.every((part) => typeof part === "number" && Number.isFinite(part)) && isRecord(value.idMap) && Object.values(value.idMap).every((id) => typeof id === "string")
    case "placeRelative": return typeof value.id === "string" && typeof value.anchor === "string" && ["below", "above", "left", "right"].includes(String(value.side)) && (value.gap === undefined || (typeof value.gap === "number" && Number.isFinite(value.gap))) && (value.align === undefined || ["start", "center", "end"].includes(String(value.align)))
    case "stack": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && ["h", "v"].includes(String(value.axis)) && (value.gap === undefined || (typeof value.gap === "number" && Number.isFinite(value.gap)))
    case "matchSize": return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") && typeof value.to === "string" && ["w", "h", "both"].includes(String(value.dims))
  }
  return false
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function pendingIntentJournalKey(docId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(docId)}`
}

function readIndex(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, MAX_PENDING_INTENT_DOCUMENTS)
  } catch {
    return []
  }
}

function writeIndex(ids: readonly string[]): void {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_PENDING_INTENT_DOCUMENTS))) } catch { /* The document cache remains the fallback. */ }
}

export function clearPendingIntents(docId: string): void {
  try { localStorage.removeItem(pendingIntentJournalKey(docId)) } catch { /* Storage can be unavailable. */ }
  writeIndex(readIndex().filter((id) => id !== docId))
}

/** Load only a current, bounded, document-scoped journal; malformed data is discarded. */
export function loadPendingIntents(docId: string): Op[][] {
  try {
    const raw = localStorage.getItem(pendingIntentJournalKey(docId))
    if (!raw) return []
    if (bytes(raw) > MAX_PENDING_INTENT_BYTES) throw new Error("oversized journal")
    const parsed = JSON.parse(raw) as Partial<StoredIntentJournal> | null
    if (!parsed || parsed.version !== PENDING_INTENT_JOURNAL_VERSION || parsed.docId !== docId || !Array.isArray(parsed.intents)) throw new Error("invalid journal")
    if (parsed.intents.length > MAX_PENDING_INTENT_COMMANDS) throw new Error("too many commands")
    let opCount = 0
    for (const intent of parsed.intents) {
      if (!Array.isArray(intent) || !intent.length || !intent.every(plausibleOp)) throw new Error("invalid intent")
      opCount += intent.length
      if (opCount > MAX_PENDING_INTENT_OPS) throw new Error("too many operations")
    }
    return JSON.parse(JSON.stringify(parsed.intents)) as Op[][]
  } catch {
    clearPendingIntents(docId)
    return []
  }
}

/** Persist pending transport intent separately from the Squig document format. */
export function savePendingIntents(docId: string, intents: readonly Op[][]): boolean {
  if (!intents.length) {
    clearPendingIntents(docId)
    return true
  }
  const opCount = intents.reduce((total, intent) => total + intent.length, 0)
  if (intents.length > MAX_PENDING_INTENT_COMMANDS || opCount > MAX_PENDING_INTENT_OPS) {
    clearPendingIntents(docId)
    return false
  }
  try {
    const record: StoredIntentJournal = { version: PENDING_INTENT_JOURNAL_VERSION, docId, intents: JSON.parse(JSON.stringify(intents)) as Op[][] }
    const raw = JSON.stringify(record)
    if (bytes(raw) > MAX_PENDING_INTENT_BYTES) throw new Error("oversized journal")
    localStorage.setItem(pendingIntentJournalKey(docId), raw)
    const index = [docId, ...readIndex().filter((id) => id !== docId)]
    for (const evicted of index.slice(MAX_PENDING_INTENT_DOCUMENTS)) {
      try { localStorage.removeItem(pendingIntentJournalKey(evicted)) } catch { /* Best effort eviction. */ }
    }
    writeIndex(index)
    return true
  } catch {
    clearPendingIntents(docId)
    return false
  }
}
