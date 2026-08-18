import type {
  ChatMessage,
  ChatMessageAttachment,
  MessageToolStep,
  SessionTokensLite,
  TurnGuardrailsLite,
} from './types'

export interface ServerTurn {
  number: number
  user_input: string
  response?: string
  started_at: string
  completed_at?: string
  tokens?: SessionTokensLite
  tool_steps?: MessageToolStep[]
  guardrails?: TurnGuardrailsLite
}

type UserMessageDisplay = {
  content: string
  attachments: ChatMessageAttachment[]
}

/**
 * Convert runtime turns to deterministic local messages.
 *
 * The optional display parser lets the renderer recover structured attachment
 * chips while keeping server-turn identity shared with main-process tests.
 */
export function turnsToChatMessages(
  turns: ServerTurn[],
  parseUserDisplay: (content: string) => UserMessageDisplay = content => ({
    content,
    attachments: [],
  })
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const turn of turns) {
    const userDisplay = parseUserDisplay(turn.user_input)
    out.push({
      id: `turn-${turn.number}-user`,
      role: 'user',
      content: userDisplay.content,
      timestamp: Date.parse(turn.started_at),
      serverTurnNumber: turn.number,
      ...(userDisplay.attachments.length ? { attachments: userDisplay.attachments } : {}),
    })
    if (turn.response !== undefined) {
      out.push({
        id: `turn-${turn.number}-assistant`,
        role: 'assistant',
        content: turn.response,
        timestamp: Date.parse(turn.completed_at ?? turn.started_at),
        serverTurnNumber: turn.number,
        ...(turn.tokens ? { tokens: turn.tokens } : {}),
        ...(turn.tool_steps?.length ? { toolSteps: turn.tool_steps } : {}),
        ...(turn.guardrails ? { guardrails: turn.guardrails } : {}),
      })
    }
  }
  return out
}
