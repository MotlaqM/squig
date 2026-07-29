"use client"

import { create } from "zustand"
import { nanoid } from "nanoid"
import type { ComponentNode, SquigNode, TextNode, Tool, Viewport, ShapeKind } from "./types"
import { screenToWorld, unionBox } from "./types"
import { getDef } from "./library/registry"
import { breakApart } from "./library/break-apart"
import { applyTheme, DEFAULT_FONT, DEFAULT_THEME, type FontMode, type ThemeName } from "./theme"
import {
  INDEX_KEY,
  deleteFile as dropFile,
  listFiles,
  loadPrefs,
  migrateLegacyDoc,
  readFile,
  saveFile,
  savePrefs,
  type FileMeta,
} from "./files"

// ---------------------------------------------------------------------------
// Store — flat node map + z-order, selection, viewport, tool, history.
// ---------------------------------------------------------------------------

interface DocSnapshot {
  nodes: Record<string, SquigNode>
  order: string[]
}

export type PanelKind = "components" | "blocks" | null

export interface ContextMenuState {
  x: number
  y: number
  /** node the menu was opened on, or null for the canvas itself */
  nodeId: string | null
}

interface SquigState {
  /** which file in the drawer this canvas is — every doc has one */
  docId: string
  fileName: string
  /** the drawer, newest first; kept in state so menus re-render as it changes */
  files: FileMeta[]
  /** bumped by an explicit save, so the file name can say so out loud */
  saveFlash: number
  nodes: Record<string, SquigNode>
  order: string[]
  selection: string[]
  viewport: Viewport
  tool: Tool
  shapeKind: ShapeKind
  panel: PanelKind
  /** component kind waiting to be placed on next canvas click */
  placing: string | null
  editingId: string | null
  contextRow: boolean
  theme: ThemeName
  font: FontMode
  hydrated: boolean
  commandOpen: boolean
  contextMenu: ContextMenuState | null
  /** the floating file name is in its editable state */
  renamingFile: boolean
  /** the arrow tool draws a head — L is a plain line, ⇧L an arrow */
  arrowHead: boolean
  /** ⌘\ — everything but the canvas gets out of the way */
  uiHidden: boolean
  shortcutsOpen: boolean
  /** ⌘K over selected text opens the link field instead of the palette */
  linkOpen: boolean
  /** private clipboard — ⌘C/⌘X/⌘V never touch the system one */
  clipboard: SquigNode[]

  past: DocSnapshot[]
  future: DocSnapshot[]

  setFileName: (n: string) => void
  setTool: (t: Tool) => void
  setShapeKind: (s: ShapeKind) => void
  setPanel: (p: PanelKind) => void
  setPlacing: (kind: string | null) => void
  setEditing: (id: string | null) => void
  setContextRow: (on: boolean) => void
  setTheme: (t: ThemeName) => void
  setFont: (f: FontMode) => void
  setViewport: (v: Viewport) => void
  setSelection: (ids: string[]) => void
  setCommandOpen: (open: boolean) => void
  setContextMenu: (m: ContextMenuState | null) => void
  setRenamingFile: (on: boolean) => void
  setArrowHead: (on: boolean) => void
  setUiHidden: (on: boolean) => void
  setShortcutsOpen: (on: boolean) => void
  setLinkOpen: (on: boolean) => void

  /** snapshot current doc onto the undo stack (call once at gesture start) */
  checkpoint: () => void
  addNode: (node: Omit<SquigNode, "id" | "seed"> & Partial<Pick<SquigNode, "id" | "seed">>, opts?: { select?: boolean; checkpoint?: boolean }) => string
  addNodes: (nodes: SquigNode[], opts?: { select?: boolean }) => void
  updateNode: (id: string, patch: Partial<SquigNode>) => void
  updateNodes: (patches: Record<string, Partial<SquigNode>>) => void
  removeNodes: (ids: string[]) => void
  deleteSelected: () => void
  /** clone the selection and select the clones; returns the new ids */
  duplicateSelected: (offset?: number) => string[]
  bringToFront: (ids: string[]) => void
  sendToBack: (ids: string[]) => void
  bringForward: (ids: string[]) => void
  sendBackward: (ids: string[]) => void
  undo: () => void
  redo: () => void
  hydrate: () => void
  clearCanvas: () => void

  /** grow a set of ids to whole groups — what a click on a member selects */
  expandSelection: (ids: string[]) => string[]
  groupSelected: () => void
  /** ⇧⌘G — peels one group off, or detaches instances when nothing is grouped */
  ungroupSelected: () => void
  detachSelected: () => void
  flipSelected: (axis: "x" | "y") => void
  toggleTextStyle: (style: "bold" | "italic" | "underline") => void
  setLinkOnSelection: (url: string) => void

  copySelected: () => void
  cutSelected: () => void
  /** paste at a world point, or nudged off the original when none is given */
  pasteClipboard: (at?: [number, number]) => void

  zoomBy: (factor: number, center?: [number, number]) => void
  zoomTo100: () => void
  zoomToFit: () => void
  zoomToSelection: () => void

  /** drop a library item at the middle of what the user is looking at */
  insertComponent: (kind: string) => void
  alignSelected: (edge: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => void
  newFile: () => void
  /** swap the canvas to another file in the drawer, saving this one first */
  openFile: (id: string) => void
  deleteFile: (id: string) => void
  /** write to the drawer right now instead of waiting out the debounce */
  saveNow: () => void
  serialize: () => string
  loadDoc: (json: string) => boolean
}

const MAX_HISTORY = 100
const SAVE_DEBOUNCE_MS = 400
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
/** breathing room around a zoom-to-fit, in screen px */
const FIT_PADDING = 96

function snapshot(s: Pick<SquigState, "nodes" | "order">): DocSnapshot {
  return structuredClone({ nodes: s.nodes, order: s.order })
}

const freshSeed = () => Math.floor(Math.random() * 2 ** 31)

/**
 * Copy nodes for duplicate / paste.
 *
 * Group ids are remapped consistently across the batch, so copying a group
 * gives you a second, independent group rather than two halves of the first.
 */
function cloneNodes(list: SquigNode[], dx: number, dy: number): SquigNode[] {
  const gmap = new Map<string, string>()
  return list.map((n) => {
    const c = structuredClone(n)
    c.id = nanoid(8)
    c.x = n.x + dx
    c.y = n.y + dy
    c.seed = freshSeed()
    if (c.groupIds?.length) {
      c.groupIds = c.groupIds.map((g) => {
        const mapped = gmap.get(g) ?? nanoid(8)
        gmap.set(g, mapped)
        return mapped
      })
    }
    return c
  })
}

/** Frame a set of nodes in the window, with a margin so nothing kisses an edge. */
function fitBox(set: (partial: { viewport: Viewport }) => void, list: SquigNode[], cap = MAX_ZOOM) {
  const box = unionBox(list)
  if (!box) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const bw = Math.max(box.maxX - box.minX, 1)
  const bh = Math.max(box.maxY - box.minY, 1)
  const zoom = Math.min(cap, Math.max(MIN_ZOOM, Math.min((vw - FIT_PADDING * 2) / bw, (vh - FIT_PADDING * 2) / bh)))
  set({
    viewport: {
      zoom,
      x: vw / 2 - (box.minX + bw / 2) * zoom,
      y: vh / 2 - (box.minY + bh / 2) * zoom,
    },
  })
}

/** Move ids one slot along `order`, without jumping over each other. */
function stepOrder(order: string[], ids: string[], dir: 1 | -1): string[] {
  const out = [...order]
  const sel = new Set(ids)
  if (dir === 1) {
    for (let i = out.length - 2; i >= 0; i--) {
      if (sel.has(out[i]) && !sel.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (sel.has(out[i]) && !sel.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** true between an edit and the write that records it */
let dirty = false

/** Every edit calls this; the drawer only gets written once the hand rests. */
function scheduleSave(get: () => SquigState) {
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => flushSave(get), SAVE_DEBOUNCE_MS)
}

/**
 * Write the current document to the drawer now. A blank canvas nobody has
 * touched stays out of the list — until `force`, which is a person asking.
 *
 * A canvas with nothing new on it writes nothing at all: a second tab may be
 * holding a fresher copy of this same document, and an idle tab closing is no
 * reason to hand it back an old one.
 */
function flushSave(get: () => SquigState, force = false) {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const s = get()
  savePrefs({ theme: s.theme, font: s.font, contextRow: s.contextRow, activeId: s.docId })
  if (!dirty && !force) return
  const known = s.files.some((f) => f.id === s.docId)
  if (!s.order.length && !known && !force) return
  const files = saveFile({
    id: s.docId,
    name: s.fileName,
    nodes: s.nodes,
    order: s.order,
    updatedAt: Date.now(),
  })
  useSquig.setState({ files })
  dirty = false
}

let watching = false
/**
 * A tab can close inside the debounce window. Catch it on the way out — and
 * on the way to the background, which is all iOS ever gives you.
 *
 * The same listener keeps an eye on the drawer itself, so a file made in
 * another tab shows up in this one's recents without a reload.
 */
function watchWindow(get: () => SquigState) {
  if (watching || typeof window === "undefined") return
  watching = true
  const save = () => flushSave(get)
  window.addEventListener("beforeunload", save)
  window.addEventListener("pagehide", save)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save()
  })
  window.addEventListener("storage", (e) => {
    if (e.key === INDEX_KEY) useSquig.setState({ files: listFiles() })
  })
}

export const useSquig = create<SquigState>((set, get) => ({
  docId: nanoid(8),
  fileName: "untitled scribbles",
  files: [],
  saveFlash: 0,
  nodes: {},
  order: [],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  tool: "select",
  shapeKind: "rect",
  panel: null,
  placing: null,
  editingId: null,
  contextRow: false,
  theme: DEFAULT_THEME,
  font: DEFAULT_FONT,
  hydrated: false,
  commandOpen: false,
  contextMenu: null,
  renamingFile: false,
  arrowHead: true,
  uiHidden: false,
  shortcutsOpen: false,
  linkOpen: false,
  clipboard: [],
  past: [],
  future: [],

  setFileName: (n) => {
    set({ fileName: n })
    scheduleSave(get)
  },
  setTool: (t) => set({ tool: t, placing: null, panel: null }),
  setShapeKind: (s) => set({ shapeKind: s }),
  setPanel: (p) => set((st) => ({ panel: st.panel === p ? null : p, placing: null })),
  setPlacing: (kind) => set({ placing: kind }),
  setEditing: (id) => set({ editingId: id }),
  setContextRow: (on) => {
    set({ contextRow: on })
    scheduleSave(get)
  },
  setTheme: (t) => {
    set({ theme: t })
    applyTheme(t, get().font)
    scheduleSave(get)
  },
  setFont: (f) => {
    set({ font: f })
    applyTheme(get().theme, f)
    scheduleSave(get)
  },
  setViewport: (v) => set({ viewport: v }),
  setSelection: (ids) => set({ selection: ids }),
  setCommandOpen: (open) =>
    set({ commandOpen: open, contextMenu: null, shortcutsOpen: false, panel: open ? null : get().panel }),
  setContextMenu: (m) => set({ contextMenu: m }),
  setRenamingFile: (on) => set({ renamingFile: on }),
  setArrowHead: (on) => set({ arrowHead: on }),
  setUiHidden: (on) => set({ uiHidden: on }),
  setShortcutsOpen: (on) => set({ shortcutsOpen: on, commandOpen: false, contextMenu: null }),
  setLinkOpen: (on) => set({ linkOpen: on, contextMenu: null }),

  checkpoint: () => {
    set((s) => ({ past: [...s.past.slice(-MAX_HISTORY + 1), snapshot(s)], future: [] }))
  },

  addNode: (node, opts = {}) => {
    const id = node.id ?? nanoid(8)
    const seed = node.seed ?? Math.floor(Math.random() * 2 ** 31)
    if (opts.checkpoint !== false) get().checkpoint()
    set((s) => ({
      nodes: { ...s.nodes, [id]: { ...node, id, seed } as SquigNode },
      order: [...s.order, id],
      selection: opts.select !== false ? [id] : s.selection,
    }))
    scheduleSave(get)
    return id
  },

  addNodes: (nodes, opts = {}) => {
    get().checkpoint()
    set((s) => {
      const map = { ...s.nodes }
      const ids: string[] = []
      for (const n of nodes) {
        map[n.id] = n
        ids.push(n.id)
      }
      return {
        nodes: map,
        order: [...s.order, ...ids],
        selection: opts.select !== false ? ids : s.selection,
      }
    })
    scheduleSave(get)
  },

  updateNode: (id, patch) => {
    set((s) => {
      const cur = s.nodes[id]
      if (!cur) return s
      return { nodes: { ...s.nodes, [id]: { ...cur, ...patch } as SquigNode } }
    })
    scheduleSave(get)
  },

  updateNodes: (patches) => {
    set((s) => {
      const map = { ...s.nodes }
      for (const [id, patch] of Object.entries(patches)) {
        const cur = map[id]
        if (cur) map[id] = { ...cur, ...patch } as SquigNode
      }
      return { nodes: map }
    })
    scheduleSave(get)
  },

  removeNodes: (ids) => {
    if (!ids.length) return
    get().checkpoint()
    set((s) => {
      const map = { ...s.nodes }
      for (const id of ids) delete map[id]
      return {
        nodes: map,
        order: s.order.filter((i) => !ids.includes(i)),
        selection: s.selection.filter((i) => !ids.includes(i)),
      }
    })
    scheduleSave(get)
  },

  deleteSelected: () => get().removeNodes(get().selection),

  duplicateSelected: (offset = 16) => {
    const { selection, nodes, order } = get()
    const src = order.filter((id) => selection.includes(id)).map((id) => nodes[id])
    if (!src.length) return []
    get().checkpoint()
    const clones = cloneNodes(src, offset, offset)
    set((s) => ({
      nodes: { ...s.nodes, ...Object.fromEntries(clones.map((c) => [c.id, c])) },
      order: [...s.order, ...clones.map((c) => c.id)],
      selection: clones.map((c) => c.id),
    }))
    scheduleSave(get)
    return clones.map((c) => c.id)
  },

  bringToFront: (ids) => {
    if (!ids.length) return
    get().checkpoint()
    set((s) => ({ order: [...s.order.filter((i) => !ids.includes(i)), ...s.order.filter((i) => ids.includes(i))] }))
    scheduleSave(get)
  },
  sendToBack: (ids) => {
    if (!ids.length) return
    get().checkpoint()
    set((s) => ({ order: [...s.order.filter((i) => ids.includes(i)), ...s.order.filter((i) => !ids.includes(i))] }))
    scheduleSave(get)
  },
  bringForward: (ids) => {
    if (!ids.length) return
    get().checkpoint()
    set((s) => ({ order: stepOrder(s.order, ids, 1) }))
    scheduleSave(get)
  },
  sendBackward: (ids) => {
    if (!ids.length) return
    get().checkpoint()
    set((s) => ({ order: stepOrder(s.order, ids, -1) }))
    scheduleSave(get)
  },

  undo: () => {
    const { past } = get()
    if (!past.length) return
    set((s) => {
      const prev = s.past[s.past.length - 1]
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, snapshot(s)],
        nodes: prev.nodes,
        order: prev.order,
        selection: s.selection.filter((id) => prev.nodes[id]),
      }
    })
    scheduleSave(get)
  },

  redo: () => {
    const { future } = get()
    if (!future.length) return
    set((s) => {
      const next = s.future[s.future.length - 1]
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, snapshot(s)],
        nodes: next.nodes,
        order: next.order,
        selection: s.selection.filter((id) => next.nodes[id]),
      }
    })
    scheduleSave(get)
  },

  hydrate: () => {
    migrateLegacyDoc(() => nanoid(8))
    const prefs = loadPrefs()
    const files = listFiles()
    // last file open wins; failing that, the most recent one we have
    const wanted = prefs.activeId && files.some((f) => f.id === prefs.activeId) ? prefs.activeId : files[0]?.id
    const doc = wanted ? readFile(wanted) : null

    set({
      docId: doc?.id ?? nanoid(8),
      fileName: doc?.name ?? "untitled scribbles",
      nodes: doc?.nodes ?? {},
      order: doc?.order ?? [],
      files,
      contextRow: prefs.contextRow,
      theme: prefs.theme,
      font: prefs.font,
      hydrated: true,
    })
    applyTheme(prefs.theme, prefs.font)
    // what we just read is, by definition, what the drawer already holds
    dirty = false
    watchWindow(get)
  },

  clearCanvas: () => {
    get().checkpoint()
    set({ nodes: {}, order: [], selection: [] })
    scheduleSave(get)
  },

  // -- groups ---------------------------------------------------------------

  expandSelection: (ids) => {
    const { nodes, order } = get()
    const gids = new Set<string>()
    for (const id of ids) {
      const g = nodes[id]?.groupIds?.[0]
      if (g) gids.add(g)
    }
    if (!gids.size) return ids
    const out = new Set(ids)
    for (const id of order) {
      const g = nodes[id]?.groupIds?.[0]
      if (g && gids.has(g)) out.add(id)
    }
    return order.filter((id) => out.has(id))
  },

  groupSelected: () => {
    const { selection, nodes, order } = get()
    const ids = order.filter((id) => selection.includes(id) && nodes[id])
    if (ids.length < 2) return
    get().checkpoint()
    const gid = nanoid(8)
    set((s) => {
      const map = { ...s.nodes }
      for (const id of ids) {
        const n = map[id]
        map[id] = { ...n, groupIds: [gid, ...(n.groupIds ?? [])] } as SquigNode
      }
      // collapse the members together at the topmost one, so nothing else
      // can sit inside the group's z-range and look like it belongs
      const top = s.order.lastIndexOf(ids[ids.length - 1])
      const before = s.order.slice(0, top + 1).filter((id) => !ids.includes(id))
      const after = s.order.slice(top + 1).filter((id) => !ids.includes(id))
      return { nodes: map, order: [...before, ...ids, ...after], selection: ids }
    })
    scheduleSave(get)
  },

  ungroupSelected: () => {
    const { selection, nodes } = get()
    const sel = selection.map((id) => nodes[id]).filter(Boolean) as SquigNode[]
    if (!sel.length) return
    const gids = new Set(sel.map((n) => n.groupIds?.[0]).filter(Boolean) as string[])

    // nothing grouped? then ⇧⌘G means the other kind of coming apart
    if (!gids.size) {
      get().detachSelected()
      return
    }

    get().checkpoint()
    set((s) => {
      const map = { ...s.nodes }
      const freed: string[] = []
      for (const id of s.order) {
        const n = map[id]
        const g = n?.groupIds?.[0]
        if (!g || !gids.has(g)) continue
        const rest = n.groupIds!.slice(1)
        map[id] = { ...n, groupIds: rest.length ? rest : undefined } as SquigNode
        freed.push(id)
      }
      return { nodes: map, selection: freed }
    })
    scheduleSave(get)
  },

  detachSelected: () => {
    const { selection, nodes } = get()
    const comps = selection.map((id) => nodes[id]).filter((n) => n?.type === "component") as ComponentNode[]
    if (!comps.length) return
    get().checkpoint()
    set((s) => {
      const map = { ...s.nodes }
      let ord = [...s.order]
      const picked: string[] = []
      for (const c of comps) {
        // a detached instance stays one thing you can drag — same as Figma
        const gid = nanoid(8)
        const pieces = breakApart(c).map((p) => ({ ...p, groupIds: [gid, ...(c.groupIds ?? [])] }))
        if (!pieces.length) continue
        for (const p of pieces) {
          map[p.id] = p
          picked.push(p.id)
        }
        const at = ord.indexOf(c.id)
        ord = [...ord.slice(0, at), ...pieces.map((p) => p.id), ...ord.slice(at + 1)]
        delete map[c.id]
      }
      return { nodes: map, order: ord, selection: picked }
    })
    scheduleSave(get)
  },

  flipSelected: (axis) => {
    const { selection, nodes } = get()
    const sel = selection.map((id) => nodes[id]).filter(Boolean) as SquigNode[]
    if (!sel.length) return
    const box = unionBox(sel)
    if (!box) return
    get().checkpoint()
    const patches: Record<string, Partial<SquigNode>> = {}
    for (const n of sel) {
      patches[n.id] =
        axis === "x"
          ? { x: box.minX + box.maxX - (n.x + n.w), flipX: !n.flipX }
          : { y: box.minY + box.maxY - (n.y + n.h), flipY: !n.flipY }
    }
    get().updateNodes(patches)
  },

  toggleTextStyle: (style) => {
    const { selection, nodes } = get()
    const texts = selection.map((id) => nodes[id]).filter((n) => n?.type === "text") as TextNode[]
    if (!texts.length) return
    get().checkpoint()
    // mixed selection turns everything on first, like every text editor ever
    const on = texts.some((n) => !n[style])
    get().updateNodes(Object.fromEntries(texts.map((n) => [n.id, { [style]: on } as Partial<SquigNode>])))
  },

  setLinkOnSelection: (url) => {
    const { selection, nodes } = get()
    const texts = selection.map((id) => nodes[id]).filter((n) => n?.type === "text") as TextNode[]
    if (!texts.length) return
    get().checkpoint()
    const trimmed = url.trim()
    get().updateNodes(
      Object.fromEntries(texts.map((n) => [n.id, { link: trimmed || undefined } as Partial<SquigNode>]))
    )
  },

  // -- clipboard ------------------------------------------------------------

  copySelected: () => {
    const { selection, nodes, order } = get()
    const sel = order.filter((id) => selection.includes(id)).map((id) => nodes[id])
    if (!sel.length) return
    set({ clipboard: structuredClone(sel) })
  },

  cutSelected: () => {
    get().copySelected()
    get().deleteSelected()
  },

  pasteClipboard: (at) => {
    const { clipboard } = get()
    if (!clipboard.length) return
    const box = unionBox(clipboard)!
    const [dx, dy] = at ? [at[0] - box.minX, at[1] - box.minY] : [16, 16]
    get().checkpoint()
    const clones = cloneNodes(clipboard, dx, dy)
    set((s) => ({
      nodes: { ...s.nodes, ...Object.fromEntries(clones.map((c) => [c.id, c])) },
      order: [...s.order, ...clones.map((c) => c.id)],
      selection: clones.map((c) => c.id),
    }))
    scheduleSave(get)
  },

  // -- zoom -----------------------------------------------------------------

  zoomBy: (factor, center) => {
    const v = get().viewport
    const [cx, cy] = center ?? [window.innerWidth / 2, window.innerHeight / 2]
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
    const k = zoom / v.zoom
    set({ viewport: { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k } })
  },

  zoomTo100: () => {
    const v = get().viewport
    const [cx, cy] = [window.innerWidth / 2, window.innerHeight / 2]
    const k = 1 / v.zoom
    set({ viewport: { zoom: 1, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k } })
  },

  zoomToFit: () => {
    const { nodes, order } = get()
    fitBox(set, order.map((id) => nodes[id]).filter(Boolean))
  },

  zoomToSelection: () => {
    const { nodes, selection } = get()
    const sel = selection.map((id) => nodes[id]).filter(Boolean)
    if (!sel.length) return get().zoomToFit()
    fitBox(set, sel)
  },

  insertComponent: (kind) => {
    const def = getDef(kind)
    if (!def) return
    const v = get().viewport
    const [cx, cy] = screenToWorld(v, window.innerWidth / 2, window.innerHeight / 2)
    get().addNode({
      type: "component",
      kind: def.kind,
      props: { ...def.defaults },
      x: Math.round(cx - def.size.w / 2),
      y: Math.round(cy - def.size.h / 2),
      w: def.size.w,
      h: def.size.h,
    } as Omit<SquigNode, "id" | "seed">)
  },

  alignSelected: (edge) => {
    const { selection, nodes } = get()
    if (selection.length < 2) return
    const sel = selection.map((id) => nodes[id]).filter(Boolean)
    if (sel.length < 2) return
    get().checkpoint()
    const minX = Math.min(...sel.map((n) => n.x))
    const maxX = Math.max(...sel.map((n) => n.x + n.w))
    const minY = Math.min(...sel.map((n) => n.y))
    const maxY = Math.max(...sel.map((n) => n.y + n.h))
    const patches: Record<string, Partial<SquigNode>> = {}
    for (const n of sel) {
      switch (edge) {
        case "left": patches[n.id] = { x: minX }; break
        case "right": patches[n.id] = { x: maxX - n.w }; break
        case "hcenter": patches[n.id] = { x: (minX + maxX) / 2 - n.w / 2 }; break
        case "top": patches[n.id] = { y: minY }; break
        case "bottom": patches[n.id] = { y: maxY - n.h }; break
        case "vcenter": patches[n.id] = { y: (minY + maxY) / 2 - n.h / 2 }; break
      }
    }
    get().updateNodes(patches)
  },

  newFile: () => {
    // the file you were on keeps its place in the drawer — this is a new one
    flushSave(get)
    set({
      docId: nanoid(8),
      fileName: "untitled scribbles",
      nodes: {},
      order: [],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      renamingFile: false,
      linkOpen: false,
      past: [],
      future: [],
    })
    flushSave(get)
  },

  openFile: (id) => {
    if (id === get().docId) return
    flushSave(get)
    const doc = readFile(id)
    if (!doc) {
      // the index knew about it but the document itself is gone
      set({ files: dropFile(id) })
      return
    }
    set({
      docId: doc.id,
      fileName: doc.name,
      nodes: doc.nodes,
      order: doc.order,
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      renamingFile: false,
      linkOpen: false,
      panel: null,
      past: [],
      future: [],
    })
    // frame what's there, but never past life size — 400% on one small
    // rectangle tells you nothing about where you've landed
    if (doc.order.length) fitBox(set, doc.order.map((nid) => doc.nodes[nid]).filter(Boolean), 1)
    // straight off the drawer, so there is nothing to write back yet
    dirty = false
    flushSave(get)
  },

  deleteFile: (id) => {
    const files = dropFile(id)
    set({ files })
    if (id !== get().docId) return
    // The file you had open just went away. Let go of it before landing
    // somewhere else, or the save on the way out would write it right back.
    set({
      docId: nanoid(8),
      fileName: "untitled scribbles",
      nodes: {},
      order: [],
      selection: [],
      past: [],
      future: [],
    })
    const next = files[0]?.id
    if (next) get().openFile(next)
    else get().newFile()
  },

  saveNow: () => {
    flushSave(get, true)
    set((s) => ({ saveFlash: s.saveFlash + 1 }))
  },

  serialize: () => {
    const { fileName, nodes, order } = get()
    return JSON.stringify({ app: "squig", version: 1, fileName, nodes, order }, null, 2)
  },

  loadDoc: (json) => {
    try {
      const doc = JSON.parse(json)
      if (!doc || typeof doc !== "object" || !doc.nodes || !Array.isArray(doc.order)) return false
      // an opened file joins the drawer as its own document, so importing
      // never writes over whatever was on the canvas
      flushSave(get)
      set({
        docId: nanoid(8),
        fileName: typeof doc.fileName === "string" ? doc.fileName : "imported scribbles",
        nodes: doc.nodes,
        order: doc.order,
        selection: [],
        renamingFile: false,
        linkOpen: false,
        past: [],
        future: [],
      })
      // an imported file was drawn wherever its author left it — go there,
      // or the canvas looks empty when it isn't
      const list = (doc.order as string[]).map((id: string) => doc.nodes[id]).filter(Boolean)
      if (list.length) fitBox(set, list, 1)
      else set({ viewport: { x: 0, y: 0, zoom: 1 } })
      scheduleSave(get)
      return true
    } catch {
      return false
    }
  },
}))
