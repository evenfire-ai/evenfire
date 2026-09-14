/**
 * Spec 15 Fase B — per-session rename core. Shared, dependency-injected so it is
 * unit-testable outside `main.ts`. Wired by the `PATCH /v1/runtime/sessions/
 * :agent/:chatId/name` route (`handleSetTitleRoute`).
 *
 * Behaviour: sanitize + validate the caller-supplied title (§5), resolve the
 * session by exact key scoped to `userSub`, and overwrite `sessions.title`.
 * Key-derivation contract mirrors the session-read routes: the "agent" slot is
 * the desktop's rpc `channelId` and `chatId` maps to `threadId`, so this renames
 * the SAME row the catalog/messages routes read.
 *
 * Ownership + anti-enumeration: uses `getSessionByKeyForUserAsync` (NOT
 * `getOrCreate` — a rename must never create a row), which collapses "does not
 * exist" and "owned by another user" into `undefined` → a UNIFORM 404. Channel
 * sessions (Slack/Telegram) are not renamable by construction: their key carries
 * a non-`rpc` channelType, so the rpc-shaped key built here can never resolve one
 * (→ 404). No secret handling here; the title is user content, logged only by
 * length (§5).
 */
import type { ConversationManager } from '../core/conversation/conversation'
import {
  MAX_TITLE_BYTES,
  MAX_TITLE_CODE_POINTS,
  normalizeTitleText,
} from '../core/conversation/sessionTitle'
import type { SetTitleResult } from '../server/types'
import { serializeSessionKey } from '../session'

export interface SessionTitleDeps {
  convManager: ConversationManager
}

export async function applySessionTitle(
  deps: SessionTitleDeps,
  userSub: string,
  agent: string,
  chatId: string,
  rawTitle: string
): Promise<SetTitleResult> {
  const { convManager } = deps

  // §5 — sanitize with the SAME core as the auto-title (D4), then enforce the
  // rename policy: non-empty after sanitize, capped at 120 code points / 512
  // bytes. Reject over-cap (400) rather than silently truncating so the user's
  // stored name is never a surprise.
  const title = normalizeTitleText(rawTitle)
  if (
    title.length === 0 ||
    Array.from(title).length > MAX_TITLE_CODE_POINTS ||
    Buffer.byteLength(title, 'utf8') > MAX_TITLE_BYTES
  ) {
    return { ok: false as const, reason: 'invalid_title' as const }
  }

  const key = serializeSessionKey({
    userId: userSub,
    channelType: 'rpc',
    channelId: agent,
    threadId: chatId,
  })
  // Uniform 404 for missing / foreign / channel sessions (no existence oracle).
  const conversation = await convManager.getSessionByKeyForUserAsync(key, userSub)
  if (!conversation) {
    return { ok: false as const, reason: 'not_found' as const }
  }

  // No-op if unchanged (§5): there is no rate limit and every rename is an op on
  // the persistQueue shared with turn persistence, so skip the write when the
  // title already matches (the client already holds this canonical value).
  if (conversation.title === title) {
    return { ok: true as const, title }
  }

  convManager.setTitle(conversation, title)
  // NEVER log the raw title (user content, §5) — only its length + the chatId.
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'set_session_title',
      userId: userSub,
      chatId,
      titleLength: title.length,
    })
  )
  return { ok: true as const, title }
}
