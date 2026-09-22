/**
 * Pure presentation map for GFS server verdicts, on both the grant plane
 * (grant/revoke/list) and the read plane (resolve/download/list/affordances).
 *
 * The renderer receives error codes embedded in Electron IPC error messages
 * (e.g. "Error invoking remote method 'gfs:grant': Error: 403 Forbidden:
 * foreign_agent_forbidden"), so codes are matched as substrings of the raw
 * message. Unknown errors keep their server verdict — fail loud, never swallow
 * it — but lose the IPC wrapper, which names our own process boundary and
 * means nothing to a user.
 */

export interface GfsGrantErrorPresentation {
  /** Matched server error code, or null when the message is passed through. */
  code: string | null
  message: string
  /**
   * 'quiet' renders as an informational banner (never an error toast) — the
   * caller simply lacks manage access, which is an expected state, not a fault.
   */
  severity: 'error' | 'quiet'
}

const GFS_GRANT_ERROR_MESSAGES: Record<string, string> = {
  agent_manager_forbidden: "Agents can't be given manage or share access.",
  managed_agent_permission_forbidden: 'Managed agents can only be granted read and write.',
  foreign_agent_forbidden: 'You can only grant access to your own agents.',
  subjects_invalid: 'Some selected subjects are invalid and were rejected.',
  escalation_rejected: 'You can only grant permissions you already hold here.',
  manage_acl_required: 'Only people with manage access can view who has access here.',
}

/**
 * Electron prefixes every IPC rejection with
 * `Error invoking remote method '<channel>': <ErrorClass>: `. The channel name
 * is an implementation detail of our own main/renderer split; the server
 * verdict that follows it is the part a user can act on. This strips exactly
 * the wrapper and leaves the verdict intact.
 */
const IPC_WRAPPER_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

export function stripIpcWrapper(message: string): string {
  return message.replace(IPC_WRAPPER_PREFIX, '')
}

/**
 * Drop the markers the main process appends for the renderer's own use.
 *
 * `surfaceGfsGrantError` puts `httpStatus=` and `retryAfterSeconds=` at the end
 * of the message so the classifiers below can read a verdict that prose cannot
 * carry. They are plumbing between our two processes, exactly like the IPC
 * wrapper above, and a user told "read access was revoked httpStatus=403" is
 * being shown the mechanism instead of the reason. Removing one piece of
 * plumbing from the banner while adding another is not a fix.
 *
 * Anchored to the end and applied in the reverse of the order the builder
 * appends them, so this removes only what that builder wrote. A copy carried by
 * the server's own body sits ahead of that position and is left intact: it is
 * the server's text, and `surfaceGfsGrantError` has already stripped the ones
 * that could have been mistaken for a verdict.
 *
 * Strip only AFTER classifying. `isRateLimited`, `parseHttpStatus` and
 * `parseRetryAfterSeconds` all read these markers; a message cleaned first is a
 * message that can no longer be classified, which is the incident this module
 * exists to prevent.
 */
export function stripVettedMarkers(message: string): string {
  return message.replace(/\s+retryAfterSeconds=\d+$/, '').replace(/\s+httpStatus=\d{3}$/, '')
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function parseInvalidIndexes(message: string): number[] {
  const match = message.match(/invalidIndexes[^[]*\[([\d,\s]*)\]/)
  if (!match || !match[1]?.trim()) return []
  return match[1]
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(index => Number.isInteger(index) && index >= 0)
}

/**
 * Upper bound on a server-supplied retry window, in seconds.
 *
 * The value drives a real wall-clock gate: it disables the Retry button and
 * suppresses focus revalidation. An unbounded value from the wire would wedge
 * both for the controller's lifetime, recoverable only by remount — a durable
 * self-denial of service out of a transient 429. Every limiter behind this
 * endpoint meters per minute, so five minutes is already far past any window
 * the server can legitimately be asking us to wait.
 */
const MAX_RETRY_AFTER_SECONDS = 300

/**
 * Lift a retry window out of an error message.
 *
 * Only the main process may declare one. It parses the response body itself
 * (uriHandler `parseGfsGrantErrorFields`), accepts the field only at the TOP
 * level, strips any counterfeit token the server's own message carried, and
 * republishes what it accepted as its own trailing ` retryAfterSeconds=N`
 * suffix — always last, after `invalidIndexes=[…]`.
 *
 * Both anchors are load-bearing, and each closes a different hole:
 *
 * - The leading `(?:^|\s)` keeps a longer token from smuggling the field in.
 * - The trailing `$` keeps an EARLIER occurrence from winning. `String.match`
 *   without `/g` returns the FIRST match, so an unanchored pattern reads
 *   whichever token appears earliest in the concatenation — which is the
 *   server's text, not our suffix. `httpClient` puts the RAW response body
 *   into the error message whenever the JSON carries no top-level
 *   `error`/`message` key, so a body such as
 *   `{"detail":"slow down retryAfterSeconds=0"}` crosses IPC verbatim and
 *   lands ahead of the vetted value.
 *
 * Matching `:` as well would re-admit what the main process rejected outright:
 * `{"policy":{"retryAfterSeconds":3600},"limit":100}` is a NESTED field the
 * authoritative parser refused to trust. Nothing scans for "the next number
 * ANYWHERE", which would both invent a window out of an unrelated field and
 * run quadratically over an upstream proxy's HTML 429 page.
 *
 * The digit run is unbounded because both anchors leave exactly ONE candidate
 * position, which matches in linear time. Bounding its LENGTH instead would
 * silently truncate an over-long value to its leading digits — reading part of
 * a number as though it were the whole — or, once anchored, drop it entirely
 * and skip the clamp below. `Math.min` is the bound that matters, and a run
 * long enough to exceed `Number.MAX_VALUE` fails the integer check and yields
 * no window at all.
 */
export function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/(?:^|\s)retryAfterSeconds=(\d+)$/)
  if (!match?.[1]) return null
  const seconds = Number.parseInt(match[1], 10)
  if (!Number.isInteger(seconds) || seconds < 0) return null
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
}

/**
 * The HTTP status the main process vetted, or `null` when nothing vetted one.
 *
 * `surfaceGfsGrantError` appends `httpStatus=<code>` from `ApiError.status` —
 * the transport's own verdict — and strips any copy the server's text carried,
 * exactly as it does for the retry window. The position is what makes the
 * token trustworthy here: it sits at the very end of the message, or directly
 * before the `retryAfterSeconds=` suffix, and the lookahead admits nothing
 * else. A counterfeit inside the response body lands ahead of that position
 * and `String.match` without `/g` would otherwise return it first.
 *
 * A message with no marker is one that never crossed that boundary — an error
 * raised in the renderer, or a transport failure with no response at all. The
 * status is then unknown, not 200, and the caller says so rather than assuming.
 */
export function parseHttpStatus(message: string): number | null {
  const match = message.match(/(?:^|\s)httpStatus=(\d{3})(?=(?: retryAfterSeconds=\d+)?$)/)
  if (!match?.[1]) return null
  const status = Number.parseInt(match[1], 10)
  return status >= 100 && status <= 599 ? status : null
}

/**
 * The rate-limit verdict: the vetted status when there is one, the message text
 * only when there is not.
 *
 * A status flattened into prose cannot be recovered from prose. `httpClient`
 * composes `${status} ${statusText}: ${body}`, so a 500 whose body reads
 * `upstream 429 from the pool` produces a message in which both numbers are
 * three digits delimited by whitespace — no regex can tell which one the
 * server answered with, because the distinction was destroyed before the
 * string existed. Reading `httpStatus=` first restores it: a 500 is a 500 even
 * when its body talks about a 429 somewhere upstream, and the user stops being
 * told to wait out a window nobody opened.
 *
 * The textual path below still runs for messages with no marker, and stays
 * anchored for the same reason it was: `\b` treats `-` and `/` as boundaries,
 * so `edge-429-pool` in a body matched, while every real shape delimits the
 * status with whitespace or a colon (`429 Too Many Requests`,
 * `gfs download failed: 429:`). `rate_limited` is anchored to a token boundary
 * too — as a bare substring it also matched `not_rate_limited`, which is the
 * server saying the opposite. A missed 429 is the original incident, so the
 * text is still read when nothing better exists; it is no longer read when
 * something better does.
 */
export function isRateLimited(message: string): boolean {
  const status = parseHttpStatus(message)
  if (status !== null) return status === 429
  return (
    /(?:^|[\s:])429(?=[\s:]|$)/.test(message) ||
    /(?:^|[^A-Za-z0-9_])rate_limited(?![A-Za-z0-9_])/.test(message)
  )
}

function describeRateLimited(raw: string, subject: string): GfsGrantErrorPresentation {
  const retryAfterSeconds = parseRetryAfterSeconds(raw)
  return {
    code: 'rate_limited',
    message:
      retryAfterSeconds !== null
        ? `Too many ${subject} — try again in ${retryAfterSeconds}s.`
        : `Too many ${subject} — try again shortly.`,
    severity: 'error',
  }
}

/**
 * Read-plane counterpart of `describeGfsGrantError`.
 *
 * A read and a permission change fail under the same server budget but call for
 * different words: "too many permission changes" tells a user who was only
 * opening a file to stop doing something they never did. Only the rate limit is
 * translated here — every other read failure keeps its server verdict, because
 * the grant-plane codes below describe an operation a read never performs.
 */
export function describeGfsReadError(error: unknown): GfsGrantErrorPresentation {
  const raw = rawMessage(error)

  if (isRateLimited(raw)) return describeRateLimited(raw, 'file requests')

  return {
    code: null,
    message: stripVettedMarkers(stripIpcWrapper(raw)) || 'The file request failed.',
    severity: 'error',
  }
}

export function describeGfsGrantError(error: unknown): GfsGrantErrorPresentation {
  const raw = rawMessage(error)

  if (isRateLimited(raw)) return describeRateLimited(raw, 'permission changes')

  for (const [code, message] of Object.entries(GFS_GRANT_ERROR_MESSAGES)) {
    if (!raw.includes(code)) continue
    if (code === 'subjects_invalid') {
      const invalidIndexes = parseInvalidIndexes(raw)
      return {
        code,
        message: invalidIndexes.length
          ? `${message} (subjects ${invalidIndexes.map(index => index + 1).join(', ')})`
          : message,
        severity: 'error',
      }
    }
    return { code, message, severity: code === 'manage_acl_required' ? 'quiet' : 'error' }
  }

  return {
    code: null,
    message: stripVettedMarkers(raw) || 'The permission change failed.',
    severity: 'error',
  }
}
