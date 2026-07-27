// ---------------------------------------------------------------------------
// Smart Guides — Snap Engine
// ---------------------------------------------------------------------------
// Pure calculation engine for alignment snapping. No React, no store.
// All calculations in screen space (overlay-relative pixels) so the snap
// threshold feels consistent regardless of zoom level.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rectangle in screen-space overlay coordinates. */
export interface SnapRect {
  id: string
  left: number
  top: number
  width: number
  height: number
  /** center x = left + width / 2 */
  cx: number
  /** center y = top + height / 2 */
  cy: number
}

/** A guide line to render on the overlay. */
export interface GuideLine {
  axis: "x" | "y"
  /** For axis='x' this is the x position; for axis='y' this is the y position */
  position: number
  /** Extent start (min of aligned elements) */
  start: number
  /** Extent end (max of aligned elements) */
  end: number
}

/** A distance indicator between two edges. */
export interface DistanceIndicator {
  axis: "x" | "y"
  /** Pixel distance */
  distance: number
  /** Line start */
  x1: number
  y1: number
  /** Line end */
  x2: number
  y2: number
  /** Label position */
  labelX: number
  labelY: number
}

/** Result of a snap calculation. */
export interface SnapResult {
  /** Screen-space delta to apply */
  dx: number
  dy: number
  /** Guide lines to render */
  guides: GuideLine[]
  /** Distance indicators to render */
  distances: DistanceIndicator[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSnapRect(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number
): SnapRect {
  return { id, left, top, width, height, cx: left + width / 2, cy: top + height / 2 }
}

/** Extract 3 snap positions per axis. */
function getEdges(r: SnapRect): { x: number[]; y: number[] } {
  return {
    x: [r.left, r.cx, r.left + r.width],
    y: [r.top, r.cy, r.top + r.height],
  }
}

// ---------------------------------------------------------------------------
// computeSnap — Core snapping algorithm
// ---------------------------------------------------------------------------

/**
 * Compare the dragged rect's edges/centers against all candidate edges.
 * For each axis independently, find the smallest delta within `threshold`.
 * Returns the snap delta (screen px) and guide lines to render.
 */
export function computeSnap(
  dragged: SnapRect,
  candidates: SnapRect[],
  threshold: number,
  parent?: SnapRect
): SnapResult {
  const allCandidates = parent ? [parent, ...candidates] : candidates
  const dragEdges = getEdges(dragged)
  const guides: GuideLine[] = []

  let bestDx = Infinity
  let bestDy = Infinity
  const xMatches: { pos: number; rects: SnapRect[]; dragEdgeIdx: number }[] = []
  const yMatches: { pos: number; rects: SnapRect[]; dragEdgeIdx: number }[] = []

  // Check X axis (vertical guide lines)
  for (let di = 0; di < dragEdges.x.length; di++) {
    const dragPos = dragEdges.x[di]
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.x) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDx)) {
          bestDx = delta
          xMatches.length = 0
          xMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
        } else if (absDelta === Math.abs(bestDx) && delta === bestDx) {
          // Same delta — collect for multi-element guides
          const existing = xMatches.find((m) => m.pos === candPos)
          if (existing) {
            existing.rects.push(cand)
          } else {
            xMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
          }
        }
      }
    }
  }

  // Check Y axis (horizontal guide lines)
  for (let di = 0; di < dragEdges.y.length; di++) {
    const dragPos = dragEdges.y[di]
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.y) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDy)) {
          bestDy = delta
          yMatches.length = 0
          yMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
        } else if (absDelta === Math.abs(bestDy) && delta === bestDy) {
          const existing = yMatches.find((m) => m.pos === candPos)
          if (existing) {
            existing.rects.push(cand)
          } else {
            yMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
          }
        }
      }
    }
  }

  const dx = isFinite(bestDx) ? bestDx : 0
  const dy = isFinite(bestDy) ? bestDy : 0

  // Build guide lines for X matches (vertical lines)
  const snappedDragged = makeSnapRect(
    dragged.id,
    dragged.left + dx,
    dragged.top + dy,
    dragged.width,
    dragged.height
  )

  for (const match of xMatches) {
    // Compute the vertical extent of the guide line
    const allRects = [...match.rects, snappedDragged]
    let minY = Infinity
    let maxY = -Infinity
    for (const r of allRects) {
      minY = Math.min(minY, r.top)
      maxY = Math.max(maxY, r.top + r.height)
    }
    guides.push({
      axis: "x",
      position: match.pos,
      start: minY,
      end: maxY,
    })
  }

  // Build guide lines for Y matches (horizontal lines)
  for (const match of yMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minX = Infinity
    let maxX = -Infinity
    for (const r of allRects) {
      minX = Math.min(minX, r.left)
      maxX = Math.max(maxX, r.left + r.width)
    }
    guides.push({
      axis: "y",
      position: match.pos,
      start: minX,
      end: maxX,
    })
  }

  return { dx, dy, guides, distances: [] }
}

// ---------------------------------------------------------------------------
// computeResizeSnap — Snap only the edges being resized
// ---------------------------------------------------------------------------

/**
 * During resize, only the moving edge(s) should snap.
 * `handle` is the resize handle string like "nw", "e", "se", etc.
 */
export function computeResizeSnap(
  dragged: SnapRect,
  handle: string,
  candidates: SnapRect[],
  threshold: number,
  parent?: SnapRect
): SnapResult {
  const allCandidates = parent ? [parent, ...candidates] : candidates
  const guides: GuideLine[] = []

  // Determine which edges are moving
  const movingLeft = handle.includes("w")
  const movingRight = handle.includes("e")
  const movingTop = handle.includes("n")
  const movingBottom = handle.includes("s")

  // Collect the drag positions to test for each axis
  const testX: number[] = []
  if (movingLeft) testX.push(dragged.left)
  if (movingRight) testX.push(dragged.left + dragged.width)

  const testY: number[] = []
  if (movingTop) testY.push(dragged.top)
  if (movingBottom) testY.push(dragged.top + dragged.height)

  let bestDx = Infinity
  let bestDy = Infinity
  const xMatches: { pos: number; rects: SnapRect[] }[] = []
  const yMatches: { pos: number; rects: SnapRect[] }[] = []

  // X axis
  for (const dragPos of testX) {
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.x) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDx)) {
          bestDx = delta
          xMatches.length = 0
          xMatches.push({ pos: candPos, rects: [cand] })
        } else if (absDelta === Math.abs(bestDx) && delta === bestDx) {
          const existing = xMatches.find((m) => m.pos === candPos)
          if (existing) existing.rects.push(cand)
          else xMatches.push({ pos: candPos, rects: [cand] })
        }
      }
    }
  }

  // Y axis
  for (const dragPos of testY) {
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.y) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDy)) {
          bestDy = delta
          yMatches.length = 0
          yMatches.push({ pos: candPos, rects: [cand] })
        } else if (absDelta === Math.abs(bestDy) && delta === bestDy) {
          const existing = yMatches.find((m) => m.pos === candPos)
          if (existing) existing.rects.push(cand)
          else yMatches.push({ pos: candPos, rects: [cand] })
        }
      }
    }
  }

  const dx = isFinite(bestDx) ? bestDx : 0
  const dy = isFinite(bestDy) ? bestDy : 0

  // Build guide lines
  const snappedDragged = makeSnapRect(
    dragged.id,
    dragged.left + (movingLeft ? dx : 0),
    dragged.top + (movingTop ? dy : 0),
    dragged.width + (movingRight ? dx : movingLeft ? -dx : 0),
    dragged.height + (movingBottom ? dy : movingTop ? -dy : 0)
  )

  for (const match of xMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minY = Infinity
    let maxY = -Infinity
    for (const r of allRects) {
      minY = Math.min(minY, r.top)
      maxY = Math.max(maxY, r.top + r.height)
    }
    guides.push({ axis: "x", position: match.pos, start: minY, end: maxY })
  }

  for (const match of yMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minX = Infinity
    let maxX = -Infinity
    for (const r of allRects) {
      minX = Math.min(minX, r.left)
      maxX = Math.max(maxX, r.left + r.width)
    }
    guides.push({ axis: "y", position: match.pos, start: minX, end: maxX })
  }

  return { dx, dy, guides, distances: [] }
}

// ---------------------------------------------------------------------------
// computeDistances — Alt+hover distance indicators
// ---------------------------------------------------------------------------

/**
 * For each direction (left, right, up, down), find the nearest element
 * that overlaps on the perpendicular axis and compute the pixel gap.
 * `scale` converts screen distances to world (design-space) distances
 * so labels show the correct value regardless of zoom level.
 */
export function computeDistances(
  selected: SnapRect,
  candidates: SnapRect[],
  parent?: SnapRect,
  scale: number = 1
): DistanceIndicator[] {
  const allCandidates = parent ? [parent, ...candidates] : candidates
  const indicators: DistanceIndicator[] = []

  const selLeft = selected.left
  const selRight = selected.left + selected.width
  const selTop = selected.top
  const selBottom = selected.top + selected.height

  // For each candidate, check if it overlaps on one axis and compute gap on the other
  for (const cand of allCandidates) {
    if (cand.id === selected.id) continue

    const candLeft = cand.left
    const candRight = cand.left + cand.width
    const candTop = cand.top
    const candBottom = cand.top + cand.height

    // Vertical overlap check (for horizontal distance)
    const vOverlapStart = Math.max(selTop, candTop)
    const vOverlapEnd = Math.min(selBottom, candBottom)
    const hasVerticalOverlap = vOverlapEnd > vOverlapStart

    // Horizontal overlap check (for vertical distance)
    const hOverlapStart = Math.max(selLeft, candLeft)
    const hOverlapEnd = Math.min(selRight, candRight)
    const hasHorizontalOverlap = hOverlapEnd > hOverlapStart

    if (hasVerticalOverlap) {
      const midY = (vOverlapStart + vOverlapEnd) / 2

      // Gap to the left
      if (candRight <= selLeft) {
        const dist = selLeft - candRight
        indicators.push({
          axis: "x",
          distance: Math.round(dist / scale),
          x1: candRight,
          y1: midY,
          x2: selLeft,
          y2: midY,
          labelX: candRight + dist / 2,
          labelY: midY,
        })
      }

      // Gap to the right
      if (candLeft >= selRight) {
        const dist = candLeft - selRight
        indicators.push({
          axis: "x",
          distance: Math.round(dist / scale),
          x1: selRight,
          y1: midY,
          x2: candLeft,
          y2: midY,
          labelX: selRight + dist / 2,
          labelY: midY,
        })
      }
    }

    if (hasHorizontalOverlap) {
      const midX = (hOverlapStart + hOverlapEnd) / 2

      // Gap above
      if (candBottom <= selTop) {
        const dist = selTop - candBottom
        indicators.push({
          axis: "y",
          distance: Math.round(dist / scale),
          x1: midX,
          y1: candBottom,
          x2: midX,
          y2: selTop,
          labelX: midX,
          labelY: candBottom + dist / 2,
        })
      }

      // Gap below
      if (candTop >= selBottom) {
        const dist = candTop - selBottom
        indicators.push({
          axis: "y",
          distance: Math.round(dist / scale),
          x1: midX,
          y1: selBottom,
          x2: midX,
          y2: candTop,
          labelX: midX,
          labelY: selBottom + dist / 2,
        })
      }
    }
  }

  // Also compute distance to parent edges if parent is provided
  if (parent) {
    const pLeft = parent.left
    const pRight = parent.left + parent.width
    const pTop = parent.top
    const pBottom = parent.top + parent.height

    // Distance to parent left edge
    if (selLeft > pLeft) {
      const dist = selLeft - pLeft
      indicators.push({
        axis: "x",
        distance: Math.round(dist / scale),
        x1: pLeft,
        y1: selected.cy,
        x2: selLeft,
        y2: selected.cy,
        labelX: pLeft + dist / 2,
        labelY: selected.cy,
      })
    }

    // Distance to parent right edge
    if (selRight < pRight) {
      const dist = pRight - selRight
      indicators.push({
        axis: "x",
        distance: Math.round(dist / scale),
        x1: selRight,
        y1: selected.cy,
        x2: pRight,
        y2: selected.cy,
        labelX: selRight + dist / 2,
        labelY: selected.cy,
      })
    }

    // Distance to parent top edge
    if (selTop > pTop) {
      const dist = selTop - pTop
      indicators.push({
        axis: "y",
        distance: Math.round(dist / scale),
        x1: selected.cx,
        y1: pTop,
        x2: selected.cx,
        y2: selTop,
        labelX: selected.cx,
        labelY: pTop + dist / 2,
      })
    }

    // Distance to parent bottom edge
    if (selBottom < pBottom) {
      const dist = pBottom - selBottom
      indicators.push({
        axis: "y",
        distance: Math.round(dist / scale),
        x1: selected.cx,
        y1: selBottom,
        x2: selected.cx,
        y2: pBottom,
        labelX: selected.cx,
        labelY: selBottom + dist / 2,
      })
    }
  }

  return indicators
}

// ---------------------------------------------------------------------------
// computePairwiseDistances — Alt + hover specific target
// ---------------------------------------------------------------------------

/**
 * Distances between exactly two rects (selected ↔ target). For disjoint rects,
 * emits up to two indicators (one per axis where there is a gap). Unlike
 * `computeDistances`, falls back to a projection when there is no overlap on
 * the perpendicular axis, so users can measure spacing to any element they
 * hover. When one rect fully contains the other (e.g. hovering the parent
 * container), emits inset distances from the inner rect to all four outer
 * edges instead.
 */
export function computePairwiseDistances(
  selected: SnapRect,
  target: SnapRect,
  scale: number = 1
): DistanceIndicator[] {
  if (target.id === selected.id) return []
  const indicators: DistanceIndicator[] = []

  const selLeft = selected.left
  const selRight = selected.left + selected.width
  const selTop = selected.top
  const selBottom = selected.top + selected.height
  const tLeft = target.left
  const tRight = target.left + target.width
  const tTop = target.top
  const tBottom = target.top + target.height

  // Containment: measure the inner rect's inset to each outer edge, matching
  // the parent-edge behavior in `computeDistances`.
  const targetContainsSel =
    tLeft <= selLeft && tRight >= selRight && tTop <= selTop && tBottom >= selBottom
  const selContainsTarget =
    selLeft <= tLeft && selRight >= tRight && selTop <= tTop && selBottom >= tBottom
  if (targetContainsSel || selContainsTarget) {
    const inner = targetContainsSel ? selected : target
    const outer = targetContainsSel ? target : selected
    const inLeft = inner.left
    const inRight = inner.left + inner.width
    const inTop = inner.top
    const inBottom = inner.top + inner.height
    const outLeft = outer.left
    const outRight = outer.left + outer.width
    const outTop = outer.top
    const outBottom = outer.top + outer.height

    if (inLeft > outLeft) {
      const dist = inLeft - outLeft
      indicators.push({
        axis: "x",
        distance: Math.round(dist / scale),
        x1: outLeft,
        y1: inner.cy,
        x2: inLeft,
        y2: inner.cy,
        labelX: outLeft + dist / 2,
        labelY: inner.cy,
      })
    }
    if (inRight < outRight) {
      const dist = outRight - inRight
      indicators.push({
        axis: "x",
        distance: Math.round(dist / scale),
        x1: inRight,
        y1: inner.cy,
        x2: outRight,
        y2: inner.cy,
        labelX: inRight + dist / 2,
        labelY: inner.cy,
      })
    }
    if (inTop > outTop) {
      const dist = inTop - outTop
      indicators.push({
        axis: "y",
        distance: Math.round(dist / scale),
        x1: inner.cx,
        y1: outTop,
        x2: inner.cx,
        y2: inTop,
        labelX: inner.cx,
        labelY: outTop + dist / 2,
      })
    }
    if (inBottom < outBottom) {
      const dist = outBottom - inBottom
      indicators.push({
        axis: "y",
        distance: Math.round(dist / scale),
        x1: inner.cx,
        y1: inBottom,
        x2: inner.cx,
        y2: outBottom,
        labelX: inner.cx,
        labelY: inBottom + dist / 2,
      })
    }
    return indicators
  }

  // Horizontal gap (x-axis). Use vertical-overlap midpoint when overlapping,
  // otherwise project from the selected rect's center y.
  const vOverlapStart = Math.max(selTop, tTop)
  const vOverlapEnd = Math.min(selBottom, tBottom)
  const midY = vOverlapEnd > vOverlapStart ? (vOverlapStart + vOverlapEnd) / 2 : selected.cy

  if (tRight <= selLeft) {
    const dist = selLeft - tRight
    indicators.push({
      axis: "x",
      distance: Math.round(dist / scale),
      x1: tRight,
      y1: midY,
      x2: selLeft,
      y2: midY,
      labelX: tRight + dist / 2,
      labelY: midY,
    })
  } else if (tLeft >= selRight) {
    const dist = tLeft - selRight
    indicators.push({
      axis: "x",
      distance: Math.round(dist / scale),
      x1: selRight,
      y1: midY,
      x2: tLeft,
      y2: midY,
      labelX: selRight + dist / 2,
      labelY: midY,
    })
  }

  // Vertical gap (y-axis). Mirror of the horizontal case.
  const hOverlapStart = Math.max(selLeft, tLeft)
  const hOverlapEnd = Math.min(selRight, tRight)
  const midX = hOverlapEnd > hOverlapStart ? (hOverlapStart + hOverlapEnd) / 2 : selected.cx

  if (tBottom <= selTop) {
    const dist = selTop - tBottom
    indicators.push({
      axis: "y",
      distance: Math.round(dist / scale),
      x1: midX,
      y1: tBottom,
      x2: midX,
      y2: selTop,
      labelX: midX,
      labelY: tBottom + dist / 2,
    })
  } else if (tTop >= selBottom) {
    const dist = tTop - selBottom
    indicators.push({
      axis: "y",
      distance: Math.round(dist / scale),
      x1: midX,
      y1: selBottom,
      x2: midX,
      y2: tTop,
      labelX: midX,
      labelY: selBottom + dist / 2,
    })
  }

  return indicators
}

// ---------------------------------------------------------------------------
// Candidate collectors
// ---------------------------------------------------------------------------

/**
 * Collect snap candidates for a node being dragged.
 * Returns sibling node rects and the parent artboard/group content area rect.
 * All coordinates are in overlay-relative screen space.
 */
export function collectNodeSnapCandidates(
  draggedId: string,
  containerEl: HTMLElement | null
): { siblings: SnapRect[]; parent: SnapRect | null } {
  if (!containerEl) return { siblings: [], parent: null }
  const containerRect = containerEl.getBoundingClientRect()

  // Find the dragged element and its parent container
  const draggedEl = document.querySelector(`[data-studio-id="${draggedId}"]`) as HTMLElement | null
  if (!draggedEl) return { siblings: [], parent: null }

  // Find parent: either an artboard or a group node
  const parentEl =
    (draggedEl.parentElement?.closest("[data-studio-id]") as HTMLElement | null) ??
    (draggedEl.closest("[data-studio-artboard]")?.children[0] as HTMLElement | null)

  // Get parent rect
  let parentRect: SnapRect | null = null
  if (parentEl) {
    // Use artboard content area for parent rect
    const artboardEl = draggedEl.closest("[data-studio-artboard]") as HTMLElement | null
    const contentEl = artboardEl?.children[0] as HTMLElement | null
    if (contentEl) {
      const r = contentEl.getBoundingClientRect()
      parentRect = makeSnapRect(
        artboardEl?.getAttribute("data-studio-artboard") ?? "parent",
        r.left - containerRect.left,
        r.top - containerRect.top,
        r.width,
        r.height
      )
    }
  }

  // Collect siblings: children of the same parent that are not the dragged node
  const siblings: SnapRect[] = []
  const parentContainer = draggedEl.parentElement
  if (parentContainer) {
    for (const child of parentContainer.children) {
      const childEl = child as HTMLElement
      const childId = childEl.getAttribute("data-studio-id")
      if (!childId || childId === draggedId) continue

      const r = childEl.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      siblings.push(
        makeSnapRect(
          childId,
          r.left - containerRect.left,
          r.top - containerRect.top,
          r.width,
          r.height
        )
      )
    }
  }

  return { siblings, parent: parentRect }
}

/**
 * Collect snap candidates for an artboard being dragged.
 * Converts all other artboards from world coordinates to screen space.
 */
export function collectArtboardSnapCandidates(
  draggedId: string,
  artboards: { id: string; x: number; y: number; width: number; height: number }[],
  zoom: number,
  panX: number,
  panY: number
): SnapRect[] {
  const rects: SnapRect[] = []
  for (const ab of artboards) {
    if (ab.id === draggedId) continue
    // World to screen: screenX = ab.x * zoom + panX, relative to container
    const screenLeft = ab.x * zoom + panX
    const screenTop = ab.y * zoom + panY
    const screenWidth = ab.width * zoom
    const screenHeight = ab.height * zoom
    rects.push(makeSnapRect(ab.id, screenLeft, screenTop, screenWidth, screenHeight))
  }
  return rects
}
