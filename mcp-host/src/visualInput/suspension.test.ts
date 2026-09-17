import { describe, expect, it } from 'vitest'
import { prePrune } from '../core/extensions/prePrune'
import { appendToolResults } from '../core/orchestration/toolUseLoopMessages'
import type { Attachment, ChatMessage, PendingApproval, ToolResult } from '../core/types'
import { projectGfsApproval } from './suspension'

const source = {
  kind: 'gfs' as const,
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  version: 3,
  name: 'neutral.png',
}
const image: Attachment = {
  id: 'read-image',
  kind: 'image',
  mimeType: 'image/png',
  encoding: 'base64',
  // Projection/deduplication tests do not decode this synthetic payload.
  dataBase64: 'image-payload-must-not-be-persisted',
  visualSource: source,
}
const result = (id = 'read-1'): ToolResult => ({
  tool_call_id: id,
  name: 'clerum__gfs_read',
  content: 'image prepared',
  is_error: false,
  attachments: [image],
})

describe('current-turn GFS image lifecycle', () => {
  it('delivers a reread after the real historical-media pruning pass', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'inspect image' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'read-1', name: 'clerum__gfs_read', arguments: {} }],
      },
    ]
    appendToolResults(messages, [result()], [])
    for (const content of ['follow-up one', 'follow-up two', 'read the image again'])
      messages.push({ role: 'user', content })
    const pruned = prePrune(messages)
    expect(pruned.passesApplied).toContain('strip_media')
    expect(pruned.messages.flatMap(m => m.contentParts ?? []).some(p => p.type === 'image')).toBe(
      false
    )
    pruned.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'read-again', name: 'clerum__gfs_read', arguments: {} }],
    })
    appendToolResults(pruned.messages, [result('read-again')], [])
    const images = pruned.messages
      .flatMap(m => m.contentParts ?? [])
      .filter(p => p.type === 'image')
    expect(images).toHaveLength(1)
    expect(images[0].data).toBe(image.dataBase64)
  })
  it.each([true, false])(
    'admits GFS against the complete batch regardless of ordering (first=%s)',
    first => {
      const gfs = result()
      const other: ToolResult = {
        ...result('screenshots'),
        name: 'screenshots',
        attachments: [1, 2, 3].map(index => ({
          ...image,
          id: `screenshot-${index}`,
          visualSource: undefined,
          dataBase64: `screenshot-${index}`,
        })),
      }
      const messages: ChatMessage[] = []
      appendToolResults(messages, first ? [gfs, other] : [other, gfs], [])
      const images = messages.flatMap(m => m.contentParts ?? []).filter(p => p.type === 'image')
      expect(images).toHaveLength(3)
      expect(images.every(p => p.source === undefined)).toBe(true)
      const reference = messages.find(m => m.tool_call_id === 'read-1')!
      expect(JSON.parse(reference.content).reason).toBe('image_input_limit_exceeded')
    }
  )
  it('reinserts a reread after the image leaves the context, without collecting it as a generated download', () => {
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    appendToolResults(messages, [result()], collected)
    expect(
      messages.flatMap(m => m.contentParts ?? []).filter(p => p.type === 'image')
    ).toHaveLength(1)
    expect(collected).toEqual([])
    appendToolResults(messages, [result('read-2')], collected)
    expect(
      messages.flatMap(m => m.contentParts ?? []).filter(p => p.type === 'image')
    ).toHaveLength(1)
    for (const message of messages) delete message.contentParts
    appendToolResults(messages, [result('read-3')], collected)
    expect(
      messages.flatMap(m => m.contentParts ?? []).filter(p => p.type === 'image')
    ).toHaveLength(1)
  })

  it('does not promote images attached to a failed tool result', () => {
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    appendToolResults(messages, [{ ...result(), is_error: true }], collected)
    expect(messages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(false)
    expect(collected).toEqual([])
  })

  it('preserves separate source/version associations for identical pixels', () => {
    const messages: ChatMessage[] = []
    appendToolResults(
      messages,
      [
        result(),
        {
          ...result('read-other'),
          attachments: [
            { ...image, visualSource: { ...source, gfsUri: `gfs://main/${'b'.repeat(32)}` } },
          ],
        },
      ],
      []
    )
    const images = messages.flatMap(m => m.contentParts ?? []).filter(p => p.type === 'image')
    expect(images).toHaveLength(2)
  })

  it('projects snapshots, completed results and lateral attachments without altering approval identity or pairings', () => {
    const generated: Attachment = {
      ...image,
      id: 'existing-download',
      kind: 'file',
      mimeType: 'application/pdf',
      dataBase64: 'existing-artifact',
      visualSource: undefined,
    }
    const approval: PendingApproval = {
      request_id: 'approval-1',
      tool_name: 'shell_exec',
      tool_call_id: 'pending-1',
      description: 'pending operation',
      parameters: { command: 'echo ready' },
      context_snapshot: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'read-1', name: 'clerum__gfs_read', arguments: {} }],
        },
        {
          role: 'tool',
          content: 'image prepared',
          tool_call_id: 'read-1',
          name: 'clerum__gfs_read',
        },
        {
          role: 'user',
          content: 'image',
          contentParts: [{ type: 'image', mimeType: 'image/png', data: image.dataBase64, source }],
        },
      ],
      completed_results: [result()],
      attachments: [image, generated],
    }
    const projected = projectGfsApproval(approval)
    expect(projected.parameters).toBe(approval.parameters)
    expect(projected.request_id).toBe(approval.request_id)
    expect(projected.tool_call_id).toBe(approval.tool_call_id)
    expect(projected.context_snapshot.slice(0, 2)).toEqual(approval.context_snapshot.slice(0, 2))
    expect(JSON.stringify(projected)).not.toContain(image.dataBase64)
    expect(JSON.stringify(projected)).toContain('new_gfs_read_required_after_suspension')
    expect(projected.attachments).toEqual([generated])
    expect(projected.completed_results![0].tool_call_id).toBe('read-1')
    expect(projectGfsApproval(projected)).toEqual(projected)
    expect(approval.attachments).toHaveLength(2)
    // A later authorized read may produce another version; it must be new input.
    appendToolResults(
      projected.context_snapshot,
      [
        {
          ...result('read-new'),
          attachments: [{ ...image, visualSource: { ...source, version: 4 } }],
        },
      ],
      []
    )
    const delivered = projected.context_snapshot
      .flatMap(m => m.contentParts ?? [])
      .filter(p => p.type === 'image')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].source?.version).toBe(4)
  })
})
