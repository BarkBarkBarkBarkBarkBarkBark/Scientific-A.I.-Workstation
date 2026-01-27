import type { SawState } from '../storeTypes'

export type A2uiDevSnapshot = {
  ts: number
  nodeId: string
  pluginId: string
  computed: Record<string, any>
  uiState: Record<string, any>
  lastAction?: { action: string; event?: any } | null
  lastQueries?: { ids: string[]; ts: number } | null
}

export type A2uiDevState = {
  a2uiDev: {
    enabled: boolean
    snapshots: Record<string, A2uiDevSnapshot>
  }

  setA2uiDevEnabled: (enabled: boolean) => void
  setA2uiDevSnapshot: (snap: A2uiDevSnapshot) => void
  clearA2uiDevSnapshots: () => void
}

export function createA2uiDevSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
): Pick<SawState, 'a2uiDev' | 'setA2uiDevEnabled' | 'setA2uiDevSnapshot' | 'clearA2uiDevSnapshots'> {
  return {
    a2uiDev: { enabled: true, snapshots: {} },

    setA2uiDevEnabled: (enabled: boolean) => set((s) => ({ a2uiDev: { ...s.a2uiDev, enabled } })),

    setA2uiDevSnapshot: (snap: A2uiDevSnapshot) =>
      set((s) => ({ a2uiDev: { ...s.a2uiDev, snapshots: { ...s.a2uiDev.snapshots, [snap.nodeId]: snap } } })),

    clearA2uiDevSnapshots: () => set((s) => ({ a2uiDev: { ...s.a2uiDev, snapshots: {} } })),
  }
}
