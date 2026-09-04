// WebMCP's browser surface, exercised in the repository's dependency-free
// Node harness with native EventTarget plus document/window-shaped fakes.

class FakeWindow extends EventTarget {
  location = { origin: "https://squig.test" }
  innerWidth = 1200
  innerHeight = 800
  addEventListener = super.addEventListener
  removeEventListener = super.removeEventListener
}

class FakeDocument extends EventTarget {
  readonly defaultView: FakeWindow

  constructor(defaultView: FakeWindow) {
    super()
    this.defaultView = defaultView
  }
}

const browserWindow = new FakeWindow()
const browserDocument = new FakeDocument(browserWindow)
;(globalThis as { window?: unknown }).window = browserWindow
;(globalThis as { document?: unknown }).document = browserDocument

const held = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => held.get(key) ?? null,
  setItem: (key: string, value: string) => void held.set(key, value),
  removeItem: (key: string) => void held.delete(key),
}

const { ModelContextShim, executeToolByName } = await import("../lib/agent/model-context-shim.ts")
const { registerSquigTools, V1_TOOL_NAMES } = await import("../lib/agent/tools.ts")
const { useSquig } = await import("../lib/store.ts")
import type { ArrowNode, DrawNode, SquigNode, TextNode } from "../lib/types.ts"

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = "") {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
}

async function rejects(name: string, run: () => Promise<unknown>) {
  try {
    await run()
    failures.push(`${name} — resolved`)
  } catch {
    passed++
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

// -- draft ModelContext contract --------------------------------------------

{
  const owner = new FakeWindow() as unknown as Window
  const context = new ModelContextShim(owner)
  const events: string[] = []
  context.addEventListener("toolchange", () => events.push("change"))
  const registration = new AbortController()
  const schema = { type: "object", properties: { label: { type: "string" } } }

  await context.registerTool({ name: "zeta", description: "z", inputSchema: schema, execute: (input) => ({ ok: input }) })
  await context.registerTool({ name: "alpha", description: "a", inputSchema: schema, execute: () => 1 }, { signal: registration.signal })
  await rejects("shim rejects duplicate names", () => context.registerTool({ name: "alpha", description: "again", execute: () => 2 }))
  check("shim sorts registered tools", (await context.getTools()).map((tool) => tool.name).join(",") === "alpha,zeta")

  const copy = (await context.getTools())[0].inputSchema as { properties: { label: { type: string } } }
  copy.properties.label.type = "number"
  const fresh = (await context.getTools())[0].inputSchema as { properties: { label: { type: string } } }
  check("shim returns a schema copy", fresh.properties.label.type === "string")

  const beforeAbortEvents = events.length
  registration.abort()
  check("registration abort unregisters synchronously", (await context.getTools()).map((tool) => tool.name).join(",") === "zeta")
  await pause()
  check("registration abort fires toolchange asynchronously", events.length === beforeAbortEvents + 1)

  const json = await executeToolByName(context, "zeta", { n: 4 })
  check("executeTool returns stringified JSON", typeof json === "string" && JSON.parse(json).ok.n === 4)

  await context.registerTool({ name: "slow", description: "slow", execute: (_input, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("late"), { once: true })) })
  const execution = new AbortController()
  const pending = executeToolByName(context, "slow", {}, { signal: execution.signal })
  execution.abort(new DOMException("stop", "AbortError"))
  await rejects("executeTool propagates execution abort", () => pending)
}

// -- Squig catalogue and transactional adapters -----------------------------

const state = () => useSquig.getState()

function reset(nodes: Record<string, SquigNode> = {}, order: string[] = []) {
  useSquig.setState({
    nodes,
    order,
    selection: [],
    selectionGroupId: null,
    past: [],
    future: [],
    dupTrail: null,
    editingId: null,
    croppingId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
  })
}

const docJson = () => JSON.stringify({ nodes: state().nodes, order: state().order })
const execute = async (name: string, input: Record<string, unknown> = {}) =>
  JSON.parse(await executeToolByName(registration.context, name, input))

reset()
const registration = await registerSquigTools(
  browserDocument as unknown as Document,
  browserWindow as unknown as Window,
  useSquig
)

{
  const tools = await registration.context.getTools()
  check("catalogue has 28 v1 names", V1_TOOL_NAMES.length === 28 && new Set(V1_TOOL_NAMES).size === 28)
  check("no eligible selection exposes 27 tools", tools.length === 27)
  check("dynamic set_props is absent without eligible selection", !tools.some((tool) => tool.name === "set_props"))

  const beforeSteps = state().past.length
  const result = await execute("insert_component", { kind: "button", x: 100, y: 100 })
  const id = result.id as string
  check("insert_component adds one node", state().order.length === 1 && state().nodes[id]?.type === "component")
  check("insert_component honors coordinates", state().nodes[id]?.x === 100 && state().nodes[id]?.y === 100)
  check("insert_component selects its node", state().selection.length === 1 && state().selection[0] === id)
  check("insert_component costs one undo step", state().past.length === beforeSteps + 1)
  await registration.refresh()
  const selectedNames = (await registration.context.getTools()).map((tool) => tool.name)
  check("eligible component selection exposes all 28 tools", selectedNames.length === 28)
  check("getTools returns exactly the complete v1 catalogue", selectedNames.join(",") === [...V1_TOOL_NAMES].sort().join(","))
  check("registration installs document.modelContext", (browserDocument as FakeDocument & { modelContext?: unknown }).modelContext === registration.context)
}

// A card proves exact string/boolean keys. It deliberately has no enum control.
{
  reset()
  await registration.refresh()
  await execute("insert_component", { kind: "card", x: 0, y: 0 })
  await registration.refresh()
  const propsTool = (await registration.context.getTools()).find((tool) => tool.name === "set_props")!
  const schema = propsTool.inputSchema as { properties: { props: { properties: Record<string, { type?: string; enum?: unknown[] }> } } }
  const props = schema.properties.props.properties
  check("card schema has its exact control keys", Object.keys(props).sort().join(",") === "actions,cta,cta2,footer,header,image,secondary,title")
  check("card schema carries string and boolean types", props.title.type === "string" && props.image.type === "boolean" && props.actions.type === "boolean")
  check("card schema does not invent enums", Object.values(props).every((property) => property.enum === undefined))

  const beforeDoc = docJson()
  const beforeHistory = JSON.stringify({ past: state().past, future: state().future })
  await rejects("set_props rejects unknown component props", () => execute("set_props", { ids: "selection", props: { imaginary: true } }))
  check("unknown props leave document untouched", docJson() === beforeDoc)
  check("unknown props leave history untouched", JSON.stringify({ past: state().past, future: state().future }) === beforeHistory)
}

// Image proves a registry select becomes a JSON Schema enum.
{
  reset()
  await registration.refresh()
  await execute("insert_component", { kind: "image", x: 0, y: 0 })
  await registration.refresh()
  const propsTool = (await registration.context.getTools()).find((tool) => tool.name === "set_props")!
  const schema = propsTool.inputSchema as { properties: { props: { properties: Record<string, { enum?: unknown[] }> } } }
  check("image select compiles to an enum", schema.properties.props.properties.style.enum?.join(",") === "plain,crossed")
}

// Locked targets are rejected before a document or history write.
{
  const id = state().selection[0]
  await execute("lock", { ids: [id] })
  const beforeDoc = docJson()
  const beforeHistory = JSON.stringify({ past: state().past, future: state().future })
  await rejects("tools reject locked targets", () => execute("set_geometry", { ids: [id], x: 99 }))
  check("locked rejection leaves document untouched", docJson() === beforeDoc)
  check("locked rejection leaves history untouched", JSON.stringify({ past: state().past, future: state().future }) === beforeHistory)
}

// set_geometry uses the canvas scaling path for draw, text, and arrows.
{
  const draw: DrawNode = { id: "draw", type: "draw", x: 0, y: 0, w: 20, h: 10, seed: 1, points: [[0, 0], [20, 10]] }
  const words: TextNode = { id: "words", type: "text", x: 100, y: 0, w: 60, h: 20, seed: 2, text: "hello", fontSize: 20 }
  const arrow: ArrowNode = { id: "arrow", type: "arrow", x: 200, y: 0, w: 40, h: 10, seed: 3, points: [[0, 0], [40, 10]], head: true }
  reset({ draw, words, arrow }, ["draw", "words", "arrow"])
  await registration.refresh()
  await execute("set_geometry", { ids: ["draw"], w: 40, h: 20 })
  await execute("set_geometry", { ids: ["words"], h: 40 })
  await execute("set_geometry", { ids: ["arrow"], w: 80, h: 20 })
  check("draw resize scales points", (state().nodes.draw as DrawNode).points[1][0] === 40 && (state().nodes.draw as DrawNode).points[1][1] === 20)
  check("text resize scales font", (state().nodes.words as TextNode).fontSize === 40)
  check("arrow resize scales endpoints", (state().nodes.arrow as ArrowNode).points[1][0] === 80 && (state().nodes.arrow as ArrowNode).points[1][1] === 20)
}

// The same geometry transition settles every bound arrow in the temporary doc.
{
  reset()
  await registration.refresh()
  const first = (await execute("add_shape", { shape: "rect", x: 0, y: 0, w: 40, h: 40 })).id as string
  const second = (await execute("add_shape", { shape: "rect", x: 200, y: 0, w: 40, h: 40 })).id as string
  const arrowId = (await execute("add_arrow", { from: first, to: second, anchors: ["right", "left"] })).id as string
  const before = JSON.stringify(state().nodes[arrowId])
  await execute("set_geometry", { ids: [first], x: 60, w: 80 })
  check("set_geometry settles bound arrows", JSON.stringify(state().nodes[arrowId]) !== before && (state().nodes[arrowId] as ArrowNode).bind?.[0] === first)
}

// A valid batch writes once; a bad later call writes nothing.
{
  reset()
  await registration.refresh()
  const beforeSteps = state().past.length
  const result = await execute("batch", {
    ops: [
      { name: "insert_component", arguments: { kind: "button", x: 10, y: 20 } },
      { name: "set_props", arguments: { ids: ["$0.id"], props: { label: "Save" } } },
    ],
  })
  const id = result.data[0].id as string
  check("batch resolves earlier result references", (state().nodes[id] as { props?: { label?: string } }).props?.label === "Save")
  check("batch commits as exactly one undo step", state().past.length === beforeSteps + 1)

  const beforeDoc = docJson()
  const beforeHistory = JSON.stringify({ past: state().past, future: state().future, selection: state().selection })
  await rejects("batch rejects an invalid later call", () => execute("batch", {
    ops: [
      { name: "insert_component", arguments: { kind: "card", x: 1, y: 2 } },
      { name: "set_geometry", arguments: { ids: ["missing"], x: 50 } },
    ],
  }))
  check("failed batch leaves document untouched", docJson() === beforeDoc)
  check("failed batch leaves history and selection untouched", JSON.stringify({ past: state().past, future: state().future, selection: state().selection }) === beforeHistory)
}

// A document no-op after undo must hand the complete redo branch back.
{
  reset()
  await registration.refresh()
  const id = (await execute("insert_component", { kind: "button", x: 0, y: 0 })).id as string
  await execute("set_geometry", { ids: [id], x: 50 })
  state().undo()
  const beforeDoc = docJson()
  const beforePast = JSON.stringify(state().past)
  const beforeFuture = JSON.stringify(state().future)
  await execute("reorder", { ids: [id], to: "front" })
  check("no-op store command preserves the document", docJson() === beforeDoc)
  check("no-op store command preserves past", JSON.stringify(state().past) === beforePast)
  check("no-op store command preserves the redo branch", JSON.stringify(state().future) === beforeFuture)
}

reset()
await registration.refresh()
const finalNames = (await registration.context.getTools()).map((tool) => tool.name)
check("registered static names equal the 28-name catalogue minus set_props", finalNames.join(",") === V1_TOOL_NAMES.filter((name) => name !== "set_props").sort().join(","))
registration.dispose()

if (failures.length) {
  console.error(`agent: ${failures.length} failure(s), ${passed} passed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`agent: ${passed} checks passed`)
}
