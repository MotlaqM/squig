// ---------------------------------------------------------------------------
// Sketch kit — the primitive DSL every component renders into.
// A component's render() returns Prim[]; the canvas draws them with rough.js.
// Break-apart works by converting these same prims into real canvas nodes.
// ---------------------------------------------------------------------------

export type InkColor = "ink" | "muted" | "faint" | "paper" | "accent"

export const INK: Record<InkColor, string> = {
  ink: "#2d2a26",
  muted: "#8a857d",
  faint: "#c9c4bb",
  paper: "#fdfcfa",
  accent: "#2d2a26",
}

export interface PrimOpts {
  stroke?: InkColor
  strokeWidth?: number
  fill?: "none" | "hachure" | "solid"
  fillColor?: InkColor
  roughness?: number
  dashed?: boolean
}

export type Prim =
  | ({ t: "rect"; x: number; y: number; w: number; h: number; r?: number } & { o?: PrimOpts })
  | ({ t: "ellipse"; x: number; y: number; w: number; h: number } & { o?: PrimOpts })
  | ({ t: "line"; x1: number; y1: number; x2: number; y2: number } & { o?: PrimOpts })
  | ({ t: "poly"; pts: [number, number][]; close?: boolean } & { o?: PrimOpts })
  | {
      t: "text"
      x: number
      y: number // baseline
      text: string
      size: number
      align?: "left" | "center" | "right"
      color?: InkColor
      bold?: boolean
      maxW?: number
    }
  /**
   * Raw SVG path data in a square viewBox, drawn crisp (not roughened) —
   * icons read better sharp, and it keeps big templates fast.
   * (x, y) is the top-left of the size×size box the icon is scaled into.
   */
  | ({
      t: "path"
      d: string[]
      x: number
      y: number
      size: number
      vb: number
      mode: "fill" | "stroke"
    } & { o?: PrimOpts })

// -- constructors -----------------------------------------------------------

export const rect = (x: number, y: number, w: number, h: number, o?: PrimOpts): Prim => ({ t: "rect", x, y, w, h, o })
export const ellipse = (x: number, y: number, w: number, h: number, o?: PrimOpts): Prim => ({ t: "ellipse", x, y, w, h, o })
export const line = (x1: number, y1: number, x2: number, y2: number, o?: PrimOpts): Prim => ({ t: "line", x1, y1, x2, y2, o })
export const poly = (pts: [number, number][], close?: boolean, o?: PrimOpts): Prim => ({ t: "poly", pts, close, o })
export const text = (
  x: number,
  y: number,
  content: string,
  size: number,
  extra?: Partial<Extract<Prim, { t: "text" }>>
): Prim => ({ t: "text", x, y, text: content, size, ...extra })

/** Translate a batch of prims — lets template blocks compose smaller components. */
export function place(prims: Prim[], dx: number, dy: number): Prim[] {
  return prims.map((p) => {
    switch (p.t) {
      case "rect":
      case "ellipse":
      case "text":
      case "path":
        return { ...p, x: p.x + dx, y: p.y + dy }
      case "line":
        return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy }
      case "poly":
        return { ...p, pts: p.pts.map(([px, py]) => [px + dx, py + dy] as [number, number]) }
    }
  })
}

/** Approx text width in px for the sketch font (Patrick Hand ≈ 0.46em avg). */
export function textWidth(s: string, size: number): number {
  return s.length * size * 0.46
}

export function truncate(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  const chars = Math.max(1, Math.floor(maxW / (size * 0.46)) - 1)
  return s.slice(0, chars) + "…"
}

/**
 * A few squiggly "lorem" lines — the classic wireframe placeholder text.
 * Rendered as slightly wavy horizontal lines.
 */
export function loremLines(x: number, y: number, w: number, count: number, gap = 12): Prim[] {
  const prims: Prim[] = []
  for (let i = 0; i < count; i++) {
    const lw = i === count - 1 ? w * 0.6 : w * (0.85 + (i % 3) * 0.05)
    prims.push(line(x, y + i * gap, x + lw, y + i * gap, { stroke: "muted", strokeWidth: 1.15, roughness: 0.7 }))
  }
  return prims
}

// -- icons ------------------------------------------------------------------
// Phosphor-backed; see ./icons for the name list and aliases.

export { icon, ICON_NAMES, resolveIconName, type IconName } from "./icons"
