import type { PatchFile, PatchProposal, PatchRisk, PatchScopeDomain } from '../types/patch'

export type ParsedPatchProposal = {
  ok: true
  proposal: PatchProposal
} | {
  ok: false
  error: string
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function coerceRisk(x: any): PatchRisk {
  return x === 'high' || x === 'medium' ? x : 'low'
}

function coerceDomain(x: any): PatchScopeDomain {
  return x === 'workspace' ? 'workspace' : 'shell_app'
}

function normalizePatch(patch: string): string {
  let p = String(patch ?? '')
  p = p.replaceAll('\r\n', '\n')
  p = p.replace(/[\u200B-\u200D\uFEFF]/g, '')
  if (!p.endsWith('\n')) p += '\n'
  return p
}

export function extractUnifiedDiff(text: string): string | null {
  const m = text.match(/```diff\s*([\s\S]*?)```/m)
  if (m?.[1]) {
    const d = m[1].trim()
    if (!/^\s*---\s+/m.test(d) || !/^\s*\+\+\+\s+/m.test(d)) return null
    return normalizePatch(d)
  }
  const idx = text.indexOf('diff --git ')
  if (idx >= 0) {
    const d = text.slice(idx).trim()
    if (!/^\s*---\s+/m.test(d) || !/^\s*\+\+\+\s+/m.test(d)) return null
    return normalizePatch(d)
  }
  return null
}

function splitDiffByFile(patch: string): PatchFile[] {
  const p = normalizePatch(patch)
  const chunks = p.split(/\n(?=diff --git a\/)/g).filter((s) => s.trim().length > 0)
  const files: PatchFile[] = []
  for (const chunk of chunks) {
    const m = chunk.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/m)
    const path = (m?.[2] ?? '').trim()
    if (!path) continue
    files.push({ path, diff: normalizePatch(chunk) })
  }
  // Fallback: if no diff --git headers, treat as single patch and try +++ b/<path>
  if (files.length === 0) {
    const mm = p.match(/^\+\+\+\s+b\/(.+?)\s*$/m)
    const path = (mm?.[1] ?? '').trim()
    if (path) return [{ path, diff: p }]
  }
  return files
}

export function parsePatchProposalFromAssistant(text: string): ParsedPatchProposal {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, error: 'empty_message' }

  // Preferred: JSON PatchProposal (either the whole message, or first JSON object found)
  const direct = safeJsonParse(raw)
  const jsonObj =
    direct ??
    (() => {
      const m = raw.match(/\{[\s\S]*\}/m)
      return m ? safeJsonParse(m[0]) : null
    })()

  if (jsonObj && typeof jsonObj === 'object') {
    const files: PatchFile[] = Array.isArray((jsonObj as any).files) ? (jsonObj as any).files : []
    const normalizedFiles: PatchFile[] = files
      .map((f: any) => ({
        path: String(f?.path ?? '').replaceAll('\\', '/'),
        diff: normalizePatch(String(f?.diff ?? '')),
        base_hash: typeof f?.base_hash === 'string' ? f.base_hash : undefined,
      }))
      .filter((f) => f.path && f.diff && /^\s*---\s+/m.test(f.diff) && /^\s*\+\+\+\s+/m.test(f.diff))

    if (normalizedFiles.length > 0) {
      const proposal: PatchProposal = {
        id: String((jsonObj as any).id ?? `pp_${Date.now()}`),
        summary: String((jsonObj as any).summary ?? ''),
        rationale: String((jsonObj as any).rationale ?? ''),
        scope: {
          domain: coerceDomain((jsonObj as any)?.scope?.domain),
          editable_mode_required: Boolean((jsonObj as any)?.scope?.editable_mode_required ?? true),
          allowlist_paths: Array.isArray((jsonObj as any)?.scope?.allowlist_paths)
            ? ((jsonObj as any).scope.allowlist_paths as any[]).map((s) => String(s))
            : undefined,
        },
        files: normalizedFiles,
        validation_steps: Array.isArray((jsonObj as any).validation_steps)
          ? ((jsonObj as any).validation_steps as any[]).map((s) => String(s))
          : [],
        risk: coerceRisk((jsonObj as any).risk),
      }
      return { ok: true, proposal }
    }
  }

  // Fallback: unified diff in message
  const diff = extractUnifiedDiff(raw)
  if (!diff) return { ok: false, error: 'no_patch_found' }
  const files = splitDiffByFile(diff)
  if (files.length === 0) return { ok: false, error: 'patch_parse_failed' }

  const proposal: PatchProposal = {
    id: `pp_${Date.now()}`,
    summary: 'Patch (unified diff)',
    rationale: 'Parsed from assistant unified diff output.',
    scope: { domain: 'shell_app', editable_mode_required: true },
    files,
    validation_steps: [],
    risk: 'low',
  }
  return { ok: true, proposal }
}


