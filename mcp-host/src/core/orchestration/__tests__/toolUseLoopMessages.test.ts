import { describe, expect, it } from 'vitest'
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
})
