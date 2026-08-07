import { describe, expect, it } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../../../../src/chatMessageMerge'
import type { ChatMessage } from '../../../../src/types'
import { turnsToChatMessages } from '../sessionAdapter'

describe('turnsToChatMessages', () => {
  it('maps an empty turn list to an empty message array', () => {
    expect(turnsToChatMessages([])).toEqual([])
  })

  it('maps a completed turn to one user + one assistant message', () => {
    const msgs = turnsToChatMessages([
      {
        number: 1,
        user_input: 'hello',
        response: 'hi',
        started_at: '2026-04-22T10:00:00Z',
        completed_at: '2026-04-22T10:00:01Z',
      },
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'hi' })
  })

  it('maps an in-flight turn (no response) to a single user message', () => {
    const msgs = turnsToChatMessages([
      {
        number: 1,
        user_input: 'hello',
        started_at: '2026-04-22T10:00:00Z',
      },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('strips legacy attached context text from server turns', () => {
    const msgs = turnsToChatMessages([
      {
        number: 1,
        user_input: 'hello\n\n[Attached context]\n- mcp-coingecko-remote',
        started_at: '2026-04-22T10:00:00Z',
      },
    ])

    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(msgs[0]?.attachments).toMatchObject([
      { type: 'connector', label: 'mcp-coingecko-remote' },
    ])
  })

  it('merges an image-only optimistic turn using producer-shaped attachments', () => {
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
    const incoming = turnsToChatMessages([
      {
        number: 7,
        user_input: '[Attached images]\n- photo.png',
        response: 'done',
        started_at: new Date(120_001).toISOString(),
        completed_at: new Date(120_002).toISOString(),
      },
    ])

    const merged = mergeAuthoritativeServerMessages(existing, incoming)

    expect(merged.map(message => message.id)).toEqual(['turn-7-user', 'turn-7-assistant'])
    expect(merged[0]?.attachments).toMatchObject([{ type: 'uploaded_file', label: 'photo.png' }])
  })

  it('preserves turn order for multi-turn transcripts', () => {
    const msgs = turnsToChatMessages([
      { number: 1, user_input: 'a', response: 'A', started_at: '2026-04-22T10:00:00Z' },
      { number: 2, user_input: 'b', response: 'B', started_at: '2026-04-22T10:01:00Z' },
    ])
    expect(msgs.map(m => m.content)).toEqual(['a', 'A', 'b', 'B'])
  })

  it('copies per-turn tokens onto the assistant message (not the user message)', () => {
    const msgs = turnsToChatMessages([
      {
        number: 1,
        user_input: 'hello',
        response: 'hi',
        started_at: '2026-04-22T10:00:00Z',
        completed_at: '2026-04-22T10:00:01Z',
        tokens: { input: 130, output: 50, cacheRead: 10, cacheWrite: 0 },
      },
    ])
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[0]?.tokens).toBeUndefined()
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      tokens: { input: 130, output: 50, cacheRead: 10, cacheWrite: 0 },
    })
  })

  it('leaves the assistant message without tokens when the turn has none', () => {
    const msgs = turnsToChatMessages([
      { number: 1, user_input: 'a', response: 'A', started_at: '2026-04-22T10:00:00Z' },
    ])
    expect(msgs[1]?.tokens).toBeUndefined()
  })

  it('copies tool_steps onto the assistant message so they survive a reload (#582)', () => {
    const msgs = turnsToChatMessages([
      {
        number: 1,
        user_input: 'busca noticias',
        response: 'aquí están',
        started_at: '2026-06-17T10:00:00Z',
        completed_at: '2026-06-17T10:00:40Z',
        tool_steps: [
          {
            toolName: 'web-research__fetch_page',
            displayName: 'Web research',
            state: 'completed',
            durationMs: 40000,
          },
        ],
      },
    ])
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[0]?.toolSteps).toBeUndefined()
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      toolSteps: [
        {
          toolName: 'web-research__fetch_page',
          displayName: 'Web research',
          state: 'completed',
          durationMs: 40000,
        },
      ],
    })
  })

  it('leaves the assistant message without toolSteps when the turn made no tool calls', () => {
    const msgs = turnsToChatMessages([
      { number: 1, user_input: 'a', response: 'A', started_at: '2026-04-22T10:00:00Z' },
    ])
    expect(msgs[1]?.toolSteps).toBeUndefined()
  })
})
