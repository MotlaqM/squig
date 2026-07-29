"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  // The viewport stretches as a flex item rather than the stock `size-full`:
  // a percentage height resolves to nothing when the root is itself a flex
  // child, so the viewport grew to its content and the panel clipped it
  // instead of scrolling. Stretching works whether the root's height is
  // capped or content-sized.
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative flex flex-col", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="min-h-0 w-full flex-auto overscroll-contain rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        // Thin and floating — it overlays the content rather than taking a lane
        // of its own, and fades in while you're scrolling or hovering the area.
        "flex touch-none p-px opacity-0 transition-opacity delay-150 select-none data-hovering:opacity-100 data-hovering:delay-0 data-scrolling:opacity-100 data-scrolling:delay-0",
        "data-[orientation=horizontal]:mb-1 data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col",
        "data-[orientation=vertical]:mr-1 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-foreground/20" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
