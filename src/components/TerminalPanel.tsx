import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'

type TermEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code?: number }
  | { type: 'info'; data: string }

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const closedRef = useRef<boolean>(false)

  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'disabled' | 'error'>(
    'idle',
  )
  const [errorText, setErrorText] = useState<string>('')

  const api = useMemo(
    () => ({
      async openSession() {
        const r = await fetch('/api/dev/term/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!r.ok) throw new Error(await r.text())
        return (await r.json()) as { session_id: string; cwd_rel: string }
      },
      async write(session_id: string, data: string) {
        void fetch('/api/dev/term/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id, data }),
        })
      },
      async resize(session_id: string, cols: number, rows: number) {
        void fetch('/api/dev/term/resize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id, cols, rows }),
        })
      },
      async close(session_id: string) {
        void fetch('/api/dev/term/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id }),
        })
      },
    }),
    [],
  )

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 12,
      convertEol: true,
      cursorBlink: true,
      scrollback: 4000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    termRef.current = term
    fitRef.current = fit

    term.open(containerRef.current)
    fit.fit()

    const onDataDispose = term.onData((data) => {
      const sid = sessionIdRef.current
      if (!sid) return
      void api.write(sid, data)
    })

    return () => {
      onDataDispose.dispose()
      try {
        term.dispose()
      } catch {
        // ignore
      }
      termRef.current = null
      fitRef.current = null
    }
  }, [api])

  useEffect(() => {
    const term = termRef.current
    if (!term) return

    const connect = async () => {
      setStatus('connecting')
      setErrorText('')

      try {
        const { session_id, cwd_rel } = await api.openSession()
        sessionIdRef.current = session_id

        term.writeln(`\x1b[90m[terminal] connected (cwd: ${cwd_rel})\x1b[0m`)

        const es = new EventSource(`/api/dev/term/stream?session_id=${encodeURIComponent(session_id)}`)
        esRef.current = es

        es.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data) as TermEvent
            if (msg.type === 'stdout' || msg.type === 'stderr') {
              term.write(msg.data)
              return
            }
            if (msg.type === 'exit') {
              term.writeln(`\r\n\x1b[90m[terminal] exited (${msg.code ?? 'unknown'})\x1b[0m`)
              setStatus('error')
              setErrorText('terminal session exited')
              return
            }
            if (msg.type === 'info') {
              term.writeln(`\r\n\x1b[90m[terminal] ${msg.data}\x1b[0m`)
            }
          } catch {
            // ignore malformed
          }
        }

        es.onerror = () => {
          if (closedRef.current) return
          setStatus('error')
          setErrorText('disconnected (patch engine restart?)')
        }

        setStatus('connected')

        // Initial size
        try {
          const fitAddon = fitRef.current
          fitAddon?.fit()
          const cols = term.cols
          const rows = term.rows
          void api.resize(session_id, cols, rows)
        } catch {
          // ignore
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        if (msg.includes('SAW_ENABLE_TERMINAL') || msg.includes('terminal_disabled') || msg.includes('term_disabled')) {
          setStatus('disabled')
          setErrorText(msg)
        } else {
          setStatus('error')
          setErrorText(msg)
        }

        term.writeln('\x1b[90m[terminal] unavailable\x1b[0m')
        term.writeln('\x1b[90mSet SAW_ENABLE_TERMINAL=1 and restart Patch Engine.\x1b[0m')
      }
    }

    void connect()

    return () => {
      closedRef.current = true
      try {
        esRef.current?.close()
      } catch {
        // ignore
      }
      esRef.current = null

      const sid = sessionIdRef.current
      sessionIdRef.current = null
      if (sid) void api.close(sid)
    }
  }, [api])

  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    const sid = () => sessionIdRef.current

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const s = sid()
        if (s) void api.resize(s, term.cols, term.rows)
      } catch {
        // ignore
      }
    })

    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      try {
        ro.disconnect()
      } catch {
        // ignore
      }
    }
  }, [api])

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-400">
        <div className="truncate">
          status:{' '}
          <span
            className={
              status === 'connected'
                ? 'text-emerald-400'
                : status === 'connecting'
                  ? 'text-zinc-300'
                  : status === 'disabled'
                    ? 'text-zinc-500'
                    : 'text-amber-300'
            }
          >
            {status}
          </span>
        </div>
        {errorText ? <div className="max-w-[70%] truncate text-zinc-500">{errorText}</div> : null}
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  )
}
