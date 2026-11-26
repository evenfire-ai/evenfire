// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import {
  fileView,
  pickedReferences,
  resentReference,
  suggestedCandidate,
} from '../../__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import { useComposerAttachments } from '../useComposerAttachments'

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

describe('useComposerAttachments — addSuggestedFileReference', () => {
  it('adds the suggested file, ordered after what is attached, and moves the attachment revision', async () => {
    const [notes] = await pickedReferences(hookMock.useGfsBrowserController, [await fileView(1)])
    const candidate = await suggestedCandidate(await fileView(2, 'report.md'))
    const { hook, clearSendError } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments([notes!]))
    clearSendError.mockClear()
    const revision = hook.result.current.composerAttachmentRevisionRef.current

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedFileReference(candidate)
    })

    expect(outcome).toBe('added')
    const references = hook.result.current.composerReferenceAttachments
    expect(references.map(reference => reference.label)).toEqual([notes!.label, 'report.md'])
    expect(references[1]).toEqual({ ...candidate, addedOrder: references[1]!.addedOrder })
    expect(references[1]!.addedOrder).toBeGreaterThan(references[0]!.addedOrder!)
    expect(hook.result.current.composerAttachmentRevisionRef.current).toBe(revision + 1)
    expect(clearSendError).not.toHaveBeenCalled()
  })

  it('reports a duplicate when the picker already attached the same file', async () => {
    const view = await fileView(3, 'report.md')
    const [picked] = await pickedReferences(hookMock.useGfsBrowserController, [view])
    const candidate = await suggestedCandidate(view)
    const { hook } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments([picked!]))
    const before = hook.result.current.composerReferenceAttachments
    const revision = hook.result.current.composerAttachmentRevisionRef.current

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedFileReference(candidate)
    })

    expect(outcome).toBe('duplicate')
    expect(hook.result.current.composerReferenceAttachments).toBe(before)
    expect(hook.result.current.composerAttachmentRevisionRef.current).toBe(revision)
  })

  it('reports a duplicate when a resend restored the same file under its own id', async () => {
    const view = await fileView(4, 'report.md')
    const [picked] = await pickedReferences(hookMock.useGfsBrowserController, [view])
    const resent = resentReference(picked!)
    const candidate = await suggestedCandidate(view)
    // The resend names the file by URI, so only the URI can tell it apart.
    expect(resent.id).not.toBe(candidate.id)
    const { hook } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments([resent]))

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedFileReference(candidate)
    })

    expect(outcome).toBe('duplicate')
    expect(hook.result.current.composerReferenceAttachments).toEqual([
      { ...resent, addedOrder: expect.any(Number) },
    ])
  })

  it('reports full at the file cap and leaves the composer as it was', async () => {
    const views = await Promise.all(
      Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => fileView(10 + index))
    )
    const picked = await pickedReferences(hookMock.useGfsBrowserController, views)
    const candidate = await suggestedCandidate(await fileView(99, 'report.md'))
    const { hook } = renderComposer()
    act(() => hook.result.current.handleAddComposerReferenceAttachments(picked))
    expect(hook.result.current.composerReferenceAttachments).toHaveLength(FILE_REFERENCE_MAX_COUNT)
    const revision = hook.result.current.composerAttachmentRevisionRef.current

    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedFileReference(candidate)
    })

    expect(outcome).toBe('full')
    expect(hook.result.current.composerReferenceAttachments.map(reference => reference.id)).toEqual(
      picked.map(reference => reference.id)
    )
    expect(hook.result.current.composerAttachmentRevisionRef.current).toBe(revision)
  })

  it('sees a reference added earlier in the same tick', async () => {
    const candidate = await suggestedCandidate(await fileView(5, 'report.md'))
    const { hook } = renderComposer()
    const outcomes: string[] = []
    act(() => {
      outcomes.push(hook.result.current.addSuggestedFileReference(candidate))
      outcomes.push(hook.result.current.addSuggestedFileReference(candidate))
    })
    expect(outcomes).toEqual(['added', 'duplicate'])
    expect(hook.result.current.composerReferenceAttachments).toHaveLength(1)
  })
})
