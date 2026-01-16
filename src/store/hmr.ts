import type { StoreApi } from 'zustand'

// Preserve app state across Vite HMR updates while still picking up NEW actions/state fields.
// Strategy: if an old store exists, migrate its state into the newly created store,
// then replace the global pointer with the new store.
const STORE_KEY = '__SAW_ZUSTAND_STORE__'

export function installHmrBridge<TState extends object>(store: StoreApi<TState>): StoreApi<TState> {
  const existingStore = (globalThis as any)[STORE_KEY] as StoreApi<TState> | undefined
  if (existingStore?.getState) {
    const prev = existingStore.getState() as any
    store.setState({ ...(store.getState() as any), ...prev } as any, true)
  }
  ;(globalThis as any)[STORE_KEY] = store
  return store
}
