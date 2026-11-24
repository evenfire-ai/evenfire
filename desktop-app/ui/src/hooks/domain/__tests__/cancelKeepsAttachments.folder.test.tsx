// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { LOCATION_REFERENCE_LIMIT_REASON } from '@constants/tabReferenceSuggestion'
import { loadHostModels, resetHostModelSelectionStore } from '@lib/hostModelSelectionStore'
import type { HostModelsResult } from '../../../../../src/types'
import {
  fileView,
  folderView,
  pickedReferences,
  resentReference,
  suggestedFolderCandidate,
} from '../../__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum
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

beforeEach(() => {
  clerum = installMockClerum()
  Object.assign(clerum.rpc, modelTransport)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetHostModelSelectionStore()
  uninstallMockClerum()
})

function keptToast(spies: ReturnType<typeof renderController>['spies']): string | undefined {
  const call = spies.pushToast.mock.calls.find(([message]) =>
    String(message).startsWith('Attachments kept')
  )
  return call ? String(call[0]) : undefined
}

async function mounted() {
  const rendered = renderController()
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  await act(async () => {
    await loadHostModels(modelTransport, 'agent-x', null)
  })
  return rendered
}

async function sendAsync(result: ReturnType<typeof renderController>['result'], taskId: string) {
  clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId })
  const send = act(async () => {
    await result.current.handleSendAgentMessage('cancel me')
  })
  await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true))
  await send
}

describe('cancel keeps a folder reference', () => {
  it('S-F9: puts back ten files and a folder, all of them', async () => {
    const views = await Promise.all(
      Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => fileView(10 + index))
    )
    const files = await pickedReferences(hookMock.useGfsBrowserController, views)
    const folder = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const rendered = await mounted()
    // The folder comes first, so the files are restored after it.
    act(() => {
      rendered.result.current.addSuggestedLocationReference(folder)
    })
    act(() => rendered.result.current.handleAddComposerReferenceAttachments(files))
    await sendAsync(rendered.result, 'task-folder')
    expect(rendered.result.current.composerReferenceAttachments).toEqual([])

    await act(async () => {
      await rendered.result.current.cancelTask('task-folder')
    })

    expect(rendered.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      folder.id,
      ...files.map(item => item.id),
    ])
    expect(keptToast(rendered.spies)).toBe('Attachments kept')
  })

  it('S-F9: a folder that finds another one in the composer is dropped with the folder reason', async () => {
    const [file] = await pickedReferences(hookMock.useGfsBrowserController, [await fileView(1)])
    const sent = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const held = await suggestedFolderCandidate(await folderView(2, 'Invoices'))
    const rendered = await mounted()
    act(() => rendered.result.current.handleAddComposerReferenceAttachments([file!]))
    act(() => {
      rendered.result.current.addSuggestedLocationReference(sent)
    })
    await sendAsync(rendered.result, 'task-two-folders')
    // Another folder is chosen while the task runs.
    act(() => {
      rendered.result.current.addSuggestedLocationReference(held)
    })

    await act(async () => {
      await rendered.result.current.cancelTask('task-two-folders')
    })

    expect(rendered.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      held.id,
      file!.id,
    ])
    const toast = keptToast(rendered.spies)
    expect(toast).toBe(
      `Attachments kept. ${LOCATION_REFERENCE_LIMIT_REASON}: a folder was dropped.`
    )
    expect(toast).not.toContain('file limit')
  })

  it('a resent folder restored over the same folder picked again is not reported as dropped', async () => {
    const folder = await suggestedFolderCandidate(await folderView(3, 'Reports'))
    const resent = resentReference(folder)
    expect(resent.id).not.toBe(folder.id)
    const rendered = await mounted()
    act(() => rendered.result.current.handleAddComposerReferenceAttachments([resent]))
    await sendAsync(rendered.result, 'task-resent-folder')
    // The same folder is offered again by the tab while the task runs.
    act(() => {
      rendered.result.current.addSuggestedLocationReference(folder)
    })

    await act(async () => {
      await rendered.result.current.cancelTask('task-resent-folder')
    })

    expect(rendered.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      folder.id,
    ])
    expect(keptToast(rendered.spies)).toBe('Attachments kept')
  })
})
