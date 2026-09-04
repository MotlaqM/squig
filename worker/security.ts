export interface SecurityEnv {
  APP_ORIGIN: string
  ENVIRONMENT: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_APPLICATION_AUD?: string
}

export interface SecurityContext {
  owner: string
  preflight: boolean
}

export interface SecurityDependencies {
  fetch?: typeof fetch
  now?: () => number
}

interface AccessJwtHeader {
  alg?: unknown
  kid?: unknown
}

interface AccessJwtPayload {
  aud?: unknown
  email?: unknown
  exp?: unknown
  iss?: unknown
  nbf?: unknown
}

interface AccessJwk extends JsonWebKey {
  alg?: string
  kid?: string
  use?: string
}

interface CachedJwks {
  url: string
  expiresAt: number
  keys: AccessJwk[]
}

const JWKS_CACHE_MS = 5 * 60_000
const MAX_ACCESS_JWT_BYTES = 64 * 1024
let cachedJwks: CachedJwks | null = null

function loopbackPeer(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (url.hostname === "localhost") url.hostname = "127.0.0.1"
    else if (url.hostname === "127.0.0.1") url.hostname = "localhost"
    else return null
    return url.origin
  } catch {
    return null
  }
}

/** Production permits one exact origin; local development permits its exact loopback spelling peer. */
export function isAllowedOrigin(origin: string, env: SecurityEnv): boolean {
  if (origin === env.APP_ORIGIN) return true
  return env.ENVIRONMENT === "local" && origin === loopbackPeer(env.APP_ORIGIN)
}

function accessIssuer(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null
    if (!url.hostname.endsWith(".cloudflareaccess.com")) return null
    return url.origin
  } catch {
    return null
  }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url")
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T
}

async function fetchJwks(url: string, fetcher: typeof fetch, now: number, force = false): Promise<AccessJwk[]> {
  if (!force && cachedJwks?.url === url && cachedJwks.expiresAt > now) return cachedJwks.keys
  const response = await fetcher(url, { headers: { Accept: "application/json" }, redirect: "error" })
  if (!response.ok) throw new Error("Access JWKS unavailable")
  const body = await response.json() as { keys?: unknown }
  if (!Array.isArray(body.keys) || body.keys.length > 16) throw new Error("Invalid Access JWKS")
  const keys = body.keys.filter((key): key is AccessJwk => !!key && typeof key === "object")
  if (!keys.length) throw new Error("Empty Access JWKS")
  cachedJwks = { url, expiresAt: now + JWKS_CACHE_MS, keys }
  return keys
}

function matchingKey(keys: readonly AccessJwk[], kid: string): AccessJwk | undefined {
  return keys.find((key) => key.kid === kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"))
}

async function verifyAccessJwt(
  token: string,
  issuer: string,
  audience: string,
  dependencies: SecurityDependencies
): Promise<AccessJwtPayload | null> {
  if (new TextEncoder().encode(token).byteLength > MAX_ACCESS_JWT_BYTES) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null

  let header: AccessJwtHeader
  let payload: AccessJwtPayload
  let signature: Uint8Array<ArrayBuffer>
  try {
    header = decodeJson<AccessJwtHeader>(parts[0])
    payload = decodeJson<AccessJwtPayload>(parts[1])
    signature = decodeBase64Url(parts[2])
  } catch {
    return null
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null

  const nowMs = dependencies.now?.() ?? Date.now()
  const nowSeconds = Math.floor(nowMs / 1000)
  const validAudience = typeof payload.aud === "string"
    ? payload.aud === audience
    : Array.isArray(payload.aud) && payload.aud.some((entry) => entry === audience)
  if (payload.iss !== issuer || !validAudience || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return null
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds)) return null

  const fetcher = dependencies.fetch ?? fetch
  const jwksUrl = `${issuer}/cdn-cgi/access/certs`
  try {
    let keys = await fetchJwks(jwksUrl, fetcher, nowMs)
    let jwk = matchingKey(keys, header.kid)
    if (!jwk) {
      keys = await fetchJwks(jwksUrl, fetcher, nowMs, true)
      jwk = matchingKey(keys, header.kid)
    }
    if (!jwk) return null
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    )
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)
    return verified ? payload : null
  } catch {
    return null
  }
}

/** Validate origin first, then the Access application JWT for every substantive production request. */
export async function requestSecurity(
  request: Request,
  env: SecurityEnv,
  dependencies: SecurityDependencies = {}
): Promise<SecurityContext | Response> {
  const origin = request.headers.get("Origin")
  if (origin && !isAllowedOrigin(origin, env)) return new Response("Forbidden origin", { status: 403 })

  if (request.method === "OPTIONS") {
    if (!origin || !isAllowedOrigin(origin, env)) return new Response("Forbidden preflight", { status: 403 })
    return { owner: "preflight", preflight: true }
  }
  if (env.ENVIRONMENT === "local") return { owner: "local", preflight: false }

  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN)
  const audience = env.ACCESS_APPLICATION_AUD?.trim()
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim()
  if (!issuer || !audience || !token) return new Response("Cloudflare Access token required", { status: 401 })

  const payload = await verifyAccessJwt(token, issuer, audience, dependencies)
  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : ""
  if (!email) return new Response("Invalid Cloudflare Access token", { status: 401 })
  return { owner: email, preflight: false }
}
