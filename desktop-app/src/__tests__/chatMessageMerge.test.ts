import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mergeAuthoritativeServerMessages, messageServerTurnNumber } from '../chatMessageMerge.js'
import { type ServerTurn, turnsToChatMessages } from '../serverTurnAdapter.js'
import type { ChatMessage } from '../types.js'

describe('mergeAuthoritativeServerMessages', () => {
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

  it('keeps an active optimistic message without dropping the unscoped server turn (D-3)', () => {
    // The server has not scoped its history row to the optimistic's task, so the
    // row must survive (invariant §3) while the live optimistic stays as a
    // transient duplicate that a later reconciliation collapses (§6).
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

    expect(merged.map(message => message.id)).toEqual([
      'turn-1-user',
      'optimistic-task-2',
      'turn-2-user',
    ])
    expect(merged.find(message => message.id === 'optimistic-task-2')).toEqual(
      expect.objectContaining({ content: 'second', task_id: 'task-2' })
    )
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

  it('preserves a local message interleaved between authoritative slots of one turn', () => {
    const local: ChatMessage[] = [
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'question',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'local-warning',
        role: 'system',
        content: 'local warning',
        timestamp: 2,
        preserveLocal: true,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant',
        content: 'answer',
        timestamp: 3,
        serverTurnNumber: 1,
      },
    ]
    const authoritative = turnsToChatMessages([
      {
        number: 1,
        user_input: 'question',
        response: 'answer',
        started_at: new Date(1).toISOString(),
        completed_at: new Date(3).toISOString(),
      },
    ])

    const first = mergeAuthoritativeServerMessages(local, authoritative)
    const second = mergeAuthoritativeServerMessages(first, authoritative)

    expect(first.map(message => message.id)).toEqual([
      'turn-1-user',
      'local-warning',
      'turn-1-assistant',
    ])
    expect(second).toEqual(first)
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

  it('collapses a completed local echo into its server slot without dropping the slot', () => {
    // echo-answer-A is the idle echo of turn-2-assistant; the live task-B bubble
    // must not cause the completed server row turn-2-assistant to be suppressed
    // (invariant §3). The idle local echo collapses into its server row (§6.1),
    // and every numbered server row survives.
    const serverMessages = turnsToChatMessages([
      {
        number: 2,
        user_input: 'question A',
        response: 'answer A',
        started_at: new Date(2).toISOString(),
      },
    ])
    const localMessages: ChatMessage[] = [
      serverMessages[0]!,
      {
        id: 'echo-answer-A',
        role: 'assistant',
        content: 'answer A',
        timestamp: 3,
        task_id: 'task-A',
      },
      {
        id: 'optimistic-user-B',
        role: 'user',
        content: 'question B',
        timestamp: 4,
        task_id: 'task-B',
      },
      {
        id: 'optimistic-assistant-B',
        role: 'assistant',
        content: 'working',
        timestamp: 5,
        task_id: 'task-B',
      },
    ]

    const merged = mergeAuthoritativeServerMessages(localMessages, serverMessages, {
      activeTaskIds: new Set(['task-B']),
    })

    expect(merged.map(message => message.id)).toEqual([
      'turn-2-user',
      'turn-2-assistant',
      'optimistic-user-B',
      'optimistic-assistant-B',
    ])
    // Both numbered server rows survive; the live task-B bubbles remain as
    // transient duplicates.
    expect(merged.map(message => message.id)).toEqual(
      expect.arrayContaining(['turn-2-user', 'turn-2-assistant'])
    )
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

  it.each([
    {
      name: 'settled numbered replacement',
      existing: turnsToChatMessages([
        {
          number: 1,
          user_input: 'local q1',
          response: 'local a1',
          started_at: new Date(1).toISOString(),
        },
      ]),
      incoming: turnsToChatMessages([
        {
          number: 1,
          user_input: 'server q1',
          response: 'server a1',
          started_at: new Date(2).toISOString(),
        },
        {
          number: 2,
          user_input: 'server q2',
          response: 'server a2',
          started_at: new Date(3).toISOString(),
        },
      ]),
    },
    {
      name: 'partial window with durable locals',
      existing: [
        ...turnsToChatMessages([
          {
            number: 3,
            user_input: 'local q3',
            response: 'local a3',
            started_at: new Date(3).toISOString(),
          },
        ]),
        {
          id: 'local-failed-send',
          role: 'user' as const,
          content: 'retry me',
          timestamp: 4,
          preserveLocal: true,
        },
        {
          id: 'local-error',
          role: 'assistant' as const,
          content: 'connection lost',
          timestamp: 5,
          isError: true,
        },
      ],
      incoming: turnsToChatMessages([
        {
          number: 3,
          user_input: 'server q3',
          response: 'server a3',
          started_at: new Date(6).toISOString(),
        },
        {
          number: 4,
          user_input: 'server q4',
          started_at: new Date(7).toISOString(),
        },
      ]),
    },
    {
      name: 'interleaved system message',
      existing: [
        ...turnsToChatMessages([
          {
            number: 5,
            user_input: 'local q5',
            started_at: new Date(5).toISOString(),
          },
        ]),
        {
          id: 'system-diagnostic',
          role: 'system' as const,
          content: 'local diagnostic',
          timestamp: 6,
        },
      ],
      incoming: turnsToChatMessages([
        {
          number: 5,
          user_input: 'server q5',
          response: 'server a5',
          started_at: new Date(7).toISOString(),
        },
      ]),
    },
  ])('maintains merge invariants for $name', ({ existing, incoming }) => {
    const first = mergeAuthoritativeServerMessages(existing, incoming)
    const second = mergeAuthoritativeServerMessages(first, incoming)
    const ids = first.map(message => message.id)
    const numberedTurns = first
      .map(message => message.serverTurnNumber)
      .filter((turn): turn is number => turn !== undefined)
    const durableLocalIds = existing
      .filter(message => message.preserveLocal || message.isError || message.role === 'system')
      .map(message => message.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(numberedTurns).toEqual([...numberedTurns].sort((left, right) => left - right))
    expect(second).toEqual(first)
    expect(ids).toEqual(expect.arrayContaining(durableLocalIds))
  })
})

const roleRank = (role: ChatMessage['role']): number =>
  role === 'user' ? 0 : role === 'assistant' ? 1 : 2

// Server-turn windows are derived from the real producer (T1). turnsToChatMessages
// never scopes task_id, so any generator here yields the dominant D-3 shape: every
// live optimistic sees only unscoped server rows and none is ever suppressed.
const serverTurnsArb: fc.Arbitrary<ServerTurn[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 5 })
  .map(numbers => [...numbers].sort((left, right) => left - right))
  .chain(numbers =>
    fc
      .array(fc.boolean(), { minLength: numbers.length, maxLength: numbers.length })
      .map(hasResponse =>
        numbers.map((number, index) => ({
          number,
          user_input: `server q${number}`,
          ...(hasResponse[index] ? { response: `server a${number}` } : {}),
          started_at: new Date(number).toISOString(),
        }))
      )
  )

type TurnlessSpec =
  | { kind: 'durable'; variant: 'system' | 'error' | 'preserve' }
  | { kind: 'live'; role: 'user' | 'assistant'; task: 'live-a' | 'live-b' }
  | { kind: 'idle'; role: 'user' | 'assistant'; task?: 'idle-a' | 'idle-b' }

const turnlessSpecArb: fc.Arbitrary<TurnlessSpec> = fc.oneof(
  fc.record({
    kind: fc.constant('durable' as const),
    variant: fc.constantFrom('system' as const, 'error' as const, 'preserve' as const),
  }),
  fc.record({
    kind: fc.constant('live' as const),
    role: fc.constantFrom('user' as const, 'assistant' as const),
    task: fc.constantFrom('live-a' as const, 'live-b' as const),
  }),
  fc.record({
    kind: fc.constant('idle' as const),
    role: fc.constantFrom('user' as const, 'assistant' as const),
    task: fc.option(fc.constantFrom('idle-a' as const, 'idle-b' as const), { nil: undefined }),
  })
)

interface MergeScenario {
  existing: ChatMessage[]
  incoming: ChatMessage[]
  activeTaskIds: ReadonlySet<string>
}

// A disk state is a previously-sorted transcript: numbered rows stay ascending,
// turnless durable/optimistic messages are spliced between them. The active set is
// fixed to the live-* pool so every 'live' spec is a genuine optimistic-live bubble
// — including the R1-B1 shape (no numbered rows + live optimistics + a completed
// incoming window).
const mergeScenarioArb: fc.Arbitrary<MergeScenario> = fc
  .record({
    serverTurns: serverTurnsArb,
    numberedNumbers: fc
      .uniqueArray(fc.integer({ min: 1, max: 8 }), { maxLength: 5 })
      .map(numbers => [...numbers].sort((left, right) => left - right)),
    numberedAssistant: fc.array(fc.boolean(), { maxLength: 8 }),
    turnless: fc.array(turnlessSpecArb, { maxLength: 6 }),
    inserts: fc.array(fc.nat(), { maxLength: 12 }),
  })
  .map(({ serverTurns, numberedNumbers, numberedAssistant, turnless, inserts }) => {
    const incoming = turnsToChatMessages(serverTurns)
    let uid = 0
    const numbered: ChatMessage[] = []
    numberedNumbers.forEach((number, index) => {
      numbered.push({
        id: `disk-turn-${number}-user-${uid++}`,
        role: 'user',
        content: `local q${number}`,
        timestamp: number * 10,
        serverTurnNumber: number,
      })
      if (numberedAssistant[index]) {
        numbered.push({
          id: `disk-turn-${number}-assistant-${uid++}`,
          role: 'assistant',
          content: `local a${number}`,
          timestamp: number * 10 + 1,
          serverTurnNumber: number,
        })
      }
    })
    const turnlessRows: ChatMessage[] = turnless.map((spec, index) => {
      const id = `tl-${index}-${uid++}`
      const timestamp = 1000 + index
      if (spec.kind === 'durable') {
        if (spec.variant === 'system')
          return { id, role: 'system', content: 'diagnostic', timestamp }
        if (spec.variant === 'error')
          return { id, role: 'assistant', content: 'error', timestamp, isError: true }
        return { id, role: 'user', content: 'retry me', timestamp, preserveLocal: true }
      }
      return { id, role: spec.role, content: `optimistic ${index}`, timestamp, task_id: spec.task }
    })
    const existing = [...numbered]
    turnlessRows.forEach((row, index) => {
      const position =
        existing.length === 0 ? 0 : (inserts[index] ?? existing.length) % (existing.length + 1)
      existing.splice(position, 0, row)
    })
    return { existing, incoming, activeTaskIds: new Set(['live-a', 'live-b']) }
  })

describe('mergeAuthoritativeServerMessages property invariants (R1-B1)', () => {
  it('holds all six merge properties under fuzzing including the active-task path', () => {
    const durableIds = (messages: ChatMessage[]) =>
      messages.filter(m => m.role === 'system' || m.isError || m.preserveLocal).map(m => m.id)
    const numberedIds = (messages: ChatMessage[]) =>
      messages.filter(m => messageServerTurnNumber(m) !== undefined).map(m => m.id)

    fc.assert(
      fc.property(mergeScenarioArb, ({ existing, incoming, activeTaskIds }) => {
        const merged = mergeAuthoritativeServerMessages(existing, incoming, { activeTaskIds })
        const mergedIds = merged.map(m => m.id)

        // Property 3: no duplicate ids.
        expect(new Set(mergedIds).size).toBe(mergedIds.length)

        // Property 1: every incoming server row with a turn number survives by id
        // (this is the one that catches R1-B1 — no server row is ever suppressed).
        for (const server of incoming) {
          if (messageServerTurnNumber(server) !== undefined) {
            expect(mergedIds).toContain(server.id)
          }
        }

        // Property 2: numbered output is ordered by (turn, roleRank).
        const orderKeys = merged
          .filter(m => messageServerTurnNumber(m) !== undefined)
          .map(m => [messageServerTurnNumber(m)!, roleRank(m.role)] as const)
        for (let index = 1; index < orderKeys.length; index += 1) {
          const [previousTurn, previousRank] = orderKeys[index - 1]!
          const [turn, rank] = orderKeys[index]!
          expect(previousTurn < turn || (previousTurn === turn && previousRank <= rank)).toBe(true)
        }

        // Property 4: durable locals (system/error/preserveLocal) are never lost.
        for (const id of durableIds(existing)) {
          expect(mergedIds).toContain(id)
        }

        // Property 5: idempotence, including the active-task path.
        const remerged = mergeAuthoritativeServerMessages(merged, incoming, { activeTaskIds })
        expect(remerged).toEqual(merged)

        // Property 6: composability at the renderer/main seam — reapplying the same
        // authoritative window preserves the numbered subsequence exactly.
        expect(numberedIds(remerged)).toEqual(numberedIds(merged))
      }),
      { numRuns: 40000 }
    )
  }, 120000)
})

describe('mergeAuthoritativeServerMessages invariant §3 (R1-B1)', () => {
  it('never drops a completed server turn because a live turnless optimistic is present', () => {
    // Exact reproduction of mini-spec §2: disk holds only two live optimistic
    // bubbles for task-1, the server replaces with a completed turn-1, task-1 is
    // still active. The completed server turn must not disappear.
    const incoming = turnsToChatMessages([
      {
        number: 1,
        user_input: 'live question',
        response: 'live answer',
        started_at: new Date(1).toISOString(),
      },
    ])
    const existing: ChatMessage[] = [
      { id: 'opt-user', role: 'user', content: 'live question', timestamp: 10, task_id: 'task-1' },
      {
        id: 'opt-assistant',
        role: 'assistant',
        content: 'working',
        timestamp: 11,
        task_id: 'task-1',
      },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(['task-1']),
    })

    const ids = merged.map(message => message.id)
    expect(ids).toContain('turn-1-user')
    expect(ids).toContain('turn-1-assistant')
  })
})

describe('mergeAuthoritativeServerMessages unique claim (D-1 ↔ D-2)', () => {
  // The server does not scope task_id on history rows today (mini-spec §6), so a
  // task-scoped server row cannot come from turnsToChatMessages. We derive the base
  // row from the real producer and add the scope by hand to exercise D-1/D-2 — the
  // one place the code must stay correct for if the server ever gains the field.
  const scopedServerUserRow = (task: string): ChatMessage => {
    const [base] = turnsToChatMessages([
      { number: 1, user_input: 'q1', started_at: new Date(1).toISOString() },
    ])
    return { ...base!, task_id: task }
  }

  it('D-1: a single live optimistic is consumed by its exact-task server row', () => {
    const merged = mergeAuthoritativeServerMessages(
      [{ id: 'opt-1', role: 'user', content: 'q1', timestamp: 5, task_id: 'task-x' }],
      [scopedServerUserRow('task-x')],
      { activeTaskIds: new Set(['task-x']) }
    )

    expect(merged.map(message => message.id)).toEqual(['turn-1-user'])
  })

  it('D-2: two live optimistics of the same role/task neither double-claim the row nor lose a local', () => {
    const merged = mergeAuthoritativeServerMessages(
      [
        { id: 'opt-1', role: 'user', content: 'q1', timestamp: 5, task_id: 'task-x' },
        { id: 'opt-2', role: 'user', content: 'q1b', timestamp: 6, task_id: 'task-x' },
      ],
      [scopedServerUserRow('task-x')],
      { activeTaskIds: new Set(['task-x']) }
    )

    const ids = merged.map(message => message.id)
    // The single server row is claimed by neither local; both locals survive and
    // the server row is preserved (Property 1).
    expect(ids).toEqual(expect.arrayContaining(['opt-1', 'opt-2', 'turn-1-user']))
    expect(ids).toHaveLength(3)
  })
})

describe('mergeAuthoritativeServerMessages — R2-H1 idle echo liveness (§6.1, prop #7)', () => {
  // Models the active -> idle transition the real flow performs across TWO merge
  // calls with different activeTaskIds:
  //   1. active reconcile persists the numbered server turn NEXT TO the still-live
  //      optimistic bubble (D-3, what fix 229369e4 now does).
  //   2. the task leaves activeTaskIds (idle).
  //   3. the idle reconcile MUST collapse the residual optimistic echo — but only
  //      because its content matches the adjacent numbered turn (gate (b)).
  // Assertion is on the observable id list the user sees (T4).
  it('collapses the transient duplicate once the task leaves activeTaskIds (exact repro)', () => {
    // Server window derived from the real producer (T1): no hand-built rows.
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'first', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'second', started_at: new Date(3).toISOString() },
    ])

    // Disk after the ACTIVE reconcile of task-2: the numbered turn-2-user the fix
    // now persists sits as the immediate numbered neighbour of the still-turnless
    // optimistic bubble, whose content ('second') mirrors turn-2-user.
    const activePersisted: ChatMessage[] = [
      { id: 'turn-1-user', role: 'user', content: 'first', timestamp: 1, serverTurnNumber: 1 },
      { id: 'optimistic-task-2', role: 'user', content: 'second', timestamp: 2, task_id: 'task-2' },
      { id: 'turn-2-user', role: 'user', content: 'second', timestamp: 3, serverTurnNumber: 2 },
    ]

    // While task-2 is still active the duplicate is tolerated (§3 / D-3).
    const activeMerge = mergeAuthoritativeServerMessages(activePersisted, incoming, {
      activeTaskIds: new Set(['task-2']),
    })
    expect(activeMerge.map(m => m.id)).toContain('optimistic-task-2')
    expect(activeMerge.map(m => m.id)).toEqual(
      expect.arrayContaining(['turn-1-user', 'turn-2-user'])
    )

    // Transition to idle: task-2 has left activeTaskIds. The echo collapses because
    // its content == turn-2-user; both server turns remain. FAILS against 229369e4.
    const idleMerge = mergeAuthoritativeServerMessages(activePersisted, incoming, {
      activeTaskIds: new Set(),
    })
    expect(idleMerge.map(m => m.id)).toEqual(['turn-1-user', 'turn-2-user'])

    // Convergence: re-applying the merge does not re-materialise the echo.
    const reMerge = mergeAuthoritativeServerMessages(idleMerge, incoming, {
      activeTaskIds: new Set(),
    })
    expect(reMerge.map(m => m.id)).toEqual(['turn-1-user', 'turn-2-user'])
  })

  it('compares the idle echo against the authoritative incoming row, not the stale disk neighbour (STALE/FRESH)', () => {
    // Regression for the R2-H1 content-gate defect: the collapse gate must compare
    // the idle local against the AUTHORITATIVE incoming row that fills the neighbour
    // slot, not against the stale numbered neighbour from `existing`. Here the disk
    // turn-2-user still holds the pre-reconcile text 'STALE'; incoming carries the
    // fresh 'FRESH' for that same slot. The idle optimistic content 'STALE' equals
    // the STALE disk neighbour but NOT the FRESH authoritative row that actually
    // lands in the output. Dropping it would erase local text that is nowhere in the
    // output. Server rows are derived from the real producer (T1).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'A', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'FRESH', started_at: new Date(3).toISOString() },
    ])
    const existing: ChatMessage[] = [
      { id: 'turn-1-user', role: 'user', content: 'A', timestamp: 1, serverTurnNumber: 1 },
      {
        id: 'optimistic-stale',
        role: 'user',
        content: 'STALE',
        timestamp: 2,
        task_id: 'done-task',
      },
      { id: 'turn-2-user', role: 'user', content: 'STALE', timestamp: 2, serverTurnNumber: 2 },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })
    const ids = merged.map(m => m.id)

    // The local's text must survive: the optimistic is not dropped, because its
    // content matches neither authoritative neighbour (turn-1='A', turn-2='FRESH').
    expect(ids).toContain('optimistic-stale')
    expect(merged.find(m => m.id === 'optimistic-stale')).toEqual(
      expect.objectContaining({ content: 'STALE' })
    )
    // 'STALE' text is present in the output at least once (via the surviving local).
    expect(merged.some(m => m.content === 'STALE')).toBe(true)
    // Non-reintroduction of R1-B1: both authoritative rows survive, carrying FRESH.
    expect(ids).toEqual(expect.arrayContaining(['turn-1-user', 'turn-2-user']))
    expect(merged.find(m => m.id === 'turn-2-user')?.content).toBe('FRESH')
  })

  it('does NOT drop an idle orphan whose content diverges from its numbered neighbours (gate (b))', () => {
    // The key test of remediation (b): an accepted task that never registered a
    // server turn (cancelled-in-queue / budget-denied / persistTurnStart failure,
    // verified in mcp-host) leaves a turnless idle non-durable user message. When
    // it lands sandwiched between two consecutive same-role numbered turns, the
    // content-blind positional rule would delete it — LOSING local text. The
    // content gate keeps it because its content ('B') matches neither neighbour.
    // Server turns are derived from the real producer (T1).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'A', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'C', started_at: new Date(3).toISOString() },
    ])
    const [turn1User, turn2User] = incoming
    const existing: ChatMessage[] = [
      turn1User!,
      { id: 'orphan-user', role: 'user', content: 'B', timestamp: 2, task_id: 'done-task' },
      turn2User!,
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })

    // The orphan survives (at worst a duplicate) — no local text is lost.
    expect(merged.map(m => m.id)).toContain('orphan-user')
    expect(merged.find(m => m.id === 'orphan-user')).toEqual(
      expect.objectContaining({ content: 'B' })
    )
    // Non-reintroduction of R1-B1: both numbered server rows survive.
    expect(merged.map(m => m.id)).toEqual(expect.arrayContaining(['turn-1-user', 'turn-2-user']))
  })

  it('does NOT collapse an optimistic-live bubble even when slot-saturated (I-5 gate)', () => {
    // Same sandwich shape and matching content as the exact repro, but the task is
    // ACTIVE: the in-flight bubble must remain visible in the UI (§1/§3, I-5).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'first', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'second', started_at: new Date(3).toISOString() },
    ])
    const existing: ChatMessage[] = [
      { id: 'turn-1-user', role: 'user', content: 'first', timestamp: 1, serverTurnNumber: 1 },
      { id: 'optimistic-task-2', role: 'user', content: 'second', timestamp: 2, task_id: 'task-2' },
      { id: 'turn-2-user', role: 'user', content: 'second', timestamp: 3, serverTurnNumber: 2 },
    ]
    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(['task-2']),
    })
    expect(merged.map(m => m.id)).toContain('optimistic-task-2')
  })

  it('property: a same-role sandwiched idle echo collapses, an orphan survives, and no numbered row is lost', () => {
    const durableIds = (messages: ChatMessage[]) =>
      messages.filter(m => m.role === 'system' || m.isError || m.preserveLocal).map(m => m.id)
    const numberedIds = (messages: ChatMessage[]) =>
      messages.filter(m => messageServerTurnNumber(m) !== undefined).map(m => m.id)

    const scenarioArb = fc.record({
      start: fc.integer({ min: 1, max: 6 }),
      role: fc.constantFrom<'user' | 'assistant'>('user', 'assistant'),
      // fresh-echo -> content mirrors the AUTHORITATIVE incoming row (collapses when
      //   idle); stale-echo -> content mirrors a STALE disk neighbour that diverges
      //   from incoming for the same slot (must NOT collapse — its text is nowhere
      //   in the output otherwise); orphan -> content matches neither (survives).
      bubbleMode: fc.constantFrom<'fresh-echo' | 'stale-echo' | 'orphan'>(
        'fresh-echo',
        'stale-echo',
        'orphan'
      ),
      // If active, the bubble is optimistic-live and must never collapse (I-5).
      active: fc.boolean(),
      // R2-M1: whether the optimistic bubble carries side metadata
      // (toolSteps/attachments) that the reconciled server row does NOT have. When
      // an idle echo collapses, that metadata must survive on the authoritative row.
      withMeta: fc.boolean(),
    })

    fc.assert(
      fc.property(scenarioArb, ({ start, role, bubbleMode, active, withMeta }) => {
        const turns = [
          { number: start, user_input: `q${start}`, started_at: new Date(start).toISOString() },
          {
            number: start + 1,
            user_input: `q${start + 1}`,
            started_at: new Date(start + 1).toISOString(),
          },
        ]
        // Keep only the requested role slot so the bubble is truly sandwiched by
        // two consecutive same-role numbered turns (Q = P + 1). turnsToChatMessages
        // emits an assistant slot only when a response is present; there is none
        // here, so for the assistant role there is no sandwich to build.
        const numbered = turnsToChatMessages(turns).filter(m => m.role === role)
        if (numbered.length !== 2) return
        const [low, high] = numbered
        const incoming = numbered
        // The disk copy of the higher numbered neighbour. In stale-echo it carries a
        // pre-reconcile text that diverges from the authoritative incoming row for the
        // same (turn, role) slot; the first loop replaces it with the fresh incoming
        // row in the output, so a gate comparing against this disk row would false-
        // match and drop a local whose text never reaches the output.
        const staleContent = `stale-${start + 1}`
        const diskHigh: ChatMessage =
          bubbleMode === 'stale-echo' ? { ...high!, content: staleContent } : high!
        const bubbleContent =
          bubbleMode === 'fresh-echo'
            ? high!.content
            : bubbleMode === 'stale-echo'
              ? staleContent
              : `orphan-${start}`
        // R2-M1: side metadata the reconciled server rows never carry. When the
        // idle echo collapses it must be merged onto the authoritative row.
        const bubbleToolSteps = [
          { toolName: 'search', displayName: 'Search', state: 'completed' as const },
        ]
        const bubbleAttachments = [
          { id: 'echo-file', type: 'response_file' as const, label: 'result.txt' },
        ]
        const bubble: ChatMessage = {
          id: 'sandwiched-bubble',
          role,
          content: bubbleContent,
          timestamp: 999,
          task_id: 'the-task',
          ...(withMeta ? { toolSteps: bubbleToolSteps, attachments: bubbleAttachments } : {}),
        }
        const existing: ChatMessage[] = [low!, bubble, diskHigh]

        const activeTaskIds = active ? new Set(['the-task']) : new Set<string>()
        const merged = mergeAuthoritativeServerMessages(existing, incoming, { activeTaskIds })
        const ids = merged.map(m => m.id)

        // Prop #7 liveness: ONLY an idle bubble whose content matches the AUTHORITATIVE
        // incoming row collapses. A live bubble (I-5), a content-divergent orphan, and
        // a stale-echo (matches the disk neighbour but not incoming) all survive —
        // gate (b) plus the authoritative-comparison fix: no local text is lost.
        if (bubbleMode === 'fresh-echo' && !active) {
          expect(ids).not.toContain('sandwiched-bubble')
          // R2-M1: the collapsed echo's side metadata survives on the surviving
          // authoritative row (never dropped with the local, never rewriting content).
          if (withMeta) {
            const authRow = merged.find(m => m.serverTurnNumber === start + 1 && m.role === role)
            expect(authRow?.toolSteps).toEqual(bubbleToolSteps)
            expect(authRow?.attachments).toEqual(bubbleAttachments)
          }
          // The done task's identity never leaks onto a numbered server row (§6.2).
          for (const server of incoming) {
            expect(merged.find(m => m.id === server.id)?.task_id).toBeUndefined()
          }
        } else {
          expect(ids).toContain('sandwiched-bubble')
          // The surviving bubble keeps its original text in the output.
          expect(merged.find(m => m.id === 'sandwiched-bubble')?.content).toBe(bubbleContent)
          // R2-M1: an un-collapsed bubble keeps its own metadata and never leaks it
          // onto the authoritative row (no false merge).
          if (withMeta) {
            expect(merged.find(m => m.id === 'sandwiched-bubble')?.toolSteps).toEqual(
              bubbleToolSteps
            )
          }
        }
        // The authoritative higher turn always lands with its FRESH content.
        expect(merged.find(m => m.serverTurnNumber === start + 1 && m.role === role)?.content).toBe(
          high!.content
        )

        // Prop #1: no numbered server row is ever suppressed (R1-B1 guard).
        for (const server of incoming) {
          if (messageServerTurnNumber(server) !== undefined) {
            expect(ids).toContain(server.id)
          }
        }
        // Prop #3: no duplicate ids.
        expect(new Set(ids).size).toBe(ids.length)
        // Prop #2: numbered output ordered by (turn, roleRank).
        const orderKeys = merged
          .filter(m => messageServerTurnNumber(m) !== undefined)
          .map(m => [messageServerTurnNumber(m)!, roleRank(m.role)] as const)
        for (let index = 1; index < orderKeys.length; index += 1) {
          const [previousTurn, previousRank] = orderKeys[index - 1]!
          const [turn, rank] = orderKeys[index]!
          expect(previousTurn < turn || (previousTurn === turn && previousRank <= rank)).toBe(true)
        }
        // Prop #4: durable locals never lost (none here, but the invariant holds).
        for (const id of durableIds(existing)) expect(ids).toContain(id)
        // Prop #5 idempotence + Prop #6 composability at the seam.
        const remerged = mergeAuthoritativeServerMessages(merged, incoming, { activeTaskIds })
        expect(remerged).toEqual(merged)
        expect(numberedIds(remerged)).toEqual(numberedIds(merged))
      }),
      { numRuns: 20000 }
    )
  }, 120000)
})

describe('mergeAuthoritativeServerMessages — R2-M1 idle echo metadata precedence (§6.2)', () => {
  it('R2-M1: preserves a collapsed idle echo side metadata (toolSteps/attachments) on the authoritative row', () => {
    // Regression for R2-M1 (regression of 40cc7afe): a drop-only collapse discarded
    // the optimistic bubble's toolSteps/attachments that the reconciled server row
    // does not carry. Server rows are derived from the real producer (T1) and carry
    // NO tool_steps here, so the metadata lives only on the local bubble. After the
    // idle collapse the metadata must land on the surviving authoritative row (T4).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'q1', response: 'a1', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'q2', response: 'a2', started_at: new Date(2).toISOString() },
    ])
    const optimisticEcho: ChatMessage = {
      id: 'optimistic-assistant',
      role: 'assistant',
      content: 'a2', // mirrors turn-2-assistant → collapses once idle (I-1)
      timestamp: 999,
      task_id: 'done-task',
      toolSteps: [{ toolName: 'search', displayName: 'Search', state: 'completed' }],
      attachments: [{ id: 'echo-file', type: 'response_file', label: 'result.txt' }],
    }
    const existing: ChatMessage[] = [
      {
        id: 'turn-1-assistant',
        role: 'assistant',
        content: 'a1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      optimisticEcho,
      {
        id: 'turn-2-assistant',
        role: 'assistant',
        content: 'a2',
        timestamp: 3,
        serverTurnNumber: 2,
      },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })

    // The echo collapsed (drop of the local), the authoritative row survives.
    expect(merged.map(m => m.id)).not.toContain('optimistic-assistant')
    const outputTurn2Assistant = merged.find(m => m.id === 'turn-2-assistant')
    expect(outputTurn2Assistant).toBeDefined()
    // The side metadata the bubble accumulated survives on the authoritative row.
    expect(outputTurn2Assistant?.toolSteps).toEqual(optimisticEcho.toolSteps)
    expect(outputTurn2Assistant?.attachments).toEqual(optimisticEcho.attachments)
    // content is NOT rewritten (loss-safety of text, §6.2).
    expect(outputTurn2Assistant?.content).toBe('a2')
    // The done task's identity is NOT leaked onto the historical server row (§6.2).
    expect(outputTurn2Assistant?.task_id).toBeUndefined()
    // Non-reintroduction of R1-B1: every numbered server row survives.
    for (const server of incoming) {
      if (messageServerTurnNumber(server) !== undefined) {
        expect(merged.map(m => m.id)).toContain(server.id)
      }
    }
  })

  it('R2-M1: collapse does not leak the idle echo task_id onto the historical server row', () => {
    // Extends the ':602' stale-metadata guard to the COLLAPSE path (F1 regression of
    // d8f45d34): the chained copy used preferredServerMessage, which propagates
    // task_id (local.task_id ?? server.task_id), tagging the historical numbered row
    // with the done task's id. That id leak would break task_id-based dedupe in
    // useAgentChatController (noop) and useChatNotifications (toast dedupe). The
    // collapse must copy attachments/toolSteps ONLY, never task_id. Server rows are
    // derived from the real producer (T1).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'q1', response: 'a1', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'q2', response: 'a2', started_at: new Date(2).toISOString() },
    ])
    const idleEcho: ChatMessage = {
      id: 'idle-echo-assistant',
      role: 'assistant',
      content: 'a2', // mirrors turn-2-assistant → collapses once idle (I-1)
      timestamp: 999,
      task_id: 'done-task',
      toolSteps: [{ toolName: 'search', displayName: 'Search', state: 'completed' }],
    }
    const existing: ChatMessage[] = [
      {
        id: 'turn-1-assistant',
        role: 'assistant',
        content: 'a1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      idleEcho,
      {
        id: 'turn-2-assistant',
        role: 'assistant',
        content: 'a2',
        timestamp: 3,
        serverTurnNumber: 2,
      },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })

    // The echo collapsed; the authoritative row survives.
    expect(merged.map(m => m.id)).not.toContain('idle-echo-assistant')
    const outputTurn2Assistant = merged.find(m => m.id === 'turn-2-assistant')
    expect(outputTurn2Assistant).toBeDefined()
    // task_id identity is NOT leaked onto the historical server row.
    expect(outputTurn2Assistant?.task_id).toBeUndefined()
    // No OTHER authoritative row picks up the done task_id either.
    for (const server of incoming) {
      if (messageServerTurnNumber(server) !== undefined) {
        expect(merged.find(m => m.id === server.id)?.task_id).toBeUndefined()
      }
    }
    // The durable side metadata still survives (the R2-M1 preservation is intact).
    expect(outputTurn2Assistant?.toolSteps).toEqual(idleEcho.toolSteps)
  })

  it('R2-M1: does not collapse a text-less idle bubble on empty-content coincidence', () => {
    // The collapse gate used strict equality, so '' === '' fired on an
    // attachment-only bubble sandwiched between two empty-content numbered turns.
    // §6.2 requires truthy content on both sides: a text-less bubble is not a text
    // echo and must survive with its attachment. Server rows come from the real
    // producer (T1).
    const incoming = turnsToChatMessages([
      { number: 1, user_input: '', started_at: new Date(1).toISOString() },
      { number: 2, user_input: '', started_at: new Date(2).toISOString() },
    ])
    const attachmentOnly: ChatMessage = {
      id: 'attachment-only',
      role: 'user',
      content: '',
      timestamp: 999,
      task_id: 'done-task',
      attachments: [{ id: 'file-9', type: 'uploaded_file', label: 'photo.png' }],
    }
    const existing: ChatMessage[] = [
      { id: 'turn-1-user', role: 'user', content: '', timestamp: 1, serverTurnNumber: 1 },
      attachmentOnly,
      { id: 'turn-2-user', role: 'user', content: '', timestamp: 3, serverTurnNumber: 2 },
    ]

    const merged = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })

    // The empty bubble is not a text echo: it survives with its attachment.
    expect(merged.map(m => m.id)).toContain('attachment-only')
    expect(merged.find(m => m.id === 'attachment-only')?.attachments).toEqual(
      attachmentOnly.attachments
    )
    // Non-reintroduction of R1-B1: both numbered server rows survive.
    expect(merged.map(m => m.id)).toEqual(expect.arrayContaining(['turn-1-user', 'turn-2-user']))
  })
})
