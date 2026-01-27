import React from 'react'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function safeStringify(value: unknown, pretty: boolean): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_k, v) => {
        if (v && typeof v === 'object') {
          const obj = v as object
          if (seen.has(obj)) return '[Circular]'
          seen.add(obj)
        }
        return v
      },
      pretty ? 2 : 0
    )
  } catch {
    return String(value)
  }
}

function formatScalar(value: unknown): { text: string; title?: string } {
  if (value === null) return { text: 'null' }
  if (value === undefined) return { text: 'undefined' }
  if (typeof value === 'string') {
    const t = value
    if (t.length > 160) return { text: `${t.slice(0, 160)}…`, title: t }
    return { text: t }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return { text: String(value) }
  if (typeof value === 'symbol') return { text: value.toString() }
  if (typeof value === 'function') return { text: '[Function]' }

  // object/array
  const raw = safeStringify(value, false)
  if (raw.length > 160) return { text: `${raw.slice(0, 160)}…`, title: raw }
  return { text: raw }
}

function CellValue(props: { value: unknown }) {
  const v = props.value
  if (isPlainObject(v) || Array.isArray(v)) {
    const s = safeStringify(v, true)
    return (
      <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-200">{s}</pre>
    )
  }
  const { text, title } = formatScalar(v)
  return (
    <span className="whitespace-pre-wrap" title={title}>
      {text}
    </span>
  )
}

function TableShell(props: { headers: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-auto rounded-md border border-zinc-800">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 bg-zinc-950">
          <tr>
            {props.headers.map((h, idx) => (
              <th key={idx} className="border-b border-zinc-800 px-2 py-1 font-semibold text-zinc-300">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r, ridx) => (
            <tr key={ridx} className={ridx % 2 === 0 ? 'bg-zinc-950/30' : 'bg-zinc-950/10'}>
              {r.map((c, cidx) => (
                <td key={cidx} className="align-top border-b border-zinc-900 px-2 py-1 text-zinc-200">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function JsonTable(props: { value: unknown; maxArrayRows?: number }) {
  const maxArrayRows = Math.max(1, props.maxArrayRows ?? 50)
  const value = props.value

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-[11px] text-zinc-500">[]</div>
    }

    const rows = value.slice(0, maxArrayRows)
    const areObjects = rows.every((r) => isPlainObject(r))

    if (areObjects) {
      const keySet = new Set<string>()
      for (const row of rows) for (const k of Object.keys(row)) keySet.add(k)
      const keys = Array.from(keySet)

      return (
        <TableShell
          headers={['#', ...keys]}
          rows={rows.map((row, idx) => [
            <span key="i" className="text-zinc-500">
              {idx}
            </span>,
            ...keys.map((k) => <CellValue key={k} value={(row as Record<string, unknown>)[k]} />),
          ])}
        />
      )
    }

    return (
      <TableShell
        headers={['#', 'value']}
        rows={rows.map((v, idx) => [
          <span key="i" className="text-zinc-500">
            {idx}
          </span>,
          <CellValue key="v" value={v} />,
        ])}
      />
    )
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      return <div className="text-[11px] text-zinc-500">{'{}'}</div>
    }

    return (
      <TableShell
        headers={['key', 'value']}
        rows={keys.map((k) => [
          <span key="k" className="font-mono text-zinc-300">
            {k}
          </span>,
          <CellValue key="v" value={value[k]} />,
        ])}
      />
    )
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-2">
      <span className="font-mono text-[11px] text-zinc-200">{formatScalar(value).text}</span>
    </div>
  )
}
