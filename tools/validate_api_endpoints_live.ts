import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateApiEndpointsDoc } from './api_endpoints_schema.js'

type OpenApi = {
  openapi?: string
  swagger?: string
  paths?: Record<string, Record<string, unknown>>
}

type LiveServiceTarget = {
  id: string
  baseUrl: string
  openapiUrl: string
}

function normalizeBaseUrl(u: string): string {
  return String(u).replace(/\/+$/, '')
}

function joinUrl(base: string, p: string): string {
  const b = normalizeBaseUrl(base)
  if (!p) return b
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

function normalizePathTemplate(p: string): string {
  // FastAPI OpenAPI uses `{param}`; we keep as-is but normalize redundant slashes.
  const s = String(p).trim().replace(/\/+/g, '/')
  return s.startsWith('/') ? s : `/${s}`
}

function methodKey(m: string): string {
  return String(m).toLowerCase()
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} fetching ${url}${body ? `\n${body}` : ''}`)
  }
  return res.json()
}

function openApiHasEndpoint(openapi: OpenApi, method: string, routePath: string): boolean {
  const paths = openapi.paths ?? {}
  const p = normalizePathTemplate(routePath)
  const m = methodKey(method)

  // Exact match first
  const item = paths[p]
  if (item && Object.prototype.hasOwnProperty.call(item, m)) return true

  // Fallback: some frameworks may emit with/without trailing slash.
  if (p.endsWith('/')) {
    const p2 = p.replace(/\/+$/, '')
    const item2 = paths[p2]
    if (item2 && Object.prototype.hasOwnProperty.call(item2, m)) return true
  } else {
    const p2 = `${p}/`
    const item2 = paths[p2]
    if (item2 && Object.prototype.hasOwnProperty.call(item2, m)) return true
  }

  return false
}

function getLiveTargetsFromDoc(doc: ReturnType<typeof validateApiEndpointsDoc> extends { ok: true; value: infer T } ? T : never): LiveServiceTarget[] {
  const targets: LiveServiceTarget[] = []

  for (const s of doc.services) {
    // Only validate services that have an origin/base url concept.
    // - saw_api: uses SAW_API_URL or default_base_url
    // - patch_engine: uses SAW_PATCH_ENGINE_URL or default_base_url
    // - vite_openai_proxy: same-origin; no OpenAPI
    const envBase = s.base_url_env ? process.env[s.base_url_env] : undefined
    const baseUrl = envBase ?? s.default_base_url ?? s.base_url
    if (!baseUrl) continue

    if (s.id === 'vite_openai_proxy') continue

    const openapiUrl = joinUrl(baseUrl, '/openapi.json')
    targets.push({ id: s.id, baseUrl: normalizeBaseUrl(baseUrl), openapiUrl })
  }

  return targets
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  const defaultDocPath = path.resolve(__dirname, '..', 'saw-workspace', 'machine-context', 'api_endpoints.json')
  const docPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultDocPath

  const raw = await fs.readFile(docPath, 'utf8')
  const parsedJson = JSON.parse(raw) as unknown

  const validated = validateApiEndpointsDoc(parsedJson)
  if (!validated.ok) {
    console.error(`Schema validation failed: ${docPath}`)
    console.error(validated.error.toString())
    process.exit(1)
  }

  const doc = validated.value
  const targets = getLiveTargetsFromDoc(doc)
  if (!targets.length) {
    console.error('No live-validation targets found (missing base URLs?)')
    process.exit(2)
  }

  const errors: string[] = []

  for (const target of targets) {
    let openapi: OpenApi
    try {
      openapi = (await fetchJson(target.openapiUrl)) as OpenApi
    } catch (e: any) {
      errors.push(`Failed to fetch OpenAPI for '${target.id}' at ${target.openapiUrl}: ${String(e?.message ?? e)}`)
      continue
    }

    const service = doc.services.find((s) => s.id === target.id)
    if (!service) continue

    for (const ep of service.endpoints) {
      // Skip endpoints that are purely descriptive (no server route).
      // In this repo, everything under saw_api/patch_engine should be a real route.
      const ok = openApiHasEndpoint(openapi, ep.method, ep.path)
      if (!ok) {
        errors.push(`Missing in live OpenAPI: service='${target.id}' ${ep.method} ${ep.path} (checked ${target.openapiUrl})`)
      }
    }
  }

  if (errors.length) {
    console.error(`Live validation failed for: ${docPath}`)
    for (const e of errors) console.error(`- ${e}`)
    console.error('Tip: ensure services are running and SAW_API_URL / SAW_PATCH_ENGINE_URL point to them.')
    process.exit(1)
  }

  console.log(`OK (live): ${docPath}`)
}

main().catch((e) => {
  console.error(String(e?.stack ?? e))
  process.exit(2)
})
