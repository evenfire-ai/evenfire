/**
 * Slack text limits that decide how a reply is delivered.
 *
 * `chat.update` rejects text over 4,000 characters with `msg_too_long`.
 * `chat.postMessage` accepts up to 40,000 characters and may split anything
 * longer than about 4,000 on its own, including through the middle of a code
 * fence. A Block Kit section is capped at 3,000 characters. Replies stay on
 * the plain `text` field and are packed under the update limit so Slack never
 * has to split them. A fenced block that cannot fit is left whole and uploaded
 * as a snippet.
 */
export const SLACK_CHAT_UPDATE_TEXT_LIMIT = 4_000
export const SLACK_CHAT_POST_TEXT_LIMIT = 40_000
export const SLACK_SECTION_TEXT_LIMIT = 3_000

const ANSWER_CONTINUES =
  'The answer is too long for one Slack edit. The rest is in the following message.'

export type SlackFollowUp =
  | { kind: 'message'; text: string }
  | { kind: 'snippet'; filename: string; text: string }

export interface SlackReplyPlan {
  /** Always short enough for `chat.update`. */
  acknowledgement: string
  /** True when `acknowledgement` is a stand-in and the real text starts in `followUps`. */
  acknowledgementIsPlaceholder: boolean
  followUps: SlackFollowUp[]
}

export function channelRunErrorText(reason: string): string {
  const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 180) || 'unknown error'
  return `⚠️ Sorry, I couldn't finish this request (${clean}). Try again or ask for a shorter answer.`
}

/**
 * Split `text` on paragraph, line, or word boundaries.
 * A fenced code block is never cut. When the fence itself is longer than
 * `limit`, it is returned as its own piece.
 * Joining the pieces with '' restores `text`.
 */
export function splitSlackText(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Slack text limit must be a positive integer')
  }
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let current = ''
  const emit = () => {
    if (current.length === 0) return
    chunks.push(current)
    current = ''
  }

  for (const token of tokenize(text)) {
    if (token.code) {
      if (token.text.length > limit) {
        emit()
        chunks.push(token.text)
        continue
      }
      if (current.length > 0 && current.length + token.text.length > limit) emit()
      current += token.text
      continue
    }

    let rest = token.text
    while (rest.length > 0) {
      const room = limit - current.length
      if (room <= 0) {
        emit()
        continue
      }
      if (rest.length <= room) {
        current += rest
        break
      }
      const splitAt = findBoundary(rest, room)
      if (splitAt <= 0) {
        if (current.length > 0) {
          emit()
          continue
        }
        chunks.push(rest.slice(0, limit))
        rest = rest.slice(limit)
        continue
      }
      current += rest.slice(0, splitAt)
      rest = rest.slice(splitAt)
      emit()
    }
  }
  emit()
  return absorbBlankPieces(chunks)
}

/**
 * A whitespace-only piece cannot be posted: Slack treats it as an empty
 * message, and the delivery then stops before the rest of the answer.
 * Fold that separator into a neighbour so join('') still restores `text`.
 */
function absorbBlankPieces(chunks: string[]): string[] {
  const out: string[] = []
  let leading = ''
  for (const chunk of chunks) {
    if (chunk.length === 0) continue
    if (chunk.trim().length === 0) {
      if (out.length === 0) leading += chunk
      else out[out.length - 1] += chunk
      continue
    }
    out.push(leading + chunk)
    leading = ''
  }
  if (leading.length > 0) {
    if (out.length === 0) out.push(leading)
    else out[out.length - 1] += leading
  }
  return out
}

export function planSlackReply(text: string): SlackReplyPlan {
  const pieces = splitSlackText(text, SLACK_CHAT_UPDATE_TEXT_LIMIT).filter(
    piece => piece.length > 0
  )
  if (pieces.length === 0) {
    return { acknowledgement: '', acknowledgementIsPlaceholder: false, followUps: [] }
  }

  const asFollowUp = (piece: string, index: number): SlackFollowUp =>
    piece.length <= SLACK_CHAT_UPDATE_TEXT_LIMIT
      ? { kind: 'message', text: piece }
      : { kind: 'snippet', filename: `reply-part-${index + 1}.txt`, text: piece }

  const first = pieces[0]!
  if (first.length <= SLACK_CHAT_UPDATE_TEXT_LIMIT) {
    return {
      acknowledgement: first,
      acknowledgementIsPlaceholder: false,
      followUps: pieces.slice(1).map((piece, index) => asFollowUp(piece, index + 1)),
    }
  }
  return {
    acknowledgement: ANSWER_CONTINUES,
    acknowledgementIsPlaceholder: true,
    followUps: pieces.map((piece, index) => asFollowUp(piece, index)),
  }
}

function findBoundary(text: string, windowEnd: number): number {
  const window = text.slice(0, windowEnd)
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph > 0) return paragraph
  const line = window.lastIndexOf('\n')
  if (line > 0) return line
  const word = window.lastIndexOf(' ')
  if (word > 0) return word
  return -1
}

function tokenize(text: string): Array<{ code: boolean; text: string }> {
  const tokens: Array<{ code: boolean; text: string }> = []
  let cursor = 0
  for (const span of fenceSpans(text)) {
    if (span.start > cursor) tokens.push({ code: false, text: text.slice(cursor, span.start) })
    tokens.push({ code: true, text: text.slice(span.start, span.end) })
    cursor = span.end
  }
  if (cursor < text.length) tokens.push({ code: false, text: text.slice(cursor) })
  return tokens
}

function fenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let offset = 0
  let open: { marker: string; start: number } | null = null
  while (offset <= text.length) {
    const nextBreak = text.indexOf('\n', offset)
    const lineEnd = nextBreak === -1 ? text.length : nextBreak
    const marker = fenceMarker(text.slice(offset, lineEnd))
    if (open && marker === open.marker) {
      spans.push({ start: open.start, end: nextBreak === -1 ? lineEnd : nextBreak + 1 })
      open = null
    } else if (!open && marker) {
      open = { marker, start: offset }
    }
    if (nextBreak === -1) break
    offset = nextBreak + 1
  }
  if (open) spans.push({ start: open.start, end: text.length })
  return spans
}

function fenceMarker(line: string): string | null {
  // CommonMark allows up to three leading spaces. The pair key is the fence
  // token only, so an indented close still closes an indented open.
  const match = /^( {0,3})(```+|~~~+)/.exec(line)
  return match ? match[2]! : null
}
