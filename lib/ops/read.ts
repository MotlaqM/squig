import { ALL_DEFS, type Category } from "../library/registry"
import { selectionSummary } from "../selection"
import type { SquigNode, Viewport } from "../types"
import { controlsToJsonSchema } from "./schema"
import type { Doc } from "./types"

export interface FindNodesQuery {
  type?: SquigNode["type"]
  kind?: string
  text?: string
  within?: { x: number; y: number; w: number; h: number }
}

function compactNode(node: SquigNode) {
  return {
    id: node.id,
    type: node.type,
    ...(node.type === "component" ? { kind: node.kind, props: node.props } : {}),
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    ...(node.groupIds?.length ? { groupIds: node.groupIds } : {}),
    ...(node.locked ? { locked: true } : {}),
    ...(node.type === "text" ? { text: node.text, ...(node.link ? { link: node.link } : {}) } : {}),
  }
}

export function describeDoc(
  doc: Doc,
  extras: { fileName?: string; viewport?: Viewport; selection?: string[] } = {}
) {
  return {
    ...(extras.fileName !== undefined ? { fileName: extras.fileName } : {}),
    ...(extras.viewport ? { viewport: extras.viewport } : {}),
    selection: extras.selection ?? [],
    order: [...doc.order],
    nodes: doc.order.map((id) => doc.nodes[id]).filter(Boolean).map(compactNode),
  }
}

export function describeSelection(doc: Doc, selection: readonly string[]) {
  const wanted = new Set(selection)
  const nodes = doc.order.filter((id) => wanted.has(id)).map((id) => doc.nodes[id]).filter(Boolean)
  return { nodes: nodes.map(compactNode), selectionSummary: selectionSummary(nodes) }
}

export function findNodes(doc: Doc, query: FindNodesQuery): string[] {
  const text = query.text?.toLowerCase()
  return doc.order.filter((id) => {
    const node = doc.nodes[id]
    if (!node) return false
    if (query.type && node.type !== query.type) return false
    if (query.kind && (node.type !== "component" || node.kind !== query.kind)) return false
    if (text) {
      const haystack = node.type === "text"
        ? node.text
        : node.type === "component"
          ? JSON.stringify(node.props)
          : ""
      if (!haystack.toLowerCase().includes(text)) return false
    }
    if (query.within) {
      const box = query.within
      if (node.x < box.x || node.y < box.y || node.x + node.w > box.x + box.w || node.y + node.h > box.y + box.h) {
        return false
      }
    }
    return true
  })
}

export function componentCatalog(query?: { query?: string; category?: Category }) {
  const text = query?.query?.trim().toLowerCase() ?? ""
  return ALL_DEFS.filter((def) => {
    if (query?.category && def.category !== query.category) return false
    if (!text) return true
    return [def.kind, def.name, def.group ?? "", ...(def.keywords ?? [])].some((value) => value.toLowerCase().includes(text))
  }).map((def) => ({
    kind: def.kind,
    name: def.name,
    group: def.group,
    keywords: def.keywords ?? [],
    size: def.size,
    propsSchema: controlsToJsonSchema(def),
  }))
}
