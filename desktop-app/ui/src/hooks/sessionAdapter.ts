import {
  type ServerTurn,
  turnsToChatMessages as adaptServerTurnsToChatMessages,
} from '../../../src/serverTurnAdapter'
import type { ChatMessage } from '../../../src/types'
import { parseChatMessageDisplay } from '../lib/chatMessageAttachments'

export type { ServerTurn }

/**
 * Adapt server-side Turn[] to the client's ChatMessage[] shape.
 * Tool-call intermediates are not included in v1 of the transcript API.
 *
 * ChatMessage.timestamp is Unix ms (number); ChatMessage.id is required.
 * IDs are derived deterministically from the turn number and role.
 */
export function turnsToChatMessages(turns: ServerTurn[]): ChatMessage[] {
  return adaptServerTurnsToChatMessages(turns, parseChatMessageDisplay)
}
