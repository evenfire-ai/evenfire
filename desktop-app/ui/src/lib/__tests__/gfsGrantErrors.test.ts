import { describe, expect, it } from 'vitest'
import {
  describeGfsGrantError,
  describeGfsReadError,
  parseRetryAfterSeconds,
} from '../gfsGrantErrors'

/**
 * Pure presentation map for GFS grant-plane server verdicts. Codes arrive
 * embedded in Electron IPC error messages, so matching is substring-based.
 *
 * `invalidIndexes` / `retryAfterSeconds` are SEPARATE response-body fields on the
 * server; the desktop main process (uriHandler surfaceGfsGrantError) appends them
 * to the error message as `invalidIndexes=[…]` / `retryAfterSeconds=…` BEFORE the
 * IPC boundary drops `ApiError.bodyText`. These cases feed that real production
 * message shape — not a JSON blob the wire never carries.
 */

describe('describeGfsGrantError', () => {
  it.each([
    ['agent_manager_forbidden', "Agents can't be given manage or share access."],
    ['managed_agent_permission_forbidden', 'Managed agents can only be granted read and write.'],
    ['foreign_agent_forbidden', 'You can only grant access to your own agents.'],
    ['escalation_rejected', 'You can only grant permissions you already hold here.'],
  ])('maps %s to its human message with error severity', (code, message) => {
    const presentation = describeGfsGrantError(
      new Error(`Error invoking remote method 'gfs:grant': Error: 403 Forbidden: ${code}`)
    )

    expect(presentation).toEqual({ code, message, severity: 'error' })
  })

  it('maps manage_acl_required to a quiet banner, never an error toast', () => {
    const presentation = describeGfsGrantError(
      new Error(
        "Error invoking remote method 'gfs:listGrants': Error: 403 Forbidden: manage_acl_required"
      )
    )

    expect(presentation).toEqual({
      code: 'manage_acl_required',
      message: 'Only people with manage access can view who has access here.',
      severity: 'quiet',
    })
  })

  it('maps subjects_invalid without indexes', () => {
    expect(describeGfsGrantError(new Error('400 Bad Request: subjects_invalid'))).toEqual({
      code: 'subjects_invalid',
      message: 'Some selected subjects are invalid and were rejected.',
      severity: 'error',
    })
  })

  it('appends 1-based subject positions when subjects_invalid carries invalidIndexes', () => {
    // The exact message the main process now produces: the ApiError message with
    // the appended `invalidIndexes=[…]` the server sent as a separate body field.
    const presentation = describeGfsGrantError(
      new Error(
        "Error invoking remote method 'gfs:grant': Error: 400 Bad Request: subjects_invalid invalidIndexes=[0,2]"
      )
    )

    expect(presentation).toEqual({
      code: 'subjects_invalid',
      message: 'Some selected subjects are invalid and were rejected. (subjects 1, 3)',
      severity: 'error',
    })
  })

  it('maps 429 with retryAfterSeconds into the retry message', () => {
    // rate-limit body is `{ error: 'Too Many Requests', retryAfterSeconds }`; the
    // main process appends `retryAfterSeconds=…` from the dropped body field.
    const presentation = describeGfsGrantError(
      new Error(
        "Error invoking remote method 'gfs:grant': Error: 429 Too Many Requests: Too Many Requests retryAfterSeconds=42"
      )
    )

    expect(presentation).toEqual({
      code: 'rate_limited',
      message: 'Too many permission changes — try again in 42s.',
      severity: 'error',
    })
  })

  it('maps 429 without a parseable retryAfterSeconds to the generic retry message', () => {
    const presentation = describeGfsGrantError(new Error('429 Too Many Requests'))

    expect(presentation).toEqual({
      code: 'rate_limited',
      message: 'Too many permission changes — try again shortly.',
      severity: 'error',
    })
  })

  it('does not treat an id containing 429 as a rate limit', () => {
    const presentation = describeGfsGrantError(new Error('resource res-4290 not found'))

    expect(presentation).toEqual({
      code: null,
      message: 'resource res-4290 not found',
      severity: 'error',
    })
  })

  it.each([
    ['hyphen-delimited, as in a name', '500 Internal Server Error: upstream edge-429-pool refused'],
    ['slash-delimited, as in a path', '404 Not Found: no handler for /docs/429/index.md'],
  ])('does not treat a 429 embedded in text as a rate limit (%s)', (_label, raw) => {
    // `httpClient` copies the RAW body into the message when the JSON carries
    // no top-level `error`/`message`, so arbitrary server text reaches the
    // classifier. A word-boundary match fired on `-429-` and `/429/`.
    const presentation = describeGfsReadError(new Error(raw))

    expect(presentation.code).toBeNull()
    // Witness: the classifier is live and still recognises the status token in
    // the very same message, so the null above is a rejected embedding and not
    // a matcher that stopped working.
    expect(describeGfsReadError(new Error(`${raw} 429`)).code).toBe('rate_limited')
  })

  it.each([
    ['leading status', '429 Too Many Requests'],
    ['colon-wrapped status', 'gfs download failed: 429: Too Many Requests'],
    ['trailing status', 'gfs download failed: 429'],
  ])('still recognises the status token the wire produces (%s)', (_label, raw) => {
    expect(describeGfsReadError(new Error(raw)).code).toBe('rate_limited')
  })

  it('passes unknown errors through verbatim — fail loud, never swallow', () => {
    expect(describeGfsGrantError(new Error('total surprise'))).toEqual({
      code: null,
      message: 'total surprise',
      severity: 'error',
    })
    expect(describeGfsGrantError('string failure')).toEqual({
      code: null,
      message: 'string failure',
      severity: 'error',
    })
  })
})

/**
 * Reads are a different plane from grants. The copy diverges because the user's
 * next action diverges: a rate-limited grant means "stop changing permissions",
 * a rate-limited read means "the file is fine, ask again in a moment".
 */
describe('describeGfsReadError', () => {
  it('reports a rate-limited read as a read, with the server retry hint', () => {
    const raw =
      "Error invoking remote method 'gfs:download': Error: gfs download failed: 429: " +
      'Too Many Requests retryAfterSeconds=7'

    expect(describeGfsReadError(new Error(raw))).toEqual({
      code: 'rate_limited',
      message: 'Too many file requests — try again in 7s.',
      severity: 'error',
    })
  })

  it('drops the countdown when the server sent no retry hint', () => {
    expect(describeGfsReadError(new Error('gfs download failed: 429'))).toEqual({
      code: 'rate_limited',
      message: 'Too many file requests — try again shortly.',
      severity: 'error',
    })
  })

  it('never borrows the permission-plane copy for a read', () => {
    const readMessage = describeGfsReadError(new Error('429 retryAfterSeconds=7')).message

    expect(readMessage).not.toContain('permission changes')
    // Witness: the rate-limit branch really ran, so the assertion above is
    // about chosen copy and not about a message that never got classified.
    expect(readMessage).toContain('7s')
  })

  it('passes a non-rate-limited read failure through verbatim', () => {
    expect(describeGfsReadError(new Error('gfs download failed: 502'))).toEqual({
      code: null,
      message: 'gfs download failed: 502',
      severity: 'error',
    })
  })

  it('keeps the server verdict but drops the IPC wrapper around it', () => {
    // The wrapper names our own main/renderer channel. It is noise to a user
    // and the verdict after it is the part they can act on, so exactly one of
    // the two is removed.
    const presented = describeGfsReadError(
      new Error(
        "Error invoking remote method 'gfs:listChildren': GfsUriError: 503 Service Unavailable: upstream_unreachable"
      )
    )

    expect(presented.message).toBe('503 Service Unavailable: upstream_unreachable')
  })

  it('reads a retry window only from its own field', () => {
    // A pattern that skips non-digits binds to the next number ANYWHERE in the
    // message, so a null window next to an unrelated number yielded that
    // number — inventing a 100-second gate out of a rate-limit ceiling.
    expect(
      parseRetryAfterSeconds('429 Too Many Requests: {"retryAfterSeconds":null,"limit":100}')
    ).toBeNull()
    // Witness: the same parser does find the field when it is genuinely there,
    // in the one shape the main process emits.
    expect(parseRetryAfterSeconds('429 Too Many Requests retryAfterSeconds=7')).toBe(7)
  })

  it('refuses a retry window the main process declined to trust', () => {
    // `parseGfsGrantErrorFields` reads the body field at the TOP level only, so
    // a nested one yields no `retryAfterSeconds=` suffix. httpClient then puts
    // the RAW body into the message (it carries no top-level `error`/`message`
    // key), and a separator-agnostic pattern read the nested value back out —
    // gating Retry and focus revalidation for the full 300s clamp on a number
    // the authoritative parser had already rejected.
    expect(
      parseRetryAfterSeconds('429 Too Many Requests: {"policy":{"retryAfterSeconds":3600}}')
    ).toBeNull()
    // Witness: the identical window IS honoured once the main process has
    // vetted it and republished it as its own suffix, so the assertion above
    // is about provenance and not about a parser that stopped working.
    expect(parseRetryAfterSeconds('429 Too Many Requests retryAfterSeconds=3600')).toBe(300)
  })

  it('bounds a retry window the server could never legitimately be asking for', () => {
    // The value disables the Retry button and suppresses focus revalidation.
    // Unbounded, one hostile or corrupt response wedges both for the lifetime
    // of the controller — a durable outage out of a transient 429.
    expect(parseRetryAfterSeconds('429 retryAfterSeconds=999999999')).toBe(300)
    // Witness: the clamp is a ceiling, not a constant.
    expect(parseRetryAfterSeconds('429 retryAfterSeconds=45')).toBe(45)
  })
})
