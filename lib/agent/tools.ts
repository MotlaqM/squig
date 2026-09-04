import { nanoid } from "nanoid"
import { anchorPoint, endsPatch } from "../canvas/arrow-binding"
import { nodeVisualBounds } from "../canvas/line-routing"
import { fitViewport, revealViewport } from "../canvas/navigate"
import { fitTextBox } from "../canvas/text-reflow"
import { scaleNodes } from "../canvas/transform"
import { ALL_DEFS, getDef, type Category } from "../library/registry"
import {
  applyOp,
  assertJsonSchema,
  componentCatalog,
  controlsToJsonSchema,
  describeDoc,
  describeSelection,
  findNodes,
  seedFromId,
  validateComponentProps,
  type Doc,
  type JsonSchema,
  type Op,
  type OpContext,
} from "../ops/index"
import { sameValue } from "../ops/value"
import { sharedControls, unionBounds } from "../selection"
import { useSquig } from "../store"
import {
  ARROW_ANCHORS,
  screenToWorld,
  unionBox,
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
import {
  executeToolByName,
  installModelContextShim,
  type ModelContextLike,
  type ModelContextTool,
} from "./model-context-shim"

type SquigStore = Pick<typeof useSquig, "getState" | "setState" | "subscribe">
type UnknownRecord = Record<string, unknown>

export const V1_TOOL_NAMES = [
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
  "select",
  "reveal",
  "undo",
  "redo",
  "batch",
] as const

export type V1ToolName = (typeof V1_TOOL_NAMES)[number]

const STATIC_TOOL_NAMES = V1_TOOL_NAMES.filter((name) => name !== "set_props")
const MUTATION_NAMES = new Set<V1ToolName>([
  "insert_component", "add_text", "add_shape", "add_arrow", "duplicate", "set_props",
  "set_text", "set_geometry", "set_style", "set_link", "remove", "align", "distribute",
  "reorder", "group", "ungroup", "flip", "lock", "unlock",
])

const OP_CONTEXT: OpContext = {
  getDef,
  nanoid: () => nanoid(8),
  seed: seedFromId,
}

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

const SCHEMAS: Record<Exclude<V1ToolName, "set_props">, JsonSchema> = {
  get_document: objectSchema(),
  get_selection: objectSchema(),
  find_nodes: objectSchema({ type: stringSchema(["component", "shape", "draw", "text", "arrow", "image"]), kind: stringSchema(), text: stringSchema(), within: boxSchema }),
  list_components: objectSchema({ query: stringSchema(), category: stringSchema(["components", "blocks"]) }),
  insert_component: objectSchema({ kind: stringSchema(), props: openObjectSchema, x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema }, ["kind"]),
  add_text: objectSchema({ text: stringSchema(), x: numberSchema, y: numberSchema, fontSize: numberSchema, align: stringSchema(["left", "center", "right"]), bold: booleanSchema, italic: booleanSchema, boxed: booleanSchema, w: numberSchema }, ["text", "x", "y"]),
  add_shape: objectSchema({ shape: stringSchema(["rect", "ellipse"]), x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema, fill: stringSchema(["none", "paper", "light", "strong"]), stroke: stringSchema(["light", "regular", "heavy"]), dashed: booleanSchema }, ["shape", "x", "y", "w", "h"]),
  add_arrow: objectSchema({ from: { oneOf: [stringSchema(), pointSchema] }, to: { oneOf: [stringSchema(), pointSchema] }, anchors: { type: "array", items: stringSchema(ARROW_ANCHORS) }, head: booleanSchema, style: stringSchema(["straight", "elbow", "curved"]) }, ["from", "to"]),
  duplicate: objectSchema({ ids: idsSchema, offset: objectSchema({ dx: numberSchema, dy: numberSchema }, ["dx", "dy"]) }, ["ids"]),
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
  select: objectSchema({ ids: idsSchema }, ["ids"]),
  reveal: objectSchema({ ids: idsSchema }, ["ids"]),
  undo: objectSchema(),
  redo: objectSchema(),
  batch: objectSchema({ ops: { type: "array", items: objectSchema({ name: stringSchema(), arguments: openObjectSchema }, ["name"]) } }, ["ops"]),
}

interface Draft {
  doc: Doc
  selection: string[]
}

interface ToolEnvironment {
  viewport: Viewport
  viewportWidth: number
  viewportHeight: number
}

interface ToolOutcome {
  content: { type: "text"; text: string }[]
  affected: string[]
  summary: string
  id?: string
  ids?: string[]
  data?: unknown
}

function outcome(affected: string[], summary: string, extra: Partial<Omit<ToolOutcome, "content" | "affected" | "summary">> = {}): ToolOutcome {
  return { content: [{ type: "text", text: summary }], affected, summary, ...extra }
}

interface ToolCall {
  name: V1ToolName
  arguments?: UnknownRecord
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

function currentDoc(store: SquigStore): Doc {
  const state = store.getState()
  return { nodes: state.nodes, order: state.order }
}

function resolveIds(value: unknown, draft: Draft, options: { allowLocked?: boolean; min?: number } = {}): string[] {
  const raw = value === "selection" ? draft.selection : value
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw new TypeError("ids must be an array of ids or selection")
  const wanted = new Set(raw as string[])
  const ids = draft.doc.order.filter((id) => wanted.has(id))
  if (ids.length !== wanted.size) throw new RangeError("Every target id must exist")
  if (ids.length < (options.min ?? 1)) throw new RangeError(`At least ${options.min ?? 1} target is required`)
  if (!options.allowLocked && ids.some((id) => draft.doc.nodes[id].locked)) throw new DOMException("Locked targets cannot be changed", "InvalidStateError")
  return ids
}

function apply(draft: Draft, op: Op, selection?: string[]): ToolOutcome {
  const result = applyOp(draft.doc, op, OP_CONTEXT)
  draft.doc = result.doc
  if (selection) draft.selection = selection
  else draft.selection = draft.selection.filter((id) => !!result.doc.nodes[id] && !result.doc.nodes[id].locked)
  return outcome(result.affected, result.summary)
}

function makeId(doc: Doc): string {
  let id = nanoid(8)
  while (doc.nodes[id]) id = nanoid(8)
  return id
}

function createNode<T extends SquigNode>(draft: Draft, node: Omit<T, "id" | "seed">): ToolOutcome {
  const id = makeId(draft.doc)
  const outcome = apply(draft, { t: "add", node: { ...node, id, seed: seedFromId(id) } as T }, [id])
  return { ...outcome, id }
}

function belowVisibleDocument(doc: Doc, environment: ToolEnvironment, size: { w: number; h: number }): { x: number; y: number } {
  const { viewport, viewportWidth, viewportHeight } = environment
  const [left, top] = screenToWorld(viewport, 0, 0)
  const [right, bottom] = screenToWorld(viewport, viewportWidth, viewportHeight)
  const visible = doc.order
    .map((id) => doc.nodes[id])
    .filter((node) => {
      if (!node) return false
      const bounds = nodeVisualBounds(node)
      return bounds.x + bounds.w >= left && bounds.x <= right && bounds.y + bounds.h >= top && bounds.y <= bottom
    })
  if (visible.length) {
    return {
      x: Math.min(...visible.map((node) => nodeVisualBounds(node).x)),
      y: Math.max(...visible.map((node) => {
        const bounds = nodeVisualBounds(node)
        return bounds.y + bounds.h
      })) + Math.min(80, Math.max(24, size.h / 4)),
    }
  }
  const [centerX, centerY] = screenToWorld(viewport, viewportWidth / 2, viewportHeight / 2)
  return { x: centerX - size.w / 2, y: centerY - size.h / 2 }
}

function resolveArrowEnd(value: unknown, anchorValue: unknown, draft: Draft): { point: [number, number]; id: string | null; anchor: ArrowAnchor | null } {
  if (typeof value === "string") {
    const node = draft.doc.nodes[value]
    if (!node || node.type === "arrow") throw new RangeError(`Arrow target does not exist or is not bindable: ${value}`)
    if (node.locked) throw new DOMException("Locked targets cannot be changed", "InvalidStateError")
    const anchor = anchorValue === undefined ? "center" : choice(anchorValue, ARROW_ANCHORS, "anchor")
    return { point: anchorPoint(node, anchor), id: node.id, anchor }
  }
  const point = record(value, "arrow endpoint")
  exact(point, ["x", "y"], "arrow endpoint")
  return { point: [finite(point.x, "x"), finite(point.y, "y")], id: null, anchor: null }
}

function compileMutation(name: V1ToolName, rawInput: UnknownRecord, draft: Draft, environment: ToolEnvironment): ToolOutcome {
  switch (name) {
    case "insert_component": {
      exact(rawInput, ["kind", "props", "x", "y", "w", "h"])
      const kind = text(rawInput.kind, "kind")
      const def = getDef(kind)
      if (!def) throw new RangeError(`Unknown component kind: ${kind}`)
      const props = rawInput.props === undefined ? {} : record(rawInput.props, "props")
      const at = belowVisibleDocument(draft.doc, environment, def.size)
      const node: Omit<ComponentNode, "id" | "seed"> = {
        type: "component",
        kind,
        props: { ...def.defaults, ...props },
        x: optionalFinite(rawInput.x, "x") ?? at.x,
        y: optionalFinite(rawInput.y, "y") ?? at.y,
        w: optionalFinite(rawInput.w, "w") ?? def.size.w,
        h: optionalFinite(rawInput.h, "h") ?? def.size.h,
      }
      validateComponentProps(def, props, { ...node, id: "candidate", seed: 0 })
      return createNode<ComponentNode>(draft, node)
    }
    case "add_text": {
      exact(rawInput, ["text", "x", "y", "fontSize", "align", "bold", "italic", "boxed", "w"])
      const value = text(rawInput.text, "text")
      const fontSize = optionalFinite(rawInput.fontSize, "fontSize") ?? 24
      const width = optionalFinite(rawInput.w, "w")
      const base: TextNode = {
        id: "draft",
        seed: 0,
        type: "text",
        text: value,
        x: finite(rawInput.x, "x"),
        y: finite(rawInput.y, "y"),
        w: width ?? 120,
        h: Math.max(24, fontSize * 1.3),
        fontSize,
        ...(width !== undefined ? { fixedW: true } : {}),
        ...(rawInput.align !== undefined ? { align: choice(rawInput.align, ["left", "center", "right"] as const, "align") } : {}),
        ...(rawInput.bold !== undefined ? { bold: optionalBoolean(rawInput.bold, "bold") } : {}),
        ...(rawInput.italic !== undefined ? { italic: optionalBoolean(rawInput.italic, "italic") } : {}),
        ...(rawInput.boxed !== undefined ? { boxed: optionalBoolean(rawInput.boxed, "boxed") } : {}),
      }
      const fitted = { ...base, ...fitTextBox(base, value, fontSize) }
      return createNode<TextNode>(draft, omitIdentity(fitted))
    }
    case "add_shape": {
      exact(rawInput, ["shape", "x", "y", "w", "h", "fill", "stroke", "dashed"])
      return createNode<ShapeNode>(draft, {
        type: "shape",
        shape: choice(rawInput.shape, ["rect", "ellipse"] as const, "shape") as ShapeKind,
        x: finite(rawInput.x, "x"), y: finite(rawInput.y, "y"),
        w: finite(rawInput.w, "w"), h: finite(rawInput.h, "h"),
        fill: optionalChoice(rawInput.fill, ["none", "paper", "light", "strong"] as const, "fill") ?? "none",
        ...(rawInput.stroke !== undefined ? { stroke: optionalChoice(rawInput.stroke, ["light", "regular", "heavy"] as const, "stroke") } : {}),
        ...(rawInput.dashed !== undefined ? { dashed: optionalBoolean(rawInput.dashed, "dashed") } : {}),
      })
    }
    case "add_arrow": {
      exact(rawInput, ["from", "to", "anchors", "head", "style"])
      let anchors: unknown[] = []
      if (rawInput.anchors !== undefined) {
        if (!Array.isArray(rawInput.anchors) || rawInput.anchors.length !== 2) throw new TypeError("anchors must contain two anchors")
        anchors = rawInput.anchors
      }
      const from = resolveArrowEnd(rawInput.from, anchors[0], draft)
      const to = resolveArrowEnd(rawInput.to, anchors[1], draft)
      const geometry = endsPatch(from.point, to.point)
      return createNode<ArrowNode>(draft, {
        type: "arrow",
        x: geometry.x!, y: geometry.y!, w: geometry.w!, h: geometry.h!, points: geometry.points!,
        head: optionalBoolean(rawInput.head, "head") ?? true,
        ...(from.id || to.id ? { bind: [from.id, to.id], anchors: [from.anchor, to.anchor] } : {}),
        ...(rawInput.style !== undefined ? { lineStyle: optionalChoice(rawInput.style, ["straight", "elbow", "curved"] as const, "style") } : {}),
      })
    }
    case "duplicate": {
      exact(rawInput, ["ids", "offset"])
      const ids = resolveIds(rawInput.ids, draft)
      const offset = rawInput.offset === undefined ? { dx: 16, dy: 16 } : record(rawInput.offset, "offset")
      exact(offset, ["dx", "dy"], "offset")
      const idMap = Object.fromEntries(ids.map((id) => [id, makeId({ ...draft.doc, nodes: { ...draft.doc.nodes } })]))
      const reserved = new Set<string>()
      for (const source of ids) {
        let next = idMap[source]
        while (reserved.has(next) || draft.doc.nodes[next]) next = nanoid(8)
        idMap[source] = next
        reserved.add(next)
      }
      const copies = ids.map((id) => idMap[id])
      const outcome = apply(draft, { t: "duplicate", ids, offset: [finite(offset.dx, "dx"), finite(offset.dy, "dy")], idMap }, copies)
      return { ...outcome, ids: copies }
    }
    case "set_props": {
      exact(rawInput, ["ids", "props"])
      const ids = resolveIds(rawInput.ids, draft)
      const props = record(rawInput.props, "props")
      const nodes = ids.map((id) => draft.doc.nodes[id])
      if (nodes.some((node) => node.type !== "component")) throw new TypeError("set_props targets must be components")
      const components = nodes as ComponentNode[]
      const kinds = new Set(components.map((node) => node.kind))
      if (kinds.size !== 1) throw new TypeError("set_props targets must have one component kind")
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
      exact(rawInput, ["id", "text"])
      const id = text(rawInput.id, "id")
      resolveIds([id], draft)
      const node = draft.doc.nodes[id]
      if (node.type !== "text") throw new TypeError("set_text target must be text")
      return apply(draft, { t: "update", id, patch: fitTextBox(node, text(rawInput.text, "text")) })
    }
    case "set_geometry": {
      exact(rawInput, ["ids", "x", "y", "w", "h"])
      const ids = resolveIds(rawInput.ids, draft)
      const nodes = ids.map((id) => draft.doc.nodes[id])
      const orig = unionBounds(nodes)
      if (!orig) throw new RangeError("Geometry requires at least one target")
      const next = {
        x: optionalFinite(rawInput.x, "x") ?? orig.x,
        y: optionalFinite(rawInput.y, "y") ?? orig.y,
        w: optionalFinite(rawInput.w, "w") ?? orig.w,
        h: optionalFinite(rawInput.h, "h") ?? orig.h,
      }
      if (next.w < 0 || next.h < 0) throw new RangeError("w and h cannot be negative")
      return apply(draft, { t: "updateMany", patches: scaleNodes(nodes, orig, next) })
    }
    case "set_style": {
      exact(rawInput, ["ids", "ink", "stroke", "fill", "dashed"])
      const ids = resolveIds(rawInput.ids, draft)
      const ink = optionalChoice(rawInput.ink, ["ink", "muted", "faint"] as const, "ink") as InkTone | undefined
      const stroke = optionalChoice(rawInput.stroke, ["light", "regular", "heavy"] as const, "stroke") as StrokeWeight | undefined
      const fill = optionalChoice(rawInput.fill, ["none", "paper", "light", "strong"] as const, "fill") as FillTone | undefined
      const dashed = optionalBoolean(rawInput.dashed, "dashed")
      if ([ink, stroke, fill, dashed].every((value) => value === undefined)) throw new TypeError("At least one style property is required")
      const patches: Record<string, Partial<SquigNode>> = {}
      for (const id of ids) {
        const node = draft.doc.nodes[id]
        if (node.type === "component" || node.type === "image") throw new TypeError(`${node.type} nodes do not expose set_style`)
        if (fill !== undefined && node.type !== "shape") throw new TypeError("fill applies only to shapes")
        if ((stroke !== undefined || dashed !== undefined) && node.type === "text") {
          throw new TypeError("stroke and dashed apply only to outlined nodes")
        }
        patches[id] = {
          ...(ink !== undefined ? { ink } : {}),
          ...(stroke !== undefined ? { stroke } : {}),
          ...(fill !== undefined ? { fill } : {}),
          ...(dashed !== undefined ? { dashed } : {}),
        } as Partial<SquigNode>
      }
      return apply(draft, { t: "updateMany", patches })
    }
    case "set_link": {
      exact(rawInput, ["ids", "url"])
      const ids = resolveIds(rawInput.ids, draft)
      if (ids.some((id) => draft.doc.nodes[id].type !== "text")) throw new TypeError("set_link targets must be text")
      const url = text(rawInput.url, "url").trim()
      return apply(draft, { t: "updateMany", patches: Object.fromEntries(ids.map((id) => [id, { link: url || undefined }])) })
    }
    case "remove":
      exact(rawInput, ["ids"])
      return apply(draft, { t: "remove", ids: resolveIds(rawInput.ids, draft) })
    case "align":
      exact(rawInput, ["ids", "edge"])
      return apply(draft, { t: "align", ids: resolveIds(rawInput.ids, draft, { min: 2 }), edge: choice(rawInput.edge, ["left", "hcenter", "right", "top", "vcenter", "bottom"] as const, "edge") })
    case "distribute":
      exact(rawInput, ["ids", "axis"])
      return apply(draft, { t: "distribute", ids: resolveIds(rawInput.ids, draft, { min: 3 }), axis: choice(rawInput.axis, ["h", "v"] as const, "axis") })
    case "reorder":
      exact(rawInput, ["ids", "to"])
      return apply(draft, { t: "reorder", ids: resolveIds(rawInput.ids, draft), to: choice(rawInput.to, ["front", "back", "forward", "backward"] as const, "to") })
    case "group":
      exact(rawInput, ["ids"])
      return apply(draft, { t: "group", ids: resolveIds(rawInput.ids, draft, { min: 2 }), groupId: makeId(draft.doc) })
    case "ungroup":
      exact(rawInput, ["ids"])
      return apply(draft, { t: "ungroup", ids: resolveIds(rawInput.ids, draft) })
    case "flip":
      exact(rawInput, ["ids", "axis"])
      return apply(draft, { t: "flip", ids: resolveIds(rawInput.ids, draft), axis: choice(rawInput.axis, ["x", "y"] as const, "axis") })
    case "lock":
      exact(rawInput, ["ids"])
      return apply(draft, { t: "lock", ids: resolveIds(rawInput.ids, draft), locked: true })
    case "unlock":
      exact(rawInput, ["ids"])
      return apply(draft, { t: "lock", ids: resolveIds(rawInput.ids, draft, { allowLocked: true }), locked: false })
    default:
      throw new TypeError(`${name} is not a document mutation`)
  }
}

function omitIdentity(node: TextNode): Omit<TextNode, "id" | "seed"> {
  const rest = { ...node } as Partial<TextNode>
  delete rest.id
  delete rest.seed
  return rest as Omit<TextNode, "id" | "seed">
}

function replaceReferences(value: unknown, outputs: readonly ToolOutcome[]): unknown {
  if (typeof value === "string") {
    const match = /^\$(\d+)\.(id|ids)$/.exec(value)
    if (!match) return value
    const output = outputs[Number(match[1])]
    if (!output) throw new RangeError(`Unknown batch result reference: ${value}`)
    const resolved = match[2] === "id" ? output.id : output.ids
    if (resolved === undefined) throw new RangeError(`Batch result has no ${match[2]}: ${value}`)
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, outputs))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceReferences(item, outputs)]))
  }
  return value
}

function parseCall(value: unknown): ToolCall {
  const call = record(value, "batch call")
  exact(call, ["name", "arguments"], "batch call")
  const name = text(call.name, "batch call name") as V1ToolName
  if (!V1_TOOL_NAMES.includes(name)) throw new RangeError(`Unknown tool: ${name}`)
  return { name, arguments: call.arguments === undefined ? {} : record(call.arguments, "batch arguments") }
}

function commitDraft(store: SquigStore, before: Draft, draft: Draft): boolean {
  const state = store.getState()
  return state.edit(() => {
    store.setState({
      nodes: draft.doc.nodes,
      order: draft.doc.order,
      selection: draft.selection,
      selectionGroupId: null,
    })
  }) || !sameValue(before.selection, draft.selection)
}

function environmentFor(store: SquigStore, ownerWindow: Window): ToolEnvironment {
  return {
    viewport: store.getState().viewport,
    viewportWidth: ownerWindow.innerWidth,
    viewportHeight: ownerWindow.innerHeight,
  }
}

function runMutation(store: SquigStore, ownerWindow: Window, name: V1ToolName, input: UnknownRecord): ToolOutcome {
  const state = store.getState()
  const before: Draft = { doc: currentDoc(store), selection: [...state.selection] }
  const draft: Draft = { doc: before.doc, selection: [...before.selection] }
  const outcome = compileMutation(name, input, draft, environmentFor(store, ownerWindow))
  commitDraft(store, before, draft)
  return outcome
}

function runBatch(store: SquigStore, ownerWindow: Window, input: UnknownRecord): ToolOutcome {
  exact(input, ["ops"])
  if (!Array.isArray(input.ops)) throw new TypeError("ops must be an array")
  const state = store.getState()
  const before: Draft = { doc: currentDoc(store), selection: [...state.selection] }
  const draft: Draft = { doc: before.doc, selection: [...before.selection] }
  const environment = environmentFor(store, ownerWindow)
  const outputs: ToolOutcome[] = []

  for (const rawCall of input.ops) {
    const call = parseCall(replaceReferences(rawCall, outputs))
    if (!MUTATION_NAMES.has(call.name) && call.name !== "select") {
      throw new TypeError(`batch supports document mutations and select, not ${call.name}`)
    }
    if (call.name !== "set_props") assertJsonSchema(call.arguments ?? {}, SCHEMAS[call.name])
    if (call.name === "select") {
      exact(call.arguments ?? {}, ["ids"])
      draft.selection = resolveIds(call.arguments?.ids, draft)
      outputs.push(outcome([], `select: ${draft.selection.length} nodes`, { ids: [...draft.selection] }))
    } else {
      outputs.push(compileMutation(call.name, call.arguments ?? {}, draft, environment))
    }
  }

  commitDraft(store, before, draft)
  return outcome(affectedAcross(before.doc, draft.doc), `batch: ${outputs.length} calls`, { data: outputs })
}

function affectedAcross(before: Doc, after: Doc): string[] {
  const ids = new Set([...before.order, ...after.order])
  return [...ids].filter((id) => !sameValue(before.nodes[id], after.nodes[id]) || before.order.indexOf(id) !== after.order.indexOf(id))
}

function readTool(store: SquigStore, name: V1ToolName, input: UnknownRecord): unknown {
  const state = store.getState()
  const doc = currentDoc(store)
  switch (name) {
    case "get_document":
      exact(input, [])
      return describeDoc(doc, { fileName: state.fileName, viewport: state.viewport, selection: state.selection })
    case "get_selection":
      exact(input, [])
      return describeSelection(doc, state.selection)
    case "find_nodes":
      exact(input, ["type", "kind", "text", "within"])
      return findNodes(doc, {
        ...(input.type !== undefined ? { type: choice(input.type, ["component", "shape", "draw", "text", "arrow", "image"] as const, "type") } : {}),
        ...(input.kind !== undefined ? { kind: text(input.kind, "kind") } : {}),
        ...(input.text !== undefined ? { text: text(input.text, "text") } : {}),
        ...(input.within !== undefined ? { within: parseBox(input.within) } : {}),
      })
    case "list_components":
      exact(input, ["query", "category"])
      return componentCatalog({
        ...(input.query !== undefined ? { query: text(input.query, "query") } : {}),
        ...(input.category !== undefined ? { category: choice(input.category, ["components", "blocks"] as const, "category") as Category } : {}),
      })
    default:
      throw new TypeError(`${name} is not a read tool`)
  }
}

function parseBox(value: unknown): { x: number; y: number; w: number; h: number } {
  const box = record(value, "within")
  exact(box, ["x", "y", "w", "h"], "within")
  return { x: finite(box.x, "x"), y: finite(box.y, "y"), w: finite(box.w, "w"), h: finite(box.h, "h") }
}

function executeStatic(store: SquigStore, ownerWindow: Window, name: Exclude<V1ToolName, "set_props">, input: UnknownRecord): unknown {
  if (["get_document", "get_selection", "find_nodes", "list_components"].includes(name)) return readTool(store, name, input)
  if (MUTATION_NAMES.has(name)) return runMutation(store, ownerWindow, name, input)
  const state = store.getState()
  switch (name) {
    case "select": {
      exact(input, ["ids"])
      const draft = { doc: currentDoc(store), selection: [...state.selection] }
      const ids = resolveIds(input.ids, draft)
      state.setSelection(ids)
      return outcome([], `select: ${ids.length} nodes`, { ids })
    }
    case "reveal": {
      exact(input, ["ids"])
      const draft = { doc: currentDoc(store), selection: [...state.selection] }
      const ids = resolveIds(input.ids, draft, { allowLocked: true })
      const box = unionBox(ids.map((id) => nodeVisualBounds(draft.doc.nodes[id])))
      if (!box) throw new RangeError("Nothing to reveal")
      const reveal = revealViewport(state.viewport, box, ownerWindow.innerWidth, ownerWindow.innerHeight)
      if (reveal.kind === "pan") state.setViewport(reveal.viewport)
      else if (reveal.kind === "fit") state.setViewport(fitViewport(box, ownerWindow.innerWidth, ownerWindow.innerHeight).viewport)
      return outcome([], `reveal: ${reveal.kind}`, { ids })
    }
    case "undo":
      exact(input, [])
      state.undo()
      return outcome([], "undo")
    case "redo":
      exact(input, [])
      state.redo()
      return outcome([], "redo")
    case "batch": return runBatch(store, ownerWindow, input)
    default: throw new RangeError(`Unknown static tool: ${name}`)
  }
}

function eligibleComponentSelection(store: SquigStore): { kind: string; nodes: ComponentNode[] } | null {
  const state = store.getState()
  if (!state.selection.length) return null
  const nodes = state.selection.map((id) => state.nodes[id])
  if (nodes.some((node) => node?.type !== "component" || node.locked)) return null
  const components = nodes as ComponentNode[]
  const kind = components[0].kind
  return components.every((node) => node.kind === kind) ? { kind, nodes: components } : null
}

function sharedPropsSchema(eligible: { kind: string; nodes: ComponentNode[] }): JsonSchema {
  const def = getDef(eligible.kind)!
  return controlsToJsonSchema(def, eligible.nodes[0], sharedControls(eligible.nodes))
}

function staticDefinition(store: SquigStore, ownerWindow: Window, name: Exclude<V1ToolName, "set_props">): ModelContextTool {
  return {
    name,
    title: name.replaceAll("_", " "),
    description: `Squig ${name.replaceAll("_", " ")}`,
    inputSchema: SCHEMAS[name],
    annotations: { readOnlyHint: ["get_document", "get_selection", "find_nodes", "list_components"].includes(name) },
    execute: (input) => {
      assertJsonSchema(input, SCHEMAS[name])
      return executeStatic(store, ownerWindow, name, record(input))
    },
  }
}

function dynamicPropsDefinition(store: SquigStore, ownerWindow: Window, eligible: { kind: string; nodes: ComponentNode[] }): ModelContextTool {
  const def = getDef(eligible.kind)!
  const inputSchema = objectSchema({
    ids: idsSchema,
    props: sharedPropsSchema(eligible),
  }, ["ids", "props"])
  return {
    name: "set_props",
    title: `set ${def.name} props`,
    description: `Set properties shared by the selected ${def.name} component${eligible.nodes.length === 1 ? "" : "s"}`,
    inputSchema,
    execute: (input) => {
      assertJsonSchema(input, inputSchema)
      return runMutation(store, ownerWindow, "set_props", record(input))
    },
  }
}

export interface SquigToolRegistration {
  context: ModelContextLike
  refresh(): Promise<void>
  dispose(): void
}

/** Register the static catalogue and keep set_props matched to component selection. */
export async function registerSquigTools(
  targetDocument: Document = document,
  targetWindow: Window = targetDocument.defaultView ?? window,
  store: SquigStore = useSquig
): Promise<SquigToolRegistration> {
  const context = installModelContextShim(targetDocument, targetWindow)
  const staticController = new AbortController()
  for (const name of STATIC_TOOL_NAMES) {
    await context.registerTool(staticDefinition(store, targetWindow, name), { signal: staticController.signal })
  }

  let dynamicController: AbortController | null = null
  let dynamicSignature: string | null = null
  let disposed = false
  let queue = Promise.resolve()

  const refreshNow = async () => {
    if (disposed) return
    const eligible = eligibleComponentSelection(store)
    const nextSignature = eligible
      ? `${eligible.kind}:${JSON.stringify(sharedPropsSchema(eligible))}`
      : null
    if (nextSignature === dynamicSignature) return
    dynamicController?.abort()
    dynamicController = null
    dynamicSignature = nextSignature
    if (!eligible) return
    const controller = new AbortController()
    dynamicController = controller
    await context.registerTool(dynamicPropsDefinition(store, targetWindow, eligible), { signal: controller.signal })
  }
  const refresh = () => {
    queue = queue.then(refreshNow)
    return queue
  }
  await refresh()
  const unsubscribe = store.subscribe((state, previous) => {
    if (!sameValue(state.selection, previous.selection) || state.nodes !== previous.nodes) void refresh()
  })

  const windowWithHelpers = targetWindow as Window & {
    __squigTools?: () => Promise<unknown>
    __squigExecuteTool?: (name: string, input?: UnknownRecord, options?: { signal?: AbortSignal }) => Promise<string>
  }
  windowWithHelpers.__squigTools = () => context.getTools()
  windowWithHelpers.__squigExecuteTool = (name, input = {}, options = {}) => executeToolByName(context, name, input, options)

  return {
    context,
    refresh,
    dispose() {
      disposed = true
      unsubscribe()
      dynamicController?.abort()
      staticController.abort()
      delete windowWithHelpers.__squigTools
      delete windowWithHelpers.__squigExecuteTool
    },
  }
}

/** Conventional export name used by tests and small host integrations. */
export const registerTools = registerSquigTools

/** Catalogue guard: all 28 bullets in brief section 5, even though one is dynamic. */
export function assertV1Catalogue(): void {
  if (V1_TOOL_NAMES.length !== 28 || new Set(V1_TOOL_NAMES).size !== 28) throw new Error("The v1 tool catalogue must contain 28 unique names")
  if (ALL_DEFS.some((def) => !def.kind)) throw new Error("Every component definition needs a kind")
}
