"use client"

import { useEffect } from "react"
import { useSquig } from "@/lib/store"
import { Canvas } from "@/components/canvas/canvas"
import { LeftRail } from "@/components/chrome/left-rail"
import { LibraryPanel } from "@/components/chrome/library-panel"
import { Inspector } from "@/components/chrome/inspector"
import { TopCorner, ZoomPill, CommandHint } from "@/components/chrome/top-corner"
import { CommandPalette } from "@/components/chrome/command-palette"
import { CanvasContextMenu } from "@/components/chrome/context-menu"

export default function Home() {
  const hydrated = useSquig((s) => s.hydrated)
  const hydrate = useSquig((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  if (!hydrated) {
    return (
      <main className="flex h-full items-center justify-center" style={{ backgroundColor: "#faf9f6" }}>
        <p className="font-sketch text-xl" style={{ color: "#b9b3a9" }}>
          warming up the pencils…
        </p>
      </main>
    )
  }

  return (
    <main className="relative h-full">
      <Canvas />
      <TopCorner />
      <LeftRail />
      <LibraryPanel />
      <Inspector />
      <ZoomPill />
      <CommandHint />
      <CanvasContextMenu />
      <CommandPalette />
    </main>
  )
}
