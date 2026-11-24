// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { COMPOSER_MAX_NON_IMAGE_BODY_BYTES } from '@constants/attachments'
import { composerNonImageShareBytes } from '@lib/composerFileAdmission'
import { composerRequestBaseContent } from '@lib/composerHostRequest'
import { buildComposerLocationReferences } from '@lib/composerLocationReferences'
import { buildComposerRequestContent } from '@lib/composerReferencesPrompt'
import {
  fileView,
  folderView,
  pickedReferences,
  suggestedFolderCandidate,
} from '../../__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import {
  mergeComposerReferenceAttachments,
  useComposerAttachments,
} from '../useComposerAttachments'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderComposer() {
  const clearSendError = vi.fn()
  const hook = renderHook(() =>
    useComposerAttachments({ selectedAgent: 'agent-1', clearSendError })
  )
  return { hook, clearSendError }
}

async function tenPickedFiles() {
  const views = await Promise.all(
    Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => fileView(10 + index))
  )
  return pickedReferences(hookMock.useGfsBrowserController, views)
}

describe('useComposerAttachments — addSuggestedLocationReference', () => {
  it('adds the suggested folder, ordered after what is attached, and moves the revision', async () => {
    const [notes] = await pickedReferences(hookMock.useGfsBrowserController, [await fileView(1)])
    const candidate = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const { hook, clearSendError } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments([notes!]))
    clearSendError.mockClear()
    const revision = hook.result.current.composerAttachmentRevisionRef.current

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedLocationReference(candidate)
    })

    expect(outcome).toBe('added')
    const references = hook.result.current.composerReferenceAttachments
    expect(references.map(reference => reference.label)).toEqual([notes!.label, 'Reports'])
    expect(references[1]).toEqual({ ...candidate, addedOrder: references[1]!.addedOrder })
    expect(references[1]!.addedOrder).toBeGreaterThan(references[0]!.addedOrder!)
    expect(hook.result.current.composerAttachmentRevisionRef.current).toBe(revision + 1)
    expect(clearSendError).not.toHaveBeenCalled()
  })

  it('reports a duplicate for the same folder, even in the same tick', async () => {
    const candidate = await suggestedFolderCandidate(await folderView(2, 'Reports'))
    const { hook } = renderComposer()
    const outcomes: string[] = []
    act(() => {
      outcomes.push(hook.result.current.addSuggestedLocationReference(candidate))
      outcomes.push(hook.result.current.addSuggestedLocationReference(candidate))
    })
    expect(outcomes).toEqual(['added', 'duplicate'])
    expect(hook.result.current.composerReferenceAttachments).toEqual([
      { ...candidate, addedOrder: expect.any(Number) },
    ])
  })

  it('reports full when another folder is attached and keeps that one', async () => {
    const first = await suggestedFolderCandidate(await folderView(3, 'Reports'))
    const second = await suggestedFolderCandidate(await folderView(4, 'Invoices'))
    const { hook } = renderComposer()
    act(() => {
      hook.result.current.addSuggestedLocationReference(first)
    })
    const before = hook.result.current.composerReferenceAttachments
    const revision = hook.result.current.composerAttachmentRevisionRef.current

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedLocationReference(second)
    })

    expect(outcome).toBe('full')
    expect(hook.result.current.composerReferenceAttachments).toBe(before)
    expect(hook.result.current.composerAttachmentRevisionRef.current).toBe(revision)
  })

  it('adds a folder next to ten files: the file cap does not count it', async () => {
    const picked = await tenPickedFiles()
    const candidate = await suggestedFolderCandidate(await folderView(5, 'Reports'))
    const { hook } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments(picked))

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedLocationReference(candidate)
    })

    expect(outcome).toBe('added')
    expect(hook.result.current.composerReferenceAttachments.map(reference => reference.id)).toEqual(
      [...picked.map(reference => reference.id), candidate.id]
    )
  })
})

describe('mergeComposerReferenceAttachments — folders', () => {
  it('S-F9: restores ten files and a folder together', async () => {
    const picked = await tenPickedFiles()
    const folder = await suggestedFolderCandidate(await folderView(6, 'Reports'))
    const outcome = mergeComposerReferenceAttachments([], [...picked, folder])
    expect(outcome.next.map(reference => reference.id)).toEqual([
      ...picked.map(reference => reference.id),
      folder.id,
    ])
    expect(outcome).toMatchObject({ kept: 11, duplicates: 0, dropped: 0, droppedFolders: 0 })
  })

  it('S-F9: a folder listed before ten files takes none of their slots', async () => {
    const picked = await tenPickedFiles()
    const folder = await suggestedFolderCandidate(await folderView(10, 'Reports'))
    const outcome = mergeComposerReferenceAttachments([], [folder, ...picked])
    expect(outcome.next.map(reference => reference.id)).toEqual([
      folder.id,
      ...picked.map(reference => reference.id),
    ])
    expect(outcome).toMatchObject({ kept: 11, dropped: 0, droppedFolders: 0 })
  })

  it('S-F9: a folder restored over another folder is dropped and counted apart', async () => {
    const held = await suggestedFolderCandidate(await folderView(7, 'Invoices'))
    const restored = await suggestedFolderCandidate(await folderView(8, 'Reports'))
    const [file] = await pickedReferences(hookMock.useGfsBrowserController, [await fileView(1)])
    const outcome = mergeComposerReferenceAttachments([held], [restored, file!])
    expect(outcome.next.map(reference => reference.id)).toEqual([held.id, file!.id])
    expect(outcome).toMatchObject({ kept: 1, dropped: 1, droppedFolders: 1 })
  })

  it('still drops files past the file cap, with a folder held', async () => {
    const picked = await tenPickedFiles()
    const folder = await suggestedFolderCandidate(await folderView(9, 'Reports'))
    const [extra] = await pickedReferences(hookMock.useGfsBrowserController, [await fileView(99)])
    const outcome = mergeComposerReferenceAttachments([folder, ...picked], [extra!])
    expect(outcome.next).toHaveLength(11)
    expect(outcome).toMatchObject({ kept: 0, dropped: 1, droppedFolders: 0 })
  })
})

describe('useComposerAttachments — a folder in the attach-time budget', () => {
  it('refuses a file that only fits without the structured folder', async () => {
    const folder = await suggestedFolderCandidate(await folderView(11, 'Reports'))
    const references = [folder]
    const file = new File(['a'], 'a.txt', { type: 'text/plain' })
    const folderJsonBytes = new TextEncoder().encode(
      JSON.stringify(buildComposerLocationReferences(references))
    ).length
    const shareWithout = (draft: string) =>
      composerNonImageShareBytes({
        content: buildComposerRequestContent(composerRequestBaseContent(draft, 0, 1), references),
        fileReferences: [],
        locationReferences: [],
        hostRef: 'agent-1',
        files: [{ filename: 'a.txt' }],
        images: [],
      })
    const length = COMPOSER_MAX_NON_IMAGE_BODY_BYTES - shareWithout('x') - folderJsonBytes + 2
    expect(shareWithout('x'.repeat(length))).toBeLessThanOrEqual(COMPOSER_MAX_NON_IMAGE_BODY_BYTES)
    const { hook } = renderComposer()
    act(() => {
      hook.result.current.addSuggestedLocationReference(folder)
    })
    act(() => hook.result.current.handleAddComposerFiles([file], 'x'.repeat(length)))
    expect(hook.result.current.composerFileAttachments).toEqual([])
    expect(hook.result.current.composerFileRefusals.map(refusal => refusal.text)).toEqual([
      expect.stringContaining('a.txt does not fit: the text and attachment details'),
    ])
  })

  it('refuses every file while the composer holds two folders', async () => {
    const first = await suggestedFolderCandidate(await folderView(12, 'Reports'))
    const second = await suggestedFolderCandidate(await folderView(13, 'Invoices'))
    const { hook } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments([first, second]))
    act(() =>
      hook.result.current.handleAddComposerFiles([new File(['a'], 'a.txt')], 'Summarize it')
    )
    expect(hook.result.current.composerFileAttachments).toEqual([])
    expect(hook.result.current.composerFileRefusals.map(refusal => refusal.text)).toEqual([
      'Only one folder per message.',
    ])
  })
})
