/**
 * Per-(human, channel) workspace key derivation.
 *
 * `mcp-host` is a collective agent (one Pod = one agent shared by many humans).
 * Conversations are isolated by `sessionKey` (`userId:channelType:...`), but the
 * filesystem workspace is flat and global. This helper produces the stable,
 * filesystem-safe key used to namespace per-user data under `users/<userKey>/`
 * (FS isolation, plan F0–F5).
 *
 * The key is `sha256("<channelType>:<sender>")` truncated to 16 hex chars:
 *  - **stable**: same input → same key (memory survives across the user's
 *    sessions on the same channel),
 *  - **channel-namespaced**: the same `sender` string on different channels
 *    yields different keys → no accidental cross-channel collision (C2),
 *  - **path-safe**: only `[0-9a-f]`, so a malicious `sender` (`../`, `/`, null
 *    bytes) can never traverse out of the namespace, and no PII lands in a
 *    directory name.
 *
 * Cross-channel identity reconciliation (the same human across Telegram/Desktop
 * sharing one key) is deliberately NOT done here — that is the deferred
 * canonical-identity work (C4). This helper isolates by (person, channel).
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from '../server/types'
import { parseSessionKey } from '../session/types'

/** Reserved namespace for tasks with no human origin (cron, system, internal). */
export const SYSTEM_USER_KEY = '_system'

/** Length of the truncated hex digest used as the user key. */
const KEY_HEX_LENGTH = 16

/**
 * Derive the user key from a bare `(sender, channelType)` pair. An empty or
 * whitespace-only `sender` maps to {@link SYSTEM_USER_KEY} (no human origin).
 */
export function deriveUserKey(
  sender: string | null | undefined,
  channelType: string | null | undefined
): string {
  const normalizedSender = (sender ?? '').trim()
  if (normalizedSender.length === 0) return SYSTEM_USER_KEY
  const normalizedChannel = (channelType ?? '').trim()
  return createHash('sha256')
    .update(`${normalizedChannel}:${normalizedSender}`, 'utf8')
    .digest('hex')
    .slice(0, KEY_HEX_LENGTH)
}

/**
 * Derive the user key from a task's source message. Cron/system/internal tasks
 * carry no `sourceMessage` → {@link SYSTEM_USER_KEY}.
 */
/**
 * Shared normalization so the source path and the sessionKey path produce the
 * SAME key for the same logical session. Mirrors TaskExecutor's sessionKey
 * construction (`userId: sender || 'anonymous'`, `channelType: channelType ||
 * 'internal'`) and maps that exact source-less fallback to the system key.
 */
function deriveUserKeyForSession(
  userId: string | null | undefined,
  channelType: string | null | undefined
): string {
  const u = userId || 'anonymous'
  const c = channelType || 'internal'
  if (u === 'anonymous' && c === 'internal') return SYSTEM_USER_KEY
  return deriveUserKey(u, c)
}

export function deriveUserKeyFromSource(
  sourceMessage?: Pick<IncomingMessage, 'sender' | 'channelType'> | null
): string {
  if (!sourceMessage) return SYSTEM_USER_KEY
  return deriveUserKeyForSession(sourceMessage.sender, sourceMessage.channelType)
}

/**
 * Derive the user key from a serialized `sessionKey`
 * (`userId:channelType:channelId:threadId`). Used by the compaction path, which
 * only has the sessionKey (no `sourceMessage`).
 *
 * MUST agree with {@link deriveUserKeyFromSource} for the same logical session.
 * `TaskExecutor` builds the sessionKey with `userId: msg?.sender || 'anonymous'`
 * and `channelType: msg?.channelType || 'internal'` for tasks without a source
 * message (cron/system/internal). Those map back to {@link SYSTEM_USER_KEY} so
 * the compaction path and the source path don't split-brain into two roots for
 * the same system task. A malformed sessionKey also maps to the system key.
 */
export function deriveUserKeyFromSessionKey(sessionKey: string): string {
  const parsed = parseSessionKey(sessionKey)
  if (!parsed) return SYSTEM_USER_KEY
  return deriveUserKeyForSession(parsed.userId, parsed.channelType)
}
