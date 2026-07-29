"use client"

// ---------------------------------------------------------------------------
// Library panel — floats next to the rail. Search on top, grouped two-column
// grid of live sketch previews. Pick one, then click the canvas to drop it —
// or drag one straight out of the grid and let go where you want it.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react"
import { useSquig, type PanelKind } from "@/lib/store"
import { groupDefs, searchDefs, type ComponentDef } from "@/lib/library/registry"
import { SketchPrims } from "@/components/canvas/sketch"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Panel, PanelFooter } from "@/components/ui/panel"
import { cn } from "@/lib/utils"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"

const BOX_W = 118
const BOX_H = 82
/** screen px of travel before a press on a preview stops being a click */
const DRAG_THRESHOLD = 4

function Preview({
  def,
  active,
  onPick,
  onDragOut,
}: {
  def: ComponentDef
  active: boolean
  onPick: () => void
  onDragOut: () => void
}) {
  const prims = useMemo(() => def.render(def.defaults, def.size.w, def.size.h), [def])
  const scale = Math.min((BOX_W - 14) / def.size.w, (BOX_H - 14) / def.size.h, 1)
  const ox = (BOX_W - def.size.w * scale) / 2
  const oy = (BOX_H - def.size.h * scale) / 2
  /** this press turned into a drag, so the click it ends with isn't a pick */
  const dragged = useRef(false)

  /**
   * Drag out of the panel: past the threshold this becomes a pending placement,
   * and the canvas takes it from there — it draws the ghost and does the drop on
   * pointer up. Nothing happens until the threshold, so a plain click still just
   * picks the component the way it always did.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !e.isPrimary) return
    const el = e.currentTarget
    const { pointerId } = e
    const sx = e.clientX
    const sy = e.clientY
    dragged.current = false
    const ac = new AbortController()
    const stop = () => {
      ac.abort()
      // click fires before timers, so the guard below still sees the drag
      setTimeout(() => (dragged.current = false), 0)
    }
    window.addEventListener(
      "pointermove",
      (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || dragged.current) return
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return
        dragged.current = true
        // keep the events coming once the pointer leaves the button. Capture is
        // a nicety, not the mechanism — the listeners are on window either way,
        // so a pointer that's already gone must not take the drag down with it.
        try {
          el.setPointerCapture(pointerId)
        } catch {
          // no live pointer to capture — carry on
        }
        onDragOut()
      },
      { signal: ac.signal }
    )
    window.addEventListener("pointerup", stop, { signal: ac.signal })
    window.addEventListener("pointercancel", stop, { signal: ac.signal })
  }

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={() => {
        if (dragged.current) return
        onPick()
      }}
      title={def.name}
      className={cn(
        "group flex flex-col items-center gap-1 rounded-chrome-sm border border-border/70 p-1 transition-colors outline-none hover:border-border hover:bg-accent",
        active && "border-[var(--sq-ink)] bg-[var(--sq-ink)]/8 ring-1 ring-inset ring-[var(--sq-ink)]/25"
      )}
    >
      <svg width={BOX_W} height={BOX_H} className="shrink-0">
        <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
          <SketchPrims prims={prims} seed={13} />
        </g>
      </svg>
      {/* a component's name, not a hint — it stays at label size */}
      <span className="w-full truncate pb-0.5 text-center text-label leading-none text-muted-foreground group-hover:text-foreground">
        {def.name}
      </span>
    </button>
  )
}

/**
 * Mounted only while a panel is chosen, and keyed by which one — switching
 * tabs gets a fresh empty search box for free.
 */
export function LibraryPanel() {
  const panel = useSquig((s) => s.panel)
  if (!panel) return null
  return <Library key={panel} panel={panel} />
}

function Library({ panel }: { panel: Exclude<PanelKind, null> }) {
  const placing = useSquig((s) => s.placing)
  const placingDrag = useSquig((s) => s.placingDrag)
  const st = useSquig.getState
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const sections = useMemo(() => groupDefs(searchDefs(panel, query), panel), [panel, query])

  const total = sections.reduce((n, s) => n + s.defs.length, 0)
  const first = sections[0]?.defs[0]

  return (
    <Panel className="absolute top-1/2 left-16 z-30 max-h-[82vh] w-[316px] -translate-y-1/2">
      <div className="relative shrink-0 border-b border-border/70 p-3">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-[22px] size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={panel === "components" ? "find a component…" : "find a block…"}
          className="h-ctl-lg pl-9 text-row"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Escape") st().setPanel(null)
            if (e.key === "Enter" && first) st().setPlacing(first.kind)
          }}
        />
      </div>

      {/* min-h-0 — without it the flex item won't shrink below its content.
          The scrollbar fades in while scrolling or hovering, so a list this
          long doesn't look like it ends at the fold. */}
      <ScrollArea className="min-h-0 flex-1 overscroll-contain">
        <div className="p-3 pt-1.5">
          {sections.map((section) => (
            <div key={section.group} className="mb-3">
              <div className="px-0.5 pt-2 pb-2 text-label font-medium text-foreground">
                {section.group}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {section.defs.map((def) => (
                  <Preview
                    key={def.kind}
                    def={def}
                    active={placing === def.kind}
                    onPick={() => st().setPlacing(placing === def.kind ? null : def.kind)}
                    onDragOut={() => st().setPlacing(def.kind, { drag: true })}
                  />
                ))}
              </div>
            </div>
          ))}
          {!total && (
            <p className="py-8 text-center text-row text-muted-foreground">
              nothing called &ldquo;{query}&rdquo; in here
            </p>
          )}
        </div>
      </ScrollArea>

      <PanelFooter className="px-gutter py-2.5 text-label text-muted-foreground">
        {placingDrag
          ? "let go where you want it"
          : placing
            ? "now click the canvas to drop it"
            : `${total} to choose from — click one or drag it out`}
      </PanelFooter>
    </Panel>
  )
}
