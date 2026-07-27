// ---------------------------------------------------------------------------
// Import / export a .squig.json. Both entry points (file menu and ⌘K) share
// these, so there's no hidden <input> to keep a ref to.
// ---------------------------------------------------------------------------

import { useSquig } from "./store"

export function exportDoc() {
  const s = useSquig.getState()
  const blob = new Blob([s.serialize()], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${s.fileName.replace(/[^\w -]+/g, "").trim() || "squig"}.squig.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function importDoc() {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = ".json,.squig,application/json"
  input.addEventListener("change", async () => {
    const file = input.files?.[0]
    if (!file) return
    const ok = useSquig.getState().loadDoc(await file.text())
    if (!ok) window.alert("that file didn't look like a squig doc")
  })
  input.click()
}
