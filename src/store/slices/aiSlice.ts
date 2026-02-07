import type { SawState } from '../storeTypes'
import { generatePlanFallback } from '../../ai/planFallback'
import { getAiStatus, requestAiPlan } from '../../ai/client'

export function createAiSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'goalText' | 'aiMessages' | 'aiBusy' | 'aiStatus' | 'setGoalText' | 'refreshAiStatus' | 'submitGoal'> {
  return {
    goalText: '',
    aiMessages: ['AI: Drop a "Load CSV" → "Normalize" → "PCA" chain to quickly sanity-check a dataset.'],
    aiBusy: false,
    aiStatus: null,

    setGoalText: (goalText) => set({ goalText }),

    refreshAiStatus: async () => {
      try {
        const status = await getAiStatus()
        set({ aiStatus: status })
      } catch {
        set({ aiStatus: { enabled: false, model: 'unknown' } })
      }
    },

    submitGoal: async (goal: string) => {
      set({ aiBusy: true })
      set((s) => ({
        goalText: goal,
        bottomTab: 'logs',
        logs: [...s.logs, '[planner] generating plan...'],
      }))

      let plan: any = null
      try {
        plan = await requestAiPlan(goal, get().pluginCatalog)
        set((s) => ({
          aiStatus: s.aiStatus ?? { enabled: true, model: 'openai' },
          logs: [...s.logs, ...(plan.logs ?? [])],
        }))
      } catch (e: any) {
        const fallback = generatePlanFallback(goal, get().pluginCatalog)
        plan = fallback
        set((s) => ({
          bottomTab: 'logs',
          logs: [...s.logs, `[planner] openai unavailable; using local fallback (${String(e?.message ?? e)})`],
        }))
      } finally {
        set({ aiBusy: false })
      }

      set((s) => ({
        errors: [...s.errors, ...(plan?.errors ?? [])],
        errorLog: [
          ...s.errorLog,
          ...(plan?.errors ?? []).map((t: string) => ({ ts: Date.now(), tag: 'aiPlan', text: String(t) })),
        ],
        aiMessages: [
          ...s.aiMessages,
          `AI Plan:\n${plan.summary}`,
          ...(plan.suggestionsText ?? []).map((t: string) => `AI: ${t}`),
        ],
      }))

      // Best-effort auto-drop (plan or fallback)
      const suggested: string[] = Array.isArray(plan?.suggestedPlugins) ? plan.suggestedPlugins : []
      if (suggested.length === 0) return

      if (get().layoutMode === 'pipeline') {
        for (const pluginId of suggested) {
          if (!get().pluginCatalog.find((p) => p.id === pluginId)) continue
          get().addNodeFromPluginAtIndex(pluginId, get().nodes.length)
        }
        get().reflowPipeline()
        return
      }

      // Graph mode fallback: keep old horizontal spread
      const base = { x: 120, y: 140 }
      const spacing = 280
      for (const [i, pluginId] of suggested.entries()) {
        if (!get().pluginCatalog.find((p) => p.id === pluginId)) continue
        get().addNodeFromPlugin(pluginId, { x: base.x + i * spacing, y: base.y })
      }
    },
  }
}
