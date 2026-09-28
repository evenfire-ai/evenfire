import { describe, expect, it } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../../../../src/chatMessageMerge'
import type { ChatMessage } from '../../../../src/types'
import {
  buildComposerReferencesPromptSection,
  buildComposerRequestContent,
} from '../../lib/composerReferencesPrompt'
import { buildComposerResendDraft } from '../../lib/composerResend'
import type { ComposerReferenceAttachment } from '../../uiTypes'
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

  it('reconciles two same-name server image chips without duplicates or resend warnings', () => {
    const incoming = turnsToChatMessages([
      {
        number: 8,
        user_input: [
          'Analyze charts',
          '[Attached images]',
          '- chart.png',
          '- chart.png',
          'USER-ATTACHED CONTEXT: The user selected these capabilities/files for this message.',
          'Plugins: profits/revenue. Use workflow tools.',
        ].join('\n'),
        started_at: new Date(120_003).toISOString(),
      },
    ])
    const existing: ChatMessage[] = [
      {
        id: 'optimistic-user',
        role: 'user',
        content: 'Analyze charts',
        timestamp: 1,
        attachments: [
          {
            id: 'first',
            type: 'uploaded_file',
            label: 'chart.png',
            filename: 'chart.png',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: 'AQ==',
            sizeBytes: 1,
          },
          {
            id: 'second',
            type: 'uploaded_file',
            label: 'chart.png',
            filename: 'chart.png',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: 'Ag==',
            sizeBytes: 1,
          },
        ],
      },
    ]
    const merged = mergeAuthoritativeServerMessages(existing, incoming)
    const user = merged.find(message => message.id === 'turn-8-user')!
    expect(user.attachments?.map(attachment => attachment.type)).toEqual([
      'uploaded_file',
      'uploaded_file',
      'plugin',
    ])
    expect(
      user.attachments?.filter(attachment => attachment.type === 'uploaded_file')
    ).toMatchObject([
      { label: 'chart.png', dataBase64: 'AQ==' },
      { label: 'chart.png', dataBase64: 'Ag==' },
    ])
    const draft = buildComposerResendDraft(user)
    expect(draft.imageAttachments.map(image => image.dataBase64)).toEqual(['AQ==', 'Ag=='])
    expect(draft.unrestorable).toEqual([])
  })

  it('retains agent and global file identity from a real server input through Resend', () => {
    const references: ComposerReferenceAttachment[] = [
      {
        id: 'agent-file',
        type: 'agent_file',
        contextId: 'ctx-1',
        filesystemName: 'shared-fs',
        path: 'notes/todo.md',
        kind: 'file',
        label: 'todo.md',
      },
      {
        id: 'global-file',
        type: 'global_file',
        drive: 'drive-7',
        resourceId: 'res-9',
        gfsUri: 'gfs://drive-7/res-9',
        label: 'Report',
      },
    ]
    const [serverUser] = turnsToChatMessages([
      {
        number: 9,
        user_input: buildComposerRequestContent('Read these files', references),
        started_at: new Date(120_004).toISOString(),
      },
    ])
    expect(serverUser?.content).toBe('Read these files')
    expect(serverUser?.attachments).toMatchObject([
      { type: 'agent_file', label: 'todo.md', filesystemName: 'shared-fs', path: 'notes/todo.md' },
      {
        type: 'global_file',
        label: 'Report',
        drive: 'drive-7',
        resourceId: 'res-9',
        gfsUri: 'gfs://drive-7/res-9',
      },
    ])
    const draft = buildComposerResendDraft(serverUser!)
    expect(draft.unrestorable).toEqual([])
    expect(buildComposerReferencesPromptSection(draft.referenceAttachments)).toBe(
      buildComposerReferencesPromptSection(references)
    )
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
