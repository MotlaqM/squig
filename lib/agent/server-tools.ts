import { anchorPoint, endsPatch } from "../canvas/arrow-binding"
import { nodeVisualBounds } from "../canvas/line-routing"
import { fitTextBox } from "../canvas/text-reflow"
import { scaleNodes } from "../canvas/transform"
import { getDef, type Category } from "../library/registry"
import { applyOp } from "../ops/apply-op"
import { seedFromId } from "../ops/context"
import { invert } from "../ops/invert"
import { componentCatalog, describeDoc, describeSelection, findNodes } from "../ops/read"
import { assertJsonSchema, validateComponentProps, type JsonSchema } from "../ops/schema"
import type { Doc, Op, OpContext } from "../ops/types"
import { sameValue } from "../ops/value"
import { validDocument } from "./validate"
import { unionBounds } from "../selection"
import {
  ARROW_ANCHORS,
  screenToWorld,
  type ArrowAnchor,
  type ArrowNode,
  type ComponentNode,
  type FillTone,
  type InkTone,
  type ShapeKind,
  type ShapeNode,
  type SquigNode,
  type StrokeWeight,
  type TextNode,
  type Viewport,
} from "../types"

type UnknownRecord = Record<string, unknown>

/** Server-side catalogue: page-only cursor/view/history commands are custom frames. */
export const SERVER_TOOL_NAMES = [
  "get_document",
  "get_selection",
  "find_nodes",
  "list_components",
  "insert_component",
  "add_text",
  "add_shape",
  "add_arrow",
  "duplicate",
  "set_props",
  "set_text",
  "set_geometry",
  "set_style",
  "set_link",
  "remove",
  "align",
  "distribute",
  "reorder",
  "group",
  "ungroup",
  "flip",
  "lock",
  "unlock",
  "batch",
] as const

export type ServerToolName = (typeof SERVER_TOOL_NAMES)[number]

const MUTATION_NAMES = new Set<ServerToolName>([
  "insert_component", "add_text", "add_shape", "add_arrow", "duplicate", "set_props",
  "set_text", "set_geometry", "set_style", "set_link", "remove", "align", "distribute",
  "reorder", "group", "ungroup", "flip", "lock", "unlock",
])

const objectSchema = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const openObjectSchema: JsonSchema = { type: "object", additionalProperties: true }
const stringSchema = (values?: readonly string[]): JsonSchema => ({ type: "string", ...(values ? { enum: [...values] } : {}) })
const numberSchema: JsonSchema = { type: "number" }
const booleanSchema: JsonSchema = { type: "boolean" }
const idsSchema: JsonSchema = { oneOf: [{ const: "selection" }, { type: "array", items: { type: "string" } }] }
const boxSchema = objectSchema({ x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema }, ["x", "y", "w", "h"])
const pointSchema = objectSchema({ x: numberSchema, y: numberSchema }, ["x", "y"])

export const SERVER_TOOL_SCHEMAS: Record<ServerToolName, JsonSchema> = {
  get_document: objectSchema(),
  get_selection: objectSchema(),
  find_nodes: objectSchema({ type: stringSchema(["component", "shape", "draw", "text", "arrow", "image"]), kind: stringSchema(), text: stringSchema(), within: boxSchema }),
  list_components: objectSchema({ query: stringSchema(), category: stringSchema(["components", "blocks"]) }),
  insert_component: objectSchema({ kind: stringSchema(), props: openObjectSchema, x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema }, ["kind"]),
  add_text: objectSchema({ text: stringSchema(), x: numberSchema, y: numberSchema, fontSize: numberSchema, align: stringSchema(["left", "center", "right"]), bold: booleanSchema, italic: booleanSchema, boxed: booleanSchema, w: numberSchema }, ["text", "x", "y"]),
  add_shape: objectSchema({ shape: stringSchema(["rect", "ellipse"]), x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema, fill: stringSchema(["none", "paper", "light", "strong"]), stroke: stringSchema(["light", "regular", "heavy"]), dashed: booleanSchema }, ["shape", "x", "y", "w", "h"]),
  add_arrow: objectSchema({ from: { oneOf: [stringSchema(), pointSchema] }, to: { oneOf: [stringSchema(), pointSchema] }, anchors: { type: "array", items: stringSchema(ARROW_ANCHORS) }, head: booleanSchema, style: stringSchema(["straight", "elbow", "curved"]) }, ["from", "to"]),
  duplicate: objectSchema({ ids: idsSchema, offset: objectSchema({ dx: numberSchema, dy: numberSchema }, ["dx", "dy"]) }, ["ids"]),
  set_props: objectSchema({ ids: idsSchema, props: openObjectSchema }, ["ids", "props"]),
  set_text: objectSchema({ id: stringSchema(), text: stringSchema() }, ["id", "text"]),
  set_geometry: objectSchema({ ids: idsSchema, x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema }, ["ids"]),
  set_style: objectSchema({ ids: idsSchema, ink: stringSchema(["ink", "muted", "faint"]), stroke: stringSchema(["light", "regular", "heavy"]), fill: stringSchema(["none", "paper", "light", "strong"]), dashed: booleanSchema }, ["ids"]),
  set_link: objectSchema({ ids: idsSchema, url: stringSchema() }, ["ids", "url"]),
  remove: objectSchema({ ids: idsSchema }, ["ids"]),
  align: objectSchema({ ids: idsSchema, edge: stringSchema(["left", "hcenter", "right", "top", "vcenter", "bottom"]) }, ["ids", "edge"]),
  distribute: objectSchema({ ids: idsSchema, axis: stringSchema(["h", "v"]) }, ["ids", "axis"]),
  reorder: objectSchema({ ids: idsSchema, to: stringSchema(["front", "back", "forward", "backward"]) }, ["ids", "to"]),
  group: objectSchema({ ids: idsSchema }, ["ids"]),
  ungroup: objectSchema({ ids: idsSchema }, ["ids"]),
  flip: objectSchema({ ids: idsSchema, axis: stringSchema(["x", "y"]) }, ["ids", "axis"]),
  lock: objectSchema({ ids: idsSchema }, ["ids"]),
  unlock: objectSchema({ ids: idsSchema }, ["ids"]),
  batch: objectSchema({ ops: { type: "array", items: objectSchema({ name: stringSchema(), arguments: openObjectSchema }, ["name"]) } }, ["ops"]),
}

export interface ServerToolDefinition {
  type: "function"
  function: { name: ServerToolName; description: string; parameters: JsonSchema }
}

export const SERVER_TOOL_DEFINITIONS: ServerToolDefinition[] = SERVER_TOOL_NAMES.map((name) => ({
  type: "function",
  function: {
    name,
    description: name === "batch"
      ? "Run several Squig document mutations as one atomic tool call. References like $0.id may use earlier results."
      : `Squig ${name.replaceAll("_", " ")}`,
    parameters: SERVER_TOOL_SCHEMAS[name],
  },
}))

export interface ServerToolDraft {
  doc: Doc
  selection: string[]
  ops: Op[]
  inverseOps: Op[]
  affected: string[]
}

export interface ServerToolEnvironment {
  fileName?: string
  viewport?: Viewport
  viewportWidth?: number
  viewportHeight?: number
}

export interface ServerToolContext {
  allocateId(doc: Doc): string
  environment?: ServerToolEnvironment
}

export interface ServerToolOutcome {
  content: { type: "text"; text: string }[]
  affected: string[]
  summary: string
  id?: string
  ids?: string[]
  data?: unknown
}

export interface ServerToolResult {
  draft: ServerToolDraft
  outcome: ServerToolOutcome
}

const REDUCER_CONTEXT: OpContext = {
  getDef,
  nanoid: () => { throw new Error("Server operations must carry resolved ids") },
  seed: seedFromId,
}

export function createServerToolDraft(doc: Doc, selection: readonly string[] = []): ServerToolDraft {
  return {
    doc,
    selection: selection.filter((nodeId) => !!doc.nodes[nodeId] && !doc.nodes[nodeId].locked),
    ops: [],
    inverseOps: [],
    affected: [],
  }
}

function outcome(affected: string[], summary: string, extra: Partial<Omit<ServerToolOutcome, "content" | "affected" | "summary">> = {}): ServerToolOutcome {
  return { content: [{ type: "text", text: summary }], affected, summary, ...extra }
}

function record(value: unknown, label = "arguments"): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as UnknownRecord
}

function exact(value: UnknownRecord, allowed: readonly string[], label = "arguments"): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new TypeError(`Unknown ${label} property: ${unknown}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`)
  return value
}

function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finite(value, label)
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${label} must be one of ${values.join(", ")}`)
  return value as T
}

function optionalChoice<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  return value === undefined ? undefined : choice(value, values, label)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return value
}

function allocateId(draft: ServerToolDraft, context: ServerToolContext): string {
  const next = context.allocateId(draft.doc)
  if (!next || draft.doc.nodes[next]) throw new Error("allocateId must return a new non-empty id")
  return next
}

function resolveIds(value: unknown, draft: ServerToolDraft, options: { allowLocked?: boolean; min?: number } = {}): string[] {
  const raw = value === "selection" ? draft.selection : value
  if (!Array.isArray(raw) || raw.some((nodeId) => typeof nodeId !== "string")) throw new TypeError("ids must be an array of ids or selection")
  const wanted = new Set(raw as string[])
  const resolved = draft.doc.order.filter((nodeId) => wanted.has(nodeId))
  if (resolved.length !== wanted.size) throw new RangeError("Every target id must exist")
  if (resolved.length < (options.min ?? 1)) throw new RangeError(`At least ${options.min ?? 1} target is required`)
  if (!options.allowLocked && resolved.some((nodeId) => draft.doc.nodes[nodeId].locked)) throw new Error("Locked targets cannot be changed")
  return resolved
}

function apply(draft: ServerToolDraft, op: Op, selection?: string[]): ServerToolResult {
  const before = draft.doc
  const result = applyOp(before, op, REDUCER_CONTEXT)
  if (!validDocument(result.doc)) throw new RangeError("Tool would create an invalid Squig document")
  const nextSelection = selection ?? draft.selection.filter((nodeId) => !!result.doc.nodes[nodeId] && !result.doc.nodes[nodeId].locked)
  const affected = [...new Set([...draft.affected, ...result.affected])]
  return {
    draft: {
      doc: result.doc,
      selection: nextSelection,
      ops: result.affected.length ? [...draft.ops, op] : draft.ops,
      inverseOps: result.affected.length ? [...invert(op, before), ...draft.inverseOps] : draft.inverseOps,
      affected,
    },
    outcome: outcome(result.affected, result.summary),
  }
}

function createNode<T extends SquigNode>(draft: ServerToolDraft, node: Omit<T, "id" | "seed">, context: ServerToolContext): ServerToolResult {
  const id = allocateId(draft, context)
  const result = apply(draft, { t: "add", node: { ...node, id, seed: seedFromId(id) } as T }, [id])
  return { draft: result.draft, outcome: { ...result.outcome, id } }
}

function belowDocument(doc: Doc, size: { w: number; h: number }, environment?: ServerToolEnvironment): { x: number; y: number } {
  const viewport = environment?.viewport
  const viewportWidth = environment?.viewportWidth
  const viewportHeight = environment?.viewportHeight
  const nodes = doc.order.map((nodeId) => doc.nodes[nodeId]).filter((node) => {
    if (!node || !viewport || viewportWidth === undefined || viewportHeight === undefined) return !!node
    const [left, top] = screenToWorld(viewport, 0, 0)
    const [right, bottom] = screenToWorld(viewport, viewportWidth, viewportHeight)
    const bounds = nodeVisualBounds(node)
    return bounds.x + bounds.w >= left && bounds.x <= right && bounds.y + bounds.h >= top && bounds.y <= bottom
  })
  if (!nodes.length) {
    if (viewport && viewportWidth !== undefined && viewportHeight !== undefined) {
      const [centerX, centerY] = screenToWorld(viewport, viewportWidth / 2, viewportHeight / 2)
      return { x: centerX - size.w / 2, y: centerY - size.h / 2 }
    }
    return { x: 0, y: 0 }
  }
  return {
    x: Math.min(...nodes.map((node) => nodeVisualBounds(node).x)),
    y: Math.max(...nodes.map((node) => {
      const bounds = nodeVisualBounds(node)
      return bounds.y + bounds.h
    })) + Math.min(80, Math.max(24, size.h / 4)),
  }
}

function resolveArrowEnd(value: unknown, anchorValue: unknown, draft: ServerToolDraft): { point: [number, number]; id: string | null; anchor: ArrowAnchor | null } {
  if (typeof value === "string") {
    const node = draft.doc.nodes[value]
    if (!node || node.type === "arrow") throw new RangeError(`Arrow target does not exist or is not bindable: ${value}`)
    if (node.locked) throw new Error("Locked targets cannot be changed")
    const anchor = anchorValue === undefined ? "center" : choice(anchorValue, ARROW_ANCHORS, "anchor")
    return { point: anchorPoint(node, anchor), id: node.id, anchor }
  }
  const point = record(value, "arrow endpoint")
  exact(point, ["x", "y"], "arrow endpoint")
  return { point: [finite(point.x, "x"), finite(point.y, "y")], id: null, anchor: null }
}

function omitIdentity(node: TextNode): Omit<TextNode, "id" | "seed"> {
  const rest = { ...node } as Partial<TextNode>
  delete rest.id
  delete rest.seed
  return rest as Omit<TextNode, "id" | "seed">
}

function parseBox(value: unknown): { x: number; y: number; w: number; h: number } {
  const box = record(value, "within")
  exact(box, ["x", "y", "w", "h"], "within")
  return { x: finite(box.x, "x"), y: finite(box.y, "y"), w: finite(box.w, "w"), h: finite(box.h, "h") }
}

function runRead(name: ServerToolName, input: UnknownRecord, draft: ServerToolDraft, context: ServerToolContext): ServerToolResult {
  switch (name) {
    case "get_document":
      exact(input, [])
      return { draft, outcome: outcome([], "get document", { data: describeDoc(draft.doc, { ...context.environment, selection: draft.selection }) }) }
    case "get_selection":
      exact(input, [])
      return { draft, outcome: outcome([], "get selection", { data: describeSelection(draft.doc, draft.selection) }) }
    case "find_nodes":
      exact(input, ["type", "kind", "text", "within"])
      return {
        draft,
        outcome: outcome([], "find nodes", { data: findNodes(draft.doc, {
          ...(input.type !== undefined ? { type: choice(input.type, ["component", "shape", "draw", "text", "arrow", "image"] as const, "type") } : {}),
          ...(input.kind !== undefined ? { kind: text(input.kind, "kind") } : {}),
          ...(input.text !== undefined ? { text: text(input.text, "text") } : {}),
          ...(input.within !== undefined ? { within: parseBox(input.within) } : {}),
        }) }),
      }
    case "list_components":
      exact(input, ["query", "category"])
      return {
        draft,
        outcome: outcome([], "list components", { data: componentCatalog({
          ...(input.query !== undefined ? { query: text(input.query, "query") } : {}),
          ...(input.category !== undefined ? { category: choice(input.category, ["components", "blocks"] as const, "category") as Category } : {}),
        }) }),
      }
    default:
      throw new TypeError(`${name} is not a read tool`)
  }
}

function runMutation(name: ServerToolName, input: UnknownRecord, draft: ServerToolDraft, context: ServerToolContext): ServerToolResult {
  switch (name) {
    case "insert_component": {
      exact(input, ["kind", "props", "x", "y", "w", "h"])
      const kind = text(input.kind, "kind")
      const def = getDef(kind)
      if (!def) throw new RangeError(`Unknown component kind: ${kind}`)
      const props = input.props === undefined ? {} : record(input.props, "props")
      const at = belowDocument(draft.doc, def.size, context.environment)
      const node: Omit<ComponentNode, "id" | "seed"> = {
        type: "component", kind, props: { ...def.defaults, ...props },
        x: optionalFinite(input.x, "x") ?? at.x, y: optionalFinite(input.y, "y") ?? at.y,
        w: optionalFinite(input.w, "w") ?? def.size.w, h: optionalFinite(input.h, "h") ?? def.size.h,
      }
      validateComponentProps(def, props, { ...node, id: "candidate", seed: 0 })
      return createNode<ComponentNode>(draft, node, context)
    }
    case "add_text": {
      exact(input, ["text", "x", "y", "fontSize", "align", "bold", "italic", "boxed", "w"])
      const value = text(input.text, "text")
      const fontSize = optionalFinite(input.fontSize, "fontSize") ?? 24
      const width = optionalFinite(input.w, "w")
      const base: TextNode = {
        id: "draft", seed: 0, type: "text", text: value,
        x: finite(input.x, "x"), y: finite(input.y, "y"), w: width ?? 120, h: Math.max(24, fontSize * 1.3), fontSize,
        ...(width !== undefined ? { fixedW: true } : {}),
        ...(input.align !== undefined ? { align: choice(input.align, ["left", "center", "right"] as const, "align") } : {}),
        ...(input.bold !== undefined ? { bold: optionalBoolean(input.bold, "bold") } : {}),
        ...(input.italic !== undefined ? { italic: optionalBoolean(input.italic, "italic") } : {}),
        ...(input.boxed !== undefined ? { boxed: optionalBoolean(input.boxed, "boxed") } : {}),
      }
      return createNode<TextNode>(draft, omitIdentity({ ...base, ...fitTextBox(base, value, fontSize) }), context)
    }
    case "add_shape":
      exact(input, ["shape", "x", "y", "w", "h", "fill", "stroke", "dashed"])
      return createNode<ShapeNode>(draft, {
        type: "shape", shape: choice(input.shape, ["rect", "ellipse"] as const, "shape") as ShapeKind,
        x: finite(input.x, "x"), y: finite(input.y, "y"), w: finite(input.w, "w"), h: finite(input.h, "h"),
        fill: optionalChoice(input.fill, ["none", "paper", "light", "strong"] as const, "fill") ?? "none",
        ...(input.stroke !== undefined ? { stroke: optionalChoice(input.stroke, ["light", "regular", "heavy"] as const, "stroke") } : {}),
        ...(input.dashed !== undefined ? { dashed: optionalBoolean(input.dashed, "dashed") } : {}),
      }, context)
    case "add_arrow": {
      exact(input, ["from", "to", "anchors", "head", "style"])
      let anchors: unknown[] = []
      if (input.anchors !== undefined) {
        if (!Array.isArray(input.anchors) || input.anchors.length !== 2) throw new TypeError("anchors must contain two anchors")
        anchors = input.anchors
      }
      const from = resolveArrowEnd(input.from, anchors[0], draft)
      const to = resolveArrowEnd(input.to, anchors[1], draft)
      const geometry = endsPatch(from.point, to.point)
      return createNode<ArrowNode>(draft, {
        type: "arrow", x: geometry.x!, y: geometry.y!, w: geometry.w!, h: geometry.h!, points: geometry.points!,
        head: optionalBoolean(input.head, "head") ?? true,
        ...(from.id || to.id ? { bind: [from.id, to.id], anchors: [from.anchor, to.anchor] } : {}),
        ...(input.style !== undefined ? { lineStyle: optionalChoice(input.style, ["straight", "elbow", "curved"] as const, "style") } : {}),
      }, context)
    }
    case "duplicate": {
      exact(input, ["ids", "offset"])
      const ids = resolveIds(input.ids, draft)
      const offset = input.offset === undefined ? { dx: 16, dy: 16 } : record(input.offset, "offset")
      exact(offset, ["dx", "dy"], "offset")
      const idMap: Record<string, string> = {}
      let reservation = draft
      for (const source of ids) {
        const next = allocateId(reservation, context)
        idMap[source] = next
        reservation = { ...reservation, doc: { nodes: { ...reservation.doc.nodes, [next]: draft.doc.nodes[source] }, order: reservation.doc.order } }
      }
      const copies = ids.map((nodeId) => idMap[nodeId])
      const result = apply(draft, { t: "duplicate", ids, offset: [finite(offset.dx, "dx"), finite(offset.dy, "dy")], idMap }, copies)
      return { draft: result.draft, outcome: { ...result.outcome, ids: copies } }
    }
    case "set_props": {
      exact(input, ["ids", "props"])
      const ids = resolveIds(input.ids, draft)
      const props = record(input.props, "props")
      const nodes = ids.map((nodeId) => draft.doc.nodes[nodeId])
      if (nodes.some((node) => node.type !== "component")) throw new TypeError("set_props targets must be components")
      const components = nodes as ComponentNode[]
      if (new Set(components.map((node) => node.kind)).size !== 1) throw new TypeError("set_props targets must have one component kind")
      const def = getDef(components[0].kind)
      if (!def) throw new RangeError(`Unknown component kind: ${components[0].kind}`)
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const node of components) {
        const next = { ...node, props: { ...node.props, ...props } }
        validateComponentProps(def, props, next)
        patches[node.id] = { props: next.props }
      }
      return apply(draft, { t: "updateMany", patches })
    }
    case "set_text": {
      exact(input, ["id", "text"])
      const nodeId = text(input.id, "id")
      resolveIds([nodeId], draft)
      const node = draft.doc.nodes[nodeId]
      if (node.type !== "text") throw new TypeError("set_text target must be text")
      return apply(draft, { t: "update", id: nodeId, patch: fitTextBox(node, text(input.text, "text")) })
    }
    case "set_geometry": {
      exact(input, ["ids", "x", "y", "w", "h"])
      const ids = resolveIds(input.ids, draft)
      const nodes = ids.map((nodeId) => draft.doc.nodes[nodeId])
      const original = unionBounds(nodes)
      if (!original) throw new RangeError("Geometry requires at least one target")
      const next = {
        x: optionalFinite(input.x, "x") ?? original.x, y: optionalFinite(input.y, "y") ?? original.y,
        w: optionalFinite(input.w, "w") ?? original.w, h: optionalFinite(input.h, "h") ?? original.h,
      }
      if (next.w < 0 || next.h < 0) throw new RangeError("w and h cannot be negative")
      return apply(draft, { t: "updateMany", patches: scaleNodes(nodes, original, next) })
    }
    case "set_style": {
      exact(input, ["ids", "ink", "stroke", "fill", "dashed"])
      const ids = resolveIds(input.ids, draft)
      const ink = optionalChoice(input.ink, ["ink", "muted", "faint"] as const, "ink") as InkTone | undefined
      const stroke = optionalChoice(input.stroke, ["light", "regular", "heavy"] as const, "stroke") as StrokeWeight | undefined
      const fill = optionalChoice(input.fill, ["none", "paper", "light", "strong"] as const, "fill") as FillTone | undefined
      const dashed = optionalBoolean(input.dashed, "dashed")
      if ([ink, stroke, fill, dashed].every((value) => value === undefined)) throw new TypeError("At least one style property is required")
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const nodeId of ids) {
        const node = draft.doc.nodes[nodeId]
        if (node.type === "component" || node.type === "image") throw new TypeError(`${node.type} nodes do not expose set_style`)
        if (fill !== undefined && node.type !== "shape") throw new TypeError("fill applies only to shapes")
        if ((stroke !== undefined || dashed !== undefined) && node.type === "text") throw new TypeError("stroke and dashed apply only to outlined nodes")
        patches[nodeId] = {
          ...(ink !== undefined ? { ink } : {}), ...(stroke !== undefined ? { stroke } : {}),
          ...(fill !== undefined ? { fill } : {}), ...(dashed !== undefined ? { dashed } : {}),
        } as Partial<SquigNode>
      }
      return apply(draft, { t: "updateMany", patches })
    }
    case "set_link": {
      exact(input, ["ids", "url"])
      const ids = resolveIds(input.ids, draft)
      if (ids.some((nodeId) => draft.doc.nodes[nodeId].type !== "text")) throw new TypeError("set_link targets must be text")
      const url = text(input.url, "url").trim()
      return apply(draft, { t: "updateMany", patches: Object.fromEntries(ids.map((nodeId) => [nodeId, { link: url || undefined }])) })
    }
    case "remove":
      exact(input, ["ids"])
      return apply(draft, { t: "remove", ids: resolveIds(input.ids, draft) })
    case "align":
      exact(input, ["ids", "edge"])
      return apply(draft, { t: "align", ids: resolveIds(input.ids, draft, { min: 2 }), edge: choice(input.edge, ["left", "hcenter", "right", "top", "vcenter", "bottom"] as const, "edge") })
    case "distribute":
      exact(input, ["ids", "axis"])
      return apply(draft, { t: "distribute", ids: resolveIds(input.ids, draft, { min: 3 }), axis: choice(input.axis, ["h", "v"] as const, "axis") })
    case "reorder":
      exact(input, ["ids", "to"])
      return apply(draft, { t: "reorder", ids: resolveIds(input.ids, draft), to: choice(input.to, ["front", "back", "forward", "backward"] as const, "to") })
    case "group":
      exact(input, ["ids"])
      return apply(draft, { t: "group", ids: resolveIds(input.ids, draft, { min: 2 }), groupId: allocateId(draft, context) })
    case "ungroup":
      exact(input, ["ids"])
      return apply(draft, { t: "ungroup", ids: resolveIds(input.ids, draft) })
    case "flip":
      exact(input, ["ids", "axis"])
      return apply(draft, { t: "flip", ids: resolveIds(input.ids, draft), axis: choice(input.axis, ["x", "y"] as const, "axis") })
    case "lock":
      exact(input, ["ids"])
      return apply(draft, { t: "lock", ids: resolveIds(input.ids, draft), locked: true })
    case "unlock":
      exact(input, ["ids"])
      return apply(draft, { t: "lock", ids: resolveIds(input.ids, draft, { allowLocked: true }), locked: false })
    default:
      throw new TypeError(`${name} is not a mutation tool`)
  }
}

function replaceReferences(value: unknown, outputs: readonly ServerToolOutcome[]): unknown {
  if (typeof value === "string") {
    const match = /^\$(\d+)\.(id|ids)$/.exec(value)
    if (!match) return value
    const prior = outputs[Number(match[1])]
    if (!prior) throw new RangeError(`Unknown batch result reference: ${value}`)
    const resolved = match[2] === "id" ? prior.id : prior.ids
    if (resolved === undefined) throw new RangeError(`Batch result has no ${match[2]}: ${value}`)
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, outputs))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceReferences(item, outputs)]))
  return value
}

function runBatch(input: UnknownRecord, draft: ServerToolDraft, context: ServerToolContext): ServerToolResult {
  exact(input, ["ops"])
  if (!Array.isArray(input.ops)) throw new TypeError("ops must be an array")
  let working = draft
  const outputs: ServerToolOutcome[] = []
  for (const raw of input.ops) {
    const call = record(replaceReferences(raw, outputs), "batch call")
    exact(call, ["name", "arguments"], "batch call")
    const name = text(call.name, "batch call name") as ServerToolName
    if (!MUTATION_NAMES.has(name)) throw new TypeError(`batch supports document mutations, not ${name}`)
    const args = call.arguments === undefined ? {} : record(call.arguments, "batch arguments")
    assertJsonSchema(args, SERVER_TOOL_SCHEMAS[name])
    const result = runMutation(name, args, working, context)
    working = result.draft
    outputs.push(result.outcome)
  }
  const changed = draft.doc.order.length !== working.doc.order.length || !sameValue(draft.doc, working.doc)
  return {
    draft: working,
    outcome: outcome(changed ? working.affected.filter((nodeId) => !draft.affected.includes(nodeId)) : [], `batch: ${outputs.length} calls`, { data: outputs }),
  }
}

/** Pure Worker-safe tool execution: callers own the draft and commit boundary. */
export function executeServerTool(
  draft: ServerToolDraft,
  name: string,
  rawInput: unknown,
  context: ServerToolContext
): ServerToolResult {
  if (!SERVER_TOOL_NAMES.includes(name as ServerToolName)) throw new RangeError(`Unknown tool: ${name}`)
  const toolName = name as ServerToolName
  const input = record(rawInput)
  assertJsonSchema(input, SERVER_TOOL_SCHEMAS[toolName])
  if (["get_document", "get_selection", "find_nodes", "list_components"].includes(toolName)) {
    return runRead(toolName, input, draft, context)
  }
  if (toolName === "batch") return runBatch(input, draft, context)
  return runMutation(toolName, input, draft, context)
}

export function assertServerToolCatalogue(): void {
  if (SERVER_TOOL_NAMES.length !== 24 || new Set(SERVER_TOOL_NAMES).size !== 24) {
    throw new Error("The server catalogue must contain 24 unique tools")
  }
}

/** Merge the common inverse runs without changing replay order. */
export function compactInverseOps(ops: readonly Op[]): Op[] {
  const compact: Op[] = []
  for (const op of ops) {
    const prior = compact.at(-1)
    if (op.t === "remove" && prior?.t === "remove") {
      prior.ids.push(...op.ids.filter((id) => !prior.ids.includes(id)))
    } else if (op.t === "updateMany" && prior?.t === "updateMany") {
      for (const [id, patch] of Object.entries(op.patches)) {
        prior.patches[id] = {
          ...(prior.patches[id] as UnknownRecord | undefined),
          ...(patch as UnknownRecord),
        } as Partial<SquigNode>
      }
    } else {
      compact.push(structuredClone(op))
    }
  }
  return compact.map((op): Op => {
    if (op.t === "update") {
      return { ...op, patch: wirePatch(op.patch) }
    }
    if (op.t === "updateMany") {
      return { ...op, patches: Object.fromEntries(Object.entries(op.patches).map(([id, patch]) => [id, wirePatch(patch)])) }
    }
    return op
  })
}

function wirePatch(patch: Partial<SquigNode>): Partial<SquigNode> {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])) as Partial<SquigNode>
}
