import React from 'react'
import { CrashScreen } from './CrashScreen'

type Props = { children: React.ReactNode }
type State = { error: unknown | null }

// #region agent log
const __DBG_INGEST = 'http://127.0.0.1:7243/ingest/f9611d69-7040-48f3-afb1-23034ebc959f'
function __dbg(hypothesisId: string, location: string, message: string, data: any) {
  fetch(__DBG_INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {})
}
// #endregion

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: any) {
    // #region agent log
    try {
      const e =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack ?? null }
          : { message: String(error) }
      __dbg('H_frontend_crash', 'src/components/ErrorBoundary.tsx:componentDidCatch', 'componentDidCatch', {
        error: e,
        componentStack: String(info?.componentStack ?? ''),
      })
    } catch {
      // ignore
    }
    // #endregion
    try {
      const payload =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack ?? null }
          : { message: String(error) }
      window.localStorage.setItem(
        '__SAW_LAST_CRASH__',
        JSON.stringify({ ts: Date.now(), error: payload, componentStack: String(info?.componentStack ?? '') }),
      )
    } catch {
      // ignore
    }
  }

  render() {
    if (this.state.error) return <CrashScreen error={this.state.error} />
    return this.props.children
  }
}


