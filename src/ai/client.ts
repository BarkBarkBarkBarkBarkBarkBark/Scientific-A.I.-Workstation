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
export type ChatMessage = {
  role: ChatRole
  content: string
  provider?: string
  model?: string
}

export type AgentToolCall = { id: string; name: string; arguments: any }
export type AgentChatResponse =
  | { status: 'ok'; conversation_id: string; message: string; model?: string }
  | { status: 'needs_approval'; conversation_id: string; tool_call: AgentToolCall }
  | { status: 'error'; conversation_id?: string; error: string }

export type AgentSseEvent = {
  conversation_id: string
  type: string
  payload: any
}

export type AgentProvider = 'copilot' | 'openai'

export async function requestAgentChat(
  conversationId: string | null,
  message: string,
  provider?: AgentProvider,
  signal?: AbortSignal,
): Promise<AgentChatResponse> {
  const url = provider ? `/api/saw/agent/chat?provider=${encodeURIComponent(provider)}` : '/api/saw/agent/chat'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, message }),
    signal,
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
  provider?: AgentProvider,
): Promise<AgentChatResponse> {
  const url = provider ? `/api/saw/agent/approve?provider=${encodeURIComponent(provider)}` : '/api/saw/agent/approve'
  const r = await fetch(url, {
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

function parseSseBlocks(text: string): Array<{ event?: string; data?: string }> {
  const blocks = text.split(/\n\n+/g)
  const out: Array<{ event?: string; data?: string }> = []
  for (const b of blocks) {
    const lines = b.split(/\n/g)
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of lines) {
      const m1 = line.match(/^event:\s*(.*)$/)
      if (m1) {
        event = (m1[1] ?? '').trim()
        continue
      }
      const m2 = line.match(/^data:\s*(.*)$/)
      if (m2) {
        dataLines.push(m2[1] ?? '')
        continue
      }
    }
    if (event || dataLines.length) out.push({ event, data: dataLines.join('\n') })
  }
  return out
}

export async function requestAgentChatStream(
  conversationId: string | null,
  message: string,
  provider: AgentProvider | undefined,
  onEvent: (ev: AgentSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = provider
    ? `/api/saw/agent/chat?stream=1&provider=${encodeURIComponent(provider)}`
    : '/api/saw/agent/chat?stream=1'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, message }),
    signal,
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Agent chat stream request failed: ${t}`)
  }

  const reader = r.body?.getReader()
  if (!reader) throw new Error('Agent chat stream unavailable (no body)')

  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // Process complete SSE blocks; keep remainder in buf.
    const lastSep = buf.lastIndexOf('\n\n')
    if (lastSep < 0) continue
    const head = buf.slice(0, lastSep)
    buf = buf.slice(lastSep + 2)

    for (const block of parseSseBlocks(head)) {
      if (!block.data) continue
      // SAW uses a single event name (saw.agent.event); the typed payload is in JSON data.
      try {
        const ev = JSON.parse(block.data) as AgentSseEvent
        if (ev && typeof ev.type === 'string') onEvent(ev)
      } catch {
        // ignore malformed blocks
      }
    }
  }
}


