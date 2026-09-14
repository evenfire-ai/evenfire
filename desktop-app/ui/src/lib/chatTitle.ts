/**
 * Session-title presentation helpers (spec 15 §2.4, A20).
 *
 * Centralizes the two things that used to be duplicated/inlined across the chat
 * controllers:
 *  - `truncateTitle`: the auto-title truncation, previously copy-pasted in
 *    `useAgentChatController` (twice) with a bug (see below);
 *  - the sidebar placeholders for a server-only session with no title yet.
 */

/** Auto-title length budget, measured in Unicode code points (not UTF-16 units). */
export const TITLE_MAX_CODE_POINTS = 60

/**
 * Suffix appended to a truncated title. U+2026 (…), a single code point, chosen
 * to match the suffix mcp-host uses for the server-side auto-title so the two
 * derivations don't visibly diverge (spec 15 §2.4).
 */
export const TITLE_ELLIPSIS = '…'

/**
 * Truncate an auto-title seed to `TITLE_MAX_CODE_POINTS`, cutting at the last
 * space at or before the budget so a word isn't sliced mid-token; when there is
 * no such space, cut hard at the budget.
 *
 * Fixes the §2.4 bug in the old inline version
 * (`substring(0, seed.lastIndexOf(' ', 60) || 60) + '...'`): with no space in
 * the first 60 chars `lastIndexOf` returns -1, which is truthy, so
 * `substring(0, -1)` dropped the last char and produced garbage like `"…"`
 * alone. This version never does that.
 *
 * Operates on code points so a surrogate pair (emoji, astral characters) is
 * never split at the boundary.
 */
export function truncateTitle(input: string): string {
  const codePoints = Array.from(input)
  if (codePoints.length <= TITLE_MAX_CODE_POINTS) return input

  // Last space at code-point index <= budget. Index 0 is treated as "no usable
  // space" (a leading-space cut would yield an empty prefix), matching the old
  // `|| 60` fallback.
  let cut = -1
  const scanEnd = Math.min(TITLE_MAX_CODE_POINTS, codePoints.length - 1)
  for (let i = 1; i <= scanEnd; i++) {
    if (codePoints[i] === ' ') cut = i
  }
  const end = cut > 0 ? cut : TITLE_MAX_CODE_POINTS
  return codePoints.slice(0, end).join('') + TITLE_ELLIPSIS
}

/** Short form of a chat id used in placeholders (chat ids are ASCII UUIDs). */
function shortChatId(chatId: string): string {
  return chatId.slice(0, 8)
}

/**
 * Placeholder for a cross-agent ("Latest sessions") server-only session that has
 * no title yet (spec 15 §2.2 case B).
 */
export function remotePlaceholder(chatId: string): string {
  return `Remote · ${shortChatId(chatId)}`
}

/**
 * Placeholder for an agent-scoped server-only session that has no title yet
 * (spec 15 §2.2 case B).
 */
export function agentChatPlaceholder(chatId: string): string {
  return `Chat ${shortChatId(chatId)}`
}
