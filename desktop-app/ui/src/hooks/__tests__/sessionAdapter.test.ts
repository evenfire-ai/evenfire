import { describe, expect, it } from 'vitest'
import { mergeAuthoritativeServerMessages } from '../../../../src/chatMessageMerge'
import type { ChatMessage } from '../../../../src/types'
import {
  buildChatMessageAttachments,
  buildResponseFileAttachments,
} from '../../lib/chatMessageAttachments'
import { buildComposerRequestContent } from '../../lib/composerReferencesPrompt'
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

  it('keeps an image-only optimistic turn without a proved server identity', () => {
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

    expect(merged.map(message => message.id)).toEqual([
      'optimistic-user',
      'turn-7-user',
      'turn-7-assistant',
    ])
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
        ...incoming[0]!,
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

  it('retains agent file identity and flags a server global-file label without a URI', () => {
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
        version: 3,
        bytes: 4096,
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
      },
    ])
    const draft = buildComposerResendDraft(serverUser!)
    expect(draft.referenceAttachments).toMatchObject([
      { type: 'agent_file', filesystemName: 'shared-fs', path: 'notes/todo.md' },
    ])
    expect(draft.referenceAttachments).toHaveLength(1)
    expect(draft.unrestorable).toEqual([{ type: 'global_file', label: 'Report' }])
  })

  it('retains two versioned same-label global files on their identified server turn', () => {
    const references: ComposerReferenceAttachment[] = [
      {
        id: 'first-global',
        type: 'global_file',
        label: 'Report',
        drive: 'drive-7',
        resourceId: 'first',
        gfsUri: 'gfs://drive-7/first',
        version: 3,
        bytes: 4096,
      },
      {
        id: 'second-global',
        type: 'global_file',
        label: 'Report',
        drive: 'drive-7',
        resourceId: 'second',
        gfsUri: 'gfs://drive-7/second',
        version: 8,
        bytes: 8192,
      },
    ]
    const incoming = turnsToChatMessages([
      {
        number: 9,
        user_input: buildComposerRequestContent('Compare both reports', references),
        started_at: new Date(9).toISOString(),
      },
    ])
    expect(incoming[0]?.attachments).toMatchObject([
      { type: 'global_file', label: 'Report' },
      { type: 'global_file', label: 'Report' },
    ])
    const local: ChatMessage = {
      ...incoming[0]!,
      attachments: buildChatMessageAttachments([], references, []),
    }
    const once = mergeAuthoritativeServerMessages([local], incoming)
    const twice = mergeAuthoritativeServerMessages(once, incoming)
    expect(twice).toEqual(once)
    expect(once).toHaveLength(1)
    expect(once[0]?.attachments).toHaveLength(2)
    const draft = buildComposerResendDraft(once[0]!)
    expect(draft.referenceAttachments).toMatchObject([
      { type: 'global_file', gfsUri: 'gfs://drive-7/first', version: 3, bytes: 4096 },
      { type: 'global_file', gfsUri: 'gfs://drive-7/second', version: 8, bytes: 8192 },
    ])
    expect(draft.unrestorable).toEqual([])
  })

  it('does not resend references from a same-text idle echo onto a context-free server turn', () => {
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'first', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'repeat', started_at: new Date(3).toISOString() },
    ])
    const localEcho: ChatMessage = {
      id: 'idle-echo',
      role: 'user',
      content: 'repeat',
      timestamp: 2,
      task_id: 'settled-task',
      attachments: [
        { id: 'plugin', type: 'plugin', label: 'profits/revenue' },
        {
          id: 'agent-file',
          type: 'agent_file',
          label: 'todo.md',
          filesystemName: 'shared-fs',
          path: 'notes/todo.md',
        },
        {
          id: 'global-file',
          type: 'global_file',
          label: 'Report',
          gfsUri: 'gfs://drive-7/res-9',
          drive: 'drive-7',
          resourceId: 'res-9',
        },
        {
          id: 'image',
          type: 'uploaded_file',
          label: 'chart.png',
          filename: 'chart.png',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: 'AQ==',
          sizeBytes: 1,
        },
      ],
    }
    const merged = mergeAuthoritativeServerMessages(
      [incoming[0]!, localEcho, incoming[1]!],
      incoming,
      { activeTaskIds: new Set() }
    )
    expect(merged.map(message => message.id)).toEqual(['turn-1-user', 'idle-echo', 'turn-2-user'])
    const serverUser = merged[2]!
    expect(serverUser.attachments).toBeUndefined()
    const draft = buildComposerResendDraft(serverUser)
    expect(draft.content).toBe('repeat')
    expect(draft.imageAttachments).toHaveLength(0)
    expect(draft.referenceAttachments).toEqual([])
    expect(draft.unrestorable).toEqual([])
    expect(buildComposerResendDraft(merged[1]!).imageAttachments[0]?.dataBase64).toBe('AQ==')
  })

  it('does not move either image across ambiguous same-text prompts, including on repeated reconciliation', () => {
    const incoming = turnsToChatMessages([
      {
        number: 1,
        user_input: 'repeat\n\n[Attached images]\n- first.png',
        started_at: new Date(1).toISOString(),
      },
      {
        number: 2,
        user_input: 'repeat\n\n[Attached images]\n- second.png',
        started_at: new Date(3).toISOString(),
      },
    ])
    const localEcho: ChatMessage = {
      id: 'second-local-echo',
      role: 'user',
      content: 'repeat',
      timestamp: 2,
      attachments: [
        {
          id: 'second-image',
          type: 'uploaded_file',
          label: 'second.png',
          filename: 'second.png',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: 'Ag==',
          sizeBytes: 1,
        },
      ],
    }
    const firstLocal: ChatMessage = {
      ...incoming[0]!,
      attachments: [
        {
          id: 'first-image',
          type: 'uploaded_file',
          label: 'first.png',
          filename: 'first.png',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: 'AQ==',
          sizeBytes: 1,
        },
      ],
    }
    const once = mergeAuthoritativeServerMessages([firstLocal, localEcho, incoming[1]!], incoming, {
      activeTaskIds: new Set(),
    })
    const twice = mergeAuthoritativeServerMessages(once, incoming, { activeTaskIds: new Set() })
    expect(twice).toEqual(once)
    expect(once.map(message => message.id)).toEqual([
      'turn-1-user',
      'second-local-echo',
      'turn-2-user',
    ])
    expect(
      buildComposerResendDraft(once[0]!).imageAttachments.map(image => image.dataBase64)
    ).toEqual(['AQ=='])
    expect(buildComposerResendDraft(once[2]!).imageAttachments).toEqual([])
    expect(buildComposerResendDraft(once[1]!).imageAttachments[0]?.dataBase64).toBe('Ag==')
  })

  it('keeps same-name bytes on their own prompt when only a content match exists', () => {
    const incoming = turnsToChatMessages([
      {
        number: 2,
        user_input: 'repeat\n\n[Attached images]\n- shared.png',
        started_at: new Date(3).toISOString(),
      },
    ])
    const firstImage = buildChatMessageAttachments(
      [
        {
          id: 'first-image',
          name: 'shared.png',
          mimeType: 'image/png',
          dataBase64: 'AQ==',
          sizeBytes: 1,
          previewDataUrl: 'data:image/png;base64,AQ==',
        },
      ],
      [],
      []
    )[0]!
    const secondImage = buildChatMessageAttachments(
      [
        {
          id: 'second-image',
          name: 'shared.png',
          mimeType: 'image/png',
          dataBase64: 'Ag==',
          sizeBytes: 1,
          previewDataUrl: 'data:image/png;base64,Ag==',
        },
      ],
      [],
      []
    )[0]!
    expect(firstImage.dataBase64).not.toBe(secondImage.dataBase64)
    const firstTurn: ChatMessage = {
      id: 'turn-1-user',
      role: 'user',
      content: 'repeat',
      timestamp: 1,
      serverTurnNumber: 1,
      attachments: [firstImage],
    }
    const localEcho: ChatMessage = {
      id: 'second-prompt-idle-echo',
      role: 'user',
      content: 'repeat',
      timestamp: 2,
      attachments: [secondImage],
    }
    const existing = [firstTurn, localEcho, incoming[0]!]
    const once = mergeAuthoritativeServerMessages(existing, incoming, {
      activeTaskIds: new Set(),
    })
    const twice = mergeAuthoritativeServerMessages(once, incoming, {
      activeTaskIds: new Set(),
    })
    expect(twice).toEqual(once)
    expect(once.map(message => message.id)).toEqual([
      'turn-1-user',
      'second-prompt-idle-echo',
      'turn-2-user',
    ])
    expect(buildComposerResendDraft(once[0]!).imageAttachments[0]?.dataBase64).toBe('AQ==')
    expect(buildComposerResendDraft(once[1]!).imageAttachments[0]?.dataBase64).toBe('Ag==')
    expect(buildComposerResendDraft(once[2]!).imageAttachments).toEqual([])
    expect(once[2]?.attachments).toMatchObject([{ type: 'uploaded_file', label: 'shared.png' }])
  })

  it('recovers image bytes when the local and server message have the same turn identity', () => {
    const incoming = turnsToChatMessages([
      {
        number: 2,
        user_input: 'repeat\n\n[Attached images]\n- shared.png',
        started_at: new Date(3).toISOString(),
      },
    ])
    const local: ChatMessage = {
      ...incoming[0]!,
      attachments: buildChatMessageAttachments(
        [
          {
            id: 'same-turn-image',
            name: 'shared.png',
            mimeType: 'image/png',
            dataBase64: 'Ag==',
            sizeBytes: 1,
            previewDataUrl: 'data:image/png;base64,Ag==',
          },
        ],
        [],
        []
      ),
    }
    const merged = mergeAuthoritativeServerMessages([local], incoming)
    expect(merged.map(message => message.id)).toEqual(['turn-2-user'])
    expect(merged[0]?.attachments).toMatchObject([
      { type: 'uploaded_file', label: 'shared.png', dataBase64: 'Ag==' },
    ])
    expect(buildComposerResendDraft(merged[0]!).imageAttachments[0]?.dataBase64).toBe('Ag==')
    expect(mergeAuthoritativeServerMessages(merged, incoming)).toEqual(merged)
  })

  it('collapses a settled assistant echo with producer-built response file bytes', () => {
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'first', response: 'one', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'second', response: 'done', started_at: new Date(3).toISOString() },
    ])
    const responseFile = buildResponseFileAttachments({
      attachments: [
        {
          id: 'result',
          kind: 'file',
          filename: 'result.txt',
          mimeType: 'text/plain',
          encoding: 'base64',
          dataBase64: 'b2s=',
          sizeBytes: 2,
        },
      ],
    })[0]!
    const localEcho: ChatMessage = {
      id: 'settled-assistant-echo',
      role: 'assistant',
      content: 'done',
      timestamp: 2,
      attachments: [responseFile],
    }
    const once = mergeAuthoritativeServerMessages(
      [incoming[1]!, localEcho, incoming[3]!],
      incoming,
      { activeTaskIds: new Set() }
    )
    expect(once.filter(message => message.role === 'assistant')).toHaveLength(2)
    expect(once.some(message => message.id === 'settled-assistant-echo')).toBe(false)
    expect(once.find(message => message.id === 'turn-2-assistant')?.attachments).toEqual([
      responseFile,
    ])
    expect(mergeAuthoritativeServerMessages(once, incoming)).toEqual(once)
  })

  it('keeps a response-file echo local when two assistant turns share its text', () => {
    const incoming = turnsToChatMessages([
      { number: 1, user_input: 'first', response: 'done', started_at: new Date(1).toISOString() },
      { number: 2, user_input: 'second', response: 'done', started_at: new Date(3).toISOString() },
    ])
    const responseFile = buildResponseFileAttachments({
      attachments: [
        {
          id: 'result',
          kind: 'file',
          filename: 'result.txt',
          mimeType: 'text/plain',
          encoding: 'base64',
          dataBase64: 'b2s=',
          sizeBytes: 2,
        },
      ],
    })[0]!
    const localEcho: ChatMessage = {
      id: 'ambiguous-assistant-echo',
      role: 'assistant',
      content: 'done',
      timestamp: 2,
      attachments: [responseFile],
    }
    const once = mergeAuthoritativeServerMessages(
      [incoming[1]!, localEcho, incoming[3]!],
      incoming,
      { activeTaskIds: new Set() }
    )
    expect(once.filter(message => message.role === 'assistant').map(message => message.id)).toEqual(
      ['turn-1-assistant', 'ambiguous-assistant-echo', 'turn-2-assistant']
    )
    expect(once.find(message => message.id === 'ambiguous-assistant-echo')?.attachments).toEqual([
      responseFile,
    ])
    expect(once.find(message => message.id === 'turn-2-assistant')?.attachments).toBeUndefined()
    expect(mergeAuthoritativeServerMessages(once, incoming)).toEqual(once)
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
