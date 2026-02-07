import type { SawState } from '../storeTypes'
import {
  approveAgentTool,
  requestAgentChat,
  requestAgentChatStream,
  type AgentProvider,
  type AgentSseEvent,
} from '../../ai/client'

// Versioned to avoid inheriting older persisted defaults (e.g. an old 'openai' selection).
const LS_PROVIDER_KEY = 'saw.agentProvider.v2'
const LS_PROVIDER_KEY_LEGACY = 'saw.agentProvider'

function loadProvider(): AgentProvider {
  try {
    if (typeof window === 'undefined') return 'copilot'

    // Prefer the new key.
    const v2 = window.localStorage.getItem(LS_PROVIDER_KEY) || ''
    const s2 = v2.trim().toLowerCase()
    if (s2 === 'openai' || s2 === 'copilot') return s2

    // Legacy fallback: only honor an explicit Copilot selection.
    // If legacy is 'openai', we intentionally reset to Copilot as the default.
    const v1 = window.localStorage.getItem(LS_PROVIDER_KEY_LEGACY) || ''
    const s1 = v1.trim().toLowerCase()
    if (s1 === 'copilot') return 'copilot'
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
): Pick<SawState, 'chatBusy' | 'chat' | 'sendChat' | 'stopChat' | 'setChatProvider' | 'approvePendingTool' | 'clearChat'> {
  const desiredProvider = loadProvider()

  let activeAbort: AbortController | null = null
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

    stopChat: () => {
      if (activeAbort) {
        try {
          activeAbort.abort()
        } catch {
          // ignore
        }
        activeAbort = null
      }
      set((s) => ({
        chatBusy: false,
        chat: { ...s.chat, pendingTool: null },
        logs: [...s.logs, '[chat] stopped'],
      }))
    },

    sendChat: async (text: string) => {
      const content = text.trim()
      if (!content) return

      const uiContext = buildUiContextForAgent(get())
      const messageForAgent = `${uiContext}\n\nUSER_MESSAGE:\n${content}`

      // Cancel any existing in-flight request (defensive).
      if (activeAbort) {
        try {
          activeAbort.abort()
        } catch {
          // ignore
        }
      }
      activeAbort = new AbortController()

      set({ chatBusy: true })
      set((s) => ({
        bottomTab: 'logs',
        chat: { ...s.chat, messages: [...s.chat.messages, { role: 'user', content }] },
        logs: [...s.logs, '[chat] user message'],
      }))

      // Prepare an assistant message slot for streaming updates.
      let assistantIndex = -1
      set((s) => {
        const desired = s.chat.desiredProvider ?? 'copilot'
        const msgs = [...s.chat.messages, { role: 'assistant' as const, content: '', provider: desired }]
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
          const model = String(ev.payload?.model ?? '').trim()
          if (provider) set((s) => ({ chat: { ...s.chat, provider } }))
          if (provider || model) {
            set((s) => {
              const msgs = [...s.chat.messages]
              const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
              const cur = msgs[i] as any
              if (cur?.role !== 'assistant') return {}
              msgs[i] = { ...cur, provider: provider || cur.provider, model: model || cur.model }
              return { chat: { ...s.chat, messages: msgs } }
            })
          }
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
        await requestAgentChatStream(state.chat.conversationId, messageForAgent, provider, applyEvent, activeAbort.signal)

        // If the stream didn't deliver anything, fall back to JSON.
        const after = get()
        const lastAssistant = after.chat.messages[assistantIndex]
        const empty = !lastAssistant || String((lastAssistant as any).content ?? '').trim().length === 0
        if (empty) {
          const r = await requestAgentChat(
            after.chat.conversationId,
            messageForAgent,
            after.chat.desiredProvider,
            activeAbort.signal,
          )
          const status = (r as any).status
          const cid = (r as any).conversation_id ?? after.chat.conversationId
          const pending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
          const msg =
            status === 'needs_approval'
              ? `Approval required: ${(pending as any)?.name ?? 'tool'}`
              : (r as any).message || (r as any).error || ''
          const model = String((r as any).model ?? '').trim()
          const p = String(after.chat.desiredProvider ?? '').trim()

          set((s) => {
            const msgs = [...s.chat.messages]
            const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
            msgs[i] = { role: 'assistant' as const, content: msg, provider: p || (msgs[i] as any)?.provider, model }
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
        // Stop button / AbortController cancellation.
        if (String(e?.name ?? '') === 'AbortError') {
          set((s) => {
            const msgs = [...s.chat.messages]
            const i = assistantIndex >= 0 ? assistantIndex : msgs.length - 1
            const cur = msgs[i] as any
            const curText = String(cur?.content ?? '').trim()
            if (cur?.role === 'assistant' && !curText) {
              msgs[i] = { ...cur, content: 'Stopped.' }
            }
            return { chatBusy: false, chat: { ...s.chat, pendingTool: null, messages: msgs } }
          })
          return
        }
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
      } finally {
        activeAbort = null
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
        const model = String((r as any).model ?? '').trim()
        const p = String(state.chat.desiredProvider ?? '').trim()
        set((s) => ({
          chatBusy: false,
          chat: {
            ...s.chat,
            conversationId: nextCid,
            pendingTool: nextPending,
            messages: [...s.chat.messages, { role: 'assistant', content: msg, provider: p || s.chat.provider || undefined, model }],
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
