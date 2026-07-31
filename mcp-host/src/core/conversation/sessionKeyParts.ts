export interface AgentChatSessionParts {
  agent: string
  chatId: string
}

/**
 * Parse a key relative to the exact prefix used to fetch it.
 *
 * For an agent-scoped prefix, the entire suffix is the chat ID. This preserves
 * chat IDs containing colons instead of treating their first segment as another
 * agent name. The scoped agent must be explicit because the prefix alone is
 * ambiguous when a user subject contains `:rpc:` or the agent is named `rpc`.
 */
export function sessionPartsFromPrefixedKey(
  key: string,
  prefix: string,
  scopedAgent?: string
): AgentChatSessionParts | null {
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  if (!rest) return null

  if (scopedAgent) {
    if (!prefix.endsWith(`:rpc:${scopedAgent}:`)) return null
    return { agent: scopedAgent, chatId: rest }
  }

  const colonIndex = rest.indexOf(':')
  if (colonIndex <= 0 || colonIndex === rest.length - 1) return null
  return {
    agent: rest.slice(0, colonIndex),
    chatId: rest.slice(colonIndex + 1),
  }
}
