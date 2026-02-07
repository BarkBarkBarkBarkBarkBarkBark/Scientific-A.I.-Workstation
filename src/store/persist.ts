import type { StoreApi } from 'zustand'

// Persist a small subset across full page reloads (commit/HMR edge cases).
export function installLocalStoragePersist<TState extends any>(store: StoreApi<TState>) {
  try {
    const KEY = '__SAW_PERSIST__'
    if (typeof window === 'undefined' || !window.localStorage) return

    const normalizeBottomTab = (tab: any) => {
      if (tab === 'ai') return 'logs'
      return tab
    }

    const raw = window.localStorage.getItem(KEY)
    if (raw) {
      const j = JSON.parse(raw) as any
      const cur = store.getState() as any
      // IMPORTANT: merge into the existing store state (do NOT replace), otherwise we can wipe required fields like `layout`.
      store.setState(
        {
          chat: j.chat ?? cur.chat,
          dev: { ...(cur.dev ?? {}), ...(j.dev ?? {}) },
          logs: j.logs ?? cur.logs,
          errors: j.errors ?? cur.errors,
          errorLog: j.errorLog ?? cur.errorLog,
          bottomTab: normalizeBottomTab(j.bottomTab) ?? cur.bottomTab,
          leftSidebarTab: j.leftSidebarTab ?? cur.leftSidebarTab,
        } as any,
        false,
      )
    }

    store.subscribe((s: any) => {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          chat: { messages: (s.chat?.messages ?? []).slice(-60) },
          dev: { attachedPaths: s.dev?.attachedPaths ?? [] },
          logs: (s.logs ?? []).slice(-120),
          errors: (s.errors ?? []).slice(-120),
          errorLog: (s.errorLog ?? []).slice(-200),
          bottomTab: normalizeBottomTab(s.bottomTab),
          leftSidebarTab: s.leftSidebarTab,
        }),
      )
    })
  } catch {
    // ignore
  }
}
