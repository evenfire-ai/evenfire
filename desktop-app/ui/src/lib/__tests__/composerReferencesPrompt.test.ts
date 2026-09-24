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
      'Global Files: quarterly-report.pdf (gfs://main/0123456789abcdef). These files were explicitly selected by the user.'
    )
    expect(prompt).not.toContain('clerum__gfs_resolve')
    expect(prompt).not.toContain('clerum__gfs_read')
  })

  it('leaves request content unchanged when no references are attached', () => {
    expect(buildComposerRequestContent('hello', [])).toBe('hello')
  })
})
