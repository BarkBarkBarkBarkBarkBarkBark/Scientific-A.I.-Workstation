import React from 'react'
import { CrashScreen } from './CrashScreen'

type Props = { children: React.ReactNode }
type State = { error: unknown | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: any) {
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


