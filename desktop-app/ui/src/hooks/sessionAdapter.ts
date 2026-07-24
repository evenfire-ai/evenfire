import type { ChatMessage, MessageToolStep, SessionTokensLite } from '../../../src/types'
import { parseChatMessageDisplay } from '../lib/chatMessageAttachments'

export interface ServerTurn {
  number: number
  user_input: string
  response?: string
  started_at: string
  completed_at?: string
  tokens?: SessionTokensLite
  tool_steps?: MessageToolStep[]
}

/**
 * Adapt server-side Turn[] to the client's ChatMessage[] shape.
 * Tool-call intermediates are not included in v1 of the transcript API.
 *
 * ChatMessage.timestamp is Unix ms (number); ChatMessage.id is required.
 * IDs are derived deterministically from the turn number and role.
 */
export function turnsToChatMessages(turns: ServerTurn[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const t of turns) {
    const userDisplay = parseChatMessageDisplay(t.user_input)
    out.push({
      id: `turn-${t.number}-user`,
      role: 'user',
      content: userDisplay.content,
      timestamp: Date.parse(t.started_at),
      serverTurnNumber: t.number,
      ...(userDisplay.attachments.length ? { attachments: userDisplay.attachments } : {}),
    })
    if (t.response !== undefined) {
      out.push({
        // completed_at may be missing on in-flight turns; falling back to started_at
        // means user+assistant share a timestamp, which is acceptable for display.
        id: `turn-${t.number}-assistant`,
        role: 'assistant',
        content: t.response,
        timestamp: Date.parse(t.completed_at ?? t.started_at),
        serverTurnNumber: t.number,
        ...(t.tokens ? { tokens: t.tokens } : {}),
        // #582: carry the turn's tools so the progress stepper's "N tools" view
        // survives a reload / cold-load (live SSE steps are renderer-only).
        ...(t.tool_steps && t.tool_steps.length ? { toolSteps: t.tool_steps } : {}),
      })
    }
  }
  return out
}
