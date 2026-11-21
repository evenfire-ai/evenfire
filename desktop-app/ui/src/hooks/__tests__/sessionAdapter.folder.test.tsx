// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../../../../src/chatMessageMerge'
import type { ChatMessage } from '../../../../src/types'
import { buildChatMessageAttachments } from '../../lib/chatMessageAttachments'
import { buildComposerRequestContent } from '../../lib/composerReferencesPrompt'
import { turnsToChatMessages } from '../sessionAdapter'
import {
  fileView,
  folderView,
  pickedReferences,
  suggestedFolderCandidate,
} from './__fixtures__/tabReferenceSuggestionFixtures'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

describe('mergeAuthoritativeServerMessages — a sent folder', () => {
  it('keeps the local folder chip when the server turn only lists the file', async () => {
    const [file] = await pickedReferences(hookMock.useGfsBrowserController, [
      await fileView(1, 'report.md'),
    ])
    const folder = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const references = [file!, folder]
    const incoming = turnsToChatMessages([
      {
        number: 4,
        user_input: buildComposerRequestContent('Save a summary next to it', references),
        started_at: new Date(4).toISOString(),
      },
    ])
    expect(incoming[0]?.attachments).toMatchObject([{ type: 'global_file', label: 'report.md' }])
    const local: ChatMessage = {
      ...incoming[0]!,
      attachments: buildChatMessageAttachments([], references, []),
    }

    const merged = mergeAuthoritativeServerMessages([local], incoming)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.attachments?.map(chip => [chip.type, chip.label])).toEqual([
      ['global_file', 'report.md'],
      ['global_folder', 'Reports'],
    ])
  })
})
