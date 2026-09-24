import { describe, expect, it } from 'vitest'
import type { ComposerReferenceAttachment } from '../../uiTypes'
import {
  buildComposerReferencesPromptSection,
  buildComposerRequestContent,
} from '../composerReferencesPrompt'

describe('composer references prompt helpers', () => {
  it('builds Desktop-side prompt guidance for selected references', () => {
    const references: ComposerReferenceAttachment[] = [
      {
        id: 'plugin:sandbox-recipes:find-contacts',
        type: 'plugin',
        namespace: 'sandbox-recipes',
        name: 'find-contacts',
        label: 'Find contacts',
      },
      {
        id: 'connector:github',
        type: 'connector',
        name: 'github',
        label: 'GitHub',
      },
      {
        id: 'agent-file:ctx-1:assets:/invite.png:file',
        type: 'agent_file',
        contextId: 'ctx-1',
        filesystemName: 'assets',
        path: '/invite.png',
        kind: 'file',
        label: 'assets/invite.png',
      },
      {
        id: 'global-file:report',
        type: 'global_file',
        resourceId: 'resource-1',
        drive: 'main',
        gfsUri: 'gfs://main/0123456789abcdef',
        label: 'quarterly-report.pdf',
        version: 2,
        bytes: 4096,
      },
    ]

    const prompt = buildComposerReferencesPromptSection(references)

    expect(prompt).toContain('USER-ATTACHED CONTEXT')
    expect(prompt).toContain('Plugins: sandbox-recipes/find-contacts')
    expect(prompt).toContain('Connectors: github')
    expect(prompt).toContain('prefix before "__" exactly matches')
    expect(prompt).toContain('Agent Files: assets/invite.png')
    expect(prompt).toContain('clerum__context_files_read')
    // The Global Files line names the selection; the read instruction now comes
    // from the Host's turn context for the structured fileReferences (#666).
    expect(prompt).toContain(
      'Global Files: quarterly-report.pdf. These files were explicitly selected by the user.'
    )
    expect(prompt).not.toContain('clerum__gfs_resolve')
    expect(prompt).not.toContain('clerum__gfs_read')
    // The URI travels only in the structured fileReferences; the line above is
    // the witness that the Global Files entry was formatted.
    expect(prompt).not.toContain('gfs://')
  })

  it('leaves a Global Files entry without a label out of the prompt', () => {
    const unlabeled: ComposerReferenceAttachment = {
      id: 'global-file:unlabeled',
      type: 'global_file',
      resourceId: 'resource-2',
      drive: 'main',
      gfsUri: 'gfs://main/fedcba9876543210',
      label: '   ',
      version: 1,
      bytes: 10,
    }
    const labeled: ComposerReferenceAttachment = {
      ...unlabeled,
      id: 'global-file:notes',
      label: 'notes.md',
    }

    const prompt = buildComposerReferencesPromptSection([unlabeled, labeled])

    // Witness: the labeled entry is the only one on the line.
    expect(prompt).toContain(
      'Global Files: notes.md. These files were explicitly selected by the user.'
    )
    expect(prompt).not.toContain('gfs://')
    expect(buildComposerReferencesPromptSection([unlabeled])).toBeNull()
  })

  it('leaves request content unchanged when no references are attached', () => {
    expect(buildComposerRequestContent('hello', [])).toBe('hello')
  })
})
