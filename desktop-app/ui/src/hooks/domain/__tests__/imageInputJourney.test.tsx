// @vitest-environment jsdom
// Renderer integration: real controller/selection/recovery, fake IPC boundary.
// This is deliberately not evidence for the separately executed Electron E2E.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import {
  loadHostModels,
  resetHostModelSelectionStore,
  selectHostModel,
} from '@lib/hostModelSelectionStore'
import type { HostModelsResult } from '../../../../../src/types'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let bridge: MockClerum
const image: ComposerImageAttachment = {
  id: 'input-image',
  name: 'input.png',
  mimeType: 'image/png',
  dataBase64: 'YWJj',
  sizeBytes: 3,
  previewDataUrl: 'data:image/png;base64,YWJj',
}
// Byte identity is tested here; PNG decoding belongs to the real E2E fixture.
const catalog: HostModelsResult = {
  provider: 'zai',
  hostDefault: 'glm-5.3-flash',
  sessionModel: null,
  degraded: false,
  modelSelectionRevision: 0,
  models: [
    { name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'supported' } },
    { name: 'glm-5.3', imageInput: { state: 'unsupported', reason: 'model_unsupported' } },
  ],
}
const modelTransport = {
  getHostModels: vi.fn(async () => catalog),
  setHostModel: vi.fn(async (_host: string, _chat: string, model: string) => ({
    effective: 'next-task' as const,
    provider: 'zai',
    model,
    modelSelectionRevision: 1,
  })),
}

beforeEach(() => {
  bridge = installMockClerum()
  Object.assign(bridge.rpc, modelTransport)
})
afterEach(() => {
  cleanup()
  resetHostModelSelectionStore()
  resetComposerDraftStore()
  uninstallMockClerum()
  vi.clearAllMocks()
})

async function mountedVisualController() {
  const rendered = renderController()
  await waitFor(() => expect(bridge.chat.getIndex).toHaveBeenCalled())
  await act(async () => {
    await loadHostModels(modelTransport, 'agent-x', null)
  })
  act(() => rendered.result.current.handleAddComposerImageAttachments([image]))
  return rendered
}

describe('#654 visual send and recovery', () => {
  it('blocks pending images after selecting a text-only model, before creating a chat', async () => {
    const { result } = await mountedVisualController()
    await act(async () => {
      await selectHostModel(modelTransport, 'agent-x', null, 'glm-5.3')
    })
    await act(async () => {
      await result.current.handleSendAgentMessage('inspect')
    })
    expect(bridge.chat.create).not.toHaveBeenCalled()
    expect(bridge.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect(result.current.composerImageAttachments).toHaveLength(1)
    expect(result.current.agentError).toContain('not supported')
  })

  it('retains a synchronous error envelope without a success boolean and recovers only on explicit action', async () => {
    let reply!: (value: unknown) => void
    bridge.rpc.invokeHostMessage.mockReturnValue(
      new Promise(resolve => {
        reply = resolve
      })
    )
    const { result, spies } = await mountedVisualController()
    let send!: Promise<void>
    act(() => {
      send = result.current.handleSendAgentMessage('inspect this image')
    })
    await waitFor(() => expect(bridge.rpc.invokeHostMessage).toHaveBeenCalledTimes(1))
    const chat = result.current.activeChatId!
    act(() => setComposerDraft(chat, 'a newer draft'))
    await act(async () => {
      reply({
        error: { code: 'LLM_IMAGE_INPUT_UNKNOWN', message: 'Evidence changed', retryable: false },
      })
      await send
    })
    expect(bridge.rpc.invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({
      model: 'glm-5.3-flash',
      attachments: [{ dataBase64: image.dataBase64 }],
    })
    expect(result.current.failedAgentSend).toMatchObject({
      agentRef: 'agent-x',
      chatId: chat,
      content: 'inspect this image',
    })
    expect(getComposerDraft(chat)).toBe('a newer draft')
    act(() => result.current.handleRecoverFailedAgentSend())
    expect(getComposerDraft(chat)).toBe('a newer draft')
    expect(spies.pushToast).toHaveBeenCalledWith(expect.stringContaining('current draft'), 'error')
    act(() => setComposerDraft(chat, ''))
    act(() => result.current.handleRecoverFailedAgentSend())
    expect(getComposerDraft(chat)).toBe('inspect this image')
    expect(result.current.composerImageAttachments[0]?.dataBase64).toBe(image.dataBase64)
    expect(result.current.failedAgentSend).toBeNull()
    expect(bridge.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps asynchronous failure input with its original chat after the tracker releases it', async () => {
    bridge.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'visual-task' })
    bridge.rpc.getTaskResult.mockResolvedValue({
      status: 'failed',
      error: {
        code: 'LLM_IMAGE_INPUT_UNSUPPORTED',
        message: 'Fallback cannot receive images',
        retryable: false,
      },
    })
    const { result } = await mountedVisualController()
    await act(async () => {
      await result.current.handleSendAgentMessage('inspect')
    })
    const originalChat = result.current.activeChatId!
    await waitFor(() => expect(bridge.hasProgressHandler('visual-task')).toBe(true))
    await act(async () => {
      await result.current.switchToChat('agent-x', 'another-chat')
    })
    await act(async () => {
      bridge.emitTaskProgress('visual-task', {
        type: 'terminal',
        data: { taskId: 'visual-task', status: 'failed' },
      })
    })
    await waitFor(() => expect(bridge.rpc.getTaskResult).toHaveBeenCalled())
    expect(result.current.failedAgentSend).toBeNull()
    expect(getComposerDraft('another-chat')).toBe('')
    await act(async () => {
      await result.current.switchToChat('agent-x', originalChat)
    })
    await waitFor(() =>
      expect(result.current.failedAgentSend?.attachments[0]?.dataBase64).toBe(image.dataBase64)
    )
    act(() => result.current.handleDiscardFailedAgentSend())
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('does not resurrect input when a POST fails after logout/reset', async () => {
    let reject!: (reason: Error) => void
    bridge.rpc.invokeHostMessage.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const { result } = await mountedVisualController()
    let send!: Promise<void>
    act(() => {
      send = result.current.handleSendAgentMessage('private draft for this session')
    })
    await waitFor(() => expect(bridge.rpc.invokeHostMessage).toHaveBeenCalled())
    act(() => result.current.resetChat())
    await act(async () => {
      reject(new Error('offline'))
      await send
    })
    expect(result.current.failedAgentSend).toBeNull()
    expect(result.current.agentError).toBeNull()
    expect(bridge.chat.appendMessages).not.toHaveBeenCalled()
  })
})
