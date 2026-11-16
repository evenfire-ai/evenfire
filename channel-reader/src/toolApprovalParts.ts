import type { Message } from './types'

/** How much tool-approval text one message of a channel carries, and how it is counted. */
export interface ToolApprovalPartLimit {
  max: number
  size: (part: string) => number
}

/** A channel with no entry has no limit: its approval is one message. */
export const TOOL_APPROVAL_PART_LIMIT: Partial<
  Record<Message['channelType'], ToolApprovalPartLimit>
> = {
  // One Telegram message; telegramDelivery sends up to this as a single chunk.
  telegram: { max: 4096, size: part => part.length },
  // The text of one Slack section block; the same string is the message text.
  slack: { max: 3000, size: part => part.length },
  // The last part travels twice in one activity (card text and summary).
  teams: { max: 12_000, size: part => Buffer.byteLength(JSON.stringify(part), 'utf8') },
}

/**
 * More parts than this are not sent. A schema-valid kept-files delete card has
 * at most 24 lines and a part holds at least one, so this bound refuses none.
 * A line that redaction lengthens past the channel's message is refused by the
 * line rule of splitToolApprovalText.
 */
export const TOOL_APPROVAL_MAX_PARTS = 24

/** Sent when an approval could not be shown in full and mcp-host accepted its denial. */
export const TOOL_APPROVAL_NOT_SHOWN_DENIED =
  'This approval request could not be shown here in full, so it was not offered for approval and the action was denied. Nothing was changed.'

/** Sent when an approval could not be shown in full and mcp-host did not accept its denial. */
export const TOOL_APPROVAL_NOT_SHOWN_STILL_WAITING =
  'This approval request could not be shown here in full, so it cannot be approved here. It is still waiting on the Host; ask an operator to deny it.'

/**
 * `content` as the parts to send in order: whole lines, each part at most
 * `limit.max` by `limit.size`. One part when it fits. Null when it cannot be
 * shown whole: a line over the limit, a part with no visible text, or more
 * than TOOL_APPROVAL_MAX_PARTS parts.
 *
 * Parts are split only between lines, so no part ends inside a Slack entity,
 * a surrogate pair or an escape, and `parts.join('\n') === content`.
 */
export function splitToolApprovalText(
  content: string,
  limit: ToolApprovalPartLimit
): string[] | null {
  const lines = content.split('\n')
  const parts: string[] = []
  let current: string | undefined
  for (const line of lines) {
    if (limit.size(line) > limit.max) return null
    if (current === undefined) {
      current = line
      continue
    }
    const joined = `${current}\n${line}`
    if (limit.size(joined) <= limit.max) {
      current = joined
      continue
    }
    parts.push(current)
    if (parts.length >= TOOL_APPROVAL_MAX_PARTS) return null
    current = line
  }
  parts.push(current ?? '')
  if (parts.some(part => part.trim() === '')) return null
  return parts
}
