export type AiPlan = {
  summary: string
  suggestedPlugins: string[]
  connections: { fromPluginId: string; toPluginId: string }[]
  suggestionsText: string[]
  logs: string[]
  errors: string[]
}

export type AiStatus = {
  enabled: boolean
  model: string
}


