export function normalizePatchText(patch: string): string {
  let p = String(patch ?? '')
  // Normalize to avoid invisible chars / missing newline causing git apply parsing issues.
  p = p.replaceAll('\r\n', '\n')
  p = p.replace(/[\u200B-\u200D\uFEFF]/g, '')
  if (!p.endsWith('\n')) p += '\n'
  return p
}
