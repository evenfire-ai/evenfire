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
      ],
      { activeTaskIds: new Set(['task-1']) }
    )

    expect(merged.map(message => message.id)).toEqual(['turn-3-user', 'pending'])
  })

  it('replaces completed task-backed echoes inside their authoritative turn', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'optimistic-user',
          role: 'user',
          content: 'hello',
          timestamp: 1,
          task_id: 'completed-task',
        },
        {
          id: 'optimistic-assistant',
          role: 'assistant',
          content: 'done',
          timestamp: 2,
          task_id: 'completed-task',
        },
      ],
      [
        {
          id: 'turn-4-user',
          role: 'user',
          content: 'hello',
          timestamp: 100,
          serverTurnNumber: 4,
        },
        {
          id: 'turn-4-assistant',
          role: 'assistant',
          content: 'done',
          timestamp: 101,
          serverTurnNumber: 4,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual(['turn-4-user', 'turn-4-assistant'])
    expect(merged.every(message => message.task_id === 'completed-task')).toBe(true)
  })

  it('preserves turnless system messages inside an authoritative range', () => {
    const system: ChatMessage = {
      id: 'system-note',
      role: 'system',
      content: 'local diagnostic',
      timestamp: 2,
    }
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-1-assistant',
          role: 'assistant',
          content: 'first',
          timestamp: 1,
          serverTurnNumber: 1,
        },
        system,
        {
          id: 'turn-3-user',
          role: 'user',
          content: 'third',
          timestamp: 3,
          serverTurnNumber: 3,
        },
      ],
      [
        {
          id: 'turn-2-user',
          role: 'user',
          content: 'second',
          timestamp: 20,
          serverTurnNumber: 2,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual([
      'turn-1-assistant',
      'system-note',
      'turn-2-user',
      'turn-3-user',
    ])
  })
})
