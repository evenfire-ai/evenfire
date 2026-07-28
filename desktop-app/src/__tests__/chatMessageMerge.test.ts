import { describe, expect, it } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../chatMessageMerge.js'
import type { ChatMessage } from '../types.js'

describe('mergeAuthoritativeServerMessages', () => {
  it('replaces an image-only optimistic turn despite content and clock differences', () => {
    const existing: ChatMessage[] = [
      {
        id: 'optimistic-user',
        role: 'user',
        content: '',
        timestamp: 1,
        attachments: [
          {
            id: 'photo',
            type: 'uploaded_file',
            label: 'photo.png',
            mimeType: 'image/png',
          },
        ],
      },
      {
        id: 'optimistic-assistant',
        role: 'assistant',
        content: 'working',
        timestamp: 2,
      },
    ]
    const incoming: ChatMessage[] = [
      {
        id: 'turn-7-user',
        role: 'user',
        content: '[Image attached]',
        timestamp: 120_001,
        serverTurnNumber: 7,
      },
      {
        id: 'turn-7-assistant',
        role: 'assistant',
        content: 'done',
        timestamp: 120_002,
        serverTurnNumber: 7,
      },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming)

    expect(merged.map(message => message.id)).toEqual(['turn-7-user', 'turn-7-assistant'])
    expect(merged[0]?.attachments).toEqual(existing[0]?.attachments)
  })

  it('preserves a task-backed in-flight message outside the authoritative turn', () => {
    const pending: ChatMessage = {
      id: 'pending',
      role: 'assistant',
      content: 'still running',
      timestamp: 2,
      task_id: 'task-1',
    }
    const merged = mergeAuthoritativeServerMessages(
      [{ id: 'optimistic', role: 'user', content: 'old', timestamp: 1 }, pending],
      [
        {
          id: 'turn-3-user',
          role: 'user',
          content: 'server copy',
          timestamp: 100,
          serverTurnNumber: 3,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual(['turn-3-user', 'pending'])
  })
})
