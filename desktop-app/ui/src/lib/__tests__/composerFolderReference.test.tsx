// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useComposerAttachments } from '@hooks/domain/useComposerAttachments'
import {
  folderView,
  resentReference,
  suggestedFolderCandidate,
} from '../../hooks/__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import type { ComposerGlobalFolderReference } from '../../uiTypes'
import {
  buildChatMessageAttachments,
  getChatMessageAttachmentTypeLabel,
  parseChatMessageDisplay,
} from '../chatMessageAttachments'
import { buildComposerLocationReferences } from '../composerLocationReferences'
import { buildComposerRequestContent } from '../composerReferencesPrompt'
import { buildComposerResendDraft } from '../composerResend'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let reports: ComposerGlobalFolderReference
let quoted: ComposerGlobalFolderReference

beforeAll(async () => {
  reports = await suggestedFolderCandidate(await folderView(1, 'Reports'))
  quoted = await suggestedFolderCandidate(await folderView(2, 'Q3, "final" drafts'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the Folders: line (DC7)', () => {
  it('round-trips through the content: the folder chip comes back by name, the text alone', () => {
    for (const folder of [reports, quoted]) {
      const content = buildComposerRequestContent('Save it here', [folder])
      expect(content).not.toContain('gfs://')
      const parsed = parseChatMessageDisplay(content)
      expect(parsed.content).toBe('Save it here')
      expect(parsed.attachments).toEqual([
        expect.objectContaining({ type: 'global_folder', label: folder.label }),
      ])
      expect(parsed.attachments[0]).not.toHaveProperty('gfsUri')
    }
  })

  it('persists the folder identity on the sent chip, labelled as a folder', () => {
    const [chip] = buildChatMessageAttachments([], [reports], [])
    expect(chip).toMatchObject({
      type: 'global_folder',
      label: 'Reports',
      tooltip: 'Global Folder',
      gfsUri: reports.gfsUri,
      drive: reports.drive,
      resourceId: reports.resourceId,
    })
    expect(getChatMessageAttachmentTypeLabel('global_folder')).toBe('Global Folder')
  })
})

describe('resending a folder (DC8)', () => {
  it('rebuilds the folder from its persisted chip, as a reference the send accepts', () => {
    const resent = resentReference(reports)
    expect(resent).toEqual({
      id: `global-folder:resend:${reports.gfsUri}`,
      type: 'global_folder',
      resourceId: reports.resourceId,
      drive: reports.drive,
      gfsUri: reports.gfsUri,
      label: 'Reports',
    })
    expect(buildComposerLocationReferences([resent])).toHaveLength(1)
  })

  it.each([
    ['no URI', { gfsUri: undefined }],
    ['no drive', { drive: undefined }],
    ['no resource id', { resourceId: undefined }],
    ['a drive the URI does not name', { drive: 'other-drive' }],
  ])('reports a chip with %s as unrestorable', (_label, overrides) => {
    const [chip] = buildChatMessageAttachments([], [reports], [])
    const draft = buildComposerResendDraft({
      content: 'Save it here',
      attachments: [{ ...chip!, ...overrides }],
    })
    expect(draft.referenceAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([{ type: 'global_folder', label: 'Reports' }])
  })

  it('S-F8: after a resend of A, the chip of A is a duplicate', () => {
    const resent = resentReference(reports)
    expect(resent.id).not.toBe(reports.id)
    const hook = renderHook(() =>
      useComposerAttachments({ selectedAgent: 'agent-1', clearSendError: vi.fn() })
    )
    act(() => hook.result.current.handleAddComposerReferenceAttachments([resent]))
    let outcome: string | undefined
    act(() => {
      outcome = hook.result.current.addSuggestedLocationReference(reports)
    })
    expect(outcome).toBe('duplicate')
    expect(hook.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      resent.id,
    ])
  })
})
