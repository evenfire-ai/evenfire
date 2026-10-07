// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const freshImage: ComposerImageAttachment = {
  id: 'fresh-composer-image',
  name: 'fresh.png',
  mimeType: 'image/png',
  dataBase64: 'bmV3',
  sizeBytes: 3,
  previewDataUrl: 'data:image/png;base64,bmV3',
}

beforeEach(() => {
  uuidCounter = 0
  resetComposerDraftStore()
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetComposerDraftStore()
  uninstallMockClerum()
})

describe('composer ownership during retry and auth changes', () => {
  it('preserves fresh text and images while retrying an older failed send', async () => {
    clerum.rpc.invokeHostMessage
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValue({ response: 'retry succeeded' })
    const controller = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    act(() => setComposerDraft(null, 'failed payload', 'agent-x'))

    await act(async () => {
      await controller.result.current.handleSendAgentMessage('failed payload')
    })
    expect(controller.result.current.failedAgentSend?.content).toBe('failed payload')

    const chatId = controller.result.current.activeChatId!
    act(() => setComposerDraft(chatId, 'fresh draft', 'agent-x'))
    act(() => controller.result.current.handleAddComposerImageAttachments([freshImage]))
    expect(controller.result.current.composerImageAttachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: freshImage.id })])
    )

    await act(async () => {
      await controller.result.current.handleRetryFailedAgentSend()
    })

    expect(getComposerDraft(chatId, 'agent-x')).toBe('fresh draft')
    expect(controller.result.current.composerImageAttachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: freshImage.id })])
    )
    expect(controller.result.current.failedAgentSend).toBeNull()
    controller.unmount()
  })

  it('keeps the origin draft when Host authorization becomes uncertain before cleanup', async () => {
    await clerum.chat.create('agent-x', 'scope-chat')
    const controller = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await controller.result.current.switchToChat('agent-x', 'scope-chat')
    })
    act(() => setComposerDraft('scope-chat', 'scope-owned draft', 'agent-x'))

    const upsertMessages = clerum.chat.upsertMessages.getMockImplementation()
    if (!upsertMessages) throw new Error('Expected the real ChatStore upsertMessages producer')
    const enteredUpsert = deferred<void>()
    const releaseUpsert = deferred<void>()
    clerum.chat.upsertMessages.mockImplementation(async (...args) => {
      enteredUpsert.resolve()
      await releaseUpsert.promise
      return upsertMessages(...args)
    })

    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = controller.result.current.handleSendAgentMessage('scope-owned draft')
    })
    try {
      await enteredUpsert.promise
      controller.hostAuthority.hold('agent-x', 'uncertain')
      expect(controller.hostAuthority.isBlocked('agent-x')).toBe(true)
      await act(async () => {
        releaseUpsert.resolve()
        await sendPromise
      })

      expect(getComposerDraft('scope-chat', 'agent-x')).toBe('scope-owned draft')
    } finally {
      releaseUpsert.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      controller.unmount()
    }
  })
})
