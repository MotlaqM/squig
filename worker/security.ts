export interface SecurityEnv {
  APP_ORIGIN: string
  ENVIRONMENT: string
}

/** Access runs at the edge in production; this is the fail-closed application backstop. */
export function requestSecurity(request: Request, env: SecurityEnv): Response | null {
  const origin = request.headers.get("Origin")
  if (origin && origin !== env.APP_ORIGIN) return new Response("Forbidden origin", { status: 403 })
  if (env.ENVIRONMENT !== "local" && !request.headers.get("Cf-Access-Authenticated-User-Email")?.trim()) {
    return new Response("Cloudflare Access identity required", { status: 401 })
  }
  return null
}
