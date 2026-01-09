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

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

export type AgentToolCall = { id: string; name: string; arguments: any }
export type AgentChatResponse =
  | { status: 'ok'; conversation_id: string; message: string; model?: string }
  | { status: 'needs_approval'; conversation_id: string; tool_call: AgentToolCall }
  | { status: 'error'; conversation_id?: string; error: string }

export async function requestAgentChat(conversationId: string | null, message: string): Promise<AgentChatResponse> {
  const r = await fetch('/api/saw/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, message }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Agent chat request failed: ${t}`)
  }
  return (await r.json()) as AgentChatResponse
}

export async function approveAgentTool(
  conversationId: string,
  toolCallId: string,
  approved: boolean,
): Promise<AgentChatResponse> {
  const r = await fetch('/api/saw/agent/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, tool_call_id: toolCallId, approved }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Agent approve request failed: ${t}`)
  }
  return (await r.json()) as AgentChatResponse
}


