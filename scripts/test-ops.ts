import assert from "node:assert/strict"
import { ALL_DEFS, getDef } from "../lib/library/registry.ts"
import { applyOp, applyOps, controlsToJsonSchema, invert, type Doc, type Op, type OpContext } from "../lib/ops/index.ts"
import type { ArrowNode, ComponentNode, ShapeNode, SquigNode, TextNode } from "../lib/types.ts"

const context: OpContext = {
  getDef,
  nanoid: () => "test-id",
  seed: (id) => [...(id ?? "seed")].reduce((sum, char) => sum + char.charCodeAt(0), 0),
}

const shape = (id: string, x: number, y: number, w = 40, h = 30): ShapeNode => ({
  id, type: "shape", shape: "rect", fill: "none", x, y, w, h, seed: id.charCodeAt(0),
})
const text = (id: string, x: number, y: number): TextNode => ({
  id, type: "text", text: id, fontSize: 16, x, y, w: 30, h: 20, seed: id.charCodeAt(0),
})
const component = (id: string, kind: string, x: number, y: number): ComponentNode => ({
  id, type: "component", kind, props: { ...(getDef(kind)?.defaults ?? {}) }, x, y, w: 100, h: 80, seed: id.charCodeAt(0),
})

function fixture(): Doc {
  const nodes: SquigNode[] = [shape("a", 0, 0), shape("b", 80, 50, 60, 40), text("c", 200, 120), component("d", "card", 260, 180)]
  return { nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), order: nodes.map((node) => node.id) }
}

const grouped = (): Doc => {
  const doc = fixture()
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      a: { ...doc.nodes.a, groupIds: ["outer", "inner"] },
      b: { ...doc.nodes.b, groupIds: ["outer", "inner"] },
      c: { ...doc.nodes.c, groupIds: ["outer"] },
    },
  }
}

const cases: { name: Op["t"]; doc: Doc; op: Op }[] = [
  { name: "add", doc: fixture(), op: { t: "add", node: shape("e", 400, 10) } },
  { name: "update", doc: fixture(), op: { t: "update", id: "a", patch: { x: 25, dashed: true } } },
  { name: "updateMany", doc: fixture(), op: { t: "updateMany", patches: { a: { y: 10 }, b: { y: 20 } } } },
  { name: "remove", doc: grouped(), op: { t: "remove", ids: ["a", "c"] } },
  { name: "reorder", doc: fixture(), op: { t: "reorder", ids: ["a"], to: "front" } },
  { name: "group", doc: fixture(), op: { t: "group", ids: ["a", "c"], groupId: "new-group" } },
  { name: "ungroup", doc: grouped(), op: { t: "ungroup", ids: ["a", "b"] } },
  { name: "align", doc: fixture(), op: { t: "align", ids: ["a", "b", "c"], edge: "right" } },
  { name: "distribute", doc: fixture(), op: { t: "distribute", ids: ["a", "b", "c"], axis: "h" } },
  { name: "flip", doc: fixture(), op: { t: "flip", ids: ["a", "b"], axis: "x" } },
  { name: "lock", doc: fixture(), op: { t: "lock", ids: ["a", "b"], locked: true } },
  {
    name: "duplicate",
    doc: grouped(),
    op: { t: "duplicate", ids: ["a", "b"], offset: [16, 24], idMap: { a: "a-copy", b: "b-copy" } },
  },
  {
    name: "placeRelative",
    doc: fixture(),
    op: { t: "placeRelative", id: "a", anchor: "b", side: "below", gap: 12, align: "center" },
  },
  { name: "stack", doc: fixture(), op: { t: "stack", ids: ["a", "b", "c"], axis: "v", gap: 8 } },
  { name: "matchSize", doc: fixture(), op: { t: "matchSize", ids: ["a", "c"], to: "b", dims: "both" } },
]

const expectedVariants: Op["t"][] = [
  "add", "update", "updateMany", "remove", "reorder", "group", "ungroup", "align", "distribute", "flip", "lock",
  "duplicate", "placeRelative", "stack", "matchSize",
]
assert.deepEqual(new Set(cases.map((entry) => entry.name)), new Set(expectedVariants), "every Op discriminator has a test")

for (const entry of cases) {
  const result = applyOp(entry.doc, entry.op, context)
  assert.notEqual(result.doc, entry.doc, `${entry.name} changes its fixture`)
  assert.ok(result.affected.length > 0, `${entry.name} reports affected ids`)
  const restored = applyOps(result.doc, invert(entry.op, entry.doc), context)
  assert.deepEqual(restored, entry.doc, `${entry.name} inverse restores the exact document`)
}

for (const to of ["front", "back", "forward", "backward"] as const) {
  const doc = fixture()
  const id = to === "front" || to === "forward" ? "b" : "c"
  const op: Op = { t: "reorder", ids: [id], to }
  assert.deepEqual(applyOps(applyOp(doc, op, context).doc, invert(op, doc), context), doc, `reorder ${to} round-trips`)
}

for (const edge of ["left", "hcenter", "right", "top", "vcenter", "bottom"] as const) {
  assert.ok(applyOp(fixture(), { t: "align", ids: ["a", "b"], edge }, context).affected.length > 0, `align ${edge}`)
}

for (const axis of ["h", "v"] as const) {
  assert.ok(applyOp(fixture(), { t: "distribute", ids: ["a", "b", "c"], axis }, context).affected.length > 0, `distribute ${axis}`)
  assert.ok(applyOp(fixture(), { t: "stack", ids: ["a", "b", "c"], axis }, context).affected.length > 0, `stack ${axis}`)
}

const noOps: Op[] = [
  { t: "add", node: fixture().nodes.a },
  { t: "update", id: "missing", patch: { x: 1 } },
  { t: "updateMany", patches: { missing: { x: 1 } } },
  { t: "remove", ids: ["missing"] },
  { t: "lock", ids: ["missing"], locked: true },
]
for (const op of noOps) {
  const doc = fixture()
  assert.equal(applyOp(doc, op, context).doc, doc, `${op.t} no-op preserves document identity`)
}

// A duplicate is a serialized command: replaying it cannot consult whichever
// RNG happens to be installed in the process doing the replay.
{
  const left = { ...shape("left", 0, 0), groupIds: ["pair"] }
  const right = { ...shape("right", 100, 0), groupIds: ["pair"] }
  const connector: ArrowNode = {
    id: "connector",
    type: "arrow",
    x: 40,
    y: 15,
    w: 60,
    h: 0,
    seed: 33,
    points: [[0, 0], [60, 0]],
    head: true,
    bind: ["left", "right"],
    anchors: ["right", "left"],
  }
  const doc: Doc = {
    nodes: { left, right, connector },
    order: ["left", "connector", "right"],
  }
  const op: Op = {
    t: "duplicate",
    ids: ["left", "connector", "right"],
    offset: [25, 30],
    idMap: { left: "left-2", connector: "connector-2", right: "right-2" },
  }
  const noisyA: OpContext = { getDef, nanoid: () => "rng-a", seed: () => 1 }
  const noisyB: OpContext = { getDef, nanoid: () => "rng-b", seed: () => 999_999 }
  const first = applyOp(doc, op, noisyA).doc
  const second = applyOp(doc, op, noisyB).doc
  assert.deepEqual(second, first, "serialized duplicate replays identically under different RNG contexts")
  assert.notEqual(first.nodes["left-2"].seed, left.seed, "duplicate derives a stable new seed")
  assert.deepEqual(first.nodes["left-2"].groupIds, first.nodes["right-2"].groupIds, "complete group paths are remapped together")
  assert.notDeepEqual(first.nodes["left-2"].groupIds, left.groupIds, "complete copied groups receive a stable new identity")
  assert.deepEqual((first.nodes["connector-2"] as ArrowNode).bind, ["left-2", "right-2"], "bindings remap to cloned targets")
  assert.deepEqual(first.order, second.order, "clone z-order is replay-stable")
}

for (const def of ALL_DEFS) {
  const schema = controlsToJsonSchema(def)
  assert.equal(schema.type, "object", `${def.kind} schema is an object`)
  assert.doesNotThrow(() => JSON.stringify(schema), `${def.kind} schema stringifies`)
}

console.log(`ops: ${cases.length}/${expectedVariants.length} variants round-tripped; ${ALL_DEFS.length} component schemas compiled`)
