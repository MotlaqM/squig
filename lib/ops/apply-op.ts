import { settleBinds } from "../canvas/arrow-binding"
import { planCloneGroupPaths, planGroupPaths, pruneDegenerateGroups, orderWithClones } from "../canvas/groups"
import { nodeVisualBounds } from "../canvas/line-routing"
import { unionBox, type SquigNode } from "../types"
import type { Doc, Edge, Op, OpContext, OpResult, ReorderTarget } from "./types"
import { sameValue } from "./value"

const DEFAULT_GAP = 16

function existingIds(doc: Doc, ids: readonly string[]): string[] {
  const wanted = new Set(ids)
  return doc.order.filter((id) => wanted.has(id) && doc.nodes[id])
}

function stepOrder(order: readonly string[], ids: readonly string[], direction: 1 | -1): string[] {
  const next = [...order]
  const selected = new Set(ids)
  if (direction === 1) {
    for (let index = next.length - 2; index >= 0; index--) {
      if (selected.has(next[index]) && !selected.has(next[index + 1])) {
        ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      }
    }
  } else {
    for (let index = 1; index < next.length; index++) {
      if (selected.has(next[index]) && !selected.has(next[index - 1])) {
        ;[next[index], next[index - 1]] = [next[index - 1], next[index]]
      }
    }
  }
  return next
}

function reordered(order: readonly string[], ids: readonly string[], to: ReorderTarget): string[] {
  const selected = new Set(ids)
  if (to === "front") return [...order.filter((id) => !selected.has(id)), ...order.filter((id) => selected.has(id))]
  if (to === "back") return [...order.filter((id) => selected.has(id)), ...order.filter((id) => !selected.has(id))]
  return stepOrder(order, ids, to === "forward" ? 1 : -1)
}

function patchNodes(
  nodes: Record<string, SquigNode>,
  patches: Record<string, Partial<SquigNode>>
): Record<string, SquigNode> {
  let next = nodes
  for (const [id, patch] of Object.entries(patches)) {
    const current = next[id]
    if (!current) continue
    const candidate = { ...current, ...patch, id: current.id, type: current.type } as SquigNode
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (candidate as unknown as Record<string, unknown>)[key]
    }
    if (sameValue(current, candidate)) continue
    if (next === nodes) next = { ...nodes }
    next[id] = candidate
  }
  return next
}

function groupIdsToRemove(doc: Doc, ids: readonly string[]): Set<string> {
  const selected = existingIds(doc, ids).map((id) => doc.nodes[id])
  if (!selected.length) return new Set()

  let common = [...(selected[0].groupIds ?? [])]
  for (const node of selected.slice(1)) {
    const path = new Set(node.groupIds ?? [])
    common = common.filter((groupId) => path.has(groupId))
  }
  if (common.length) return new Set([common[common.length - 1]])
  return new Set(selected.map((node) => node.groupIds?.[0]).filter((id): id is string => !!id))
}

function stableGroupId(idMap: Record<string, string>, sequence: number): string {
  const first = Object.values(idMap).sort()[0] ?? "copy"
  return `${first}:g${sequence}`
}

function duplicate(doc: Doc, op: Extract<Op, { t: "duplicate" }>, ctx: OpContext): { nodes: Record<string, SquigNode>; order: string[] } {
  const sources = existingIds(doc, op.ids).map((id) => doc.nodes[id])
  if (!sources.length) return doc

  const targets = sources.map((source) => op.idMap[source.id])
  if (targets.some((id) => !id) || new Set(targets).size !== targets.length || targets.some((id) => !!doc.nodes[id])) {
    return doc
  }

  let groupSequence = 0
  const groups = planCloneGroupPaths(
    sources,
    doc.order.map((id) => doc.nodes[id]).filter(Boolean),
    () => stableGroupId(op.idMap, groupSequence++)
  )
  const clones = sources.map((source) => {
    const clone = structuredClone(source)
    clone.id = op.idMap[source.id]
    clone.x += op.offset[0]
    clone.y += op.offset[1]
    clone.seed = ctx.seed(clone.id)
    clone.locked = undefined
    clone.groupIds = groups.paths.get(source.id)
    return clone
  })

  const remapped = new Map(Object.entries(op.idMap))
  for (const clone of clones) {
    if (clone.type !== "arrow" || !clone.bind) continue
    const [from, to] = clone.bind
    const mappedFrom = from ? (remapped.get(from) ?? null) : null
    const mappedTo = to ? (remapped.get(to) ?? null) : null
    clone.bind = mappedFrom || mappedTo ? [mappedFrom, mappedTo] : undefined
    clone.anchors = clone.bind
      ? [mappedFrom ? (clone.anchors?.[0] ?? null) : null, mappedTo ? (clone.anchors?.[1] ?? null) : null]
      : undefined
  }

  const nodes = pruneDegenerateGroups({
    ...doc.nodes,
    ...Object.fromEntries(clones.map((clone) => [clone.id, clone])),
  })
  return { nodes: settleBinds(nodes), order: orderWithClones(doc.order, sources, clones) }
}

function alignPatches(doc: Doc, ids: readonly string[], edge: Edge): Record<string, Partial<SquigNode>> {
  const selected = existingIds(doc, ids).map((id) => doc.nodes[id])
  if (selected.length < 2) return {}
  const minX = Math.min(...selected.map((node) => node.x))
  const maxX = Math.max(...selected.map((node) => node.x + node.w))
  const minY = Math.min(...selected.map((node) => node.y))
  const maxY = Math.max(...selected.map((node) => node.y + node.h))
  return Object.fromEntries(selected.map((node) => {
    switch (edge) {
      case "left": return [node.id, { x: minX }]
      case "hcenter": return [node.id, { x: (minX + maxX) / 2 - node.w / 2 }]
      case "right": return [node.id, { x: maxX - node.w }]
      case "top": return [node.id, { y: minY }]
      case "vcenter": return [node.id, { y: (minY + maxY) / 2 - node.h / 2 }]
      case "bottom": return [node.id, { y: maxY - node.h }]
    }
  }))
}

function distributePatches(doc: Doc, ids: readonly string[], axis: "h" | "v"): Record<string, Partial<SquigNode>> {
  const selected = existingIds(doc, ids).map((id) => doc.nodes[id])
  if (selected.length < 3) return {}
  const rank = new Map(doc.order.map((id, index) => [id, index]))
  const position = (node: SquigNode) => axis === "h" ? node.x : node.y
  const size = (node: SquigNode) => axis === "h" ? node.w : node.h
  const sorted = [...selected].sort(
    (left, right) => position(left) - position(right) || (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0)
  )
  const start = Math.min(...sorted.map(position))
  const end = Math.max(...sorted.map((node) => position(node) + size(node)))
  const used = sorted.reduce((total, node) => total + size(node), 0)
  const gap = (end - start - used) / (sorted.length - 1)
  let cursor = start
  const patches: Record<string, Partial<SquigNode>> = {}
  for (const node of sorted) {
    patches[node.id] = axis === "h" ? { x: cursor } : { y: cursor }
    cursor += size(node) + gap
  }
  return patches
}

function stackPatches(doc: Doc, ids: readonly string[], axis: "h" | "v", gap = DEFAULT_GAP): Record<string, Partial<SquigNode>> {
  const selected = existingIds(doc, ids).map((id) => doc.nodes[id])
  if (selected.length < 2 || !Number.isFinite(gap)) return {}
  const rank = new Map(doc.order.map((id, index) => [id, index]))
  const position = (node: SquigNode) => axis === "h" ? node.x : node.y
  const size = (node: SquigNode) => axis === "h" ? node.w : node.h
  const sorted = [...selected].sort(
    (left, right) => position(left) - position(right) || (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0)
  )
  let cursor = Math.min(...sorted.map(position))
  const patches: Record<string, Partial<SquigNode>> = {}
  for (const node of sorted) {
    patches[node.id] = axis === "h" ? { x: cursor } : { y: cursor }
    cursor += size(node) + gap
  }
  return patches
}

function placeRelativePatch(doc: Doc, op: Extract<Op, { t: "placeRelative" }>): Partial<SquigNode> | null {
  const node = doc.nodes[op.id]
  const anchor = doc.nodes[op.anchor]
  if (!node || !anchor || node.id === anchor.id || !Number.isFinite(op.gap ?? DEFAULT_GAP)) return null
  const gap = op.gap ?? DEFAULT_GAP
  const align = op.align ?? "start"
  const cross = (anchorStart: number, anchorSize: number, nodeSize: number) => {
    if (align === "center") return anchorStart + (anchorSize - nodeSize) / 2
    if (align === "end") return anchorStart + anchorSize - nodeSize
    return anchorStart
  }
  switch (op.side) {
    case "below": return { x: cross(anchor.x, anchor.w, node.w), y: anchor.y + anchor.h + gap }
    case "above": return { x: cross(anchor.x, anchor.w, node.w), y: anchor.y - node.h - gap }
    case "right": return { x: anchor.x + anchor.w + gap, y: cross(anchor.y, anchor.h, node.h) }
    case "left": return { x: anchor.x - node.w - gap, y: cross(anchor.y, anchor.h, node.h) }
  }
}

function summaryFor(op: Op, count: number): string {
  if (!count) return `${op.t}: no change`
  const noun = count === 1 ? "node" : "nodes"
  return `${op.t}: ${count} ${noun}`
}

function affectedIds(before: Doc, after: Doc): string[] {
  const ids = new Set([...before.order, ...after.order, ...Object.keys(before.nodes), ...Object.keys(after.nodes)])
  const beforeRank = new Map(before.order.map((id, index) => [id, index]))
  const afterRank = new Map(after.order.map((id, index) => [id, index]))
  return [...ids].filter(
    (id) => !sameValue(before.nodes[id], after.nodes[id]) || beforeRank.get(id) !== afterRank.get(id)
  )
}

/** Pure document transition. It has no store, DOM, or window dependency. */
export function applyOp(doc: Doc, op: Op, ctx: OpContext): OpResult {
  let nodes = doc.nodes
  let order = doc.order

  switch (op.t) {
    case "add": {
      if (!nodes[op.node.id]) {
        nodes = settleBinds({ ...nodes, [op.node.id]: structuredClone(op.node) })
        order = [...order, op.node.id]
      }
      break
    }
    case "update":
      nodes = settleBinds(patchNodes(nodes, { [op.id]: op.patch }))
      break
    case "updateMany":
      nodes = settleBinds(patchNodes(nodes, op.patches))
      break
    case "remove": {
      const remove = new Set(op.ids.filter((id) => !!nodes[id]))
      if (!remove.size) break
      nodes = { ...nodes }
      for (const id of remove) delete nodes[id]
      nodes = settleBinds(pruneDegenerateGroups(nodes))
      order = order.filter((id) => !remove.has(id))
      break
    }
    case "reorder": {
      const ids = existingIds(doc, op.ids)
      if (ids.length) order = reordered(order, ids, op.to)
      break
    }
    case "group": {
      const ids = existingIds(doc, op.ids)
      const paths = planGroupPaths(ids, nodes, order, op.groupId)
      if (!paths) break
      nodes = { ...nodes }
      for (const id of ids) nodes[id] = { ...nodes[id], groupIds: paths.get(id) } as SquigNode
      const top = order.lastIndexOf(ids[ids.length - 1])
      const before = order.slice(0, top + 1).filter((id) => !ids.includes(id))
      const after = order.slice(top + 1).filter((id) => !ids.includes(id))
      order = [...before, ...ids, ...after]
      nodes = pruneDegenerateGroups(nodes)
      break
    }
    case "ungroup": {
      const groups = groupIdsToRemove(doc, op.ids)
      if (!groups.size) break
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const id of order) {
        const node = nodes[id]
        if (!node?.groupIds?.some((groupId) => groups.has(groupId))) continue
        const groupIds = node.groupIds.filter((groupId) => !groups.has(groupId))
        patches[id] = { groupIds: groupIds.length ? groupIds : undefined }
      }
      nodes = pruneDegenerateGroups(patchNodes(nodes, patches))
      break
    }
    case "align":
      nodes = settleBinds(patchNodes(nodes, alignPatches(doc, op.ids, op.edge)))
      break
    case "distribute":
      nodes = settleBinds(patchNodes(nodes, distributePatches(doc, op.ids, op.axis)))
      break
    case "flip": {
      const selected = existingIds(doc, op.ids).map((id) => nodes[id])
      const box = unionBox(selected.map(nodeVisualBounds))
      if (!box) break
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const node of selected) {
        patches[node.id] = op.axis === "x"
          ? { x: box.minX + box.maxX - (node.x + node.w), flipX: !node.flipX }
          : { y: box.minY + box.maxY - (node.y + node.h), flipY: !node.flipY }
      }
      nodes = settleBinds(patchNodes(nodes, patches))
      break
    }
    case "lock":
      nodes = patchNodes(nodes, Object.fromEntries(existingIds(doc, op.ids).map((id) => [id, { locked: op.locked || undefined }])))
      break
    case "duplicate": {
      const next = duplicate(doc, op, ctx)
      nodes = next.nodes
      order = next.order
      break
    }
    case "placeRelative": {
      const patch = placeRelativePatch(doc, op)
      if (patch) nodes = settleBinds(patchNodes(nodes, { [op.id]: patch }))
      break
    }
    case "stack":
      nodes = settleBinds(patchNodes(nodes, stackPatches(doc, op.ids, op.axis, op.gap)))
      break
    case "matchSize": {
      const target = nodes[op.to]
      if (!target) break
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const id of existingIds(doc, op.ids)) {
        if (id === op.to) continue
        patches[id] = {
          ...(op.dims !== "h" ? { w: target.w } : {}),
          ...(op.dims !== "w" ? { h: target.h } : {}),
        }
      }
      nodes = settleBinds(patchNodes(nodes, patches))
      break
    }
  }

  if (nodes === doc.nodes && order === doc.order) return { doc, affected: [], summary: summaryFor(op, 0) }
  const next = {
    nodes,
    order: sameValue(order, doc.order) ? doc.order : order,
  }
  if (sameValue(doc.nodes, next.nodes) && next.order === doc.order) return { doc, affected: [], summary: summaryFor(op, 0) }
  const affected = affectedIds(doc, next)
  return { doc: next, affected, summary: summaryFor(op, affected.length) }
}
