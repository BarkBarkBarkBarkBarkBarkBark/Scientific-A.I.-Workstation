import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { validateApiEndpointsDoc } from './api_endpoints_schema.js'

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const p = issue.path.length ? issue.path.join('.') : '<root>'
      return `${p}: ${issue.message}`
    })
    .join('\n')
}

function assertUnique(values: string[], label: string): string[] {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const v of values) {
    if (seen.has(v)) dups.push(v)
    seen.add(v)
  }
  if (dups.length) return [`${label} must be unique; duplicates: ${[...new Set(dups)].join(', ')}`]
  return []
}

function startsWithSlash(p: string) {
  return p.startsWith('/')
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  const defaultTarget = path.resolve(__dirname, '..', 'saw-workspace', 'machine-context', 'api_endpoints.json')
  const target = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultTarget

  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch (e: any) {
    console.error(`Failed to read: ${target}`)
    console.error(String(e?.message ?? e))
    process.exit(2)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e: any) {
    console.error(`Invalid JSON: ${target}`)
    console.error(String(e?.message ?? e))
    process.exit(2)
  }

  const validated = validateApiEndpointsDoc(json)
  if (!validated.ok) {
    console.error(`Schema validation failed: ${target}`)
    console.error(formatZodError(validated.error))
    process.exit(1)
  }

  const doc = validated.value
  const errors: string[] = []

  // Enforce basic URL path conventions
  for (const proxy of doc.vite_proxies) {
    if (!startsWithSlash(proxy.prefix)) errors.push(`vite_proxies.prefix must start with '/': ${proxy.prefix}`)
  }

  // Unique service ids
  errors.push(...assertUnique(doc.services.map((s) => s.id), 'services[].id'))

  // Endpoint rules
  for (const service of doc.services) {
    errors.push(...assertUnique(service.endpoints.map((e) => `${e.method} ${e.path}`), `endpoints in service '${service.id}'`))

    for (const ep of service.endpoints) {
      if (!startsWithSlash(ep.path)) {
        errors.push(`services['${service.id}'].endpoints[].path must start with '/': ${ep.path}`)
      }
      if (ep.browser_path && !startsWithSlash(ep.browser_path)) {
        errors.push(`services['${service.id}'].endpoints[].browser_path must start with '/': ${ep.browser_path}`)
      }

      // If browser_base is present, browser_path should usually start with it.
      if (service.browser_base && ep.browser_path) {
        if (!ep.browser_path.startsWith(service.browser_base)) {
          errors.push(
            `services['${service.id}'] browser_path '${ep.browser_path}' must start with browser_base '${service.browser_base}'`,
          )
        }
      }
    }
  }

  // Unique health check ids
  errors.push(...assertUnique(doc.health_panel_checks.map((c) => c.id), 'health_panel_checks[].id'))

  if (errors.length) {
    console.error(`Semantic validation failed: ${target}`)
    for (const e of errors) console.error(`- ${e}`)
    process.exit(1)
  }

  console.log(`OK: ${target}`)
}

main().catch((e) => {
  console.error(String(e?.stack ?? e))
  process.exit(2)
})
