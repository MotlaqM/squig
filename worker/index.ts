import { routeAgentRequest } from "agents"
import { requestSecurity } from "./security"

export { SquigDoc } from "./squig-doc"

interface DocRow {
  id: string
  name: string
  owner: string
  updated_at: number
}

function ownerOf(request: Request): string {
  return request.headers.get("Cf-Access-Authenticated-User-Email")?.trim().toLowerCase() || "local"
}

function protectedRoute(pathname: string): boolean {
  return pathname === "/api/docs" || pathname.startsWith("/api/docs/") || pathname.startsWith("/agents/")
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin")
  if (!origin || origin !== env.APP_ORIGIN) return { Vary: "Origin" }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    Vary: "Origin",
  }
}

function json(request: Request, env: Env, value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json; charset=utf-8")
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value)
  return new Response(JSON.stringify(value), { ...init, headers })
}

async function docsApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/docs" && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) })
  }

  if (url.pathname === "/api/docs" && request.method === "GET") {
    try {
      const owner = ownerOf(request)
      const rows = await env.DOCS_DB.prepare(
        "SELECT id, name, owner, updated_at FROM docs WHERE owner = ? ORDER BY updated_at DESC"
      ).bind(owner).all<DocRow>()
      return json(request, env, {
        docs: rows.results.map((row) => ({ id: row.id, name: row.name, owner: row.owner, updatedAt: row.updated_at })),
      })
    } catch {
      return json(request, env, { error: "docs_index_unavailable" }, { status: 503 })
    }
  }

  const match = /^\/api\/docs\/([^/]+)$/.exec(url.pathname)
  if (!match || request.method !== "PUT") return null
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(request, env, { error: "invalid_request" }, { status: 400 })
  }
  const candidate = body as { name?: unknown; action?: unknown }
  const name = typeof candidate.name === "string" ? candidate.name.trim() : ""
  if (!name || name.length > 200 || (candidate.action !== "rename" && candidate.action !== "save")) {
    return json(request, env, { error: "invalid_request" }, { status: 400 })
  }

  const docId = decodeURIComponent(match[1])
  const owner = ownerOf(request)
  const updatedAt = Date.now()
  try {
    await env.DOCS_DB.prepare(
      `INSERT INTO docs (id, name, owner, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner = excluded.owner, updated_at = excluded.updated_at`
    ).bind(docId, name, owner, updatedAt).run()
    return json(request, env, { ok: true, id: docId, name, owner, updatedAt, action: candidate.action })
  } catch {
    return json(request, env, { error: "docs_index_unavailable" }, { status: 503 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") return Response.json({ ok: true })
    if (protectedRoute(url.pathname)) {
      const rejected = requestSecurity(request, env)
      if (rejected) return rejected
    }
    const api = await docsApi(request, env, url)
    if (api) return api
    const agent = await routeAgentRequest(request, env)
    if (agent) return agent
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
