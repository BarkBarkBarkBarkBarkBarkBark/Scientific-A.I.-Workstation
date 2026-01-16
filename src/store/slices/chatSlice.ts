import type { SawState } from '../storeTypes'
import { approveAgentTool, requestAgentChat } from '../../ai/client'

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

      try {
        const state = get()
        const r = await requestAgentChat(state.chat.conversationId, content)
        const status = (r as any).status
        const cid = (r as any).conversation_id ?? state.chat.conversationId
        const pending = status === 'needs_approval' ? ((r as any).tool_call ?? null) : null
        const msg =
          status === 'needs_approval'
            ? `Approval required: ${(pending as any)?.name ?? 'tool'}`
            : (r as any).message || (r as any).error || ''

        set((s) => ({
          chatBusy: false,
          chat: {
            ...s.chat,
            conversationId: cid,
            pendingTool: pending,
            messages: [...s.chat.messages, { role: 'assistant', content: msg }],
          },
        }))
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
      set({ chatBusy: true })
      try {
        const r = await approveAgentTool(cid, pending.id, Boolean(approved))
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
