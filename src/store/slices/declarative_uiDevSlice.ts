import type { SawState } from '../storeTypes'

export type DeclarativeUiDevSnapshot = {
  ts: number
  nodeId: string
  pluginId: string
  computed: Record<string, any>
  uiState: Record<string, any>
  lastAction?: { action: string; event?: any } | null
  lastQueries?: { ids: string[]; ts: number } | null
}

export type DeclarativeUiDevState = {
  declarativeUiDev: {
    enabled: boolean
    snapshots: Record<string, DeclarativeUiDevSnapshot>
  }

  setDeclarativeUiDevEnabled: (enabled: boolean) => void
  setDeclarativeUiDevSnapshot: (snap: DeclarativeUiDevSnapshot) => void
  clearDeclarativeUiDevSnapshots: () => void
}

export function createDeclarativeUiDevSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
): Pick<
  SawState,
  'declarativeUiDev' | 'setDeclarativeUiDevEnabled' | 'setDeclarativeUiDevSnapshot' | 'clearDeclarativeUiDevSnapshots'
> {
  return {
    declarativeUiDev: { enabled: true, snapshots: {} },

    setDeclarativeUiDevEnabled: (enabled: boolean) =>
      set((s) => ({ declarativeUiDev: { ...s.declarativeUiDev, enabled } })),

    setDeclarativeUiDevSnapshot: (snap: DeclarativeUiDevSnapshot) =>
      set((s) => ({
        declarativeUiDev: {
          ...s.declarativeUiDev,
          snapshots: { ...s.declarativeUiDev.snapshots, [snap.nodeId]: snap },
        },
      })),

    clearDeclarativeUiDevSnapshots: () => set((s) => ({ declarativeUiDev: { ...s.declarativeUiDev, snapshots: {} } })),
  }
}
