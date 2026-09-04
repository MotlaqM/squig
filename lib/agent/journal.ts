"use client"

import { validNode } from "../clipboard-payload"
import type { Doc } from "../ops/types"
import { sameValue } from "../ops/value"
import type { SquigNode } from "../types"

export const PENDING_INTENT_JOURNAL_VERSION = 2
export const MAX_PENDING_INTENT_DOCUMENTS = 40
export const MAX_PENDING_INTENT_COMMANDS = 100
export const MAX_PENDING_INTENT_CHANGES = 10_000
export const MAX_PENDING_INTENT_BYTES = 2 * 1024 * 1024

const INDEX_KEY = "squig:sync-intents:v2"
const KEY_PREFIX = "squig:sync-intents:v2:"
const LEGACY_KEY_PREFIX = "squig:sync-intents:v1:"

export interface IntentValueState { present: boolean; value?: unknown }
export type IntentNodeTransition =
  | { kind: "add"; id: string; node: SquigNode }
  | { kind: "remove"; id: string; node: SquigNode }
  | { kind: "patch"; id: string; fields: Array<{ key: string; before: IntentValueState; after: IntentValueState }> }
export interface IntentTransition {
  nodes: IntentNodeTransition[]
  order?: { before: string[]; after: string[] }
}

interface StoredIntentJournal {
  version: 2
  docId: string
  intents: IntentTransition[]
}

function cloneWire<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function hasOwn(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key) }
function hasDefined(value: Record<string, unknown>, key: string): boolean { return hasOwn(value, key) && value[key] !== undefined }

function valueState(record: Record<string, unknown>, key: string): IntentValueState {
  return hasDefined(record, key) ? { present: true, value: cloneWire(record[key]) } : { present: false }
}

/** Capture only changed nodes and fields, retaining no reference to either source document. */
export function captureIntentTransition(before: Doc, after: Doc): IntentTransition {
  const nodes: IntentNodeTransition[] = []
  const nodeIds = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])
  for (const id of nodeIds) {
    const left = before.nodes[id]
    const right = after.nodes[id]
    if (!left && right) {
      nodes.push({ kind: "add", id, node: cloneWire(right) })
      continue
    }
    if (left && !right) {
      nodes.push({ kind: "remove", id, node: cloneWire(left) })
      continue
    }
    if (!left || !right || sameValue(left, right)) continue
    const leftRecord = left as unknown as Record<string, unknown>
    const rightRecord = right as unknown as Record<string, unknown>
    const fields = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
      .filter((key) => {
        const leftHas = hasDefined(leftRecord, key)
        const rightHas = hasDefined(rightRecord, key)
        return leftHas !== rightHas || (leftHas && !sameValue(leftRecord[key], rightRecord[key]))
      })
      .map((key) => ({ key, before: valueState(leftRecord, key), after: valueState(rightRecord, key) }))
    if (fields.length) nodes.push({ kind: "patch", id, fields })
  }
  return {
    nodes,
    ...(!sameValue(before.order, after.order) ? { order: { before: [...before.order], after: [...after.order] } } : {}),
  }
}

function stateMatches(record: Record<string, unknown>, key: string, expected: IntentValueState): boolean {
  const present = hasDefined(record, key)
  return present === expected.present && (!present || sameValue(record[key], expected.value))
}

/** Apply only parts whose expected state still matches; accepted and conflicting parts are unchanged. */
export function applyIntentTransition(current: Doc, transition: IntentTransition, direction: "forward" | "backward" = "forward"): Doc {
  const nodes: Record<string, SquigNode> = { ...current.nodes }
  for (const change of transition.nodes) {
    if (change.kind === "add" || change.kind === "remove") {
      const forwardAdds = change.kind === "add"
      const expected = direction === "forward" ? (forwardAdds ? undefined : change.node) : (forwardAdds ? change.node : undefined)
      const wanted = direction === "forward" ? (forwardAdds ? change.node : undefined) : (forwardAdds ? undefined : change.node)
      const currentNode = nodes[change.id]
      if (expected ? !!currentNode && sameValue(currentNode, expected) : !currentNode) {
        if (wanted) nodes[change.id] = cloneWire(wanted)
        else delete nodes[change.id]
      }
      continue
    }
    const currentNode = nodes[change.id]
    if (!currentNode) continue
    const next = { ...currentNode } as unknown as Record<string, unknown>
    const currentRecord = currentNode as unknown as Record<string, unknown>
    for (const field of change.fields) {
      const expected = direction === "forward" ? field.before : field.after
      const wanted = direction === "forward" ? field.after : field.before
      if (!stateMatches(currentRecord, field.key, expected)) continue
      if (wanted.present) next[field.key] = cloneWire(wanted.value)
      else delete next[field.key]
    }
    nodes[change.id] = next as unknown as SquigNode
  }

  const expectedOrder = transition.order?.[direction === "forward" ? "before" : "after"]
  const wantedOrder = transition.order?.[direction === "forward" ? "after" : "before"]
  const order = (expectedOrder && wantedOrder && sameValue(current.order, expectedOrder) ? wantedOrder : current.order)
    .filter((nodeId) => !!nodes[nodeId])
  const ordered = new Set(order)
  for (const source of [current.order, wantedOrder ?? [], Object.keys(nodes)]) {
    for (const nodeId of source) {
      if (nodes[nodeId] && !ordered.has(nodeId)) {
        order.push(nodeId)
        ordered.add(nodeId)
      }
    }
  }
  return { nodes, order }
}

export function intentTransitionChanges(transition: IntentTransition): number {
  return transition.nodes.reduce((count, change) => count + (change.kind === "patch" ? change.fields.length : 1), 0) + (transition.order ? 1 : 0)
}

function validValueState(value: unknown): value is IntentValueState {
  if (!isRecord(value) || typeof value.present !== "boolean") return false
  const keys = Object.keys(value)
  if (value.present) return hasOwn(value, "value") && keys.every((key) => key === "present" || key === "value")
  return !hasOwn(value, "value") && keys.every((key) => key === "present")
}

function validNodeCopy(value: unknown, id: string): value is SquigNode {
  if (!isRecord(value)) return false
  const clean = validNode(structuredClone(value))
  return clean !== null && clean.id === id && sameValue(clean, value)
}

function validOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((id) => typeof id === "string") && new Set(value).size === value.length
}

function validIntentTransition(value: unknown): value is IntentTransition {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false
  if (!Object.keys(value).every((key) => key === "nodes" || key === "order")) return false
  for (const change of value.nodes) {
    if (!isRecord(change) || typeof change.id !== "string") return false
    if (change.kind === "add" || change.kind === "remove") {
      if (!Object.keys(change).every((key) => key === "kind" || key === "id" || key === "node") || !validNodeCopy(change.node, change.id)) return false
      continue
    }
    if (change.kind !== "patch" || !Array.isArray(change.fields) || !Object.keys(change).every((key) => key === "kind" || key === "id" || key === "fields")) return false
    for (const field of change.fields) {
      if (!isRecord(field) || typeof field.key !== "string" || !Object.keys(field).every((key) => key === "key" || key === "before" || key === "after")) return false
      if (!validValueState(field.before) || !validValueState(field.after) || sameValue(field.before, field.after)) return false
    }
  }
  if (value.order !== undefined) {
    if (!isRecord(value.order) || !Object.keys(value.order).every((key) => key === "before" || key === "after")) return false
    if (!validOrder(value.order.before) || !validOrder(value.order.after) || sameValue(value.order.before, value.order.after)) return false
  }
  return value.nodes.length > 0 || value.order !== undefined
}

function bytes(value: string): number { return new TextEncoder().encode(value).byteLength }

export function pendingIntentJournalKey(docId: string): string { return `${KEY_PREFIX}${encodeURIComponent(docId)}` }

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
  try {
    localStorage.removeItem(pendingIntentJournalKey(docId))
    localStorage.removeItem(`${LEGACY_KEY_PREFIX}${encodeURIComponent(docId)}`)
  } catch { /* Storage can be unavailable. */ }
  writeIndex(readIndex().filter((id) => id !== docId))
}

/** Load only a current, bounded, document-scoped journal; malformed data is discarded. */
export function loadPendingIntents(docId: string): IntentTransition[] {
  try {
    const raw = localStorage.getItem(pendingIntentJournalKey(docId))
    if (!raw) return []
    if (bytes(raw) > MAX_PENDING_INTENT_BYTES) throw new Error("oversized journal")
    const parsed = JSON.parse(raw) as Partial<StoredIntentJournal> | null
    if (!parsed || parsed.version !== PENDING_INTENT_JOURNAL_VERSION || parsed.docId !== docId || !Array.isArray(parsed.intents)) throw new Error("invalid journal")
    if (parsed.intents.length > MAX_PENDING_INTENT_COMMANDS || !parsed.intents.every(validIntentTransition)) throw new Error("invalid intents")
    if (parsed.intents.reduce((total, intent) => total + intentTransitionChanges(intent), 0) > MAX_PENDING_INTENT_CHANGES) throw new Error("too many changes")
    return cloneWire(parsed.intents)
  } catch {
    clearPendingIntents(docId)
    return []
  }
}

/** Persist conditional pending intent separately from the Squig document format. */
export function savePendingIntents(docId: string, intents: readonly IntentTransition[]): boolean {
  if (!intents.length) {
    clearPendingIntents(docId)
    return true
  }
  const changeCount = intents.reduce((total, intent) => total + intentTransitionChanges(intent), 0)
  if (intents.length > MAX_PENDING_INTENT_COMMANDS || changeCount > MAX_PENDING_INTENT_CHANGES || !intents.every(validIntentTransition)) {
    clearPendingIntents(docId)
    return false
  }
  try {
    const record: StoredIntentJournal = { version: PENDING_INTENT_JOURNAL_VERSION, docId, intents: cloneWire([...intents]) }
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
