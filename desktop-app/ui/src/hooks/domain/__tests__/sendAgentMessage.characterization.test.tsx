// @vitest-environment jsdom
/**
 * Characterization tests for `sendAgentMessage` paths that the existing suites
 * (D.0 / SR-*) did not cover: the synchronous (non-async) response branch, the
 * POST-error branch (banner + failedAgentSend + late user-message persist +
 * retry), and the send-time auto-title (B10 fix).
 *
 * Pinned against the PUBLIC hook API via the shared harness so they survive the
 * refactor. See .specs/refactor-useAgentChatController/plan.md Fase 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
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

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

describe('sendAgentMessage — synchronous (non-async) response', () => {
  it('appends a direct reply, persists the user message, and never opens a stream', async () => {
    // No taskId in the response → the synchronous branch (a direct reply).
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'direct answer' })
    const { result, spies } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('quick question')
    })

    // No async task → no progress subscription was ever opened.
    expect(clerum.rpc.subscribeTaskProgress).not.toHaveBeenCalled()
    // user message + assistant reply persisted.
    expect(clerum.chat.appendMessages).toHaveBeenCalledTimes(2)
    const assistant = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
      | Array<{ role?: string; content?: string; isError?: boolean }>
      | undefined
    expect(assistant?.[0]?.role).toBe('assistant')
    expect(assistant?.[0]?.content).toBe('direct answer')
    expect(assistant?.[0]?.isError).toBeUndefined()
    expect(spies.pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
  })

  it('renders a structured synchronous error as an isError assistant message', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({
      error: { message: 'bad request', code: 'invalid_input', provider: 'anthropic' },
    })
    const { result, spies } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('do the thing')
    })

    const assistant = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
      | Array<{ role?: string; content?: string; isError?: boolean; errorCode?: string }>
      | undefined
    expect(assistant?.[0]?.isError).toBe(true)
    expect(assistant?.[0]?.errorCode).toBe('invalid_input')
    expect(assistant?.[0]?.content).toBe('bad request')
    expect(spies.pushToast).toHaveBeenCalledWith('Message to agent-x failed: bad request', 'error')
  })
})

describe('sendAgentMessage — POST failure', () => {
  it('surfaces the banner + failedAgentSend and persists the user input late', async () => {
    clerum.rpc.invokeHostMessage.mockRejectedValue(new Error('network down'))
    const { result, spies } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('please summarize')
    })

    expect(result.current.agentError).toBeTruthy()
    expect(result.current.failedAgentSend?.content).toBe('please summarize')
    expect(result.current.failedAgentSend?.kind).toBe('network')
    // Late persist: the POST threw before the single post-taskId persist, so the
    // user's typed input is still written to the store (best-effort durability).
    expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
      'agent-x',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'please summarize' }),
      ])
    )
    expect(spies.pushToast).toHaveBeenCalledWith(expect.stringContaining('Message failed'), 'error')
    // Fire-and-forget guard released.
    expect(result.current.agentSending).toBe(false)
  })

  it('handleRetryFailedAgentSend re-sends the failed payload once it recovers', async () => {
    clerum.rpc.invokeHostMessage.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('retry me')
    })
    expect(result.current.failedAgentSend?.content).toBe('retry me')

    // The retry succeeds with an async task.
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-retry' })
    const retryPromise = result.current.handleRetryFailedAgentSend().catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-retry')).toBe(true))

    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
    const secondReq = clerum.rpc.invokeHostMessage.mock.calls[1]?.[1] as { content?: string }
    expect(secondReq?.content).toContain('retry me')

    await act(async () => {
      clerum.emitTaskProgress('task-retry', {
        type: 'terminal',
        data: { taskId: 'task-retry', status: 'cancelled', reason: 'cleanup' },
      })
    })
    await retryPromise
  })
})

describe('sendAgentMessage — auto-title on send (B10)', () => {
  it('titles a chat auto-created by the send from the first message', async () => {
    // No active chat → the send auto-creates one (title "New Chat"). The closure's
    // chatList predates that chat, so pre-B10 the auto-title silently no-op'd.
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-title' })
    const { result } = renderController()
    await settleMount()
    expect(result.current.activeChatId).toBeNull()

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('summarize the quarterly report')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-title')).toBe(true))
    await act(async () => {
      clerum.emitTaskProgress('task-title', {
        type: 'terminal',
        data: { taskId: 'task-title', status: 'cancelled', reason: 'cleanup' },
      })
    })
    await sendPromise

    const createdChatId = result.current.activeChatId!
    await waitFor(() =>
      expect(clerum.chat.rename).toHaveBeenCalledWith(
        'agent-x',
        createdChatId,
        'summarize the quarterly report'
      )
    )
  })
})
