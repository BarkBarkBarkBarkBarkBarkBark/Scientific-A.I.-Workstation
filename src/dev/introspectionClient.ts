export async function runIntrospection(): Promise<unknown> {
  const r = await fetch('/api/dev/introspection/run', { method: 'GET' })
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()) as unknown
}
