export type DevTreeNode =
  | { type: 'dir'; name: string; path: string; children: DevTreeNode[] }
  | { type: 'file'; name: string; path: string }

export type CapsRule = { path: string; r: boolean; w: boolean; d: boolean }
export type CapsManifest = { version: 1; updatedAt: number; rules: CapsRule[] }

export async function fetchDevTree(params?: { root?: string; depth?: number }) {
  const root = params?.root ?? '.'
  const depth = params?.depth ?? 6
  const r = await fetch(`/api/dev/tree?root=${encodeURIComponent(root)}&depth=${encodeURIComponent(depth)}`)
  if (!r.ok) throw new Error(await r.text())
  const j = (await r.json()) as { tree: DevTreeNode }
  return j.tree
}

export async function fetchDevFile(path: string) {
  const r = await fetch(`/api/dev/file?path=${encodeURIComponent(path)}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()) as { path: string; content: string }
}

export async function fetchDevCaps() {
  const r = await fetch('/api/dev/caps')
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()) as CapsManifest
}

export async function setDevCaps(path: string, caps: { r: boolean; w: boolean; d: boolean }) {
  const r = await fetch('/api/dev/caps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, caps }),
  })
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()) as CapsManifest
}


