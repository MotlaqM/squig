"use client"

// ---------------------------------------------------------------------------
// Texture patterns — halftone, checker, dither, diagonal, grid.
//
// These are what make the flat vector look feel printed rather than rendered.
// Mounted once per document in a zero-size <svg>; SVG paint references are
// document-scoped, so every other <svg> on the page can point at them with
// fill="url(#sq-tex-...)" without carrying its own copy.
// ---------------------------------------------------------------------------

import { memo } from "react"

export const TEXTURES = ["halftone", "checker", "dither", "diagonal", "grid", "cross"] as const
export type TextureName = (typeof TEXTURES)[number]

export const TONES = ["ink", "muted", "faint"] as const
export type ToneName = (typeof TONES)[number]

export function textureUrl(texture: TextureName, tone: ToneName): string {
  return `url(#sq-tex-${texture}-${tone})`
}

/** Pattern tile geometry per texture. `c` is the mark colour, `bg` the paper. */
function tile(texture: TextureName, c: string) {
  switch (texture) {
    case "halftone":
      return { size: 5, content: <circle cx={2.5} cy={2.5} r={1.05} fill={c} /> }
    case "checker":
      return {
        size: 8,
        content: (
          <>
            <rect width={4} height={4} fill={c} />
            <rect x={4} y={4} width={4} height={4} fill={c} />
          </>
        ),
      }
    case "dither":
      return {
        size: 4,
        content: (
          <>
            <rect width={2} height={2} fill={c} />
            <rect x={2} y={2} width={2} height={2} fill={c} />
          </>
        ),
      }
    case "diagonal":
      return { size: 6, content: <rect width={2.4} height={6} fill={c} />, rotate: 45 }
    case "grid":
      return {
        size: 8,
        content: (
          <>
            <rect width={8} height={0.9} fill={c} />
            <rect width={0.9} height={8} fill={c} />
          </>
        ),
      }
    case "cross":
      return {
        size: 7,
        content: (
          <>
            <rect y={3.1} width={7} height={0.9} fill={c} />
            <rect x={3.1} width={0.9} height={7} fill={c} />
          </>
        ),
        rotate: 45,
      }
  }
}

export const SketchDefs = memo(function SketchDefs() {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={0}
      height={0}
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {TEXTURES.map((texture) =>
          TONES.map((tone) => {
            const c = `var(--sq-${tone})`
            const t = tile(texture, c)
            return (
              <pattern
                key={`${texture}-${tone}`}
                id={`sq-tex-${texture}-${tone}`}
                width={t.size}
                height={t.size}
                patternUnits="userSpaceOnUse"
                patternTransform={t.rotate ? `rotate(${t.rotate})` : undefined}
              >
                {/* opaque paper behind the marks so a textured surface occludes */}
                <rect width={t.size} height={t.size} fill="var(--sq-paper)" />
                {t.content}
              </pattern>
            )
          })
        )}
      </defs>
    </svg>
  )
})
