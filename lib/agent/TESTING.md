# WebMCP compatibility and tests

Squig follows the [current WebMCP imperative API draft](https://webmachinelearning.github.io/webmcp/): `ModelContext` is an `EventTarget`; registration, discovery, and execution are asynchronous; `executeTool` takes a registered tool object and resolves to JSON text; abort signals govern registration and execution; and `toolchange` is queued asynchronously.

The published `webmcp-types` 0.1.6 package does not yet declare `executeTool`, so `model-context-shim.ts` carries the small draft-compatible surface locally. `executeToolByName` and `window.__squigExecuteTool` are intentional developer conveniences layered over the object-based draft API; they do not replace it. `window.__squigTools()` exposes discovery in devtools.

The repository's test command is a dependency-free Node script harness, rather than the brief's suggested Vitest/jsdom setup. `scripts/test-agent.ts` therefore uses Node's native `EventTarget`, `AbortController`, and `DOMException` with document/window-shaped fakes. This proves the required DOM-facing behavior without adding a test dependency or changing the production bundle.

Zod is present only below transitive dependencies and is not resolvable from application code under pnpm's strict dependency layout. Adding it as a direct dependency would also exceed Goal 1's 50 KB dependency limit, so `lib/ops/schema.ts` validates the complete JSON Schema subset Squig emits and declares instead.
