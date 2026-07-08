/**
 * Session key — deterministic from the incoming message.
 * Each unique (userId, channelType, channelId, threadId) tuple
 * maps to one isolated session with its own conversation state.
 */
export interface SessionKey {
  userId: string
  channelType: string
  channelId: string
  threadId?: string
}

/**
 * Serialize a SessionKey to a string for use as a Map key.
 */
export function serializeSessionKey(key: SessionKey): string {
  return `${key.userId}:${key.channelType}:${key.channelId || 'default'}:${key.threadId || 'default'}`
}

/**
 * Inverse of serializeSessionKey. Returns the parsed components, or null if
 * the input does not match the expected `userId:channelType:channelId:threadId`
 * shape (which happens for legacy test fixtures that pass arbitrary strings).
 *
 * Used by the SQLite store to project the sessionKey into indexable columns
 * (`user_id`, `channel_type`, `channel_id`, `thread_id`).
 */
export function parseSessionKey(key: string): SessionKey | null {
  const parts = key.split(':')
  if (parts.length < 4) return null
  // Threads may legitimately contain `:` characters in some channel
  // implementations; rejoin the tail so we don't drop it.
  const [userId, channelType, channelId, ...threadParts] = parts
  if (!userId || !channelType || !channelId) return null
  const threadId = threadParts.join(':')
  return {
    userId,
    channelType,
    channelId,
    threadId: threadId === 'default' ? undefined : threadId,
  }
}

/**
 * Check if a message starts with /bg and extract the instruction.
 */
export function parseBackgroundPrefix(content: string): {
  isBackground: boolean
  content: string
} {
  const match = content.match(/^\/bg\s+(.+)/s)
  if (match && match[1].trim()) {
    return { isBackground: true, content: match[1].trim() }
  }
  return { isBackground: false, content }
}
