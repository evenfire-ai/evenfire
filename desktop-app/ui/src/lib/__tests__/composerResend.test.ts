import { describe, expect, it } from 'vitest'
import type { ChatMessageAttachment } from '../../../../src/types'
import {
  buildComposerResendDraft,
  findNearestPrecedingUserMessage,
  parseStructuredResendReferences,
} from '../composerResend'

function uploadedFileChip(overrides: Partial<ChatMessageAttachment> = {}): ChatMessageAttachment {
  return {
    id: 'img-1',
    type: 'uploaded_file',
    label: 'chart.png',
    addedOrder: 0,
    filename: 'chart.png',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: 'aGVsbG8=',
    sizeBytes: 5,
    ...overrides,
  }
}

describe('parseStructuredResendReferences', () => {
  it('extracts full-identity references from a USER-ATTACHED CONTEXT block', () => {
    const content = [
      'Analyze this.',
      '',
      'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message.',
      'Plugins: profits/revenue. Use workflow tools for these plugin names.',
      'Connectors: github-x. Use MCP tools.',
      'Agent Files: shared-fs/notes/todo.md. Inspect these paths.',
      'Global Files: Report (gfs://drive-7/res-9). Resolve each gfs:// URI.',
    ].join('\n')

    const structured = parseStructuredResendReferences(content)

    expect(structured.plugin).toEqual([{ namespace: 'profits', name: 'revenue' }])
    expect(structured.connector).toEqual([{ name: 'github-x' }])
    expect(structured.agentFile).toEqual([{ filesystemName: 'shared-fs', path: 'notes/todo.md' }])
    expect(structured.globalFile).toEqual([
      { label: 'Report', drive: 'drive-7', resourceId: 'res-9', gfsUri: 'gfs://drive-7/res-9' },
    ])
  })

  it('returns empty collections when the content carries no context block', () => {
    const structured = parseStructuredResendReferences('Just a plain message')
    expect(structured).toEqual({ plugin: [], connector: [], agentFile: [], globalFile: [] })
  })
})

describe('buildComposerResendDraft', () => {
  it('re-attaches an uploaded file with its bytes and preserves the visible text', () => {
    const draft = buildComposerResendDraft({
      content: 'Summarize the chart',
      attachments: [uploadedFileChip()],
    })

    expect(draft.content).toBe('Summarize the chart')
    expect(draft.imageAttachments).toHaveLength(1)
    expect(draft.imageAttachments[0]).toMatchObject({
      name: 'chart.png',
      mimeType: 'image/png',
      dataBase64: 'aGVsbG8=',
      sizeBytes: 5,
      previewDataUrl: 'data:image/png;base64,aGVsbG8=',
    })
    expect(draft.referenceAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([])
  })

  it('re-applies plugin indicators from the structured context block with full identity', () => {
    const content = [
      'Run the analysis',
      'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message.',
      'Plugins: profits/revenue, ops/deploy. Use workflow tools.',
      'Connectors: github-x. Use MCP tools.',
      'Agent Files: shared-fs/notes/todo.md. Inspect these paths.',
      'Global Files: Report (gfs://drive-7/res-9). Resolve each gfs:// URI.',
    ].join('\n')

    const draft = buildComposerResendDraft({ content, attachments: [] })

    expect(draft.content).toBe('Run the analysis')
    expect(draft.imageAttachments).toEqual([])
    expect(draft.referenceAttachments).toEqual([
      {
        id: 'plugin:profits:revenue',
        type: 'plugin',
        namespace: 'profits',
        name: 'revenue',
        label: 'revenue',
      },
      {
        id: 'plugin:ops:deploy',
        type: 'plugin',
        namespace: 'ops',
        name: 'deploy',
        label: 'deploy',
      },
      { id: 'connector:github-x', type: 'connector', name: 'github-x', label: 'github-x' },
      {
        id: 'agent-file:resend:shared-fs:notes/todo.md',
        type: 'agent_file',
        contextId: '',
        filesystemName: 'shared-fs',
        path: 'notes/todo.md',
        kind: 'file',
        label: 'todo.md',
      },
      {
        id: 'global-file:resend:gfs://drive-7/res-9',
        type: 'global_file',
        resourceId: 'res-9',
        drive: 'drive-7',
        gfsUri: 'gfs://drive-7/res-9',
        label: 'Report',
      },
    ])
  })

  it('keeps the structured plugin identity when the message also carries label chips', () => {
    // Locally optimistic messages store chips (label = recipe name only) while
    // the server-authoritative content embeds "Plugins: ns/name". Both present:
    // the structured identity must win over the bare chip label.
    const content = [
      'Run it',
      'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message.',
      'Plugins: profits/revenue. Use workflow tools.',
    ].join('\n')
    const draft = buildComposerResendDraft({
      content,
      attachments: [{ id: 'chip-1', type: 'plugin', label: 'revenue', addedOrder: 0 }],
    })

    expect(draft.referenceAttachments).toEqual([
      {
        id: 'plugin:profits:revenue',
        type: 'plugin',
        namespace: 'profits',
        name: 'revenue',
        label: 'revenue',
      },
    ])
  })

  it('re-applies a plugin indicator from a chip-only message, splitting ns/name labels', () => {
    const draft = buildComposerResendDraft({
      content: 'Run it',
      attachments: [{ id: 'chip-1', type: 'plugin', label: 'profits/revenue', addedOrder: 0 }],
    })

    expect(draft.referenceAttachments).toEqual([
      {
        id: 'plugin:profits:revenue',
        type: 'plugin',
        namespace: 'profits',
        name: 'revenue',
        label: 'revenue',
      },
    ])
  })

  it('falls back to a name-only plugin reference when the chip label has no namespace', () => {
    const draft = buildComposerResendDraft({
      content: 'Run it',
      attachments: [{ id: 'chip-1', type: 'plugin', label: 'revenue', addedOrder: 0 }],
    })

    expect(draft.referenceAttachments).toEqual([
      {
        id: 'plugin:resend:revenue',
        type: 'plugin',
        namespace: '',
        name: 'revenue',
        label: 'revenue',
      },
    ])
  })

  it('reports legacy label-only uploaded files as unrestorable instead of dropping them silently', () => {
    const draft = buildComposerResendDraft({
      content: 'Analyze',
      attachments: [{ id: 'legacy-1', type: 'uploaded_file', label: 'photo.jpg', addedOrder: 0 }],
    })

    expect(draft.imageAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([{ type: 'uploaded_file', label: 'photo.jpg' }])
  })

  it('never re-applies response_file artifacts (they belong to the old reply, not the prompt)', () => {
    const draft = buildComposerResendDraft({
      content: 'Build the report',
      attachments: [
        {
          id: 'gen-1',
          type: 'response_file',
          label: 'report.md',
          filename: 'report.md',
          mimeType: 'text/markdown',
          encoding: 'base64',
          dataBase64: 'IyByZXBvcnQ=',
        },
      ],
    })

    expect(draft.imageAttachments).toEqual([])
    expect(draft.referenceAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([])
  })

  it('uses the parsed legacy markers when the message carries no attachments array', () => {
    const content = [
      'Please analyze the attached image(s).',
      '[Attached images]',
      '- screenshot.png',
    ].join('\n')

    const draft = buildComposerResendDraft({ content, attachments: [] })

    expect(draft.content).toBe('Please analyze the attached image(s).')
    expect(draft.imageAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([{ type: 'uploaded_file', label: 'screenshot.png' }])
  })

  it('rejects non-image uploaded files for the composer (picker accepts jpeg/png only)', () => {
    const draft = buildComposerResendDraft({
      content: 'Here',
      attachments: [
        uploadedFileChip({
          id: 'doc-1',
          label: 'notes.txt',
          filename: 'notes.txt',
          mimeType: 'text/plain',
        }),
      ],
    })

    expect(draft.imageAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([{ type: 'uploaded_file', label: 'notes.txt' }])
  })
})

describe('findNearestPrecedingUserMessage', () => {
  type RoleItem = { role: 'user' | 'assistant' | 'system'; content: string; attachments: [] }
  const userA: RoleItem = { role: 'user', content: 'first prompt', attachments: [] }
  const assistantA: RoleItem = { role: 'assistant', content: 'first reply', attachments: [] }
  const userB: RoleItem = { role: 'user', content: 'second prompt', attachments: [] }
  const assistantB: RoleItem = { role: 'assistant', content: 'second reply', attachments: [] }
  const groups: Array<{ role: 'user' | 'assistant' | 'system'; items: RoleItem[] }> = [
    { role: 'user', items: [userA] },
    { role: 'assistant', items: [assistantA] },
    { role: 'user', items: [userB] },
    { role: 'assistant', items: [assistantB] },
  ]

  it('returns the last user message of the nearest preceding user group', () => {
    expect(findNearestPrecedingUserMessage(groups, 3)).toBe(userB)
  })

  it('skips consecutive assistant groups when walking back', () => {
    const followUp: RoleItem = { role: 'assistant', content: 'follow-up', attachments: [] }
    const multi: Array<{ role: 'user' | 'assistant' | 'system'; items: RoleItem[] }> = [
      { role: 'user', items: [userA] },
      { role: 'assistant', items: [assistantA] },
      { role: 'assistant', items: [followUp] },
    ]
    expect(findNearestPrecedingUserMessage(multi, 2)).toBe(userA)
  })

  it('returns the last item when a user group holds several messages', () => {
    const burstFirst: RoleItem = { role: 'user', content: 'part 1', attachments: [] }
    const burstLast: RoleItem = { role: 'user', content: 'part 2 (trigger)', attachments: [] }
    const withBurst: Array<{ role: 'user' | 'assistant' | 'system'; items: RoleItem[] }> = [
      { role: 'user', items: [burstFirst, burstLast] },
      { role: 'assistant', items: [assistantA] },
    ]
    expect(findNearestPrecedingUserMessage(withBurst, 1)).toBe(burstLast)
  })

  it('returns null when no user group precedes the assistant reply', () => {
    const assistantOnly = [{ role: 'assistant' as const, items: [assistantA] }]
    expect(findNearestPrecedingUserMessage(assistantOnly, 0)).toBeNull()
  })
})
