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

  it('keeps an active optimistic message until the server identifies its task', () => {
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

    expect(merged).toEqual([
      expect.objectContaining({ id: 'turn-1-user' }),
      expect.objectContaining({
        id: 'optimistic-task-2',
        content: 'second',
        task_id: 'task-2',
      }),
    ])
  })

  it('replaces an active optimistic message when the server identifies the same task', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'optimistic-task-2',
          role: 'user',
          content: 'second',
          timestamp: 2,
          task_id: 'task-2',
        },
      ],
      [
        {
          id: 'turn-2-user',
          role: 'user',
          content: 'second',
          timestamp: 3,
          task_id: 'task-2',
          serverTurnNumber: 2,
        },
      ],
      { activeTaskIds: new Set(['task-2']) }
    )

    expect(merged).toEqual([
      expect.objectContaining({
        id: 'turn-2-user',
        content: 'second',
        task_id: 'task-2',
      }),
    ])
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
        .filter(message => message.serverTurnNumber !== undefined && message.serverTurnNumber <= 4)
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

  it('does not copy turnless orphan metadata onto unrelated backfilled server turns', () => {
    const existing: ChatMessage[] = [
      {
        id: 'turnless-upload-orphan',
        role: 'user',
        content: 'old local upload',
        timestamp: 1,
        task_id: 'orphan-task',
        attachments: [
          {
            id: 'orphan-upload',
            type: 'uploaded_file',
            label: 'orphan.txt',
          },
        ],
      },
      ...Array.from({ length: 4 }, (_, index) => index + 5).flatMap(n => [
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
      ]),
    ]
    const incoming = turnsToChatMessages(
      Array.from({ length: 8 }, (_, index) => ({
        number: index + 1,
        user_input: `q${index + 1}`,
        response: `a${index + 1}`,
        started_at: new Date(index + 1).toISOString(),
      }))
    )

    const merged = mergeAuthoritativeServerMessages(existing, incoming)

    expect(
      merged
        .filter(message => message.serverTurnNumber !== undefined && message.serverTurnNumber <= 4)
        .flatMap(message => [message.task_id, message.attachments])
        .filter(Boolean)
    ).toEqual([])
    expect(
      merged
        .filter(message => message.serverTurnNumber === 5 && message.role === 'user')
        .map(message => ({
          taskId: message.task_id,
          attachmentId: message.attachments?.[0]?.id,
        }))
    ).toEqual([{ taskId: 'task-5', attachmentId: 'upload-5' }])
  })

  it('preserves local-only failed sends that the server never accepted', () => {
    const failedPrompt: ChatMessage = {
      id: 'failed-post-user',
      role: 'user',
      content: 'this prompt never reached the server',
      timestamp: 3,
      preserveLocal: true,
    }

    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'q1',
          timestamp: 1,
          serverTurnNumber: 1,
        },
        {
          id: 'turn-1-assistant',
          role: 'assistant',
          content: 'a1',
          timestamp: 2,
          serverTurnNumber: 1,
        },
        failedPrompt,
      ],
      turnsToChatMessages([
        {
          number: 1,
          user_input: 'q1',
          response: 'a1',
          started_at: new Date(1).toISOString(),
        },
        {
          number: 2,
          user_input: 'server-only q2',
          response: 'server-only a2',
          started_at: new Date(2).toISOString(),
        },
      ])
    )

    expect(merged).toContainEqual(failedPrompt)
  })

  it('does not delete numbered local slots that the server window did not supply', () => {
    const existing = turnsToChatMessages(
      [3, 4, 5].map(number => ({
        number,
        user_input: `q${number}`,
        response: `a${number}`,
        started_at: new Date(number).toISOString(),
      }))
    )
    const incoming = turnsToChatMessages(
      [3, 5].map(number => ({
        number,
        user_input: `server q${number}`,
        response: `server a${number}`,
        started_at: new Date(number + 10).toISOString(),
      }))
    )

    const merged = mergeAuthoritativeServerMessages(existing, incoming)

    expect(merged.map(message => message.id)).toEqual([
      'turn-3-user',
      'turn-3-assistant',
      'turn-4-user',
      'turn-4-assistant',
      'turn-5-user',
      'turn-5-assistant',
    ])
    expect(
      merged.filter(message => message.serverTurnNumber === 4).map(message => message.content)
    ).toEqual(['q4', 'a4'])
  })

  it('preserves a local assistant when the server supplies only the user slot', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-9-user-local',
          role: 'user',
          content: 'local q9',
          timestamp: 1,
          serverTurnNumber: 9,
        },
        {
          id: 'turn-9-assistant-local',
          role: 'assistant',
          content: 'local a9',
          timestamp: 2,
          serverTurnNumber: 9,
        },
      ],
      [
        {
          id: 'turn-9-user',
          role: 'user',
          content: 'server q9',
          timestamp: 3,
          serverTurnNumber: 9,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual(['turn-9-user', 'turn-9-assistant-local'])
    expect(merged[1]?.content).toBe('local a9')
  })

  it('does not let an active-task claim leak stale metadata onto another server turn', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'live-optimistic',
          role: 'user',
          content: 'live prompt',
          timestamp: 1,
          task_id: 'live',
        },
        {
          id: 'stale-echo-turn4',
          role: 'user',
          content: 'stale turn 4',
          timestamp: 2,
          task_id: 'task-4',
          attachments: [
            {
              id: 'photo-4',
              type: 'uploaded_file',
              label: 'photo-4.png',
            },
          ],
        },
      ],
      [
        {
          id: 'turn-4-user',
          role: 'user',
          content: 'server turn 4',
          timestamp: 4,
          serverTurnNumber: 4,
        },
        {
          id: 'turn-5-user',
          role: 'user',
          content: 'server turn 5',
          timestamp: 5,
          serverTurnNumber: 5,
        },
      ],
      { activeTaskIds: new Set(['live']) }
    )

    const turnFive = merged.find(message => message.id === 'turn-5-user')
    expect(merged.map(message => message.id)).toContain('live-optimistic')
    expect(turnFive?.task_id).toBeUndefined()
    expect(turnFive?.attachments).toBeUndefined()
  })

  it('keeps active-task reconciliation idempotent when a same-turn neighbor appears', () => {
    const existing: ChatMessage[] = [
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'q1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant',
        content: 'a1',
        timestamp: 2,
        serverTurnNumber: 1,
      },
      {
        id: 'optimistic-user',
        role: 'user',
        content: 'q3',
        timestamp: 3,
        task_id: 'live',
      },
    ]
    const incoming = turnsToChatMessages([
      {
        number: 3,
        user_input: 'q3',
        response: 'a3',
        started_at: new Date(3).toISOString(),
      },
      {
        number: 4,
        user_input: 'q4',
        response: 'a4',
        started_at: new Date(4).toISOString(),
      },
    ])

    const firstPass = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(['live']),
    })
    const secondPass = mergeAuthoritativeServerMessages(firstPass, incoming, {
      activeTaskIds: new Set(['live']),
    })

    expect(secondPass.map(message => message.id)).toEqual(firstPass.map(message => message.id))
    expect(secondPass.filter(message => message.id === 'turn-3-user')).toHaveLength(1)
  })

  it('keeps authoritative turns through a renderer/main double merge with active tasks', () => {
    const existing: ChatMessage[] = [
      {
        id: 'turn-2-user',
        role: 'user',
        content: 'q2',
        timestamp: 1,
        serverTurnNumber: 2,
      },
      {
        id: 'turn-2-assistant',
        role: 'assistant',
        content: 'a2',
        timestamp: 2,
        serverTurnNumber: 2,
      },
      {
        id: 'turn-4-user',
        role: 'user',
        content: 'q4',
        timestamp: 4,
        serverTurnNumber: 4,
      },
      {
        id: 'optimistic-user',
        role: 'user',
        content: 'live q5',
        timestamp: 5,
        task_id: 'live',
      },
      {
        id: 'optimistic-assistant',
        role: 'assistant',
        content: 'working',
        timestamp: 6,
        task_id: 'live',
      },
    ]
    const serverWindow = turnsToChatMessages(
      [3, 4, 5, 6].map(number => ({
        number,
        user_input: `q${number}`,
        response: `a${number}`,
        started_at: new Date(number).toISOString(),
      }))
    )

    const rendered = mergeAuthoritativeServerMessages(existing, serverWindow, {
      activeTaskIds: new Set(['live']),
    })
    const persisted = mergeAuthoritativeServerMessages(existing, rendered, {
      activeTaskIds: new Set(['live']),
    })

    expect(persisted.map(message => message.id)).toContain('turn-6-user')
    expect(persisted.map(message => message.id)).toContain('turn-6-assistant')
  })

  it('reinjects turnless incoming messages that are present only in the replacement window', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'q1',
          timestamp: 1,
          serverTurnNumber: 1,
        },
      ],
      [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'q1',
          timestamp: 1,
          serverTurnNumber: 1,
        },
        {
          id: 'turn-2-user',
          role: 'user',
          content: 'q2',
          timestamp: 2,
          serverTurnNumber: 2,
        },
        {
          id: 'local-only-note',
          role: 'assistant',
          content: 'local note',
          timestamp: 3,
        },
      ]
    )

    expect(merged.map(message => message.id)).toEqual([
      'turn-1-user',
      'turn-2-user',
      'local-only-note',
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
