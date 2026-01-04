import type { AiPlan, AiStatus } from '../types/ai'
import type { PluginDefinition } from '../types/saw'

export async function getAiStatus(): Promise<AiStatus> {
  const r = await fetch('/api/ai/status')
  if (!r.ok) return { enabled: false, model: 'unknown' }
  return (await r.json()) as AiStatus
}

export async function requestAiPlan(goal: string, plugins: PluginDefinition[]): Promise<AiPlan> {
  const r = await fetch('/api/ai/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal,
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        inputs: p.inputs,
        outputs: p.outputs,
      })),
    }),
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`AI request failed: ${t}`)
  }

  return (await r.json()) as AiPlan
}


