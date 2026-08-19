export interface AgentChatSessionParts {
  agent: string
  chatId: string
}

export interface StructuredSessionKeyParts {
  sessionKey: string
  channelType: string | null
  channelId: string | null
  threadId: string | null
}

/**
 * Recover the owner only when persisted structured columns prove the complete
 * serialized suffix. The owner prefix may contain any number of `:` characters;
 * parsing from the front would therefore cross tenant boundaries.
 */
export function userIdFromStructuredSessionKey(parts: StructuredSessionKeyParts): string | null {
  if (!parts.channelType || !parts.channelType.trim()) return null
  const channelId = parts.channelId || 'default'
  const threadId = parts.threadId || 'default'
  const suffix = `:${parts.channelType}:${channelId}:${threadId}`
  if (parts.sessionKey.length <= suffix.length || !parts.sessionKey.endsWith(suffix)) {
    return null
  }
  const userId = parts.sessionKey.slice(0, -suffix.length)
  return userId.trim() ? userId : null
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

/**
 * Extract the trusted user ID from an RPC catalog/transcript prefix. The suffix
 * is removed from the end instead of splitting on `:rpc:` because authenticated
 * subjects may themselves contain that sequence.
 */
export function userIdFromRpcPrefix(prefix: string, scopedAgent?: string): string | null {
  const suffix = scopedAgent === undefined ? ':rpc:' : `:rpc:${scopedAgent}:`
  if (!prefix.endsWith(suffix)) return null
  const userId = prefix.slice(0, -suffix.length)
  return userId || null
}
