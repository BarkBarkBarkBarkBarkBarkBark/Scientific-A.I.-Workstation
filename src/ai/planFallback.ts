import type { PluginDefinition } from '../types/saw'
import type { AiPlan } from '../types/ai'

function scorePlugin(goal: string, p: PluginDefinition): number {
  const g = goal.toLowerCase()
  const n = p.name.toLowerCase()
  const d = p.description.toLowerCase()
  let s = 0
  const hit = (kw: string, w = 1) => {
    if (g.includes(kw)) s += w
    if (n.includes(kw)) s += Math.max(1, w - 1)
    if (d.includes(kw)) s += 1
  }
  hit('csv', 4)
  hit('load', 2)
  hit('filter', 3)
  hit('clean', 2)
  hit('normalize', 3)
  hit('pca', 4)
  hit('embed', 3)
  hit('cluster', 3)
  hit('train', 4)
  hit('classif', 4)
  hit('predict', 4)
  hit('plot', 3)
  hit('visual', 3)
  hit('audio', 3)
  return s
}

export function generatePlanFallback(goal: string, plugins: PluginDefinition[]): AiPlan {
  const scored = [...plugins].map((p) => ({ p, s: scorePlugin(goal, p) })).sort((a, b) => b.s - a.s)
  const top = scored.filter((x) => x.s > 0).slice(0, 6).map((x) => x.p.id)

  const fallback = ['load_csv', 'filter_rows', 'normalize', 'pca', 'plot_scatter']
  const suggestedPlugins = top.length >= 3 ? top : fallback
  const connections = suggestedPlugins.slice(0, -1).map((id, i) => ({ fromPluginId: id, toPluginId: suggestedPlugins[i + 1] }))

  return {
    summary: `Goal: "${goal}"\nSuggested pipeline: ${suggestedPlugins.join(' → ')}`,
    suggestedPlugins,
    connections,
    suggestionsText: [
      'Start with ingestion + basic QC.',
      'Add normalization before dimensionality reduction.',
      'If you see unstable results, inspect upstream filters and column selection.',
    ],
    logs: [
      '[planner] parsing goal...',
      `[planner] matched ${top.length} plugins`,
      `[planner] proposed ${suggestedPlugins.length} nodes`,
      '[planner] ready to apply plan (local fallback)',
    ],
    errors: [],
  }
}


