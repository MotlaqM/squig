import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const project = resolve(import.meta.dirname, "..")
const accountId = "be8e1a02e385a312f00a0042fc31a1ca"
const database = { name: "squig-webmcp-docs", id: "6764c491-1611-4ae2-aaf4-16a35e9490b5" }
const gatewayId = "squig-webmcp"

const listed = spawnSync("pnpm", ["exec", "wrangler", "d1", "list", "--json"], {
  cwd: project,
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  encoding: "utf8",
})
if (listed.status !== 0) throw new Error(`D1 list failed (${listed.status})`)
const databases = JSON.parse(listed.stdout)
if (!databases.some((item) => item.name === database.name && item.uuid === database.id)) {
  throw new Error("Expected HAAC D1 database was not found")
}

const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai/chat/completions`
const gatewayResponse = await fetch(gatewayUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "resource-existence-check", messages: [] }),
})
const gatewayBody = await gatewayResponse.json()
if (gatewayResponse.status !== 401 || gatewayBody?.error?.[0]?.code !== 2009) {
  throw new Error(`Authenticated AI Gateway existence probe returned ${gatewayResponse.status}`)
}

const config = readFileSync(resolve(project, "wrangler.jsonc"), "utf8")
const example = readFileSync(resolve(project, ".dev.vars.example"), "utf8")
for (const value of [accountId, database.id, gatewayId]) {
  if (!config.includes(value) && !example.includes(value)) throw new Error(`Missing non-secret resource id ${value}`)
}
if (/CLOUDFLARE_API_TOKEN\s*=/.test(example)) throw new Error(".dev.vars.example must never contain an API token")

console.log(JSON.stringify({
  accountId,
  d1: { ...database, exists: true },
  aiGateway: { id: gatewayId, exists: true, authentication: "required" },
  secretsPrinted: false,
}, null, 2))
