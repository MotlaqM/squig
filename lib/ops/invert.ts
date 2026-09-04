import type { SquigNode } from "../types"
import { applyOp } from "./apply-op"
import type { Doc, Op, OpContext } from "./types"
import { sameValue } from "./value"

const INVERT_CONTEXT: OpContext = {
  getDef: () => undefined,
  nanoid: () => "inverse",
  seed: (id) => {
    let out = 0
    for (const char of id ?? "inverse") out = (Math.imul(out, 31) + char.charCodeAt(0)) >>> 0
    return out
  },
}

function restorationPatch(current: SquigNode, wanted: SquigNode): Partial<SquigNode> {
  const patch: Record<string, unknown> = { ...wanted }
  for (const key of Object.keys(current)) if (!(key in wanted)) patch[key] = undefined
  return patch as Partial<SquigNode>
}

function restoreOrder(current: readonly string[], wanted: readonly string[]): Op[] {
  const working = [...current]
  const ops: Op[] = []
  for (let targetIndex = 0; targetIndex < wanted.length; targetIndex++) {
    const id = wanted[targetIndex]
    let currentIndex = working.indexOf(id)
    while (currentIndex > targetIndex) {
      ops.push({ t: "reorder", ids: [id], to: "backward" })
      ;[working[currentIndex], working[currentIndex - 1]] = [working[currentIndex - 1], working[currentIndex]]
      currentIndex--
    }
  }
  return ops
}

/**
 * Return replayable operations that restore the document that existed before
 * `op`. An array is necessary because removing several interleaved layers can
 * only be restored with adds plus deterministic z-order moves.
 */
export function invert(op: Op, docBefore: Doc): Op[] {
  const docAfter = applyOp(docBefore, op, INVERT_CONTEXT).doc
  if (docAfter === docBefore) return []

  const inverse: Op[] = []
  const beforeIds = new Set(Object.keys(docBefore.nodes))
  const afterIds = new Set(Object.keys(docAfter.nodes))
  const remove = [...afterIds].filter((id) => !beforeIds.has(id))
  if (remove.length) inverse.push({ t: "remove", ids: remove })

  for (const id of docBefore.order) {
    if (!afterIds.has(id)) inverse.push({ t: "add", node: structuredClone(docBefore.nodes[id]) })
  }

  const patches: Record<string, Partial<SquigNode>> = {}
  for (const id of docBefore.order) {
    const current = docAfter.nodes[id]
    const wanted = docBefore.nodes[id]
    if (current && !sameValue(current, wanted)) patches[id] = restorationPatch(current, wanted)
  }
  if (Object.keys(patches).length) inverse.push({ t: "updateMany", patches })

  const intermediateOrder = docAfter.order.filter((id) => !remove.includes(id))
  intermediateOrder.push(...docBefore.order.filter((id) => !afterIds.has(id)))
  inverse.push(...restoreOrder(intermediateOrder, docBefore.order))
  return inverse
}

export function applyOps(doc: Doc, ops: readonly Op[], ctx: OpContext): Doc {
  return ops.reduce((current, op) => applyOp(current, op, ctx).doc, doc)
}
