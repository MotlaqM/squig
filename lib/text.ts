// ---------------------------------------------------------------------------
// Text box measuring — one copy of the sums the inspector, the inline editor
// and the renderer all have to agree on.
//
// They used to each carry their own estimate, which was survivable while a text
// node's box was only ever the size of its words. Alignment makes the box load
// bearing: "right" means "ends at the box's right edge", so a box measured one
// way and drawn against another would sit the words a few pixels off every time
// you changed alignment.
// ---------------------------------------------------------------------------

import { textWidth } from "@/lib/sketch/kit"
import type { TextAlign, TextNode } from "@/lib/types"

/** Lines sit this far apart, as a multiple of the type size. */
export const LINE_HEIGHT = 1.35

/** No text box is narrower than this, however short the word. */
const MIN_TEXT_W = 40

/** The box a run of text needs, in world units. */
export function textBox(text: string, fontSize: number): { w: number; h: number } {
  const lines = (text || " ").split("\n")
  const widest = Math.max(...lines.map((l) => textWidth(l, fontSize)))
  return { w: Math.max(MIN_TEXT_W, widest), h: lines.length * fontSize * LINE_HEIGHT }
}

/**
 * Re-measure a text node after its words or its type size changed.
 *
 * A left-aligned box is exactly its content — the box *is* the text. A centred
 * or right-aligned one keeps any extra width it was given, because that extra
 * width is the only thing the alignment has to work with: snapping back to the
 * content would quietly undo the alignment on the next keystroke.
 */
export function reflowText(n: TextNode, text: string, fontSize: number): Partial<TextNode> {
  const box = textBox(text, fontSize)
  const keepWidth = (n.align ?? "left") !== "left" && n.w > box.w
  return { text, fontSize, w: keepWidth ? n.w : box.w, h: box.h }
}

/** Where a line is anchored inside the node's own box, for a given alignment. */
export function textAnchorX(w: number, align: TextAlign = "left"): number {
  return align === "center" ? w / 2 : align === "right" ? w : 0
}
