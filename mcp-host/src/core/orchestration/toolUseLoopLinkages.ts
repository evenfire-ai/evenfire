import type { ChatMessage } from '../types'

/**
 * Validate that tool_call_id linkages are preserved.
 *
 * Risk 4.4: after any context manipulation, verify that every assistant
 * message with tool_calls has corresponding tool result messages following it.
 */
export function validateToolLinkages(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const expectedIds = new Set(msg.tool_calls.map(tc => tc.id))
      const foundIds = new Set<string>()

      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === 'tool' && messages[j].tool_call_id) {
          if (expectedIds.has(messages[j].tool_call_id!)) {
            foundIds.add(messages[j].tool_call_id!)
          }
        }
        if (messages[j].role !== 'tool') break
      }

      for (const id of expectedIds) {
        if (!foundIds.has(id)) {
          throw new Error(
            `Tool linkage violated: assistant message has tool_call id "${id}" ` +
              `but no matching tool result follows`
          )
        }
      }
    }
  }
}
