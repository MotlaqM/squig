"use client"

// ---------------------------------------------------------------------------
// Sketch renderers — turn prims / nodes into rough.js SVG paths.
//
// Tuning note: this is deliberately *restrained* hand-drawn. The target is
// FigJam/tldraw — enough irregularity to read as "not decided yet", not so
// much that it reads as a napkin. Low roughness, low bowing, single stroke,
// rounded corners, soft hatching. Icons stay crisp.
// ---------------------------------------------------------------------------

import { memo, useMemo } from "react"
import rough from "roughjs"
import type { Options } from "roughjs/bin/core"
import type { RoughGenerator } from "roughjs/bin/generator"
import { INK, type Prim } from "@/lib/sketch/kit"
import type { SquigNode } from "@/lib/types"
import { renderComponent } from "@/lib/library/registry"

const gen: RoughGenerator = rough.generator()

/** House defaults. Nudge these to retune the whole app's hand. */
const HAND = {
  roughness: 0.5,
  bowing: 0.6,
  strokeWidth: 1.25,
  /** default corner rounding for rects that don't ask for one */
  radius: 3,
}

/**
 * Filled surfaces read as soft grey washes, not scribbled-in boxes. Diagonal
 * hatching is the single loudest thing rough.js does, and on a canvas full of
 * buttons it turns the whole page into static — so "hachure" resolves to a
 * flat tint here. `fill: "solid"` still means genuinely opaque (menus, popovers).
 */
const WASH: Record<string, string> = {
  ink: "#e4e0d8",
  muted: "#eeebe5",
  faint: "#f4f2ee",
  paper: "#fdfcfa",
  accent: "#e4e0d8",
}

function primOptions(p: Prim, seed: number): Options {
  const o = "o" in p ? p.o : undefined
  const opts: Options = {
    seed,
    roughness: o?.roughness ?? HAND.roughness,
    bowing: HAND.bowing,
    stroke: INK[o?.stroke ?? "ink"],
    strokeWidth: o?.strokeWidth ?? HAND.strokeWidth,
    fill: undefined,
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
    preserveVertices: true,
  }
  if (o?.fill && o.fill !== "none") {
    opts.fillStyle = "solid"
    opts.fill = o.fill === "hachure" ? WASH[o.fillColor ?? "faint"] : INK[o.fillColor ?? "faint"]
  }
  return opts
}

/** Rounded-rect as SVG path data — rough.js has no radius of its own. */
function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2))
  if (rr < 0.5) return `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`
  return [
    `M${x + rr} ${y}`,
    `L${x + w - rr} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + rr}`,
    `L${x + w} ${y + h - rr}`,
    `Q${x + w} ${y + h} ${x + w - rr} ${y + h}`,
    `L${x + rr} ${y + h}`,
    `Q${x} ${y + h} ${x} ${y + h - rr}`,
    `L${x} ${y + rr}`,
    `Q${x} ${y} ${x + rr} ${y}`,
    "Z",
  ].join(" ")
}

interface PathBit {
  d: string
  stroke: string
  strokeWidth: number
  fill: string
  dash?: string
}

/** Icon / raw-path prims, rendered crisp rather than through rough.js. */
interface CrispBit {
  d: string[]
  transform: string
  mode: "fill" | "stroke"
  color: string
  strokeWidth: number
}

function drawableToPaths(drawable: ReturnType<RoughGenerator["rectangle"]>, dash?: string): PathBit[] {
  return gen.toPaths(drawable).map((pi) => ({
    d: pi.d,
    stroke: pi.stroke,
    strokeWidth: pi.strokeWidth,
    fill: pi.fill ?? "none",
    // only dash real strokes — dashing the hachure fill looks like static
    dash: dash && pi.stroke !== "none" ? dash : undefined,
  }))
}

export function primsToPaths(
  prims: Prim[],
  seed: number
): { paths: PathBit[]; texts: Extract<Prim, { t: "text" }>[]; crisp: CrispBit[] } {
  const paths: PathBit[] = []
  const texts: Extract<Prim, { t: "text" }>[] = []
  const crisp: CrispBit[] = []

  prims.forEach((p, i) => {
    const s = ((seed + i * 7919) % 2 ** 31) || 1
    const dash = "o" in p && p.o?.dashed ? "6 4" : undefined
    try {
      switch (p.t) {
        case "rect": {
          const r = p.r ?? p.o?.r ?? HAND.radius
          paths.push(...drawableToPaths(gen.path(roundRectPath(p.x, p.y, p.w, p.h, r), primOptions(p, s)), dash))
          break
        }
        case "ellipse":
          paths.push(...drawableToPaths(gen.ellipse(p.x + p.w / 2, p.y + p.h / 2, p.w, p.h, primOptions(p, s)), dash))
          break
        case "line":
          paths.push(...drawableToPaths(gen.line(p.x1, p.y1, p.x2, p.y2, primOptions(p, s)), dash))
          break
        case "poly":
          if (p.close) paths.push(...drawableToPaths(gen.polygon(p.pts, primOptions(p, s)), dash))
          else paths.push(...drawableToPaths(gen.linearPath(p.pts, primOptions(p, s)), dash))
          break
        case "path": {
          const k = p.size / p.vb
          crisp.push({
            d: p.d,
            transform: `translate(${p.x} ${p.y}) scale(${k})`,
            mode: p.mode,
            color: INK[p.o?.stroke ?? "ink"],
            strokeWidth: (p.o?.strokeWidth ?? 12) / k,
          })
          break
        }
        case "text":
          texts.push(p)
          break
      }
    } catch {
      // rough.js throws on degenerate geometry mid-resize — drop that prim
    }
  })
  return { paths, texts, crisp }
}

export const SketchPrims = memo(function SketchPrims({ prims, seed }: { prims: Prim[]; seed: number }) {
  const { paths, texts, crisp } = useMemo(() => primsToPaths(prims, seed), [prims, seed])
  return (
    <>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          fill={p.fill}
          strokeDasharray={p.dash}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {crisp.map((c, i) => (
        <g key={`c${i}`} transform={c.transform}>
          {c.d.map((d, j) => (
            <path
              key={j}
              d={d}
              fill={c.mode === "fill" ? c.color : "none"}
              stroke={c.mode === "stroke" ? c.color : "none"}
              strokeWidth={c.mode === "stroke" ? c.strokeWidth : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      ))}
      {texts.map((t, i) => (
        <text
          key={`t${i}`}
          x={t.x}
          y={t.y}
          fontSize={t.size}
          fontFamily="var(--font-sketch)"
          fontWeight={t.bold ? 700 : 400}
          fill={INK[t.color ?? "ink"]}
          textAnchor={t.align === "center" ? "middle" : t.align === "right" ? "end" : "start"}
        >
          {t.text}
        </text>
      ))}
    </>
  )
})

/**
 * Render a node's visual content (no hit area, no selection ring).
 *
 * Geometry is memoized on the shape-affecting fields only — NOT on x/y, which
 * the parent <g transform> handles. Without that, dragging a template would
 * re-run rough.js over hundreds of prims on every pointer move.
 */
export const NodeSketch = memo(function NodeSketch({ node }: { node: SquigNode }) {
  const shapeKey = useMemo(() => {
    switch (node.type) {
      case "component":
        return `c:${node.kind}:${node.w}:${node.h}:${JSON.stringify(node.props)}`
      case "shape":
        return `s:${node.shape}:${node.w}:${node.h}:${node.fill}`
      case "draw":
        return `d:${node.points.length}:${node.w}:${node.h}:${node.points[0]?.join()}:${node.points.at(-1)?.join()}`
      case "arrow":
        return `a:${node.w}:${node.h}:${node.head}:${node.points.flat().join()}`
      case "text":
        return `t:${node.text}:${node.fontSize}`
    }
  }, [node])

  const prims = useMemo<Prim[]>(() => {
    switch (node.type) {
      case "component":
        return renderComponent(node.kind, node.props, node.w, node.h)
      case "shape":
        if (node.shape === "ellipse")
          return [
            { t: "ellipse", x: 0, y: 0, w: node.w, h: node.h, o: node.fill ? { fill: "hachure", fillColor: "ink" } : undefined },
          ]
        return [
          { t: "rect", x: 0, y: 0, w: node.w, h: node.h, r: 6, o: node.fill ? { fill: "hachure", fillColor: "ink" } : undefined },
        ]
      case "draw":
        // freehand is already the user's own line — barely roughen it
        return [{ t: "poly", pts: node.points, o: { roughness: 0.2, strokeWidth: 1.9 } }]
      case "arrow": {
        const [[x1, y1], [x2, y2]] = node.points
        const out: Prim[] = [{ t: "line", x1, y1, x2, y2, o: { strokeWidth: 1.6 } }]
        if (node.head) {
          const a = Math.atan2(y2 - y1, x2 - x1)
          const L = 12
          out.push({
            t: "poly",
            pts: [
              [x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)],
              [x2, y2],
              [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)],
            ],
            o: { strokeWidth: 1.6 },
          })
        }
        return out
      }
      case "text":
        return node.text.split("\n").map((lineText, i): Prim => ({
          t: "text",
          x: 0,
          y: node.fontSize * (i + 1),
          text: lineText,
          size: node.fontSize,
        }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey, node.type])

  return <SketchPrims prims={prims} seed={node.seed} />
})
