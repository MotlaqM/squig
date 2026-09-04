import type { ComponentDef } from "../library/registry"
import type { SquigNode } from "../types"

export type Edge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"
export type ReorderTarget = "front" | "back" | "forward" | "backward"

/** The serializable part of a Squig document that operations own. */
export interface Doc {
  nodes: Record<string, SquigNode>
  order: string[]
}

export interface OpContext {
  getDef: (kind: string) => ComponentDef | undefined
  nanoid: () => string
  seed: (id?: string) => number
}

export type RelativeSide = "below" | "above" | "left" | "right"
export type RelativeAlign = "start" | "center" | "end"

/**
 * The single document mutation vocabulary shared by the UI, page tools, and
 * later remote clients. Operations contain resolved ids only; selection is a
 * caller concern.
 */
export type Op =
  | { t: "add"; node: SquigNode }
  | { t: "update"; id: string; patch: Partial<SquigNode> }
  | { t: "updateMany"; patches: Record<string, Partial<SquigNode>> }
  | { t: "remove"; ids: string[] }
  | { t: "reorder"; ids: string[]; to: ReorderTarget }
  | { t: "group"; ids: string[]; groupId: string }
  | { t: "ungroup"; ids: string[] }
  | { t: "align"; ids: string[]; edge: Edge }
  | { t: "distribute"; ids: string[]; axis: "h" | "v" }
  | { t: "flip"; ids: string[]; axis: "x" | "y" }
  | { t: "lock"; ids: string[]; locked: boolean }
  | { t: "duplicate"; ids: string[]; offset: [number, number]; idMap: Record<string, string> }
  | {
      t: "placeRelative"
      id: string
      anchor: string
      side: RelativeSide
      gap?: number
      align?: RelativeAlign
    }
  | { t: "stack"; ids: string[]; axis: "h" | "v"; gap?: number }
  | { t: "matchSize"; ids: string[]; to: string; dims: "w" | "h" | "both" }

export interface OpResult {
  doc: Doc
  affected: string[]
  summary: string
}
