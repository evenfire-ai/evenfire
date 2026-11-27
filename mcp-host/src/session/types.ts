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
 * Strip any `[;?&]messageid=[^;?&]+.*` suffix from Microsoft Teams
 * channel IDs ONLY when deriving canonical session keys or per-conversation
 * FIFO keys. Raw `msg.channelId` (`providerConversationId`) remains untouched
 * for `channelRuntimeSourceMismatch` and Bot Framework reply delivery.
 */
export function normalizeSessionChannelId(
  channelType: string | undefined,
  channelId: string | undefined
): string {
  const raw = (channelId || '').trim()
  if (!raw) return 'default'
  if (channelType === 'teams') {
    const stripped = raw.replace(/[;?&]messageid=[^;?&]+.*/i, '').trim()
    return stripped || 'default'
  }
  return raw
}

/**
 * Serialize a SessionKey to a string for use as a Map key.
 */
export function serializeSessionKey(key: SessionKey): string {
  return `${key.userId}:${key.channelType}:${key.channelId || 'default'}:${key.threadId || 'default'}`
}

/**
 * Single canonical session-key derivation shared across execute, executeAsync,
 * resolveTaskSessionKey, createIncomingAdmission, /channel-attachments/ingest,
 * releaseSessionForTask, and subscribeLifecycle cancel cleanup.
 */
export function resolveCanonicalSessionKey(
  msg:
    | {
        sender?: string
        userId?: string
        channelType?: string
        channelId?: string
        threadId?: string
      }
    | undefined
): string {
  const channelType = msg?.channelType || 'internal'
  return serializeSessionKey({
    userId: msg?.sender || msg?.userId || 'anonymous',
    channelType,
    channelId: normalizeSessionChannelId(channelType, msg?.channelId),
    threadId: msg?.threadId,
  })
}

const KNOWN_SESSION_CHANNEL_TYPES = new Set([
  'telegram',
  'slack',
  'teams',
  'email',
  'rpc',
  'cli',
  'internal',
  'cron',
  'desktop',
])

/**
 * Inverse of serializeSessionKey. Returns the parsed components, or null if
 * the input does not match the expected `userId:channelType:channelId:threadId`
 * shape (which happens for legacy test fixtures that pass arbitrary strings).
 *
 * Handles colon-bearing Teams identifiers (`29:<aad>` user IDs and
 * `19:<room>@thread.tacv2` channel IDs) by locating the known `channelType`
 * delimiter across `parts[1 .. parts.length - 3]`, while preserving
 * colon-bearing non-Teams `threadId` values (e.g. `u1:slack:C1:t:1`).
 *
 * Used by the SQLite store to project the sessionKey into indexable columns
 * (`user_id`, `channel_type`, `channel_id`, `thread_id`).
 */
export function parseSessionKey(key: string): SessionKey | null {
  const parts = key.split(':')
  if (parts.length < 4) return null

  let channelIdx = -1
  for (let i = 1; i <= parts.length - 3; i++) {
    if (KNOWN_SESSION_CHANNEL_TYPES.has(parts[i])) {
      channelIdx = i
      break
    }
  }

  if (channelIdx >= 1 && parts[channelIdx] === 'teams') {
    const userId = parts.slice(0, channelIdx).join(':')
    const rest = parts.slice(channelIdx + 1)
    const rawThreadId = rest[rest.length - 1]
    const channelId = rest.slice(0, -1).join(':')
    if (!userId || !channelId) return null
    return {
      userId,
      channelType: 'teams',
      channelId,
      threadId: rawThreadId === 'default' ? undefined : rawThreadId,
    }
  }

  if (channelIdx > 1) {
    const userId = parts.slice(0, channelIdx).join(':')
    const channelType = parts[channelIdx]
    const channelId = parts[channelIdx + 1]
    const threadId = parts.slice(channelIdx + 2).join(':')
    if (!userId || !channelType || !channelId) return null
    return {
      userId,
      channelType,
      channelId,
      threadId: threadId === 'default' ? undefined : threadId,
    }
  }

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
