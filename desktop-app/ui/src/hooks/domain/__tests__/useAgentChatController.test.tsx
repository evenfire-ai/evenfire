// @vitest-environment jsdom
/**
 * ⚠️ CHARACTERIZATION TESTS — D.0.
 *
 * These tests capture the OBSERVABLE behavior of `useAgentChatController`
 * PRE-D.3. Do NOT modify them when refactoring in D.3 — only adapt the setup
 * (e.g. wrap with AgentTaskTrackerProvider). If an assertion stops passing
 * after D.3, that means the refactor changed user-visible behavior and must be
 * discussed before merging.
 *
 * Plan: .specs/feat-feedback-fire-forget-comeback/implementation-plans/D0-characterization-tests.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

// React 18/19 needs this flag for act() to flush effects in the test env.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  // Deterministic UUIDs so userMessageId / chatId are stable across asserts.
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

/** Wait until the controller's mount effect (loadChatList) has settled. */
async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

describe('useAgentChatController — characterization (D.0)', () => {
  describe('switchToChat', () => {
    // ⚠️ Rewritten for D.4 (plan §5.3): the pre-D.4 `isRemote` dual-path was
    // replaced by a single cache-first → server-reconcile → tracker-rejoin path,
    // so these now characterize the UNIFIED switchToChat. The behavior change is
    // the documented D.4 decision, not a silent regression.
    it('4.1 renders the local cache then reconciles with the server (idle → no rejoin)', async () => {
      clerum.chat.loadMessages.mockResolvedValue([
        { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'hello', timestamp: 2 },
        { id: 'm3', role: 'user', content: 'again', timestamp: 3 },
      ])
      // Server reconcile returns no extra turns and an idle session.
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'chat-1',
        state: 'idle',
        turns: [],
      })
      const { result } = renderController()
      await settleMount()

      await act(async () => {
        await result.current.switchToChat('agent-x', 'chat-1')
      })

      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'chat-1')
      // Phase 2 now always reconciles with the server.
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'chat-1',
        undefined,
        { limit: 80 }
      )
      // Cache was up to date → no overwrite, no rejoin.
      expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
      expect(result.current.chatMessages).toHaveLength(3)
      expect(result.current.activeChatId).toBe('chat-1')
    })

    it('4.2 hydrates a server-only chat (created on another device) and persists via replace', async () => {
      clerum.chat.loadMessages.mockResolvedValue([]) // nothing cached locally
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'chat-2',
        state: 'idle',
        turns: [
          {
            number: 1,
            user_input: 'remote question',
            response: 'remote answer',
            started_at: '2026-05-28T10:00:00Z',
            completed_at: '2026-05-28T10:00:05Z',
          },
        ],
      })
      const { result } = renderController()
      await settleMount()

      await act(async () => {
        await result.current.switchToChat('agent-x', 'chat-2')
      })

      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'chat-2',
        undefined,
        { limit: 80 }
      )
      expect(clerum.chat.create).toHaveBeenCalledWith('agent-x', 'chat-2')
      // Server is source of truth → replace, not append.
      expect(clerum.chat.replaceMessages).toHaveBeenCalled()
      expect(clerum.chat.appendMessages).not.toHaveBeenCalled()
      // Auto-title from the first user turn.
      expect(clerum.chat.rename).toHaveBeenCalledWith('agent-x', 'chat-2', 'remote question')
      expect(result.current.chatMessages).toHaveLength(2)
      expect(result.current.activeChatId).toBe('chat-2')
    })

    it('4.3 stays on the local cache and flags offline mode when the reconcile network-fails', async () => {
      clerum.chat.loadMessages.mockResolvedValue([])
      clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('network unreachable'))
      const { result } = renderController()
      await settleMount()

      await act(async () => {
        await result.current.switchToChat('agent-x', 'chat-2')
      })

      // No crash; Phase 1 cache stays rendered, chat stays active (not evicted).
      expect(result.current.activeChatId).toBe('chat-2')
      expect(result.current.chatMessages).toEqual([])
      expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
      const key = 'agent-x::chat-2'
      expect(result.current.sessionStateByChatKey[key]).toMatchObject({
        syncing: false,
        offlineMode: true,
      })
    })
  })

  describe('sendAgentMessage', () => {
    it('4.4 completes a task end-to-end and persists the assistant reply', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'done!' })
      const { result, spies } = renderController()
      await settleMount()

      let sendResolved = false
      const sendPromise = act(async () => {
        await result.current.handleSendAgentMessage('hola')
        sendResolved = true
      })

      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'completed' },
        })
      })
      await sendPromise

      expect(sendResolved).toBe(true)
      // user message + assistant reply
      expect(clerum.chat.appendMessages).toHaveBeenCalledTimes(2)
      expect(clerum.rpc.getTaskResult).toHaveBeenCalledWith('agent-x', 'task-abc', ['agent-x'])
      expect(spies.pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
    })

    it('4.4b auto-creates a chat when none is active before invoking the host', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'ok' })
      const { result } = renderController()
      await settleMount()
      expect(result.current.activeChatId).toBeNull()

      const sendPromise = act(async () => {
        await result.current.handleSendAgentMessage('first message')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'completed' },
        })
      })
      await sendPromise

      expect(clerum.chat.create).toHaveBeenCalled()
      const createOrder = clerum.chat.create.mock.invocationCallOrder[0]!
      const invokeOrder = clerum.rpc.invokeHostMessage.mock.invocationCallOrder[0]!
      expect(createOrder).toBeLessThan(invokeOrder)
      expect(result.current.activeChatId).not.toBeNull()
    })

    it('4.4b-err aborts the send when chat creation fails', async () => {
      clerum.chat.create.mockRejectedValue(new Error('disk full'))
      const { result, spies } = renderController()
      await settleMount()

      await act(async () => {
        await result.current.handleSendAgentMessage('doomed message')
      })

      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(spies.pushToast).toHaveBeenCalledWith(
        expect.stringContaining('Could not create a chat session'),
        'error'
      )
      expect(result.current.agentSending).toBe(false)
    })

    it('4.4c rejects a concurrent send while one is in flight', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'ok' })
      const { result } = renderController()
      await settleMount()

      // First send — leave it in flight (no terminal emitted yet).
      const firstSend = act(async () => {
        await result.current.handleSendAgentMessage('m1')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))

      // Second send while first is in flight — should be silently rejected.
      await act(async () => {
        await result.current.handleSendAgentMessage('m2')
      })
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)

      // Clean up: terminate the first task.
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'completed' },
        })
      })
      await firstSend
    })

    it('4.5 surfaces a failed terminal as an error assistant message', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = act(async () => {
        await result.current.handleSendAgentMessage('hola')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: {
            taskId: 'task-abc',
            status: 'failed',
            error: { message: 'LLM down', code: 'provider_error', provider: 'anthropic' },
          },
        })
      })
      await sendPromise

      expect(spies.pushToast).toHaveBeenCalledWith('Message to agent-x failed: LLM down', 'error')
      const appended = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
        | Array<{ isError?: boolean; errorCode?: string }>
        | undefined
      expect(appended?.[0]?.isError).toBe(true)
      expect(appended?.[0]?.errorCode).toBe('provider_error')
    })

    it('4.6 marks the task cancelled without fetching a result', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      const { result } = renderController()
      await settleMount()

      const sendPromise = act(async () => {
        await result.current.handleSendAgentMessage('hola')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'cancelled', reason: 'user_cancelled' },
        })
      })
      await sendPromise

      expect(clerum.rpc.getTaskResult).not.toHaveBeenCalled()
      const progress = result.current.progressByAgentMessage['agent-x']
      const entry = progress && Object.values(progress)[0]
      expect(entry?.status).toBe('cancelled')
    })

    it('4.7 surfaces a suspended approval and pushes an approval notification', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      const { result, spies } = renderController()
      await settleMount()

      // Start the send bare (it stays in flight until terminal); read state
      // after the suspended event flushes, before resolving.
      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'suspended',
          data: {
            taskId: 'task-abc',
            requestId: 'req-1',
            displayName: 'Shell Execute',
            reason: 'approval',
          },
        })
      })

      await waitFor(() => {
        const progress = result.current.progressByAgentMessage['agent-x']
        const entry = progress && Object.values(progress)[0]
        expect(entry?.status).toBe('suspended')
      })
      const entry = Object.values(result.current.progressByAgentMessage['agent-x']!)[0]
      expect(entry?.suspendedInfo?.requestId).toBe('req-1')
      expect(spies.pushNotification).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'approval_required' })
      )

      // Clean up: resolve the suspended task with a terminal so the send promise settles.
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'cancelled', reason: 'cleanup' },
        })
      })
      await sendPromise
    })

    it('4.8 trips the 30s watchdog when no terminal arrives', async () => {
      vi.useFakeTimers()
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // A genuinely stalled task has no durable per-task result, so the Fix B
      // durable-result fallback can't recover it and the watchdog error stands.
      clerum.rpc.getTaskResult.mockRejectedValue(new Error('404 not found'))
      const { result, spies } = renderController()
      // Flush mount effect (getIndex) under fake timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      let sendError: unknown = null
      const sendPromise = result.current.handleSendAgentMessage('hola').catch((e: unknown) => {
        sendError = e
      })

      // Flush the async send setup until the progress subscription is wired.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(clerum.hasProgressHandler('task-abc')).toBe(true)

      await act(async () => {
        // Open the stream, then go silent and advance past the 30s watchdog.
        // The idle check is strict (> 30_000) and fires on a 5s interval, so the
        // first tick that trips it lands at ~35s — advance 40s to be safe.
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        await vi.advanceTimersByTimeAsync(40_000)
      })
      await sendPromise

      expect(spies.pushToast).toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      expect(result.current.agentSending).toBe(false)
      expect(sendError).toBeNull() // controller catches internally, does not reject
    })

    it('4.10 surfaces a result-fetch failure after a completed terminal (GAP-2)', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.getTaskResult.mockRejectedValue(new Error('fetch failed'))
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'completed' },
        })
      })
      await sendPromise

      const appended = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
        | Array<{ isError?: boolean; content?: string }>
        | undefined
      expect(appended?.[0]?.isError).toBe(true)
      expect(appended?.[0]?.content).toContain('Failed to retrieve task result')
      expect(spies.pushToast).toHaveBeenCalledWith(
        expect.stringContaining('Failed to retrieve result'),
        'error'
      )
    })

    it('4.9 trips the 5s connection timeout when the stream never opens', async () => {
      vi.useFakeTimers()
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // No durable per-task result exists for a task whose stream never opened,
      // so the Fix B fallback can't recover it and the timeout error stands.
      clerum.rpc.getTaskResult.mockRejectedValue(new Error('404 not found'))
      const { result } = renderController()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(clerum.hasProgressHandler('task-abc')).toBe(true)

      await act(async () => {
        // Never emit 'open'. Advance past the 5s connection timeout.
        await vi.advanceTimersByTimeAsync(6_000)
      })
      await sendPromise

      const progress = result.current.progressByAgentMessage['agent-x']
      const entry = progress && Object.values(progress)[0]
      expect(entry?.status).toBe('error')
    })

    // ── stream-recovery spec: a lost stream reconciles instead of failing ──

    it('SR-1 rejoins a still-running task on stream loss instead of failing', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        turns: [],
        state: 'processing',
        activeTaskId: 'task-abc',
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // The reconcile re-subscribes (rejoin) and surfaces no failure.
      await waitFor(() => expect(clerum.rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2))
      expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      expect(result.current.failedAgentSend).toBeNull()

      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'cancelled', reason: 'cleanup' },
        })
      })
      await sendPromise
    })

    it('SR-2 renders the durable server reply on stream loss after completion', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        turns: [
          {
            number: 1,
            user_input: 'hola',
            response: 'here is your report',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        ],
        state: 'idle',
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // The durable reply is pulled from the server; no error/resend.
      await waitFor(() => expect(clerum.chat.replaceMessages).toHaveBeenCalled())
      expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      expect(result.current.failedAgentSend).toBeNull()
      await sendPromise
    })

    it('SR-3 re-establishes the approval gate on stream loss during awaiting_approval WITHOUT re-notifying (§4.7.3)', async () => {
      // Fase 5c (spec-v2 §4.7.3 / §8-R2): the stream-loss recovery now routes
      // through `reconcileChat` → `attachLiveTask`, whose `SERVER_SNAPSHOT`
      // (state awaiting_approval + pendingApproval + activeTaskId) settles the
      // badge, re-establishes the in-chat approve/deny affordance from the FSM
      // projection (`seedSuspended` is gone — §8-R2 optimistic paint), and
      // PRE-ARMS the (taskId,requestId) notification dedupe: "SERVER_SNAPSHOT
      // asienta estado/badge pero NO re-emite la notificación" (§4.7.3). The
      // rejoined SSE's replayed sticky `suspended` (V2) is the definitive gate.
      // Only a genuinely-live suspended (no prior snapshot) notifies. This
      // supersedes the old pin that re-notified.
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        turns: [],
        state: 'awaiting_approval',
        activeTaskId: 'task-abc',
        pendingApproval: { requestId: 'req-1', displayName: 'Run shell' },
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      const chatId = result.current.activeChatId!
      const key = makeTaskKey('agent-x', chatId)
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', { type: 'error', message: 'disconnected' })
      })

      // The reconcile rejoins (re-subscribes) and re-establishes the approval gate
      // from the snapshot: the badge is awaiting_approval and the in-chat
      // affordance (pendingApproval) is back — but no notification is re-emitted.
      await waitFor(() =>
        expect(result.current.sessionStateByChatKey[key]?.state).toBe('awaiting_approval')
      )
      expect(result.current.sessionStateByChatKey[key]?.pendingApproval).toMatchObject({
        requestId: 'req-1',
      })
      expect(clerum.rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2)
      expect(spies.pushNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'approval_required' })
      )
      expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')

      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'cancelled', reason: 'cleanup' },
        })
      })
      await sendPromise
    })

    it('SR-4 falls through to error + resend when the server has nothing recoverable', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // default loadSessionMessages → { turns: [] }, no state/activeTaskId.
      // A genuinely lost task has NO durable per-task result either (the Fix B
      // durable-result fallback must not recover it): make getTaskResult 404.
      clerum.rpc.getTaskResult.mockRejectedValue(new Error('404 not found'))
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', { type: 'error', message: 'disconnected' })
      })

      await waitFor(() =>
        expect(spies.pushToast).toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      )
      expect(result.current.failedAgentSend).not.toBeNull()
      await sendPromise
    })

    it('SR-5 does not flash a Progress stream error before the reconcile lands', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // Defer the reconcile so we can observe the window between the stream error
      // and the durable reply landing — that's where the flash used to appear.
      let resolveLoad!: (value: unknown) => void
      clerum.rpc.loadSessionMessages.mockImplementation(
        () => new Promise(resolve => (resolveLoad = resolve))
      )
      const { result } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // The live subscription has fired for the `failed` state, but the reconcile
      // is still pending → no message may be painted as an error (no flash).
      const midProgress = result.current.progressByAgentMessage['agent-x'] ?? {}
      expect(Object.values(midProgress).some(p => p.status === 'error')).toBe(false)

      // Let the reconcile complete with the durable reply.
      await act(async () => {
        resolveLoad({
          agent: 'agent-x',
          chatId: 'c',
          state: 'idle',
          turns: [
            {
              number: 1,
              user_input: 'hola',
              response: 'done',
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
            },
          ],
        })
        await Promise.resolve()
      })
      await waitFor(() => expect(clerum.chat.replaceMessages).toHaveBeenCalled())
      await sendPromise
    })

    it('SR-6 renders the durable reply after a rejoin whose stream also dies (no zombie block)', async () => {
      // Repro of bug-report Problema 2 through the `onTrackerTerminal` path: the
      // first stream loss reconciles to a STILL-running task → rejoin (re-adds a
      // tracker entry + re-subscribes). That rejoined stream also dies, but by
      // then the server has completed and persisted the durable reply. The reply
      // must render — a residual (zombie) tracker entry must not block the replace.
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // Cache after send = the user message persisted with its task_id (1 msg).
      clerum.chat.loadMessages.mockResolvedValue([
        { id: 'turn-1-user', role: 'user', content: 'q1', timestamp: 1 },
      ])
      // First reconcile: task still processing → rejoin.
      clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
        agent: 'agent-x',
        chatId: 'c',
        state: 'processing',
        activeTaskId: 'task-abc',
        turns: [{ number: 1, user_input: 'q1', started_at: new Date().toISOString() }],
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('q1').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))

      // First stream loss → reconcile → rejoin (re-subscribes the SSE).
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })
      await waitFor(() =>
        expect(
          clerum.rpc.subscribeTaskProgress.mock.calls.filter((c: unknown[]) => c[1] === 'task-abc')
        ).toHaveLength(2)
      )
      expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()

      // Second reconcile (rejoined stream also dies): server now idle + completed.
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        state: 'idle',
        turns: [
          {
            number: 1,
            user_input: 'q1',
            response: 'here is your report',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        ],
      })
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // The durable reply lands as a delta; no error/resend and no zombie block.
      await waitFor(() => expect(clerum.chat.appendMessages).toHaveBeenCalled())
      expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      expect(result.current.failedAgentSend).toBeNull()
      await sendPromise
    })

    it('SR-7 renders the durable failed task result (budget deny) on stream loss with no session turn', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // A pre-executor budget deny writes a durable PER-TASK result (with an
      // error) but NEVER a session TURN (turns are written by the executor,
      // which never runs on a deny). So the reconcile sees an idle session with
      // no new turns — pre-fix that fell through to the scary "Resend" UX.
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        turns: [],
        state: 'idle',
      })
      // mcp-host ALWAYS stores `status:'completed'` for a durable result (even a
      // failure); the deny is signalled solely by the `error` field.
      clerum.rpc.getTaskResult.mockResolvedValue({
        success: false,
        status: 'completed',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: 'Token budget exceeded for this workspace.',
          provider: 'anthropic',
        },
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // The durable error is rendered as a failed assistant message. Wait for the
      // ASSISTANT append specifically: `appendMessages` fires first for the user
      // message, so a bare "was called" wait would race the recovery's append
      // (which lands after the `getTaskResult` await) — read the last call only
      // once its message is the error bubble.
      await waitFor(() => {
        const last = clerum.chat.appendMessages.mock.calls.at(-1)?.[2]?.[0] as
          | { isError?: boolean }
          | undefined
        expect(last?.isError).toBe(true)
      })
      const appended = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
        | Array<{ isError?: boolean; errorCode?: string; content?: string }>
        | undefined
      expect(appended?.[0]?.isError).toBe(true)
      expect(appended?.[0]?.errorCode).toBe('BUDGET_EXCEEDED')
      expect(appended?.[0]?.content).toContain('Token budget exceeded')
      expect(spies.pushToast).toHaveBeenCalledWith(
        'Message to agent-x failed: Token budget exceeded for this workspace.',
        'error'
      )
      // … and the session is idle/recoverable — NOT the "Lost connection" resend UX.
      expect(result.current.failedAgentSend).toBeNull()
      expect(result.current.agentError).toBeNull()
      // The session must settle back to idle (no residual "processing" spinner) —
      // the recovery path always calls setIdle, not just the fallback path.
      expect(
        Object.values(result.current.sessionStateByChatKey).some(s => s.state === 'processing')
      ).toBe(false)
      await sendPromise
    })

    it('SR-8 renders a durable success reply with no session turn on stream loss', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      // Idle session, no new turns …
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        agent: 'agent-x',
        chatId: 'c',
        turns: [],
        state: 'idle',
      })
      // … but a durable per-task result carries the reply the stream never
      // delivered (mcp-host stores `status:'completed'` for every durable result).
      clerum.rpc.getTaskResult.mockResolvedValue({
        success: true,
        status: 'completed',
        response: 'here is your report',
      })
      const { result, spies } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'open',
          taskId: 'task-abc',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('task-abc', {
          type: 'error',
          message: 'Progress stream disconnected',
        })
      })

      // Wait for the ASSISTANT append specifically (the user-message append fires
      // first; the recovery's reply lands after the `getTaskResult` await).
      await waitFor(() => {
        const last = clerum.chat.appendMessages.mock.calls.at(-1)?.[2]?.[0] as
          | { role?: string }
          | undefined
        expect(last?.role).toBe('assistant')
      })
      const appended = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
        | Array<{ role?: string; content?: string; isError?: boolean }>
        | undefined
      expect(appended?.[0]?.role).toBe('assistant')
      expect(appended?.[0]?.content).toBe('here is your report')
      expect(appended?.[0]?.isError).toBeUndefined()
      expect(result.current.failedAgentSend).toBeNull()
      expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'error')
      await sendPromise
    })
  })

  describe('activity stream (GAP-1)', () => {
    it('drives message activity status: open→streaming, activity event, error', async () => {
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-abc' })
      const { result } = renderController()
      await settleMount()

      const sendPromise = result.current.handleSendAgentMessage('hola').catch(() => undefined)
      await waitFor(() => expect(clerum.hasActivityHandler('agent-x')).toBe(true))

      // Read via the production-consumed selected-agent slice (`activityByMessageId`)
      // instead of the removed cross-agent `activityByAgentMessage` map (B18 dead
      // contract). For selectedAgent 'agent-x' the two hold identical entries.
      const currentEntry = () => Object.values(result.current.activityByMessageId ?? {})[0]

      // open → in-flight message transitions to 'streaming'
      await act(async () => {
        clerum.emitActivity('agent-x', {
          type: 'open',
          hostRef: 'agent-x',
          observedAt: '2026-05-28T10:00:00Z',
        })
      })
      expect(currentEntry()?.status).toBe('streaming')

      // activity event is appended to the message's event list
      await waitFor(() => expect(clerum.hasProgressHandler('task-abc')).toBe(true))
      await act(async () => {
        clerum.emitActivity('agent-x', {
          type: 'activity',
          activity: {
            version: '1.0',
            eventId: 'evt-1',
            hostRef: 'agent-x',
            ts: '2026-05-28T10:00:01Z',
            taskId: 'task-abc',
            type: 'tool.start',
            title: 'Running a tool',
            severity: 'info',
            meta: {},
            redactions: [],
          },
        })
      })
      expect(currentEntry()?.events.length).toBeGreaterThan(0)

      // error event flips status to 'error'
      await act(async () => {
        clerum.emitActivity('agent-x', { type: 'error', message: 'stream boom' })
      })
      expect(currentEntry()?.status).toBe('error')

      // Clean up the in-flight task.
      await act(async () => {
        clerum.emitTaskProgress('task-abc', {
          type: 'terminal',
          data: { taskId: 'task-abc', status: 'cancelled', reason: 'cleanup' },
        })
      })
      await sendPromise
    })
  })

  /**
   * Dev-behavior characterization (added for the D.3 re-application).
   *
   * The dev refactor (commit bd8ecec1 / post-merge) added `latestChatSessions`
   * (the cross-agent sidebar list), eager user-message persistence and
   * auto-title — all INSIDE the functions D.3 reweaves. The original D.0 suite
   * (feature-base) did not cover them, so they could be silently dropped during
   * the option-1 reweave (base 506cf826 + re-apply dev deltas). These tests pin
   * them so a dropped dev behavior fails loudly. They must keep passing AFTER
   * the D.3 reweave (the behaviors survive; only the lifecycle plumbing moves).
   */
  describe('dev behaviors (must survive the D.3 reweave)', () => {
    it('defers cross-agent menu sessions until the first screen has painted', async () => {
      const { rerender } = renderController({
        selectedAgent: null,
        loadMenuData: false,
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(clerum.chat.getIndex).not.toHaveBeenCalled()
      expect(clerum.rpc.listSessions).not.toHaveBeenCalled()

      rerender({ selectedAgent: null, loadMenuData: true })

      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    })

    it('GAP-D populates latestChatSessions from chat.getIndex on mount', async () => {
      clerum.chat.getIndex.mockResolvedValue({
        version: 1,
        lastActiveChatId: null,
        onboardingDismissed: false,
        chats: [
          {
            id: 'c1',
            title: 'Chat 1',
            createdAt: '2026-05-01T00:00:00Z',
            updatedAt: '2026-05-01T00:00:00Z',
            messageCount: 2,
          },
        ],
      })
      const { result } = renderController()
      await waitFor(() => expect(result.current.latestChatSessions.length).toBeGreaterThan(0))
      const entry = result.current.latestChatSessions.find(e => e.id === 'c1')
      expect(entry?.agentRef).toBe('agent-x')
    })

    it('renders local sessions without waiting for remote listSessions', async () => {
      clerum.chat.getIndex.mockResolvedValue({
        version: 1,
        lastActiveChatId: null,
        onboardingDismissed: false,
        chats: [
          {
            id: 'local-chat',
            title: 'Local chat',
            createdAt: '2026-05-01T00:00:00Z',
            updatedAt: '2026-05-01T00:00:00Z',
            messageCount: 2,
          },
        ],
      })
      clerum.rpc.listSessions.mockImplementation(() => new Promise(() => undefined))

      const { result } = renderController()

      await waitFor(() =>
        expect(result.current.chatList.some(chat => chat.id === 'local-chat')).toBe(true)
      )
      expect(result.current.chatListLoading).toBe(false)

      await waitFor(() =>
        expect(result.current.latestChatSessions.some(chat => chat.id === 'local-chat')).toBe(true)
      )
      expect(result.current.latestChatSessionsLoading).toBe(false)
    })

    it('GAP-A persists the outgoing user message to the chat store on send', async () => {
      // Eager user-message persistence (dev) → D.3 must keep persisting it
      // (post-D.3 it carries task_id; here we only pin that it IS persisted).
      clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-ga' })
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'ok' })
      const { result } = renderController()
      await settleMount()

      const sendPromise = act(async () => {
        await result.current.handleSendAgentMessage('persist me')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('task-ga')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('task-ga', { type: 'open', taskId: 'task-ga', hostRef: 'agent-x' })
        clerum.emitTaskProgress('task-ga', {
          type: 'terminal',
          data: { taskId: 'task-ga', status: 'completed' },
        })
      })
      await sendPromise

      // The user message was persisted (a chat was auto-created and the typed
      // input written to it) — the input is durable across reload.
      expect(clerum.chat.create).toHaveBeenCalled()
      expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'persist me' })])
      )
    })
  })
})
