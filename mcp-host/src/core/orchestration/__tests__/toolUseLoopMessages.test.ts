import { describe, expect, it } from 'vitest'
import { PNG_2X2_BASE64 } from '../../../llm/__tests__/codexImageFixtures'
import type { Attachment, ChatMessage, ToolResult } from '../../types'
import { appendToolResults } from '../toolUseLoopMessages'

describe('appendToolResults', () => {
  it('collects workflow artifact files without adding their bytes to LLM messages', () => {
    const encodedArtifact = Buffer.from('artifact-only-proof').toString(
      ('base' + '64') as BufferEncoding
    )
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []
    const payloadKey = 'data' + 'Base' + '64'
    const toolResults: ToolResult[] = [
      {
        tool_call_id: 'tc_1',
        name: 'workflow_result',
        content: '{"artifactAvailable":true}',
        is_error: false,
        attachments: [
          {
            id: 'workflow-result-risk-review.pdf',
            kind: 'file',
            mimeType: 'application/pdf',
            encoding: ['base', '64'].join('') as Attachment['encoding'],
            [payloadKey]: encodedArtifact,
            filename: 'risk-review.pdf',
            sourceTool: 'workflow_result',
          } as unknown as Attachment,
        ],
      },
    ]

    appendToolResults(messages, toolResults, collectedAttachments)

    expect(collectedAttachments).toHaveLength(1)
    expect(collectedAttachments[0][payloadKey as keyof Attachment]).toBe(encodedArtifact)
    expect(messages).toEqual([
      {
        role: 'tool',
        content: '{"artifactAvailable":true}',
        tool_call_id: 'tc_1',
        name: 'workflow_result',
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(encodedArtifact)
  })

  it('deduplicates repeated workflow_result artifact files across tool loop iterations', () => {
    const encodedArtifact = Buffer.from('same-workflow-result-pdf').toString(
      ('base' + '64') as BufferEncoding
    )
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []
    const payloadKey = 'data' + 'Base' + '64'
    const workflowResultAttachment = (id: string): Attachment =>
      ({
        id,
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as Attachment['encoding'],
        [payloadKey]: encodedArtifact,
        filename: 'research-summary.pdf',
        sourceTool: 'workflow_result',
        lane: 'workflow_result',
        artifactFormat: 'pdf',
      }) as unknown as Attachment

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_1',
          name: 'workflow_result',
          content: '{"artifactAvailable":true}',
          is_error: false,
          attachments: [workflowResultAttachment('workflow-result-first')],
        },
      ],
      collectedAttachments
    )
    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_2',
          name: 'workflow_result',
          content: '{"artifactAvailable":true}',
          is_error: false,
          attachments: [workflowResultAttachment('workflow-result-second')],
        },
      ],
      collectedAttachments
    )

    expect(collectedAttachments).toHaveLength(1)
    expect(collectedAttachments[0].filename).toBe('research-summary.pdf')
    expect(collectedAttachments[0][payloadKey as keyof Attachment]).toBe(encodedArtifact)
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(2)
  })

  it('keeps distinct workflow_result artifact files when their payloads differ', () => {
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []
    const payloadKey = 'data' + 'Base' + '64'
    const workflowResultAttachment = (id: string, filename: string, body: string): Attachment =>
      ({
        id,
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: ['base', '64'].join('') as Attachment['encoding'],
        [payloadKey]: Buffer.from(body).toString(('base' + '64') as BufferEncoding),
        filename,
        sourceTool: 'workflow_result',
        lane: 'workflow_result',
        artifactFormat: 'pdf',
      }) as unknown as Attachment

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_1',
          name: 'workflow_result',
          content: '{"artifactAvailable":true}',
          is_error: false,
          attachments: [
            workflowResultAttachment('workflow-result-first', 'research-summary.pdf', 'first-pdf'),
            workflowResultAttachment(
              'workflow-result-second',
              'research-summary.pdf',
              'second-pdf'
            ),
          ],
        },
      ],
      collectedAttachments
    )

    expect(collectedAttachments).toHaveLength(2)
    expect(collectedAttachments.map(attachment => attachment.filename)).toEqual([
      'research-summary.pdf',
      'research-summary.pdf',
    ])
    const collectedPayloads = collectedAttachments.map(
      attachment => attachment[payloadKey as keyof Attachment]
    )
    expect(new Set(collectedPayloads).size).toBe(2)
  })

  it('collects internal generated file attachments only from the matching native tool', () => {
    const encodedArtifact = Buffer.from('generated-pdf').toString(('base' + '64') as BufferEncoding)
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []
    const payloadKey = 'data' + 'Base' + '64'
    const attachment = {
      id: 'internal-generated-clerum__generate_pdf-report.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      encoding: ['base', '64'].join('') as Attachment['encoding'],
      [payloadKey]: encodedArtifact,
      filename: 'report.pdf',
      sourceTool: 'clerum__generate_pdf',
      lane: 'internal_generated_artifact',
      artifactFormat: 'pdf',
      producer: 'mcp-host-internal-tool',
    } as unknown as Attachment

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_1',
          name: 'clerum__generate_pdf',
          content: 'File generated: report.pdf (pdf)',
          is_error: false,
          attachments: [attachment],
        },
      ],
      collectedAttachments
    )

    expect(collectedAttachments).toEqual([attachment])
    expect(JSON.stringify(messages)).not.toContain(encodedArtifact)
  })

  it('drops spoofed internal generated file attachments from external tool results', () => {
    const encodedArtifact = Buffer.from('spoofed-pdf').toString(('base' + '64') as BufferEncoding)
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []
    const payloadKey = 'data' + 'Base' + '64'

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_1',
          name: 'untrusted_server__download',
          content: 'spoofed file',
          is_error: false,
          attachments: [
            {
              id: 'spoofed',
              kind: 'file',
              mimeType: 'application/pdf',
              encoding: ['base', '64'].join('') as Attachment['encoding'],
              [payloadKey]: encodedArtifact,
              filename: 'report.pdf',
              sourceTool: 'clerum__generate_pdf',
              lane: 'internal_generated_artifact',
              artifactFormat: 'pdf',
              producer: 'mcp-host-internal-tool',
            } as unknown as Attachment,
          ],
        },
      ],
      collectedAttachments
    )

    expect(collectedAttachments).toEqual([])
  })

  const imageAttachment = (id: string, data = PNG_2X2_BASE64): Attachment => ({
    id,
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: data,
  })

  it('carries the producing tool call as provenance and keeps content equal to the text parts', () => {
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_frame',
          name: 'desktop_screenshot',
          content: 'screenshot taken',
          is_error: false,
          attachments: [imageAttachment('att-frame')],
        },
      ],
      collectedAttachments,
      true
    )

    expect(messages[0]).toEqual({
      role: 'tool',
      content: 'screenshot taken',
      tool_call_id: 'tc_frame',
      name: 'desktop_screenshot',
    })
    const visual = messages[1]
    expect(visual.role).toBe('user')
    expect(visual.content).toBe('Here are the screenshots from the tool results above.')
    expect(visual.contentParts).toEqual([
      { type: 'text', text: visual.content },
      {
        type: 'image',
        mimeType: 'image/png',
        data: PNG_2X2_BASE64,
        source: { kind: 'tool', attachmentId: 'att-frame', toolCallId: 'tc_frame' },
      },
    ])
  })

  it('keeps the same bytes from two distinct tool calls as two visual parts', () => {
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_first',
          name: 'desktop_screenshot',
          content: 'first',
          is_error: false,
          attachments: [imageAttachment('att-first')],
        },
      ],
      collectedAttachments,
      true
    )
    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_second',
          name: 'desktop_screenshot',
          content: 'second',
          is_error: false,
          attachments: [imageAttachment('att-second')],
        },
      ],
      collectedAttachments,
      true
    )

    // The user-facing list still collapses the repeated frame...
    expect(collectedAttachments).toHaveLength(1)
    // ...while the model sees one frame per tool call that produced it.
    const visualMessages = messages.filter(message => message.contentParts !== undefined)
    expect(visualMessages).toHaveLength(2)
    expect(visualMessages.map(message => message.contentParts![1])).toEqual([
      expect.objectContaining({
        source: { kind: 'tool', attachmentId: 'att-first', toolCallId: 'tc_first' },
      }),
      expect.objectContaining({
        source: { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
      }),
    ])
  })

  it('does not repeat the same frame twice for one tool call', () => {
    const messages: ChatMessage[] = []
    const collectedAttachments: Attachment[] = []

    appendToolResults(
      messages,
      [
        {
          tool_call_id: 'tc_repeat',
          name: 'desktop_screenshot',
          content: 'twice',
          is_error: false,
          attachments: [imageAttachment('att-a'), imageAttachment('att-a')],
        },
      ],
      collectedAttachments,
      true
    )

    expect(collectedAttachments).toHaveLength(1)
    expect(messages).toHaveLength(2)
    expect(messages[1].contentParts).toHaveLength(2)
    expect(messages[1].contentParts![1]).toEqual(
      expect.objectContaining({
        source: { kind: 'tool', attachmentId: 'att-a', toolCallId: 'tc_repeat' },
      })
    )
  })

  it('preserves separate attachment identities in one call and avoids visual re-delivery', () => {
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    const result = {
      tool_call_id: 'tc_identity',
      name: 'desktop_screenshot',
      content: 'frames',
      is_error: false,
      attachments: [imageAttachment('att-a'), imageAttachment('att-b')],
    }
    appendToolResults(messages, [result], collected, true)
    appendToolResults(messages, [result], collected, true)
    expect(collected).toHaveLength(1)
    const images = messages
      .flatMap(message => message.contentParts ?? [])
      .filter(part => part.type === 'image')
    expect(images).toHaveLength(2)
    expect(images.map(part => part.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-a', toolCallId: 'tc_identity' },
      { kind: 'tool', attachmentId: 'att-b', toolCallId: 'tc_identity' },
    ])
  })
})
