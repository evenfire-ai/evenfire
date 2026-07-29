export interface AgentChatSessionParts {
  agent: string
  chatId: string
}

/**
 * Return the agent embedded in an agent-scoped RPC prefix.
 *
 * Unscoped prefixes end immediately after `:rpc:`. Scoped prefixes append the
 * agent and a trailing colon, for example `user:rpc:agent-a:`.
 */
export function scopedAgentFromSessionPrefix(prefix: string): string | null {
  const rpcPrefixIndex = prefix.lastIndexOf(':rpc:')
  if (rpcPrefixIndex < 0) return null
  const suffix = prefix.slice(rpcPrefixIndex + ':rpc:'.length)
  if (!suffix.endsWith(':')) return null
  const agent = suffix.slice(0, -1)
  return agent || null
}

/**
 * Parse a key relative to the exact prefix used to fetch it.
 *
 * For an agent-scoped prefix, the entire suffix is the chat ID. This preserves
 * chat IDs containing colons instead of treating their first segment as
 * another agent name.
 */
export function sessionPartsFromPrefixedKey(
  key: string,
  prefix: string
): AgentChatSessionParts | null {
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  if (!rest) return null

  const scopedAgent = scopedAgentFromSessionPrefix(prefix)
  if (scopedAgent) return { agent: scopedAgent, chatId: rest }

  const colonIndex = rest.indexOf(':')
  if (colonIndex <= 0 || colonIndex === rest.length - 1) return null
  return {
    agent: rest.slice(0, colonIndex),
    chatId: rest.slice(colonIndex + 1),
  }
}
