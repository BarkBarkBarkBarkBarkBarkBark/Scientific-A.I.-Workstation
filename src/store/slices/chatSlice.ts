import type { SawState } from '../storeTypes'
import {
  approveAgentTool,
  requestAgentChat,
  requestAgentChatStream,
  type AgentProvider,
  type AgentSseEvent,
} from '../../ai/client'

const LS_PROVIDER_KEY = 'saw.agentProvider'

function loadProvider(): AgentProvider {
  try {
    const v = (typeof window === 'undefined' ? null : window.localStorage.getItem(LS_PROVIDER_KEY)) || ''
    const s = v.trim().toLowerCase()
    if (s === 'openai' || s === 'copilot') return s
  } catch {
    // ignore
  }
  return 'copilot'
}

function saveProvider(p: AgentProvider) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(LS_PROVIDER_KEY, p)
  } catch {
    // ignore
  }
}

function buildUiContextForAgent(state: SawState): string {
  const selectedNode = state.nodes.find((n) => n.id === state.selectedNodeId) ?? null
  const selectedPluginId = selectedNode?.data?.pluginId ?? null
  const selectedPlugin = selectedPluginId
    ? state.pluginCatalog.find((p) => p.id === selectedPluginId) ?? null
    : null

  const lines: string[] = []
  lines.push('SAW_UI_CONTEXT (ephemeral; do not echo verbatim)')
  lines.push(`layoutMode: ${state.layoutMode}`)
  lines.push(`editableMode: ${state.editableMode ? 'ON' : 'OFF'}`)
  lines.push(`selectedNodeId: ${state.selectedNodeId ?? 'none'}`)
  if (selectedNode) {
    lines.push(`selectedNode.pluginId: ${String(selectedPluginId ?? '')}`)
  }
  if (selectedPlugin) {
    lines.push(`selectedPlugin.name: ${selectedPlugin.name}`)
    if (selectedPlugin.ui?.mode) lines.push(`selectedPlugin.ui.mode: ${selectedPlugin.ui.mode}`)
  }
  lines.push(`fullscreen.open: ${state.fullscreen?.open ? 'true' : 'false'}`)
  lines.push(`fullscreen.nodeId: ${state.fullscreen?.nodeId ?? 'none'}`)
  lines.push(`nodes.count: ${state.nodes.length}`)
  lines.push(`edges.count: ${state.edges.length}`)
  lines.push(`plugins.catalog.count: ${state.pluginCatalog.length}`)
  lines.push(`plugins.workspace.count: ${state.workspacePlugins.length}`)
  lines.push(`dev.attachments.count: ${(state.dev?.attachedPaths ?? []).length}`)
  return lines.join('\n')
}

export function createChatSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'chatBusy' | 'chat' | 'sendChat' | 'setChatProvider' | 'approvePendingTool' | 'clearChat'> {
  const desiredProvider = loadProvider()
  return {
    chatBusy: false,
    chat: {
      messages: [
        {
          role: 'assistant',
          content: 'SAW Chat is ready. Ask for pipeline help, debugging ideas, or how to use a module.',
        },
      ],
      conversationId: null,
      pendingTool: null,
      streamMode: 'json',
      provider: null,
      desiredProvider,
    },

    setChatProvider: (provider: AgentProvider) => {
      saveProvider(provider)
      set((s) => ({ chat: { ...s.chat, desiredProvider: provider } }))
    },

    clearChat: () => {
      set((s) => ({
        chat: {
          messages: [
            {
              role: 'assistant',
              content: 'SAW Chat is ready. Ask for pipeline help, debugging ideas, or how to use a module.',
            },
          ],
          conversationId: null,
          pendingTool: null,
          streamMode: 'json',
          provider: null,
          desiredProvider: s.chat.desiredProvider ?? loadProvider(),
        },
        logs: [...s.logs, '[chat] cleared'],
      }))
    },

    sendChat: async (text: string) => {
      const content = text.trim()
      if (!content) return

      const uiContext = buildUiContextForAgent(get())
      const messageForAgent = `${uiContext}\n\nUSER_MESSAGE:\n${content}`

      set({ chatBusy: true })
      set((s) => ({
        bottomTab: 'chat',
        chat: { ...s.chat, messages: [...s.chat.messages, { role: 'user', content }] },
        logs: [...s.logs, '[chat] user message'],
      }))

      // Prepare an assistant message slot for streaming updates.
      let assistantIndex = -1
      set((s) => {
        const msgs = [...s.chat.messages, { role: 'assistant' as const, content: '' }]
        assistantIndex = msgs.length - 1
        return { chat: { ...s.chat, messages: msgs } }
      })

      const applyEvent = (ev: AgentSseEvent) => {
        const t = ev.type
        const cid = ev.conversation_id
        if (cid) {
          set((s) => ({ chat: { ...s.chat, conversationId: cid, streamMode: 'sse' as const } }))
        }

        if (t === 'session.started') {
          const provider = String(ev.payload?.provider ?? '').trim()
          if (provider) set((s) => ({ chat: { ...s.chat, provider } }))
          return
        }

        if (t === 'assistant.message_delta') {
          const delta = String(ev.payload?.delta ?? '')
          if (!delta) return
          set((s) => {
            const msgs = [...s.chat.messages]
            const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
            const cur = (msgs[i] as any)?.content ?? ''
            msgs[i] = { role: 'assistant' as const, content: String(cur) + delta }
            return { chat: { ...s.chat, messages: msgs } }
          })
          return
        }

        if (t === 'assistant.message') {
          const full = String(ev.payload?.content ?? '')
          set((s) => {
            const msgs = [...s.chat.messages]
            const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
            msgs[i] = { role: 'assistant' as const, content: full }
            return { chat: { ...s.chat, messages: msgs } }
          })
          return
        }

        if (t === 'permission.request') {
          const details = ev.payload?.details ?? {}
          const toolCallId = String(ev.payload?.toolCallId ?? details?.id ?? '')
          const name = String(details?.name ?? 'tool')
          const args = (details?.arguments ?? details?.details?.arguments ?? details?.function?.arguments ?? details?.arguments ?? {}) as any
          set((s) => ({
            chatBusy: false,
            chat: {
              ...s.chat,
              pendingTool: toolCallId ? { id: toolCallId, name, arguments: args } : s.chat.pendingTool,
            },
          }))
          return
        }

        if (t === 'permission.resolved') {
          set((s) => ({ chatBusy: true, chat: { ...s.chat, pendingTool: null } }))
          return
        }

        if (t === 'session.error') {
          const msg = String(ev.payload?.message ?? 'session_error')
          set((s) => ({
            chatBusy: false,
            bottomTab: 'errors',
            errors: [...s.errors, `AgentChatError: ${msg}`],
            errorLog: [...s.errorLog, { ts: Date.now(), tag: 'chat', text: `AgentChatError: ${msg}` }],
            chat: { ...s.chat, pendingTool: null },
          }))
          return
        }

        if (t === 'session.idle') {
          set({ chatBusy: false })
        }
      }

      try {
        const state = get()
        const provider = state.chat.desiredProvider
        // Prefer SSE (works for Copilot mode; OpenAI mode returns a one-shot SSE too).
        await requestAgentChatStream(state.chat.conversationId, messageForAgent, provider, applyEvent)

        // If the stream didn't deliver anything, fall back to JSON.
        const after = get()
        const lastAssistant = after.chat.messages[assistantIndex]
        const empty = !lastAssistant || String((lastAssistant as any).content ?? '').trim().length === 0
        if (empty) {
          const r = await requestAgentChat(after.chat.conversationId, messageForAgent, after.chat.desiredProvider)
          const status = (r as any).status
          const cid = (r as any).conversation_id ?? after.chat.conversationId
          const pending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
          const msg =
            status === 'needs_approval'
              ? `Approval required: ${(pending as any)?.name ?? 'tool'}`
              : (r as any).message || (r as any).error || ''

          set((s) => {
            const msgs = [...s.chat.messages]
            const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
            msgs[i] = { role: 'assistant' as const, content: msg }
            return {
              chatBusy: false,
              chat: {
                ...s.chat,
                conversationId: cid,
                pendingTool: pending,
                streamMode: 'json',
                messages: msgs,
              },
            }
          })
        }
      } catch (e: any) {
        set((s) => ({
          chatBusy: false,
          bottomTab: 'errors',
          errors: [...s.errors, `AgentChatError: ${String(e?.message ?? e)}`],
          errorLog: [...s.errorLog, { ts: Date.now(), tag: 'chat', text: `AgentChatError: ${String(e?.message ?? e)}` }],
          chat: {
            ...s.chat,
            pendingTool: null,
            messages: [
              ...s.chat.messages,
              {
                role: 'assistant',
                content: 'Agent chat is unavailable (check OPENAI_API_KEY + restart SAW API + Patch Engine).',
              },
            ],
          },
        }))
      }
    },

    approvePendingTool: async (approved: boolean) => {
      const state = get()
      const cid = state.chat.conversationId
      const pending = state.chat.pendingTool
      if (!cid || !pending?.id) return
      // If streaming is active, approval resumes the existing stream.
      const streaming = state.chat.streamMode === 'sse'
      set({ chatBusy: true })
      try {
        const r = await approveAgentTool(cid, pending.id, Boolean(approved), state.chat.desiredProvider)
        if (streaming) {
          // Stream will continue and deliver the next assistant message.
          set((s) => ({ chatBusy: true, chat: { ...s.chat, pendingTool: null } }))
          return
        }

        const status = (r as any).status
        const nextCid = (r as any).conversation_id ?? cid
        const nextPending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
        const msg =
          status === 'needs_approval'
            ? `Approval required: ${((nextPending as any)?.name ?? 'tool') as string}`
            : (r as any).message || (r as any).error || ''
        set((s) => ({
          chatBusy: false,
          chat: {
            ...s.chat,
            conversationId: nextCid,
            pendingTool: nextPending,
            messages: [...s.chat.messages, { role: 'assistant', content: msg }],
          },
        }))
      } catch (e: any) {
        set((s) => ({
          chatBusy: false,
          chat: {
            ...s.chat,
            pendingTool: null,
            messages: [...s.chat.messages, { role: 'assistant', content: `Approve failed: ${String(e?.message ?? e)}` }],
          },
        }))
      }
    },
  }
}
