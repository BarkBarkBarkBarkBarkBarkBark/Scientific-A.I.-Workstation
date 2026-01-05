import { useEffect, useMemo, useState } from 'react'

function readLastCrash(): any | null {
  try {
    const raw = window.localStorage.getItem('__SAW_LAST_CRASH__')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function CrashScreen(props: { error: unknown }) {
  const [sessionNdjson, setSessionNdjson] = useState<string>('')
  const lastCrash = useMemo(() => (typeof window === 'undefined' ? null : readLastCrash()), [])

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/dev/session/log?tail=200')
        if (!r.ok) return
        const j = (await r.json()) as any
        setSessionNdjson(String(j.ndjson ?? ''))
      } catch {
        // ignore
      }
    })()
  }, [])

  const errText = (() => {
    if (props.error instanceof Error) return `${props.error.name}: ${props.error.message}\n${props.error.stack ?? ''}`
    return String(props.error ?? 'Unknown error')
  })()

  return (
    <div className="h-full bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex h-full max-w-4xl flex-col gap-3 p-6">
        <div className="text-lg font-semibold">SAW crashed</div>
        <div className="text-sm text-zinc-400">
          This is a safety screen so you can recover without leaving the app.
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.removeItem('__SAW_PERSIST__')
                window.localStorage.removeItem('__SAW_LAST_CRASH__')
              } catch {
                // ignore
              }
              window.location.reload()
            }}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-zinc-50 hover:bg-emerald-600"
          >
            Reset local state + reload
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(errText)
              } catch {
                // ignore
              }
            }}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-900"
          >
            Copy error
          </button>
        </div>

        <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3" open>
          <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">
            Error
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-zinc-100">{errText}</pre>
        </details>

        {lastCrash && (
          <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
            <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">
              Last crash record (local)
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-zinc-100">
              {JSON.stringify(lastCrash, null, 2)}
            </pre>
          </details>
        )}

        {sessionNdjson && (
          <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3" open>
            <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">
              Session log tail (`.saw/session.ndjson`)
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-zinc-100">
              {sessionNdjson}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}


