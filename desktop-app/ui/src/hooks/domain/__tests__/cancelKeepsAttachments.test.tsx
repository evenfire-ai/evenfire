// @vitest-environment jsdom
/**
 * STORY-38 — canceling an in-flight task keeps the canceled message's
 * attachments available: they return to the in-memory composer state (never
 * GFS or another persisted store) and an "Attachments kept" toast offers an
 * explicit "Discard all" action. The retained send snapshot itself is still
 * released (a cancel stays terminal for delivery), and a cancel that fails
 * upstream restores nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { loadHostModels, resetHostModelSelectionStore } from '@lib/hostModelSelectionStore'
import type { HostModelsResult } from '../../../../../src/types'
import type {
  ComposerImageAttachment,
  ComposerPluginReference,
  ToastMessageAction,
} from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
const image: ComposerImageAttachment = {
  id: 'input-image',
  name: 'input.png',
  mimeType: 'image/png',
  dataBase64: 'YWJj',
  sizeBytes: 3,
  previewDataUrl: 'data:image/png;base64,YWJj',
}
const pluginReference: ComposerPluginReference = {
  id: 'plugin-ref',
  type: 'plugin',
  namespace: 'ns',
  name: 'helper',
  label: 'helper plugin',
}
const catalog: HostModelsResult = {
  provider: 'zai',
  hostDefault: 'glm-5.3-flash',
  sessionModel: null,
  degraded: false,
  modelSelectionRevision: 0,
  models: [{ name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'supported' } }],
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

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  clerum = installMockClerum()
  Object.assign(clerum.rpc, modelTransport)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetHostModelSelectionStore()
  uninstallMockClerum()
})

function keptToastAction(
  spies: ReturnType<typeof renderController>['spies']
): ToastMessageAction | undefined {
  const call = spies.pushToast.mock.calls.find(([message]) => message === 'Attachments kept')
  return call?.[2]?.action
}

/** Mounts with a capable model catalog, then attaches an image + a reference. */
async function mountedControllerWithAttachments() {
  const rendered = renderController()
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  await act(async () => {
    await loadHostModels(modelTransport, 'agent-x', null)
  })
  act(() => rendered.result.current.handleAddComposerImageAttachments([image]))
  act(() => rendered.result.current.handleAddComposerReferenceAttachments([pluginReference]))
  return rendered
}

/** Sends the pending payload as an async task and waits for its progress handler. */
async function sendAsync(result: ReturnType<typeof renderController>['result'], taskId: string) {
  clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId })
  const send = act(async () => {
    await result.current.handleSendAgentMessage('cancel me')
  })
  await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true))
  await send
}

describe('STORY-38 — attachments survive message cancel', () => {
  it('returns the canceled message attachments to the composer with a Discard all toast', async () => {
    const { result, spies } = await mountedControllerWithAttachments()
    await sendAsync(result, 'task-cancel')
    // The accepted send cleared the composer.
    expect(result.current.composerImageAttachments).toHaveLength(0)
    expect(result.current.composerReferenceAttachments).toHaveLength(0)

    await act(async () => {
      await result.current.cancelTask('task-cancel')
    })

    expect(clerum.rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-cancel')
    expect(result.current.composerImageAttachments[0]).toMatchObject({
      id: image.id,
      dataBase64: image.dataBase64,
      previewDataUrl: 'data:image/png;base64,YWJj',
    })
    expect(result.current.composerReferenceAttachments[0]).toMatchObject({
      id: pluginReference.id,
    })
    const action = keptToastAction(spies)
    expect(action?.label).toBe('Discard all')

    act(() => action?.onAction())
    expect(result.current.composerImageAttachments).toHaveLength(0)
    expect(result.current.composerReferenceAttachments).toHaveLength(0)
  })

  it('restores the attachments when the task is already gone upstream', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('404 Not Found'))
    const { result, spies } = await mountedControllerWithAttachments()
    await sendAsync(result, 'task-gone')

    await act(async () => {
      await result.current.cancelTask('task-gone')
    })

    expect(result.current.composerImageAttachments).toHaveLength(1)
    expect(result.current.composerReferenceAttachments).toHaveLength(1)
    expect(keptToastAction(spies)?.label).toBe('Discard all')
  })

  it('restores nothing and toasts nothing for a text-only canceled message', async () => {
    const rendered = renderController()
    const { result, spies } = rendered
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await sendAsync(result, 'task-text')

    await act(async () => {
      await result.current.cancelTask('task-text')
    })

    expect(result.current.composerImageAttachments).toHaveLength(0)
    expect(result.current.composerReferenceAttachments).toHaveLength(0)
    expect(keptToastAction(spies)).toBeUndefined()
  })

  it('restores nothing when the cancel itself fails upstream', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('500 upstream exploded'))
    const { result, spies } = await mountedControllerWithAttachments()
    await sendAsync(result, 'task-fail')

    await act(async () => {
      await result.current.cancelTask('task-fail')
    })

    expect(result.current.composerImageAttachments).toHaveLength(0)
    expect(result.current.composerReferenceAttachments).toHaveLength(0)
    expect(keptToastAction(spies)).toBeUndefined()
    expect(spies.pushToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to cancel task'),
      'error'
    )
  })
})
