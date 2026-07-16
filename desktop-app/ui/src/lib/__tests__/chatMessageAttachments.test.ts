import { describe, expect, it } from 'vitest'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'
import {
  buildChatMessageAttachments,
  buildResponseFileAttachments,
  parseChatMessageDisplay,
} from '../chatMessageAttachments'

describe('chat message attachments', () => {
  it('parses legacy attached context text into display attachments', () => {
    const parsed = parseChatMessageDisplay(
      'what is the price?\n\n[Attached context]\n- mcp-coingecko-remote'
    )

    expect(parsed.content).toBe('what is the price?')
    expect(parsed.attachments).toMatchObject([{ type: 'connector', label: 'mcp-coingecko-remote' }])
  })

  it('preserves dotted agent file labels from composer prompt context', () => {
    const parsed = parseChatMessageDisplay(
      [
        'send this invitation',
        '',
        'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message. Prefer them when they are relevant to the request.',
        'Agent Files: assets/invite.png, data.json. Use clerum__context_files_list and clerum__context_files_read to inspect these paths before relying on their contents.',
      ].join('\n')
    )

    expect(parsed.content).toBe('send this invitation')
    expect(parsed.attachments).toMatchObject([
      { type: 'agent_file', label: 'invite.png' },
      { type: 'agent_file', label: 'data.json' },
    ])
  })

  it('restores friendly global file labels after composer prompt content reloads', () => {
    const parsed = parseChatMessageDisplay(
      [
        'summarize this report',
        '',
        'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message. Prefer them when they are relevant to the request.',
        'Global Files: quarterly-report.pdf (gfs://main/0123456789abcdef). These files were explicitly selected by the user. Use clerum__gfs_resolve for each gfs:// URI.',
      ].join('\n')
    )

    expect(parsed.content).toBe('summarize this report')
    expect(parsed.attachments).toMatchObject([
      { type: 'global_file', label: 'quarterly-report.pdf' },
    ])
  })

  it('uses the basename for legacy raw global file URI attachments', () => {
    const parsed = parseChatMessageDisplay(
      [
        'inspect this',
        'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message. Prefer them when they are relevant to the request.',
        'Global Files: gfs://main/archive/legacy-report.pdf. These files were explicitly selected by the user.',
      ].join('\n')
    )

    expect(parsed.attachments).toMatchObject([
      { type: 'global_file', label: 'legacy-report.pdf' },
    ])
  })

  it('builds display attachments in composer insertion order', () => {
    const references: ComposerReferenceAttachment[] = [
      {
        id: 'connector:first',
        type: 'connector',
        name: 'first',
        label: 'first',
        addedOrder: 1,
      },
      {
        id: 'connector:second',
        type: 'connector',
        name: 'second',
        label: 'second',
        addedOrder: 3,
      },
    ]
    const images: ComposerImageAttachment[] = [
      {
        id: 'image:logo',
        name: 'logo.png',
        mimeType: 'image/png',
        dataBase64: 'abc',
        sizeBytes: 1024,
        previewDataUrl: 'blob:logo',
        addedOrder: 2,
      },
    ]

    expect(
      buildChatMessageAttachments(images, references).map(attachment => attachment.label)
    ).toEqual(['first', 'logo.png', 'second'])
  })

  it('builds downloadable generated-file attachments from task responses', () => {
    const attachments = buildResponseFileAttachments({
      attachments: [
        {
          kind: 'file',
          filename: 'research-summary.pdf',
          mimeType: 'application/pdf',
          encoding: 'base64',
          dataBase64: 'JVBERi0x',
          sizeBytes: 14600,
        },
      ],
    })

    expect(attachments).toEqual([
      expect.objectContaining({
        type: 'response_file',
        label: 'research-summary.pdf',
        filename: 'research-summary.pdf',
        mimeType: 'application/pdf',
        encoding: 'base64',
        dataBase64: 'JVBERi0x',
        sizeBytes: 14600,
      }),
    ])
  })
})
