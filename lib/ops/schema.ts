import type { ComponentDef, ControlDef } from "../library/registry"
import { controlIsVisible } from "../selection"
import type { ComponentNode } from "../types"

export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  enum?: unknown[]
  const?: unknown
  items?: JsonSchema
  minimum?: number
  maximum?: number
  minLength?: number
  not?: JsonSchema
  oneOf?: JsonSchema[]
  default?: unknown
}

function schemaForControl(control: ControlDef, defaultValue: unknown): JsonSchema {
  const base: JsonSchema = { title: control.label }
  if (defaultValue !== undefined) base.default = defaultValue
  switch (control.type) {
    case "toggle":
      return { ...base, type: "boolean" }
    case "number":
      return {
        ...base,
        type: "number",
        ...(control.min !== undefined ? { minimum: control.min } : {}),
        ...(control.max !== undefined ? { maximum: control.max } : {}),
      }
    case "select":
      return { ...base, type: "string", enum: [...(control.options ?? [])] }
    case "icon":
      return {
        ...base,
        type: "string",
        minLength: 1,
        ...(control.allowNone ? {} : { not: { const: "none" } }),
      }
    case "text":
      return { ...base, type: "string" }
  }
}

/** Compile the same controls the inspector uses into a partial props schema. */
export function controlsToJsonSchema(def: ComponentDef, node?: ComponentNode): JsonSchema {
  const effectiveNode: ComponentNode = node ?? {
    type: "component",
    id: "schema",
    kind: def.kind,
    props: def.defaults,
    x: 0,
    y: 0,
    w: def.size.w,
    h: def.size.h,
    seed: 0,
  }
  const properties: Record<string, JsonSchema> = {}
  for (const control of def.controls) {
    if (!controlIsVisible(effectiveNode, control)) continue
    const value = control.key in effectiveNode.props ? effectiveNode.props[control.key] : def.defaults[control.key]
    properties[control.key] = schemaForControl(control, value)
  }
  return { type: "object", properties, additionalProperties: false }
}

/** Runtime validation paired with controlsToJsonSchema, without another bundle dependency. */
export function validateComponentProps(
  def: ComponentDef,
  props: Record<string, unknown>,
  node?: ComponentNode
): Record<string, unknown> {
  const schema = controlsToJsonSchema(def, node)
  const properties = schema.properties ?? {}
  for (const [key, value] of Object.entries(props)) {
    const property = properties[key]
    if (!property) throw new TypeError(`Unknown ${def.kind} property: ${key}`)
    if (property.type === "string" && typeof value !== "string") throw new TypeError(`${key} must be a string`)
    if (property.type === "boolean" && typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`)
    if (property.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${key} must be a finite number`)
      if (property.minimum !== undefined && value < property.minimum) throw new RangeError(`${key} must be at least ${property.minimum}`)
      if (property.maximum !== undefined && value > property.maximum) throw new RangeError(`${key} must be at most ${property.maximum}`)
    }
    if (property.enum && !property.enum.includes(value)) throw new TypeError(`${key} must be one of ${property.enum.join(", ")}`)
    if (property.not?.const !== undefined && Object.is(value, property.not.const)) throw new TypeError(`${key} cannot be ${String(value)}`)
  }
  return props
}
