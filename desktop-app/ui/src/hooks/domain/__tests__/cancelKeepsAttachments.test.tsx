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

function keptToastCall(
  spies: ReturnType<typeof renderController>['spies']
): [string, unknown, { action?: ToastMessageAction } | undefined] | undefined {
  return spies.pushToast.mock.calls.find(([message]) =>
    String(message).startsWith('Attachments kept')
  ) as ReturnType<typeof keptToastCall>
}

function keptToastAction(
  spies: ReturnType<typeof renderController>['spies']
): ToastMessageAction | undefined {
  return keptToastCall(spies)?.[2]?.action
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

  it('reports images the composer cap drops instead of claiming all were kept (L2)', async () => {
    const sent = [0, 1, 2].map(index => ({
      ...image,
      id: `sent-${index}`,
      name: `sent-${index}.png`,
      dataBase64: `c2VudC0-${index}`,
      previewDataUrl: `data:image/png;base64,c2VudC0-${index}`,
    }))
    const rendered = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await loadHostModels(modelTransport, 'agent-x', null)
    })
    act(() => rendered.result.current.handleAddComposerImageAttachments(sent))
    await sendAsync(rendered.result, 'task-cap')

    // While the task runs, the user fills the composer to the 20-image cap.
    const filler = Array.from({ length: 19 }, (_, index) => ({
      ...image,
      id: `filler-${index}`,
      name: `filler-${index}.png`,
      dataBase64: `ZmlsbGVy-${index}`,
      previewDataUrl: `data:image/png;base64,ZmlsbGVy-${index}`,
    }))
    act(() => rendered.result.current.handleAddComposerImageAttachments(filler))
    expect(rendered.result.current.composerImageAttachments).toHaveLength(19)

    await act(async () => {
      await rendered.result.current.cancelTask('task-cap')
    })

    // 19 held + 1 free slot: only 1 of the 3 canceled images returns, and the
    // toast must say so instead of a plain "Attachments kept".
    expect(rendered.result.current.composerImageAttachments).toHaveLength(20)
    const call = keptToastCall(rendered.spies)
    expect(call?.[0]).toBe(
      'Attachments kept — 2 of 3 images exceed the 20-image limit and were dropped.'
    )
    expect(call?.[1]).toBe('info')
    expect(call?.[2]?.action?.label).toBe('Discard all')
  })

  it('never clears another agent composer from a stale Discard all toast (L3)', async () => {
    const { result, spies, rerender } = await mountedControllerWithAttachments()
    await sendAsync(result, 'task-switch')

    await act(async () => {
      await result.current.cancelTask('task-switch')
    })
    const staleAction = keptToastAction(spies)
    expect(staleAction?.label).toBe('Discard all')

    // The toast outlives an agent switch; the new agent's composer holds its
    // own fresh attachment that the stale action must not destroy.
    rerender({ selectedAgent: 'agent-y', agentNames: ['agent-x', 'agent-y'] })
    const otherAgentImage = {
      ...image,
      id: 'agent-y-image',
      dataBase64: 'YWdlbnQteQ',
      previewDataUrl: 'data:image/png;base64,YWdlbnQteQ',
    }
    act(() => result.current.handleAddComposerImageAttachments([otherAgentImage]))
    expect(result.current.composerImageAttachments).toHaveLength(1)

    act(() => staleAction?.onAction())

    expect(result.current.composerImageAttachments).toHaveLength(1)
    expect(result.current.composerImageAttachments[0]).toMatchObject({ id: 'agent-y-image' })
  })

  it('does not restore attachments into another agent composer when the cancel answer lands late (L3)', async () => {
    // The cancel RPC straddles an agent switch: its answer must not drop the
    // canceled agent's attachments into the NEW agent's composer.
    let resolveCancel!: () => void
    clerum.rpc.cancelTask.mockReturnValue(
      new Promise<void>(resolve => {
        resolveCancel = resolve
      })
    )
    const rendered = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await loadHostModels(modelTransport, 'agent-x', null)
    })
    act(() => rendered.result.current.handleAddComposerImageAttachments([image]))
    act(() => rendered.result.current.handleAddComposerReferenceAttachments([pluginReference]))
    await sendAsync(rendered.result, 'task-slow')

    let cancelDone!: Promise<void>
    act(() => {
      cancelDone = rendered.result.current.cancelTask('task-slow')
    })
    // Switch agents while the RPC is still in flight.
    rendered.rerender({ selectedAgent: 'agent-y', agentNames: ['agent-x', 'agent-y'] })

    await act(async () => {
      resolveCancel()
      await cancelDone
    })

    expect(rendered.result.current.composerImageAttachments).toHaveLength(0)
    expect(rendered.result.current.composerReferenceAttachments).toHaveLength(0)
    expect(keptToastCall(rendered.spies)).toBeUndefined()
  })

  it.each([
    ['success answer', 'resolve'],
    ['404 answer', '404'],
  ])(
    'does not restore into another chat of the same agent when the cancel %s lands late (R1-H1)',
    async (_name, mode) => {
      let settleCancel!: (value?: void) => void
      clerum.rpc.cancelTask.mockReturnValue(
        new Promise<void>(resolve => {
          settleCancel = resolve
        })
      )
      if (mode === '404')
        clerum.rpc.cancelTask.mockReturnValue(
          new Promise((_resolve, reject) => {
            settleCancel = () => reject(new Error('404 Not Found'))
          })
        )
      const rendered = renderController()
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
      await act(async () => {
        await loadHostModels(modelTransport, 'agent-x', null)
      })
      act(() => rendered.result.current.handleAddComposerImageAttachments([image]))
      act(() => rendered.result.current.handleAddComposerReferenceAttachments([pluginReference]))
      await sendAsync(rendered.result, 'task-chat-sw')
      const originChat = rendered.result.current.activeChatId

      let cancelDone!: Promise<void>
      act(() => {
        cancelDone = rendered.result.current.cancelTask('task-chat-sw')
      })
      // SAME agent, DIFFERENT chat while the RPC is in flight.
      await act(async () => {
        await rendered.result.current.switchToChat('agent-x', 'another-chat')
      })
      expect(rendered.result.current.activeChatId).toBe('another-chat')

      await act(async () => {
        settleCancel()
        await cancelDone.catch(() => undefined)
      })

      // Nothing landed in the other chat's composer, and no kept-toast fired.
      expect(rendered.result.current.composerImageAttachments).toHaveLength(0)
      expect(rendered.result.current.composerReferenceAttachments).toHaveLength(0)
      expect(keptToastCall(rendered.spies)).toBeUndefined()
      // The origin chat's composer surface is the same per-agent state: empty.
      await act(async () => {
        await rendered.result.current.switchToChat('agent-x', originChat!)
      })
      expect(rendered.result.current.composerImageAttachments).toHaveLength(0)
    }
  )

  it('stale Discard all no-ops after a same-agent chat switch (R1-H1)', async () => {
    const { result, spies } = await mountedControllerWithAttachments()
    await sendAsync(result, 'task-stale-chat')

    await act(async () => {
      await result.current.cancelTask('task-stale-chat')
    })
    const staleAction = keptToastAction(spies)
    expect(staleAction?.label).toBe('Discard all')
    expect(result.current.composerImageAttachments).toHaveLength(1)

    // Same agent, different chat: the kept attachments ride along (per-agent
    // state), but the toast is bound to the chat it came from.
    await act(async () => {
      await result.current.switchToChat('agent-x', 'another-chat')
    })
    act(() => staleAction?.onAction())

    expect(result.current.composerImageAttachments).toHaveLength(1)
  })

  it('reports drops from the live composer state, not the render closure at cancel time (R1-M4)', async () => {
    // The composer fills to 19 WHILE the cancel RPC is in flight — after the
    // executing closure was captured. The toast must report drops against the
    // state the merge actually reconciled with, not the stale empty snapshot.
    let resolveCancel!: () => void
    clerum.rpc.cancelTask.mockReturnValue(
      new Promise<void>(resolve => {
        resolveCancel = resolve
      })
    )
    const sent = [0, 1, 2].map(index => ({
      ...image,
      id: `sent-${index}`,
      name: `sent-${index}.png`,
      dataBase64: `c2VudC0-${index}`,
      previewDataUrl: `data:image/png;base64,c2VudC0-${index}`,
    }))
    const rendered = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await loadHostModels(modelTransport, 'agent-x', null)
    })
    act(() => rendered.result.current.handleAddComposerImageAttachments(sent))
    await sendAsync(rendered.result, 'task-race')

    let cancelDone!: Promise<void>
    act(() => {
      cancelDone = rendered.result.current.cancelTask('task-race')
    })
    // 19 fresh images land in the composer while the RPC is pending.
    const filler = Array.from({ length: 19 }, (_, index) => ({
      ...image,
      id: `filler-${index}`,
      name: `filler-${index}.png`,
      dataBase64: `ZmlsbGVy-${index}`,
      previewDataUrl: `data:image/png;base64,ZmlsbGVy-${index}`,
    }))
    act(() => rendered.result.current.handleAddComposerImageAttachments(filler))
    expect(rendered.result.current.composerImageAttachments).toHaveLength(19)

    await act(async () => {
      resolveCancel()
      await cancelDone
    })

    expect(rendered.result.current.composerImageAttachments).toHaveLength(20)
    const call = keptToastCall(rendered.spies)
    expect(call?.[0]).toBe(
      'Attachments kept — 2 of 3 images exceed the 20-image limit and were dropped.'
    )
  })
})
