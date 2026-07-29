import { describe, expect, it } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../chatMessageMerge.js'
import { turnsToChatMessages } from '../serverTurnAdapter.js'
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

  it('does not duplicate an active optimistic message when the server returns its turn', () => {
    const serverMessages = turnsToChatMessages([
      {
        number: 2,
        user_input: 'second',
        started_at: new Date(3).toISOString(),
      },
    ])
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'first',
          timestamp: 1,
          serverTurnNumber: 1,
        },
        {
          id: 'optimistic-task-2',
          role: 'user',
          content: 'second',
          timestamp: 2,
          task_id: 'task-2',
        },
      ],
      serverMessages,
      { activeTaskIds: new Set(['task-2']) }
    )

    expect(merged.map(message => message.id)).toEqual(['turn-1-user', 'optimistic-task-2'])
  })

  it('replaces a turnless echo after the previous numbered turn', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'first',
          timestamp: 1,
          serverTurnNumber: 1,
        },
        {
          id: 'optimistic-user',
          role: 'user',
          content: 'second',
          timestamp: 2,
        },
      ],
      turnsToChatMessages([
        {
          number: 2,
          user_input: 'second',
          started_at: new Date(3).toISOString(),
        },
      ])
    )

    expect(merged.map(message => message.id)).toEqual(['turn-1-user', 'turn-2-user'])
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

  it('preserves durable turnless message positions between replaced turns', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-2-user-local',
          role: 'user',
          content: 'second',
          timestamp: 1,
          serverTurnNumber: 2,
        },
        {
          id: 'system-note',
          role: 'system',
          content: 'local diagnostic',
          timestamp: 2,
        },
        {
          id: 'durable-error',
          role: 'assistant',
          content: 'connection interrupted',
          timestamp: 3,
          isError: true,
        },
        {
          id: 'turn-3-user-local',
          role: 'user',
          content: 'third',
          timestamp: 4,
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
        {
          id: 'turn-3-user',
          role: 'user',
          content: 'third',
          timestamp: 30,
          serverTurnNumber: 3,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual([
      'turn-2-user',
      'system-note',
      'durable-error',
      'turn-3-user',
    ])
  })

  it('replaces numbered active-task rows instead of suppressing their server slot', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-4-user-local',
          role: 'user',
          content: 'local',
          timestamp: 1,
          serverTurnNumber: 4,
          task_id: 'task-4',
        },
      ],
      [
        {
          id: 'turn-4-user',
          role: 'user',
          content: 'server',
          timestamp: 2,
          serverTurnNumber: 4,
        },
      ],
      { activeTaskIds: new Set(['task-4']) }
    )

    expect(merged).toEqual([
      expect.objectContaining({
        id: 'turn-4-user',
        content: 'server',
        task_id: 'task-4',
      }),
    ])
  })

  it('does not reuse later exact matches when backfilling older server turns', () => {
    const existing: ChatMessage[] = Array.from({ length: 4 }, (_, index) => index + 5).flatMap(
      n => [
        {
          id: `turn-${n}-user-local`,
          role: 'user' as const,
          content: `local q${n}`,
          timestamp: n * 10,
          serverTurnNumber: n,
          task_id: `task-${n}`,
          attachments: [
            {
              id: `upload-${n}`,
              type: 'uploaded_file' as const,
              label: `file-${n}.txt`,
            },
          ],
        },
        {
          id: `turn-${n}-assistant-local`,
          role: 'assistant' as const,
          content: `local a${n}`,
          timestamp: n * 10 + 1,
          serverTurnNumber: n,
          task_id: `task-${n}`,
        },
      ]
    )
    const incoming = turnsToChatMessages(
      Array.from({ length: 8 }, (_, index) => ({
        number: index + 1,
        user_input: `q${index + 1}`,
        response: `a${index + 1}`,
        started_at: new Date(index + 1).toISOString(),
      }))
    )

    const merged = mergeAuthoritativeServerMessages(existing, incoming)

    expect(merged.map(message => message.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => index + 1).flatMap(n => [
        `turn-${n}-user`,
        `turn-${n}-assistant`,
      ])
    )
    expect(
      merged
        .filter(message => (message.serverTurnNumber ?? 0) <= 4)
        .flatMap(message => [message.task_id, message.attachments])
        .filter(Boolean)
    ).toEqual([])
    expect(
      merged
        .filter(message => message.serverTurnNumber === 5)
        .map(message => ({
          id: message.id,
          taskId: message.task_id,
          attachmentId: message.attachments?.[0]?.id,
        }))
    ).toEqual([
      { id: 'turn-5-user', taskId: 'task-5', attachmentId: 'upload-5' },
      { id: 'turn-5-assistant', taskId: 'task-5', attachmentId: undefined },
    ])
  })

  it('places a server response after the active optimistic prompt for that turn', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-5-user-local',
          role: 'user',
          content: 'q5',
          timestamp: 1,
          serverTurnNumber: 5,
        },
        {
          id: 'turn-5-assistant-local',
          role: 'assistant',
          content: 'a5',
          timestamp: 2,
          serverTurnNumber: 5,
        },
        {
          id: 'optimistic-turn-6-user',
          role: 'user',
          content: 'q6',
          timestamp: 3,
          task_id: 'task-live',
        },
      ],
      [
        {
          id: 'turn-5-user',
          role: 'user',
          content: 'q5',
          timestamp: 4,
          serverTurnNumber: 5,
        },
        {
          id: 'turn-5-assistant',
          role: 'assistant',
          content: 'a5',
          timestamp: 5,
          serverTurnNumber: 5,
        },
        {
          id: 'turn-6-assistant',
          role: 'assistant',
          content: 'a6',
          timestamp: 6,
          serverTurnNumber: 6,
        },
      ],
      { activeTaskIds: new Set(['task-live']) }
    )

    expect(merged.map(message => message.id)).toEqual([
      'turn-5-user',
      'turn-5-assistant',
      'optimistic-turn-6-user',
      'turn-6-assistant',
    ])
  })
})
