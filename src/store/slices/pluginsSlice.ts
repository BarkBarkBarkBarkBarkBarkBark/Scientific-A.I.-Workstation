import type { SawState } from '../storeTypes'
import { fetchWorkspacePlugins } from '../../plugins/workspace'
import { mergeCatalog } from '../utils/catalog'

async function ensureArtifactsDir(pluginId: string): Promise<void> {
  // Create a per-plugin artifacts folder by writing a sentinel file.
  // Patch Engine safe/write should create intermediate directories as needed.
  const safeId = String(pluginId || '').trim()
  if (!safeId) return
  const path = `saw-workspace/artifacts/${safeId}/.gitkeep`
  try {
    const r = await fetch('/api/dev/safe/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: '' }),
    })
    // If the Patch Engine is disabled or caps forbid it, ignore and let the UI fall back.
    if (!r.ok) return
  } catch {
    // ignore
  }
}

export function createPluginsSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'workspacePlugins' | 'pluginCatalog' | 'refreshWorkspacePlugins'> {
  return {
    workspacePlugins: [],
    pluginCatalog: mergeCatalog([]),

    refreshWorkspacePlugins: async () => {
      try {
        const ws = await fetchWorkspacePlugins()

        // Ensure per-plugin artifacts dirs exist early so the Directory tab has a stable default.
        await Promise.allSettled(ws.map((p) => ensureArtifactsDir(p.id)))

        set({ workspacePlugins: ws, pluginCatalog: mergeCatalog(ws) })
        set((s) => ({ logs: [...s.logs, `[plugins] loaded workspace plugins (${ws.length})`] }))
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({ logs: [...s.logs, `[plugins] workspace fetch failed: ${msg}`] }))
      }
    },
  }
}
