import { nanoid } from "nanoid"
import { nodeVisualBounds } from "../canvas/line-routing"
import { fitViewport, revealViewport } from "../canvas/navigate"
import { ALL_DEFS, getDef } from "../library/registry"
import { assertJsonSchema, controlsToJsonSchema, type Doc, type JsonSchema } from "../ops/index"
import { sameValue } from "../ops/value"
import { sharedControls } from "../selection"
import { useSquig } from "../store"
import { unionBox, type ComponentNode } from "../types"
import {
  createServerToolDraft,
  executeServerTool,
  SERVER_TOOL_DEFINITIONS,
  SERVER_TOOL_NAMES,
  SERVER_TOOL_SCHEMAS,
  type ServerToolName,
} from "./server-tools"
import {
  executeToolByName,
  installModelContextShim,
  type ModelContextLike,
  type ModelContextTool,
} from "./model-context-shim"

type SquigStore = Pick<typeof useSquig, "getState" | "setState" | "subscribe">
type UnknownRecord = Record<string, unknown>

export const V1_TOOL_NAMES = [
  "get_document", "get_selection", "find_nodes", "list_components",
  "insert_component", "add_text", "add_shape", "add_arrow", "duplicate",
  "set_props", "set_text", "set_geometry", "set_style", "set_link", "remove",
  "align", "distribute", "reorder", "group", "ungroup", "flip", "lock", "unlock",
  "select", "reveal", "undo", "redo", "batch",
] as const

export type V1ToolName = (typeof V1_TOOL_NAMES)[number]

const STATIC_TOOL_NAMES = V1_TOOL_NAMES.filter((name) => name !== "set_props")
const READ_NAMES = new Set<ServerToolName>(["get_document", "get_selection", "find_nodes", "list_components"])

const objectSchema = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
})
const stringSchema: JsonSchema = { type: "string" }
const idsSchema: JsonSchema = { oneOf: [{ const: "selection" }, { type: "array", items: stringSchema }] }
const BROWSER_SCHEMAS = {
  select: objectSchema({ ids: idsSchema }, ["ids"]),
  reveal: objectSchema({ ids: idsSchema }, ["ids"]),
  undo: objectSchema(),
  redo: objectSchema(),
} satisfies Record<"select" | "reveal" | "undo" | "redo", JsonSchema>

function record(value: unknown, label = "arguments"): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as UnknownRecord
}

function currentDoc(store: SquigStore): Doc {
  const state = store.getState()
  return { nodes: state.nodes, order: state.order }
}

function allocateId(doc: Doc): string {
  let id = nanoid(8)
  while (doc.nodes[id]) id = nanoid(8)
  return id
}

function resolveIds(value: unknown, doc: Doc, selection: readonly string[], allowLocked = false): string[] {
  const raw = value === "selection" ? selection : value
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw new TypeError("ids must be an array of ids or selection")
  const wanted = new Set(raw as string[])
  const ids = doc.order.filter((id) => wanted.has(id))
  if (ids.length !== wanted.size || !ids.length) throw new RangeError("Every target id must exist")
  if (!allowLocked && ids.some((id) => doc.nodes[id].locked)) throw new DOMException("Locked targets cannot be changed", "InvalidStateError")
  return ids
}

function runServerTool(store: SquigStore, ownerWindow: Window, name: ServerToolName, input: UnknownRecord): unknown {
  const state = store.getState()
  const before = createServerToolDraft(currentDoc(store), state.selection)
  const executed = executeServerTool(before, name, input, {
    allocateId,
    environment: {
      fileName: state.fileName,
      viewport: state.viewport,
      viewportWidth: ownerWindow.innerWidth,
      viewportHeight: ownerWindow.innerHeight,
    },
  })
  if (READ_NAMES.has(name)) return executed.outcome.data
  state.edit(() => {
    store.setState({
      nodes: executed.draft.doc.nodes,
      order: executed.draft.doc.order,
      selection: executed.draft.selection,
      selectionGroupId: null,
    })
  })
  return executed.outcome
}

function executeBrowserTool(store: SquigStore, ownerWindow: Window, name: "select" | "reveal" | "undo" | "redo", input: UnknownRecord): unknown {
  const state = store.getState()
  const doc = currentDoc(store)
  if (name === "undo") {
    state.undo()
    return { content: [{ type: "text", text: "undo" }], affected: [], summary: "undo" }
  }
  if (name === "redo") {
    state.redo()
    return { content: [{ type: "text", text: "redo" }], affected: [], summary: "redo" }
  }
  const ids = resolveIds(input.ids, doc, state.selection, name === "reveal")
  if (name === "select") {
    state.setSelection(ids)
    return { content: [{ type: "text", text: `select: ${ids.length} nodes` }], affected: [], summary: `select: ${ids.length} nodes`, ids }
  }
  const box = unionBox(ids.map((id) => nodeVisualBounds(doc.nodes[id])))
  if (!box) throw new RangeError("Nothing to reveal")
  const reveal = revealViewport(state.viewport, box, ownerWindow.innerWidth, ownerWindow.innerHeight)
  if (reveal.kind === "fit") state.setViewport(fitViewport(box, ownerWindow.innerWidth, ownerWindow.innerHeight).viewport)
  else if (reveal.kind === "pan") state.setViewport(reveal.viewport)
  return { content: [{ type: "text", text: `reveal: ${reveal.kind}` }], affected: [], summary: `reveal: ${reveal.kind}`, ids }
}

function eligibleComponentSelection(store: SquigStore): { kind: string; nodes: ComponentNode[] } | null {
  const state = store.getState()
  if (!state.selection.length) return null
  const nodes = state.selection.map((id) => state.nodes[id])
  if (nodes.some((node) => node?.type !== "component" || node.locked)) return null
  const components = nodes as ComponentNode[]
  return components.every((node) => node.kind === components[0].kind) ? { kind: components[0].kind, nodes: components } : null
}

function propsSchema(eligible: { kind: string; nodes: ComponentNode[] }): JsonSchema {
  return controlsToJsonSchema(getDef(eligible.kind)!, eligible.nodes[0], sharedControls(eligible.nodes))
}

function staticDefinition(store: SquigStore, ownerWindow: Window, name: Exclude<V1ToolName, "set_props">): ModelContextTool {
  if ((SERVER_TOOL_NAMES as readonly string[]).includes(name)) {
    const serverName = name as ServerToolName
    const definition = SERVER_TOOL_DEFINITIONS.find((candidate) => candidate.function.name === serverName)!
    return {
      name,
      title: name.replaceAll("_", " "),
      description: definition.function.description,
      inputSchema: SERVER_TOOL_SCHEMAS[serverName],
      annotations: { readOnlyHint: READ_NAMES.has(serverName) },
      execute(input) { return runServerTool(store, ownerWindow, serverName, record(input)) },
    }
  }
  const browserName = name as "select" | "reveal" | "undo" | "redo"
  return {
    name,
    title: name,
    description: `Squig ${name}`,
    inputSchema: BROWSER_SCHEMAS[browserName],
    execute(input) {
      assertJsonSchema(input, BROWSER_SCHEMAS[browserName])
      return executeBrowserTool(store, ownerWindow, browserName, record(input))
    },
  }
}

function dynamicPropsDefinition(store: SquigStore, ownerWindow: Window, eligible: { kind: string; nodes: ComponentNode[] }): ModelContextTool {
  const def = getDef(eligible.kind)!
  const inputSchema = objectSchema({ ids: idsSchema, props: propsSchema(eligible) }, ["ids", "props"])
  return {
    name: "set_props",
    title: `set ${def.name} props`,
    description: `Set properties shared by the selected ${def.name} component${eligible.nodes.length === 1 ? "" : "s"}`,
    inputSchema,
    execute(input) {
      assertJsonSchema(input, inputSchema)
      return runServerTool(store, ownerWindow, "set_props", record(input))
    },
  }
}

export interface SquigToolRegistration {
  context: ModelContextLike
  refresh(): Promise<void>
  dispose(): void
}

/** Register the WebMCP catalogue while reusing the Worker-safe reducer executor. */
export async function registerSquigTools(
  targetDocument: Document = document,
  targetWindow: Window = targetDocument.defaultView ?? window,
  store: SquigStore = useSquig
): Promise<SquigToolRegistration> {
  const context = installModelContextShim(targetDocument, targetWindow)
  const staticController = new AbortController()
  for (const name of STATIC_TOOL_NAMES) await context.registerTool(staticDefinition(store, targetWindow, name), { signal: staticController.signal })

  let dynamicController: AbortController | null = null
  let dynamicSignature: string | null = null
  let disposed = false
  let queue = Promise.resolve()
  const refreshNow = async () => {
    if (disposed) return
    const eligible = eligibleComponentSelection(store)
    const signature = eligible ? `${eligible.kind}:${JSON.stringify(propsSchema(eligible))}` : null
    if (signature === dynamicSignature) return
    dynamicController?.abort()
    dynamicController = null
    dynamicSignature = signature
    if (!eligible) return
    dynamicController = new AbortController()
    await context.registerTool(dynamicPropsDefinition(store, targetWindow, eligible), { signal: dynamicController.signal })
  }
  const refresh = () => (queue = queue.then(refreshNow))
  await refresh()
  const unsubscribe = store.subscribe((state, previous) => {
    if (!sameValue(state.selection, previous.selection) || state.nodes !== previous.nodes) void refresh()
  })

  const helpers = targetWindow as Window & {
    __squigTools?: () => Promise<unknown>
    __squigExecuteTool?: (name: string, input?: UnknownRecord, options?: { signal?: AbortSignal }) => Promise<string>
  }
  helpers.__squigTools = () => context.getTools()
  helpers.__squigExecuteTool = (name, input = {}, options = {}) => executeToolByName(context, name, input, options)

  return {
    context,
    refresh,
    dispose() {
      disposed = true
      unsubscribe()
      dynamicController?.abort()
      staticController.abort()
      delete helpers.__squigTools
      delete helpers.__squigExecuteTool
    },
  }
}

export const registerTools = registerSquigTools

export function assertV1Catalogue(): void {
  if (V1_TOOL_NAMES.length !== 28 || new Set(V1_TOOL_NAMES).size !== 28) throw new Error("The v1 tool catalogue must contain 28 unique names")
  if (ALL_DEFS.some((def) => !def.kind)) throw new Error("Every component definition needs a kind")
}
