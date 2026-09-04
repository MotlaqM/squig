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
const { compactInverseOps, createServerToolDraft, executeServerTool, SERVER_TOOL_NAMES } = await import("../lib/agent/server-tools.ts")
const { MAX_AGENT_STATE_BYTES, assertAgentStateBudget, serializedAgentStateBytes } = await import("../lib/agent/state-budget.ts")
const { MAX_MODEL_CONTEXT_BYTES, boundedToolResultMessage } = await import("../lib/agent/model-context-budget.ts")
const { handleServerChatFrame, inspectChatClient, resetChatClient, setChatTransport } = await import("../lib/agent/chat-client.ts")
const { isUndoableAgentCompletion } = await import("../lib/agent/chat-protocol.ts")
const { applyOps } = await import("../lib/ops/invert.ts")
const { applyAuthoritativeDocument, useSquig } = await import("../lib/store.ts")
import type { ArrowNode, DrawNode, ImageNode, SquigNode, TextNode } from "../lib/types.ts"

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
    agentSelection: [],
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
  check("mutations return the standard text content envelope", result.content?.[0]?.type === "text" && result.content[0].text === result.summary)
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

{
  const visible: SquigNode = { id: "visible", type: "shape", shape: "rect", fill: "none", x: 40, y: 100, w: 80, h: 20, seed: 1 }
  const distant: SquigNode = { id: "distant", type: "shape", shape: "rect", fill: "none", x: 20, y: 10_000, w: 80, h: 20, seed: 2 }
  reset({ visible, distant }, ["visible", "distant"])
  useSquig.setState({ viewport: { x: 0, y: 0, zoom: 1 } })
  await registration.refresh()
  const result = await execute("insert_component", { kind: "button" })
  const inserted = state().nodes[result.id as string]
  check("omitted x starts with the visible layers", inserted.x === 40, `x=${inserted.x}`)
  check("omitted y lands below the lowest visible layer", inserted.y === 144, `y=${inserted.y}`)
}

// Generated component constraints are enforced before any store write.
{
  reset()
  await registration.refresh()
  const beforeDoc = docJson()
  const beforeHistory = JSON.stringify({ past: state().past, future: state().future })
  await rejects("generated icon schema rejects an empty name", () => execute("insert_component", {
    kind: "button",
    props: { icon: "left", glyph: "" },
    x: 0,
    y: 0,
  }))
  check("invalid icon leaves the document untouched", docJson() === beforeDoc)
  check("invalid icon leaves history untouched", JSON.stringify({ past: state().past, future: state().future }) === beforeHistory)
}

{
  const invalidCalls: [string, string, Record<string, unknown>][] = [
    ["enum", "insert_component", { kind: "image", props: { style: "painted" }, x: 0, y: 0 }],
    ["type", "insert_component", { kind: "card", props: { image: "yes" }, x: 0, y: 0 }],
    ["additionalProperties", "add_shape", { shape: "rect", x: 0, y: 0, w: 20, h: 20, mystery: true }],
  ]
  for (const [constraint, name, args] of invalidCalls) {
    reset()
    await registration.refresh()
    const beforeDoc = docJson()
    const beforeHistory = JSON.stringify({ past: state().past, future: state().future })
    await rejects(`runtime schema rejects ${constraint} violations`, () => execute(name, args))
    check(`${constraint} rejection leaves the document untouched`, docJson() === beforeDoc)
    check(`${constraint} rejection leaves history untouched`, JSON.stringify({ past: state().past, future: state().future }) === beforeHistory)
  }
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

// Conditional controls must be shared by every selected component, not copied
// from whichever same-kind node happens to come first in document order.
{
  reset()
  await registration.refresh()
  const withIcon = (await execute("insert_component", {
    kind: "button",
    props: { icon: "left", glyph: "plus" },
    x: 0,
    y: 0,
  })).id as string
  const withoutIcon = (await execute("insert_component", { kind: "button", x: 180, y: 0 })).id as string
  await execute("select", { ids: [withIcon, withoutIcon] })
  await registration.refresh()
  const propsTool = (await registration.context.getTools()).find((tool) => tool.name === "set_props")!
  const schema = propsTool.inputSchema as { properties: { props: { properties: Record<string, unknown> } } }
  check("mixed conditional state advertises only shared controls", Object.keys(schema.properties.props.properties).sort().join(",") === "icon,label,size,variant")

  const beforeDoc = docJson()
  const beforeHistory = JSON.stringify({ past: state().past, future: state().future })
  await rejects("mixed conditional state rejects its unshared control", () => execute("set_props", { ids: "selection", props: { glyph: "star" } }))
  check("unshared prop rejection leaves document untouched", docJson() === beforeDoc)
  check("unshared prop rejection leaves history untouched", JSON.stringify({ past: state().past, future: state().future }) === beforeHistory)

  await execute("set_props", { ids: "selection", props: { label: "Shared" } })
  check(
    "shared prop execution updates every selected component",
    [withIcon, withoutIcon].every((id) => (state().nodes[id] as { props?: { label?: string } }).props?.label === "Shared")
  )
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

// A mixed server-side selection must not silently drop the locked member.
{
  const locked: SquigNode = { id: "server-locked", type: "shape", shape: "rect", fill: "none", x: 0, y: 0, w: 40, h: 40, seed: 1, locked: true }
  const open: SquigNode = { id: "server-open", type: "shape", shape: "rect", fill: "none", x: 80, y: 0, w: 40, h: 40, seed: 2 }
  const before = { nodes: { "server-locked": locked, "server-open": open }, order: ["server-locked", "server-open"] }
  const draft = createServerToolDraft(before, ["server-locked", "server-open"])
  const described = executeServerTool(draft, "get_selection", {}, { allocateId: () => "unused" }).outcome.data as { nodes: SquigNode[] }
  check("server read selection retains locked and unlocked nodes", described.nodes.map((node) => node.id).join(",") === "server-locked,server-open")
  await rejects("server selection mutation rejects any locked member", async () => {
    executeServerTool(draft, "set_geometry", { ids: "selection", x: 25 }, { allocateId: () => "unused" })
  })
  check("server mixed-selection rejection leaves the draft untouched", JSON.stringify(draft.doc) === JSON.stringify(before))
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

// Persisted inverses survive JSON and merge adjacent patches without losing
// the deletion markers that restore optional fields.
{
  const baseNode: SquigNode = { id: "inverse", type: "shape", shape: "rect", fill: "none", x: 0, y: 0, w: 40, h: 40, seed: 1 }
  const base = { nodes: { inverse: baseNode }, order: ["inverse"] }
  let draft = createServerToolDraft(base, ["inverse"])
  draft = executeServerTool(draft, "flip", { ids: ["inverse"], axis: "x" }, { allocateId: () => "unused" }).draft
  draft = executeServerTool(draft, "lock", { ids: ["inverse"] }, { allocateId: () => "unused" }).draft
  const inverse = JSON.parse(JSON.stringify(compactInverseOps(draft.inverseOps)))
  const restored = applyOps(draft.doc, inverse, { getDef: () => undefined, nanoid: () => "unused", seed: () => 1 })
  check("server catalogue has exactly 24 tools", SERVER_TOOL_NAMES.length === 24 && new Set(SERVER_TOOL_NAMES).size === 24)
  check("compact inverse retains JSON-safe deletions", JSON.stringify(inverse).includes("null"))
  check("JSON-round-tripped compact inverse restores the document", JSON.stringify(restored) === JSON.stringify(base))
}

// Agent history must not duplicate inline image data for a geometry-only turn.
{
  const image = (id: string, x: number, fill: string): ImageNode => ({
    id, seed: 1, type: "image", src: `data:image/png;base64,${fill.repeat(600_000)}`,
    naturalW: 1200, naturalH: 800, x, y: 0, w: 600, h: 400,
  })
  const base = { nodes: { first: image("first", 0, "A"), second: image("second", 700, "B") }, order: ["first", "second"] }
  let draft = createServerToolDraft(base, ["first", "second"])
  draft = executeServerTool(draft, "set_geometry", { ids: "selection", x: 50 }, { allocateId: () => "unused" }).draft
  const inverse = compactInverseOps(draft.inverseOps)
  const inverseBytes = new TextEncoder().encode(JSON.stringify(inverse)).byteLength
  const state = { ...draft.doc, rev: 1, clientHeads: {}, agentTurns: [{ inverseOps: inverse }] }
  const stateBytes = serializedAgentStateBytes(state)
  const restored = applyOps(draft.doc, JSON.parse(JSON.stringify(inverse)), { getDef: () => undefined, nanoid: () => "unused", seed: () => 1 })
  check("large-image agent inverse stores only changed fields", inverseBytes < 10_000, `bytes=${inverseBytes}`)
  check("large-image agent state stays below the row safety budget", stateBytes > 1_000_000 && stateBytes < MAX_AGENT_STATE_BYTES, `bytes=${stateBytes}`)
  await rejects("agent state budget rejects an oversized persisted row", async () => {
    assertAgentStateBudget({ ...state, padding: "x".repeat(MAX_AGENT_STATE_BYTES) })
  })
  check("large-image minimal inverse restores the exact document", JSON.stringify(restored) === JSON.stringify(base))
}

// Tool results are bounded before they can become another model-round input.
{
  const messages = [{ role: "system" as const, content: "Squig" }]
  const small = boundedToolResultMessage(messages, "tool-small", { ok: true })
  check("bounded model result creates one tool message", small.role === "tool" && small.tool_call_id === "tool-small")
  await rejects("oversized tool result is refused before model context append", async () => {
    boundedToolResultMessage(messages, "tool-large", { document: "x".repeat(MAX_MODEL_CONTEXT_BYTES) })
  })
}

// A document reset gives the panel an explicit boundary for all local turn UI.
{
  resetChatClient()
  const before = inspectChatClient()
  handleServerChatFrame({ type: "chat.delta", turnId: "old-turn", delta: "old transcript" })
  check("chat client records frames inside one reset epoch", inspectChatClient().events.length === 1)
  resetChatClient()
  const after = inspectChatClient()
  check("chat reset clears events and advances the panel epoch", after.events.length === 0 && after.resetEpoch === before.resetEpoch + 1)
  check("completed no-op turn is not offered for undo", !isUndoableAgentCompletion({ type: "chat.completed", turnId: "noop", rev: 0, status: "completed", affected: [] }))
  check("completed changed turn remains undoable", isUndoableAgentCompletion({ type: "chat.completed", turnId: "changed", rev: 1, status: "completed", affected: ["node"] }))
}

// A server reset clears stale panel state without dropping the live transport.
{
  resetChatClient()
  setChatTransport(() => undefined)
  handleServerChatFrame({ type: "chat.delta", turnId: "stale-review", delta: "prepared" })
  const before = inspectChatClient()
  handleServerChatFrame({ type: "chat.reset", rev: 7 })
  const after = inspectChatClient()
  check("authoritative chat reset clears old turn events", after.events.length === 0)
  check("authoritative chat reset advances the panel epoch", after.resetEpoch === before.resetEpoch + 1)
  check("authoritative chat reset preserves live transport and revision", after.connected && after.rev === 7)
  resetChatClient()
}

// Agent feedback keeps locked nodes visible without feeding them to human commands.
{
  const locked: SquigNode = { id: "agent-locked", type: "shape", shape: "rect", fill: "none", x: 0, y: 0, w: 40, h: 40, seed: 1, locked: true }
  const unlocked: SquigNode = { id: "agent-unlocked", type: "shape", shape: "rect", fill: "none", x: 50, y: 0, w: 40, h: 40, seed: 2 }
  reset({ "agent-locked": locked, "agent-unlocked": unlocked }, ["agent-locked", "agent-unlocked"])
  state().setSelection(["agent-locked"])
  check("human selection still refuses locked nodes", state().selection.length === 0)
  handleServerChatFrame({ type: "selection.set", turnId: "lock-turn", rev: 1, ids: ["agent-locked", "agent-unlocked"] })
  check("agent feedback keeps locked ids out of actionable selection", state().selection.join(",") === "agent-unlocked")
  check("agent feedback retains a non-actionable locked cursor", state().agentSelection.join(",") === "agent-locked")
  state().deleteSelected()
  check("human delete after agent feedback preserves the locked node", !!state().nodes["agent-locked"])
  check("human delete after agent feedback still removes unlocked selected nodes", !state().nodes["agent-unlocked"])
}

// A collaborator locking the local selection also closes the human mutation path.
{
  const initiallyUnlocked: SquigNode = { id: "remote-lock", type: "shape", shape: "rect", fill: "none", x: 0, y: 0, w: 40, h: 40, seed: 3 }
  reset({ "remote-lock": initiallyUnlocked }, ["remote-lock"])
  state().setSelection(["remote-lock"])
  applyAuthoritativeDocument({ nodes: { "remote-lock": { ...initiallyUnlocked, locked: true } }, order: ["remote-lock"] })
  check("authoritative lock removes the node from actionable selection", state().selection.length === 0)
  state().deleteSelected()
  check("human delete after a remote lock preserves the locked node", !!state().nodes["remote-lock"])
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
