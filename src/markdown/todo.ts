export type TodoRenderLine =
  | { kind: 'checkbox'; lineIndex: number; checked: boolean; text: string }
  | { kind: 'text'; lineIndex: number; text: string }

const CHECKBOX_RE = /^(\s*[-*]\s+)\[( |x|X)\](\s*)(.*)$/

export function parseTodoRenderLines(markdown: string): TodoRenderLine[] {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').split('\n')
  return lines.map((line, idx) => {
    const m = line.match(CHECKBOX_RE)
    if (!m) return { kind: 'text', lineIndex: idx, text: line }
    const checked = (m[2] || '').toLowerCase() === 'x'
    const text = (m[4] ?? '').trimEnd()
    return { kind: 'checkbox', lineIndex: idx, checked, text }
  })
}

export function toggleCheckboxAtLine(markdown: string, lineIndex: number): string {
  const lines = String(markdown ?? '').replaceAll('\r\n', '\n').split('\n')
  if (lineIndex < 0 || lineIndex >= lines.length) return markdown
  const line = lines[lineIndex] ?? ''
  const m = line.match(CHECKBOX_RE)
  if (!m) return markdown
  const prefix = m[1] ?? '- '
  const isChecked = (m[2] || '').toLowerCase() === 'x'
  const gap = m[3] ?? ' '
  const rest = m[4] ?? ''
  lines[lineIndex] = `${prefix}[${isChecked ? ' ' : 'x'}]${gap}${rest}`
  return lines.join('\n')
}


