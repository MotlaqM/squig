import type { ComponentDef, ControlDef } from "../library/registry"
import { controlIsVisible } from "../selection"
import type { ComponentNode } from "../types"
import {
  array as zArray,
  boolean as zBoolean,
  intersection as zIntersection,
  literal as zLiteral,
  looseObject as zLooseObject,
  maximum as zMaximum,
  minLength as zMinLength,
  minimum as zMinimum,
  null as zNull,
  number as zNumber,
  optional as zOptional,
  refine as zRefine,
  strictObject as zStrictObject,
  string as zString,
  unknown as zUnknown,
  union as zUnion,
  xor as zXor,
  type ZodMiniType,
} from "zod/mini"

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

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties", "enum", "const", "items",
  "minimum", "maximum", "minLength", "not", "oneOf", "default",
])
const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
type JsonLiteral = string | number | boolean | null

const compiledSchemas = new Map<string, ZodMiniType>()

function invalidSchema(message: string): never {
  throw new TypeError(`Unsupported Goal 1 JSON Schema: ${message}`)
}

function assertFiniteNumber(value: unknown, keyword: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidSchema(`${keyword} must be a finite number`)
}

function isJsonLiteral(value: unknown): value is JsonLiteral {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
}

function compileLiterals(values: unknown[], keyword: "const" | "enum"): ZodMiniType {
  if (values.length === 0 || values.some((value) => !isJsonLiteral(value))) {
    return invalidSchema(`${keyword} must contain at least one JSON primitive`)
  }
  return zLiteral(values as [JsonLiteral, ...JsonLiteral[]])
}

function compileObject(schema: JsonSchema): ZodMiniType {
  const properties = schema.properties ?? {}
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) invalidSchema("properties must be an object")
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    invalidSchema("additionalProperties must be boolean")
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    invalidSchema("required must be an array of property names")
  }

  const required = new Set(schema.required ?? [])
  for (const key of required) {
    if (!(key in properties)) invalidSchema(`required property ${JSON.stringify(key)} is not declared`)
  }
  const shape: Record<string, ZodMiniType> = {}
  for (const [key, propertySchema] of Object.entries(properties)) {
    const property = compileJsonSchema(propertySchema)
    shape[key] = required.has(key) ? property : zOptional(property)
  }
  return schema.additionalProperties === false ? zStrictObject(shape) : zLooseObject(shape)
}

function compileType(schema: JsonSchema, type: string): ZodMiniType {
  if (!SUPPORTED_TYPES.has(type)) return invalidSchema(`unknown type ${JSON.stringify(type)}`)
  switch (type) {
    case "object":
      return compileObject(schema)
    case "array":
      return zArray(schema.items ? compileJsonSchema(schema.items) : zUnknown())
    case "string": {
      let compiled = zString()
      if (schema.minLength !== undefined) {
        if (!Number.isInteger(schema.minLength) || schema.minLength < 0) invalidSchema("minLength must be a non-negative integer")
        compiled = compiled.check(zMinLength(schema.minLength))
      }
      return compiled
    }
    case "number": {
      let compiled = zNumber()
      if (schema.minimum !== undefined) {
        assertFiniteNumber(schema.minimum, "minimum")
        compiled = compiled.check(zMinimum(schema.minimum))
      }
      if (schema.maximum !== undefined) {
        assertFiniteNumber(schema.maximum, "maximum")
        compiled = compiled.check(zMaximum(schema.maximum))
      }
      return compiled
    }
    case "integer": {
      let compiled = zNumber().check(zRefine(Number.isInteger, { message: "must be an integer" }))
      if (schema.minimum !== undefined) {
        assertFiniteNumber(schema.minimum, "minimum")
        compiled = compiled.check(zMinimum(schema.minimum))
      }
      if (schema.maximum !== undefined) {
        assertFiniteNumber(schema.maximum, "maximum")
        compiled = compiled.check(zMaximum(schema.maximum))
      }
      return compiled
    }
    case "boolean":
      return zBoolean()
    case "null":
      return zNull()
    default:
      return invalidSchema(`unknown type ${JSON.stringify(type)}`)
  }
}

function combine(left: ZodMiniType | undefined, right: ZodMiniType): ZodMiniType {
  return left ? zIntersection(left, right) : right
}

function compileJsonSchema(schema: JsonSchema): ZodMiniType {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return invalidSchema("schema must be an object")
  const unsupported = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYS.has(key))
  if (unsupported) return invalidSchema(`keyword ${JSON.stringify(unsupported)}`)
  if (schema.title !== undefined && typeof schema.title !== "string") invalidSchema("title must be a string")
  if (schema.description !== undefined && typeof schema.description !== "string") invalidSchema("description must be a string")

  const cacheKey = JSON.stringify(schema)
  const cached = compiledSchemas.get(cacheKey)
  if (cached) return cached

  if (schema.properties !== undefined && schema.type !== "object") invalidSchema("properties require type object")
  if (schema.required !== undefined && schema.type !== "object") invalidSchema("required requires type object")
  if (schema.additionalProperties !== undefined && schema.type !== "object") invalidSchema("additionalProperties requires type object")
  if (schema.items !== undefined && schema.type !== "array") invalidSchema("items require type array")
  if (schema.minLength !== undefined && schema.type !== "string") invalidSchema("minLength requires type string")
  if ((schema.minimum !== undefined || schema.maximum !== undefined) && schema.type !== "number" && schema.type !== "integer") {
    invalidSchema("minimum and maximum require a numeric type")
  }

  const declaredTypes = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (declaredTypes.length === 0 && schema.type !== undefined) invalidSchema("type array must not be empty")
  let compiled = declaredTypes.length === 0
    ? undefined
    : declaredTypes.length === 1
      ? compileType(schema, declaredTypes[0])
      : zUnion(declaredTypes.map((type) => compileType(schema, type)))

  if ("const" in schema) compiled = combine(compiled, compileLiterals([schema.const], "const"))
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) invalidSchema("enum must be an array")
    compiled = combine(compiled, compileLiterals(schema.enum, "enum"))
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) invalidSchema("oneOf must contain at least one schema")
    compiled = combine(compiled, zXor(schema.oneOf.map(compileJsonSchema)))
  }
  compiled ??= zUnknown()

  if (schema.not !== undefined) {
    if (!schema.not || typeof schema.not !== "object" || Array.isArray(schema.not)) {
      invalidSchema("not must be an object")
    }
    const keys = Object.keys(schema.not)
    if (keys.length !== 1 || keys[0] !== "const" || !("const" in schema.not)) {
      invalidSchema("not only supports { const: <JSON primitive> }")
    }
    const excluded = compileLiterals([schema.not.const], "const")
    compiled = compiled.check(zRefine(
      (value) => !excluded.safeParse(value).success,
      { message: `must not equal ${JSON.stringify(schema.not.const)}` },
    ))
  }

  compiledSchemas.set(cacheKey, compiled)
  return compiled
}

/** Validate against the JSON Schema catalogue through its cached Zod Mini compilation. */
export function assertJsonSchema(value: unknown, schema: JsonSchema, path = "arguments"): void {
  const result = compileJsonSchema(schema).safeParse(value)
  if (result.success) return
  const issue = result.error.issues[0]
  const issuePath = issue?.path.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`).join("") ?? ""
  throw new TypeError(`${path}${issuePath} ${issue?.message ?? "is invalid"}`)
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

/** Runtime validation paired with controlsToJsonSchema. */
export function validateComponentProps(
  def: ComponentDef,
  props: Record<string, unknown>,
  node?: ComponentNode
): Record<string, unknown> {
  const schema = controlsToJsonSchema(def, node)
  assertJsonSchema(props, schema, `${def.kind} props`)
  return props
}
