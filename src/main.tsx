import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import 'reactflow/dist/style.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// #region agent log
const __DBG_INGEST = 'http://127.0.0.1:7243/ingest/f9611d69-7040-48f3-afb1-23034ebc959f'
function __dbg(hypothesisId: string, location: string, message: string, data: any) {
  fetch(__DBG_INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {})
}
try {
  window.addEventListener('error', (ev) => {
    __dbg('H_frontend_crash', 'src/main.tsx:window.error', 'window.error', {
      message: String((ev as any)?.message ?? ''),
      filename: String((ev as any)?.filename ?? ''),
      lineno: Number((ev as any)?.lineno ?? 0),
      colno: Number((ev as any)?.colno ?? 0),
    })
  })
  window.addEventListener('unhandledrejection', (ev) => {
    const r: any = (ev as any)?.reason
    __dbg('H_frontend_crash', 'src/main.tsx:window.unhandledrejection', 'window.unhandledrejection', {
      message: String(r?.message ?? r ?? ''),
      name: String(r?.name ?? ''),
      stack: String(r?.stack ?? ''),
    })
  })
  __dbg('H_frontend_crash', 'src/main.tsx:boot', 'boot', { href: window.location.href })
} catch {
  // ignore
}
// #endregion

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
