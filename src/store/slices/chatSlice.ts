import type { SawState } from '../storeTypes'
import { approveAgentTool, requestAgentChat, requestAgentChatStream, type AgentSseEvent } from '../../ai/client'

export function createChatSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
  get: () => SawState,
): Pick<SawState, 'chatBusy' | 'chat' | 'sendChat' | 'approvePendingTool' | 'clearChat'> {
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
        },
        logs: [...s.logs, '[chat] cleared'],
      }))
    },

    sendChat: async (text: string) => {
      const content = text.trim()
      if (!content) return

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
        // Prefer SSE (works for Copilot mode; OpenAI mode returns a one-shot SSE too).
        await requestAgentChatStream(state.chat.conversationId, content, applyEvent)

        // If the stream didn't deliver anything, fall back to JSON.
        const after = get()
        const lastAssistant = after.chat.messages[assistantIndex]
        const empty = !lastAssistant || String((lastAssistant as any).content ?? '').trim().length === 0
        if (empty) {
          const r = await requestAgentChat(after.chat.conversationId, content)
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
        const r = await approveAgentTool(cid, pending.id, Boolean(approved))
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
