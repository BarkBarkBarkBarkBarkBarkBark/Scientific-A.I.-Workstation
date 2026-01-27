export function getIntoPath(into: string): string[] {
  const raw = String(into ?? '').trim()
  if (!raw) return []
  const stripped = raw.startsWith('uiState.') ? raw.slice('uiState.'.length) : raw
  return stripped.split('.').map((s) => s.trim()).filter(Boolean)
}

export function setByPath(base: Record<string, any>, path: string[], value: any): Record<string, any> {
  if (path.length === 0) return base

  const out: Record<string, any> = Array.isArray(base) ? [...(base as any)] : { ...base }
  let cur: any = out

  for (let i = 0; i < path.length; i++) {
    const key = path[i]!
    if (i === path.length - 1) {
      cur[key] = value
      break
    }
    const next = cur[key]
    cur[key] = next && typeof next === 'object' && !Array.isArray(next) ? { ...next } : {}
    cur = cur[key]
  }

  return out
}
