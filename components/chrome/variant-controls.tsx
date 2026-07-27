"use client"

// ---------------------------------------------------------------------------
// Variant controls — one widget per ControlDef, shared by the inspector and
// the floating context row.
// ---------------------------------------------------------------------------

import { useSquig } from "@/lib/store"
import type { ComponentNode } from "@/lib/types"
import type { ControlDef } from "@/lib/library/registry"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function VariantControl({
  node,
  control,
  compact = false,
}: {
  node: ComponentNode
  control: ControlDef
  compact?: boolean
}) {
  const st = useSquig.getState
  const value = node.props[control.key]

  const setValue = (next: unknown) => {
    const s = st()
    s.checkpoint()
    s.updateNode(node.id, { props: { ...node.props, [control.key]: next } } as Partial<ComponentNode>)
  }

  if (control.type === "toggle") {
    return (
      <div className={compact ? "flex items-center gap-1.5" : "flex items-center justify-between"}>
        <Label className="text-xs font-normal text-muted-foreground">{control.label}</Label>
        <Switch checked={Boolean(value)} onCheckedChange={setValue} className="scale-90" />
      </div>
    )
  }

  if (control.type === "select") {
    return (
      <div className={compact ? "flex items-center gap-1.5" : "flex items-center justify-between gap-2"}>
        {!compact && <Label className="shrink-0 text-xs font-normal text-muted-foreground">{control.label}</Label>}
        <Select value={String(value ?? "")} onValueChange={setValue}>
          <SelectTrigger size="sm" className={compact ? "h-7 w-auto gap-1 px-2 text-xs" : "h-7 w-[110px] text-xs"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {control.options?.map((o) => (
              <SelectItem key={o} value={o} className="text-xs">
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  if (control.type === "number") {
    return (
      <div className={compact ? "flex items-center gap-1.5" : "flex items-center justify-between gap-2"}>
        <Label className="shrink-0 text-xs font-normal text-muted-foreground">{control.label}</Label>
        <Input
          type="number"
          className={compact ? "h-7 w-14 px-1.5 text-xs" : "h-7 w-[70px] px-2 text-xs"}
          value={String(value ?? "")}
          min={control.min}
          max={control.max}
          onChange={(e) => setValue(Number(e.target.value))}
        />
      </div>
    )
  }

  // text
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs font-normal text-muted-foreground">{control.label}</Label>
      <Input
        className="h-7 px-2 text-xs"
        value={String(value ?? "")}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  )
}
