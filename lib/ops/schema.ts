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

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => key in rightRecord && jsonEqual(leftRecord[key], rightRecord[key]))
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return !!value && typeof value === "object" && !Array.isArray(value)
    case "array": return Array.isArray(value)
    case "string": return typeof value === "string"
    case "number": return typeof value === "number" && Number.isFinite(value)
    case "integer": return typeof value === "number" && Number.isInteger(value)
    case "boolean": return typeof value === "boolean"
    case "null": return value === null
    default: return false
  }
}

function schemaError(path: string, message: string): TypeError {
  return new TypeError(`${path} ${message}`)
}

/** Validate the complete JSON Schema subset emitted and declared by Goal 1. */
export function assertJsonSchema(value: unknown, schema: JsonSchema, path = "arguments"): void {
  if (schema.oneOf) {
    let matches = 0
    for (const candidate of schema.oneOf) {
      try {
        assertJsonSchema(value, candidate, path)
        matches++
      } catch {
        // A oneOf branch mismatch is expected; exactly one branch must survive.
      }
    }
    if (matches !== 1) throw schemaError(path, "must match exactly one allowed shape")
  }

  if (schema.not) {
    let excluded = true
    try {
      assertJsonSchema(value, schema.not, path)
    } catch {
      excluded = false
    }
    if (excluded) throw schemaError(path, "uses an excluded value")
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) throw schemaError(path, `must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    throw schemaError(path, `must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`)
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) throw schemaError(path, `must be ${types.join(" or ")}`)
  }

  if (typeof value === "string" && schema.minLength !== undefined && [...value].length < schema.minLength) {
    throw schemaError(path, `must contain at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`)
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw schemaError(path, `must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) throw schemaError(path, `must be at most ${schema.maximum}`)
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => assertJsonSchema(item, schema.items!, `${path}[${index}]`))
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in object)) throw schemaError(path, `requires ${key}`)
    }
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties))
      if (unknown) throw schemaError(`${path}.${unknown}`, "is not allowed")
    }
    for (const [key, property] of Object.entries(properties)) {
      if (key in object) assertJsonSchema(object[key], property, `${path}.${key}`)
    }
  }
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
export function controlsToJsonSchema(
  def: ComponentDef,
  node?: ComponentNode,
  controls: readonly ControlDef[] = def.controls
): JsonSchema {
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
  for (const control of controls) {
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
  assertJsonSchema(props, schema, `${def.kind} props`)
  return props
}
