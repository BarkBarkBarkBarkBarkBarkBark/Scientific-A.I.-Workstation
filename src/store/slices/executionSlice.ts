import type { SawState } from '../storeTypes'

export function createExecutionSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'runPluginNode'> {
  return {
    runPluginNode: async (nodeId: string) => {
      const node = get().nodes.find((n) => n.id === nodeId) ?? null
      if (!node) return { ok: false, error: 'missing_node' }
      const pluginId = node.data.pluginId
      const inputPayload = Object.fromEntries(
        Object.entries(node.data.inputs ?? {}).map(([key, value]) => [key, { data: value }]),
      )

      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, status: 'running' } } : n)),
        logs: [...s.logs, `[run] ${pluginId}: start`],
      }))

      try {
        const r = await fetch('/api/saw/plugins/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin_id: pluginId,
            inputs: inputPayload,
            params: node.data.params ?? {},
          }),
        })
        if (!r.ok) throw new Error(await r.text())
        const j = (await r.json()) as {
          ok: boolean
          outputs: any
          logs?: any[]
          raw_stdout?: string
          raw_stderr?: string
          error?: any
        }
        const ok = Boolean(j?.ok)
        const logs = Array.isArray(j?.logs) ? j.logs : []
        const ranAt = Date.now()

        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            return {
              ...n,
              data: {
                ...n.data,
                status: ok ? 'idle' : 'error',
                runtime: {
                  ...(n.data.runtime ?? {}),
                  exec: {
                    last: {
                      ok,
                      outputs: j?.outputs ?? {},
                      logs,
                      rawStdout: j?.raw_stdout ?? '',
                      rawStderr: j?.raw_stderr ?? '',
                      error: j?.error ?? null,
                      ranAt,
                    },
                  },
                },
              },
            }
          }),
          logs: [
            ...s.logs,
            `[run] ${pluginId}: ${ok ? 'ok' : 'error'}`,
            ...logs.map((l) => `[${pluginId}] ${typeof l === 'string' ? l : JSON.stringify(l)}`),
          ],
          errors: ok ? s.errors : [...s.errors, `PluginRunError: ${pluginId}`],
        }))

        return { ok: true }
      } catch (e: any) {
        const msg = String(e?.message ?? e)
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n
            return {
              ...n,
              data: {
                ...n.data,
                status: 'error',
                runtime: {
                  ...(n.data.runtime ?? {}),
                  exec: { last: { ok: false, outputs: {}, logs: [], error: msg, ranAt: Date.now() } },
                },
              },
            }
          }),
          bottomTab: 'errors',
          errors: [...s.errors, `PluginRunError: ${pluginId}: ${msg}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'plugin', text: `PluginRunError: ${pluginId}: ${msg}` }],
          logs: [...s.logs, `[run] ${pluginId}: failed (${msg})`],
        }))
        return { ok: false, error: msg }
      }
    },
  }
}
