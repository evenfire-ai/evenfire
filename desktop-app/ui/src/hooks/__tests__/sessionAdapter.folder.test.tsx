// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../../../../src/chatMessageMerge'
import type { ChatMessage } from '../../../../src/types'
import { buildChatMessageAttachments } from '../../lib/chatMessageAttachments'
import {
  buildComposerReferencesPromptSection,
  buildComposerRequestContent,
} from '../../lib/composerReferencesPrompt'
import { buildComposerResendDraft } from '../../lib/composerResend'
import type { ComposerGlobalFolderReference, ComposerReferenceAttachment } from '../../uiTypes'
import { turnsToChatMessages } from '../sessionAdapter'
import {
  fileView,
  folderView,
  pickedReferences,
  suggestedFolderCandidate,
} from './__fixtures__/tabReferenceSuggestionFixtures'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

let file: ComposerReferenceAttachment
let folder: ComposerGlobalFolderReference

beforeAll(async () => {
  const picked = await pickedReferences(hookMock.useGfsBrowserController, [
    await fileView(1, 'report.md'),
  ])
  file = picked[0]!
  folder = await suggestedFolderCandidate(await folderView(1, 'Reports'))
})

/** The server turn of a message sent with `references`, as the history reads it back. */
function serverTurn(references: ComposerReferenceAttachment[]): ChatMessage[] {
  return turnsToChatMessages([
    {
      number: 4,
      user_input: buildComposerRequestContent('Save a summary next to it', references),
      started_at: new Date(4).toISOString(),
    },
  ])
}

/** The local copy of that message in the same slot, as the send persisted it. */
function localCopy(
  incoming: ChatMessage[],
  references: ComposerReferenceAttachment[]
): ChatMessage {
  return { ...incoming[0]!, attachments: buildChatMessageAttachments([], references, []) }
}

describe('mergeAuthoritativeServerMessages — a sent folder', () => {
  it('reads the folder back from the server turn by name only (S9)', () => {
    const [server] = serverTurn([file, folder])
    expect(server?.content).toBe('Save a summary next to it')
    expect(server?.attachments).toMatchObject([
      { type: 'global_file', label: 'report.md' },
      { type: 'global_folder', label: 'Reports' },
    ])
    const folderChip = server!.attachments!.find(chip => chip.type === 'global_folder')!
    expect(folderChip.gfsUri).toBeUndefined()
    expect(buildComposerReferencesPromptSection([folder])).not.toContain('gfs://')
  })

  it('S-F10: the identified local copy gives the folder its identity, and resend rebuilds it', () => {
    const references = [file, folder]
    const incoming = serverTurn(references)
    const once = mergeAuthoritativeServerMessages([localCopy(incoming, references)], incoming)
    const twice = mergeAuthoritativeServerMessages(once, incoming)
    expect(twice).toEqual(once)
    expect(once).toHaveLength(1)
    expect(once[0]?.attachments?.find(chip => chip.type === 'global_folder')).toMatchObject({
      label: 'Reports',
      gfsUri: folder.gfsUri,
      drive: folder.drive,
      resourceId: folder.resourceId,
    })
    const draft = buildComposerResendDraft(once[0]!)
    expect(draft.unrestorable).toEqual([])
    expect(draft.referenceAttachments).toContainEqual({
      id: `global-folder:resend:${folder.gfsUri}`,
      type: 'global_folder',
      resourceId: folder.resourceId,
      drive: folder.drive,
      gfsUri: folder.gfsUri,
      label: 'Reports',
    })
  })

  it('composes with the re-merge main runs over the already-merged turn', () => {
    const references = [file, folder]
    const incoming = serverTurn(references)
    const local = localCopy(incoming, references)
    const merged = mergeAuthoritativeServerMessages([local], incoming)
    expect(mergeAuthoritativeServerMessages([local], merged)).toEqual(merged)
  })

  it.each([
    ['two spaces', 'My  Reports'],
    ['a no-break space', 'Q3\u00a0Reports'],
  ])('pairs a folder whose name has %s with its local copy', async (_label, name) => {
    const spaced = await suggestedFolderCandidate(await folderView(20, name))
    const spacedFile = (
      await pickedReferences(hookMock.useGfsBrowserController, [await fileView(20, `${name}.md`)])
    )[0]!
    const references = [spacedFile, spaced]
    const incoming = serverTurn(references)
    const [merged] = mergeAuthoritativeServerMessages([localCopy(incoming, references)], incoming)
    expect(merged?.attachments?.map(chip => chip.type)).toEqual(['global_file', 'global_folder'])
    const draft = buildComposerResendDraft(merged!)
    expect(draft.unrestorable).toEqual([])
    expect(
      draft.referenceAttachments.map(reference => ('gfsUri' in reference ? reference.gfsUri : null))
    ).toEqual([spacedFile.type === 'global_file' ? spacedFile.gfsUri : '', spaced.gfsUri])
  })

  it('S-F10b: without the local copy the folder cannot be resent', () => {
    const merged = mergeAuthoritativeServerMessages([], serverTurn([folder]))
    const draft = buildComposerResendDraft(merged[0]!)
    expect(draft.referenceAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([{ type: 'global_folder', label: 'Reports' }])
  })

  it('hardening: a local copy whose fields disagree lends no identity', () => {
    const references = [folder]
    const incoming = serverTurn(references)
    const local = localCopy(incoming, references)
    const tampered: ChatMessage = {
      ...local,
      attachments: local.attachments!.map(chip => ({ ...chip, drive: 'other-drive' })),
    }
    const merged = mergeAuthoritativeServerMessages([tampered], incoming)
    const chip = merged[0]?.attachments?.find(item => item.type === 'global_folder')
    expect(chip?.label).toBe('Reports')
    expect(chip?.gfsUri).toBeUndefined()
    expect(buildComposerResendDraft(merged[0]!).unrestorable).toEqual([
      { type: 'global_folder', label: 'Reports' },
    ])
  })
})
