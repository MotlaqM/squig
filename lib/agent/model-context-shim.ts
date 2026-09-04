/**
 * Minimal WebMCP imperative API, following the 2026-09-04 draft. The published
 * webmcp-types package still omits executeTool, so these local types include the
 * current draft method while keeping native implementations untouched.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean
  untrustedContentHint?: boolean
  consequentialHint?: boolean
}

export interface ToolExecuteOptions {
  signal: AbortSignal
}

export interface ModelContextTool {
  name: string
  title?: string
  description: string
  inputSchema?: object
  execute: (inputObject: Record<string, unknown>, options: ToolExecuteOptions) => unknown | Promise<unknown>
  annotations?: ToolAnnotations
}

export interface RegisteredTool {
  name: string
  title: string
  description: string
  inputSchema?: object
  window: Window
  origin: string
  annotations?: ToolAnnotations
}

export interface ModelContextRegisterOptions {
  signal?: AbortSignal
  exposedTo?: string[]
}

export interface ModelContextGetOptions {
  fromOrigins?: string[]
}

export interface ModelContextExecuteOptions {
  signal?: AbortSignal
}

export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterOptions): Promise<void>
  getTools(options?: ModelContextGetOptions): Promise<RegisteredTool[]>
  executeTool(tool: RegisteredTool, inputObject?: Record<string, unknown>, options?: ModelContextExecuteOptions): Promise<string>
  ontoolchange: ((this: ModelContextLike, event: Event) => unknown) | null
}

interface Registration {
  definition: ModelContextTool
  registered: RegisteredTool
}

const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function invalidState(message: string): DOMException {
  return new DOMException(message, "InvalidStateError")
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}

function task(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class ModelContextShim extends EventTarget implements ModelContextLike {
  ontoolchange: ((this: ModelContextLike, event: Event) => unknown) | null = null
  readonly #tools = new Map<string, Registration>()
  readonly #ownerWindow: Window
  readonly #origin: string

  constructor(ownerWindow: Window) {
    super()
    this.#ownerWindow = ownerWindow
    this.#origin = ownerWindow.location?.origin ?? "null"
    this.addEventListener("toolchange", (event) => this.ontoolchange?.call(this, event))
  }

  async #notifyToolChange(): Promise<void> {
    await task()
    this.dispatchEvent(new Event("toolchange"))
  }

  async registerTool(tool: ModelContextTool, options: ModelContextRegisterOptions = {}): Promise<void> {
    if (options.signal?.aborted) throw abortReason(options.signal)
    if (!toolNamePattern.test(tool.name) || !tool.description) throw invalidState("Invalid WebMCP tool name or description")
    if (this.#tools.has(tool.name)) throw invalidState(`Tool already registered: ${tool.name}`)

    const registered: RegisteredTool = {
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: clone(tool.inputSchema) } : {}),
      window: this.#ownerWindow,
      origin: this.#origin,
      ...(tool.annotations ? { annotations: clone(tool.annotations) } : {}),
    }
    const registration = { definition: tool, registered }
    this.#tools.set(tool.name, registration)

    options.signal?.addEventListener("abort", () => {
      if (this.#tools.get(tool.name) !== registration) return
      this.#tools.delete(tool.name)
      void this.#notifyToolChange()
    }, { once: true })

    await this.#notifyToolChange()
  }

  async getTools(): Promise<RegisteredTool[]> {
    await Promise.resolve()
    return [...this.#tools.values()]
      .map(({ registered }) => ({ ...registered, inputSchema: clone(registered.inputSchema), annotations: clone(registered.annotations) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async executeTool(
    tool: RegisteredTool,
    inputObject: Record<string, unknown> = {},
    options: ModelContextExecuteOptions = {}
  ): Promise<string> {
    if (options.signal?.aborted) throw abortReason(options.signal)
    const registration = this.#tools.get(tool.name)
    if (!registration) throw new DOMException(`Tool is not registered: ${tool.name}`, "NotFoundError")
    const controller = options.signal ? null : new AbortController()
    const signal = options.signal ?? controller!.signal
    const execution = Promise.resolve(registration.definition.execute(clone(inputObject), { signal }))
    const result = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(abortReason(signal))
      signal.addEventListener("abort", abort, { once: true })
      execution.then(
        (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        }
      )
    })
    return JSON.stringify(result ?? null)
  }
}

type DocumentWithModelContext = Document & { modelContext?: ModelContextLike }

/** Install the shim only when the browser has no native document.modelContext. */
export function installModelContextShim(
  targetDocument: Document = document,
  targetWindow: Window = targetDocument.defaultView ?? window
): ModelContextLike {
  const doc = targetDocument as DocumentWithModelContext
  if (doc.modelContext) return doc.modelContext
  const context = new ModelContextShim(targetWindow)
  Object.defineProperty(doc, "modelContext", { configurable: true, enumerable: true, value: context })
  return context
}

/** Name-based convenience for devtools; the draft executeTool API takes an object. */
export async function executeToolByName(
  context: ModelContextLike,
  name: string,
  inputObject: Record<string, unknown> = {},
  options: ModelContextExecuteOptions = {}
): Promise<string> {
  const tool = (await context.getTools()).find((candidate) => candidate.name === name)
  if (!tool) throw new DOMException(`Tool is not registered: ${name}`, "NotFoundError")
  return context.executeTool(tool, inputObject, options)
}
