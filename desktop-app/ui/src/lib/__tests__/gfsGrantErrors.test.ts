import { describe, expect, it } from 'vitest'
import {
  describeGfsGrantError,
  describeGfsReadError,
  isRateLimited,
  parseHttpStatus,
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
    // Witness, matching the read-plane cases below: the grant classifier is
    // live and still recognises a delimited status token in the very same
    // message, so the null above is a rejected embedding rather than a matcher
    // that stopped firing. Without it, deleting `isRateLimited` outright leaves
    // this test green.
    expect(describeGfsGrantError(new Error('resource res-4290 not found 429')).code).toBe(
      'rate_limited'
    )
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

  it('believes the vetted status over a 429 the response body merely mentions', () => {
    // The case no regex over the message can decide. `httpClient` composes
    // `${status} ${statusText}: ${body}`, so by the time the text exists both
    // numbers are three delimited digits and the real status is gone. The user
    // was told to wait out a rate-limit window that nobody had opened, on a
    // server that was simply failing.
    const raw =
      "Error invoking remote method 'gfs:listChildren': Error: " +
      '500 Internal Server Error: upstream 429 from the pool httpStatus=500'

    expect(describeGfsReadError(new Error(raw)).code).toBeNull()
    // Witness: the classifier ran on this exact message and still answers
    // `rate_limited` when the vetted status is the one that says so. Without
    // it, an `isRateLimited` that returned `false` unconditionally would leave
    // the assertion above green.
    expect(
      describeGfsReadError(
        new Error(raw.replace('httpStatus=500', 'httpStatus=429')) // same text, real 429
      ).code
    ).toBe('rate_limited')
  })

  it('ignores an httpStatus the server body wrote itself', () => {
    // The marker is only worth reading because the main process writes it and
    // strips every copy the body carried. This is what the renderer must do
    // with one that reached it anyway: the token is trusted at the suffix
    // position and nowhere else, so a body quoting it changes no verdict.
    expect(parseHttpStatus('500 Internal Server Error: httpStatus=429 said the proxy')).toBeNull()
    // Witness: the same token IS read at the position the main process writes
    // it, so the null above is a rejected position rather than a dead parser.
    expect(parseHttpStatus('500 Internal Server Error: upstream said so httpStatus=429')).toBe(429)
    expect(parseHttpStatus('429 Too Many Requests httpStatus=429 retryAfterSeconds=7')).toBe(429)
  })

  it('does not read the server saying NOT rate limited as saying it is', () => {
    // `rate_limited` was matched as a bare substring, and `not_rate_limited` is
    // the server's own negation of the very code being looked for.
    expect(isRateLimited('503 Service Unavailable: reason=not_rate_limited')).toBe(false)
    // Witness: the code is still recognised as a code, so the false above is a
    // rejected embedding and not a matcher that stopped firing.
    expect(isRateLimited('503 Service Unavailable: reason=rate_limited')).toBe(true)
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

  it('drops the vetted markers from the grant banner too', () => {
    // `surfaceGfsGrantError` wraps the grant methods as well as the read ones,
    // so the same marker reaches this plane's pass-through branch. Verbatim
    // means the server's verdict, not our plumbing appended to it.
    const raw = '409 Conflict: grant_version_stale httpStatus=409'

    // Liveness witness: the marker is present and readable before the strip.
    expect(parseHttpStatus(raw)).toBe(409)
    expect(describeGfsGrantError(new Error(raw))).toEqual({
      code: null,
      message: '409 Conflict: grant_version_stale',
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

  it('drops the vetted markers from the banner after reading them', () => {
    // The markers are plumbing between our two processes, exactly like the IPC
    // wrapper above. Swapping one for the other in front of the user is not a
    // fix, and a user told "read access was revoked httpStatus=403" is being
    // shown the mechanism instead of the reason.
    const raw =
      "Error invoking remote method 'gfs:downloadPreview': Error: 403 Forbidden: " +
      'read access was revoked httpStatus=403'

    // Liveness witness, and the reason the strip runs LAST: the marker is
    // present and readable on the way in. A strip applied before classifying
    // would leave this at null, which is the misclassification this module
    // exists to prevent.
    expect(parseHttpStatus(raw)).toBe(403)
    expect(describeGfsReadError(new Error(raw)).message).toBe(
      '403 Forbidden: read access was revoked'
    )
  })

  it('drops both markers when the server sent a window with a non-429 verdict', () => {
    // The builder appends them in a fixed order — [invalidIndexes] [httpStatus]
    // [retryAfterSeconds] — so removing them takes the reverse. One pass that
    // stopped at `retryAfterSeconds` would leave `httpStatus=503` on screen.
    const raw = '503 Service Unavailable: upstream_unreachable httpStatus=503 retryAfterSeconds=30'

    expect(parseHttpStatus(raw)).toBe(503)
    expect(parseRetryAfterSeconds(raw)).toBe(30)
    expect(describeGfsReadError(new Error(raw)).message).toBe(
      '503 Service Unavailable: upstream_unreachable'
    )
  })

  it("leaves a lookalike the server's own body carried", () => {
    // Only the suffix position is ours. A token ahead of it is the server's
    // text, and `surfaceGfsGrantError` already stripped the ones that could
    // have been mistaken for a verdict — so editing this one would be the
    // renderer rewriting a diagnostic it does not own.
    const raw = '500 Internal Server Error: {"upstream":"httpStatus=429"} httpStatus=500'

    expect(parseHttpStatus(raw)).toBe(500)
    expect(describeGfsReadError(new Error(raw)).message).toBe(
      '500 Internal Server Error: {"upstream":"httpStatus=429"}'
    )
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

  it('reads the vetted trailing suffix, not an earlier lookalike in the body', () => {
    // `String.match` without `/g` returns the FIRST match, so an unanchored
    // pattern resolves by position in the concatenation: the server's text
    // comes before the suffix the main process appends, and therefore won.
    // httpClient copies the RAW body into the message whenever the JSON has no
    // top-level `error`/`message` key, so a body that prints the field itself
    // arrives in the exact shape this parser reads.
    //
    // `retryAfterSeconds=0` is the damaging spelling: it is a VALID window, so
    // nothing downstream rejects it. It renders "try again in 0s" and clears
    // the gate immediately, restoring the refetch-on-focus loop that the 120/min
    // budget was already refusing — the original incident, one layer down.
    expect(
      parseRetryAfterSeconds(
        '429 Too Many Requests: please retryAfterSeconds=0 retryAfterSeconds=5'
      )
    ).toBe(5)
    // The same ordering with a large earlier value gates for the full clamp
    // instead, so the defect is not specific to zero.
    expect(parseRetryAfterSeconds('429: please retryAfterSeconds=300 retryAfterSeconds=5')).toBe(5)
    // Witness: the parser still resolves a message whose ONLY token is the
    // vetted suffix, so the assertions above are about which token wins and
    // not about a parser that stopped matching.
    expect(
      parseRetryAfterSeconds('429 Too Many Requests: please slow down retryAfterSeconds=5')
    ).toBe(5)
  })

  it('declines a lookalike token that the main process never republished', () => {
    // With the trailing anchor, a body whose own text ENDS in the field would
    // otherwise be read as our suffix. `surfaceGfsGrantError` strips any such
    // token before composing, so this shape cannot reach the renderer — and if
    // it ever does, no window is better than a counterfeit one.
    expect(parseRetryAfterSeconds('429 Too Many Requests: slow down')).toBeNull()
    // Witness: the message is otherwise recognised as a rate limit, so the
    // null above is the retry window being absent, not the error being unread.
    expect(isRateLimited('429 Too Many Requests: slow down')).toBe(true)
  })
})
