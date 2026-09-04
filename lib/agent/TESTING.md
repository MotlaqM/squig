# WebMCP compatibility and tests

Squig follows the [current WebMCP imperative API draft](https://webmachinelearning.github.io/webmcp/): `ModelContext` is an `EventTarget`; registration, discovery, and execution are asynchronous; `executeTool` takes a registered tool object and resolves to JSON text; abort signals govern registration and execution; and `toolchange` is queued asynchronously.

The published `webmcp-types` 0.1.6 package does not yet declare `executeTool`, so `model-context-shim.ts` carries the small draft-compatible surface locally. `executeToolByName` and `window.__squigExecuteTool` are intentional developer conveniences layered over the object-based draft API; they do not replace it. `window.__squigTools()` exposes discovery in devtools.

The repository's test command is a dependency-free Node script harness, rather than the brief's suggested Vitest/jsdom setup. `scripts/test-agent.ts` therefore uses Node's native `EventTarget`, `AbortController`, and `DOMException` with document/window-shaped fakes. This proves the required DOM-facing behavior without adding a test dependency or changing the production bundle.

Zod 4 is a direct dependency. `lib/ops/schema.ts` recursively compiles and caches the exact JSON Schema subset Goal 1 emits into `zod/mini` schemas, then parses every tool input through the compiled schema. The JSON Schema catalogue remains the single runtime definition; unsupported keywords and shapes fail compilation, and `not` is intentionally limited to the emitted `{ const: ... }` form.

At this commit, the production `/` route's manifest-listed client chunks total 1,118,466 bytes raw and 343,133 bytes gzip, up 53,766 raw and 15,467 gzip from the pre-Zod baseline. The measured gzip addition remains below Goal 1's 50 KB dependency ceiling.
