import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  OidcProfileFlowError,
  beginOidcAttempt,
  browserCookieName,
  completeOidcProfileFlow,
  newBrowserBinding,
  parseCallbackParameters,
  postOidcProfileFlow,
  returnToCookieName,
} from '../app/api/oidc/_flow'
import { GET } from '../app/api/oidc/callback/route'
import { edgeRecord, edgeResponse } from './edgeFixtures'

// Every upstream body below is External REST's recorded answer
// (external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json). A derived variant says so
// where it is built.
const EDGE_CONFIGURATION = 'GET /api/v1/oidc/profile-flow/configuration activated'
const EDGE_ATTEMPT_PLAIN = 'POST /api/v1/oidc/profile-flow/attempts plain'
const EDGE_ATTEMPT_DESKTOP_ECHO = 'POST /api/v1/oidc/profile-flow/attempts desktop-echo'
const EDGE_ATTEMPT_DESKTOP_UNAVAILABLE =
  'POST /api/v1/oidc/profile-flow/attempts desktop-unavailable'
const EDGE_DESKTOP_CODE_ISSUED = 'POST /api/v1/oidc/profile-flow/complete desktop-code-issued'
const EDGE_INVITATION_EMAIL_MISMATCH =
  'POST /api/v1/oidc/profile-flow/complete refused-invitation-email-mismatch'
const EDGE_RATE_LIMITED = 'POST /api/v1/oidc/profile-flow/complete rate-limited'
const EDGE_STORAGE_UNAVAILABLE = 'POST /api/v1/oidc/profile-flow/complete storage-unavailable'

const CONFIGURATION_PATH = '/api/v1/oidc/profile-flow/configuration'
const ATTEMPTS_PATH = '/api/v1/oidc/profile-flow/attempts'
const COMPLETE_PATH = '/api/v1/oidc/profile-flow/complete'

const TERMINAL_TEXT = 'This sign-in attempt cannot be reused. Start a new sign-in attempt.'
const INVALID_TEXT = 'Identity proof could not be verified.'

const edgeCallbackUri = (edgeRecord(EDGE_CONFIGURATION).body as { redirectUri: string }).redirectUri
const edgeState =
  new URL(
    (edgeRecord(EDGE_ATTEMPT_PLAIN).body as { authorizationUrl: string }).authorizationUrl
  ).searchParams.get('state') ?? ''
const BINDING = newBrowserBinding()
/** A fresh RFC 7636 verifier and its S256 challenge, as Evenfire Desktop makes them. */
const CODE_CHALLENGE = createHash('sha256')
  .update(randomBytes(32).toString('base64url'))
  .digest('base64url')
const bindingCookie = `${browserCookieName(edgeState)}=${BINDING}`
const returnCookie = `${returnToCookieName(edgeState)}=desktop-setup`

type UpstreamCall = Readonly<{ path: string; body: unknown }>
/** An edge.json key, or a function that builds a derived variant of a record. */
type EdgeAnswer = string | (() => Response)

/**
 * Answers External REST by the last path segment and records every request. A segment with no
 * answer gets a 404 that no test expects.
 */
async function withEdge(
  answers: Readonly<Partial<Record<'configuration' | 'attempts' | 'complete', EdgeAnswer>>>,
  run: (calls: UpstreamCall[]) => Promise<void>
): Promise<void> {
  const original = globalThis.fetch
  const calls: UpstreamCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const answer = answers[path.slice(path.lastIndexOf('/') + 1) as keyof typeof answers]
    if (answer === undefined) return Response.json({ error: 'unexpected_route' }, { status: 404 })
    return typeof answer === 'string' ? edgeResponse(answer) : answer()
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** A recorded answer's status with another body. Each use names what it changed. */
function edgeVariant(key: string, body: unknown): Response {
  return Response.json(body, { status: edgeRecord(key).status })
}

function profileRequest(): Request {
  return new Request(edgeCallbackUri)
}

function completeBody(): Record<string, unknown> {
  return { state: edgeState, code: 'provider-code', browserBinding: BINDING }
}

function callbackRequest(search: string, cookies: readonly string[]): Request {
  return new Request(`${edgeCallbackUri}?${search}`, { headers: { cookie: cookies.join('; ') } })
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
}

/**
 * The promise's result or rejection as a value. A rejection where a result was expected then
 * fails the deep-equal assertion with the error in its diff, instead of escaping the test.
 */
async function settled<T>(
  promise: Promise<T>
): Promise<Readonly<{ value: T }> | Readonly<{ error: unknown }>> {
  try {
    return { value: await promise }
  } catch (error) {
    return { error }
  }
}

function flowError(
  status: number,
  code: string,
  retryable: boolean,
  retryAfterSeconds?: number
): (error: unknown) => true {
  return error => {
    assert.ok(error instanceof OidcProfileFlowError)
    assert.deepEqual(
      {
        status: error.status,
        code: error.code,
        retryable: error.retryable,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status, code, retryable, retryAfterSeconds }
    )
    return true
  }
}

test('keeps 409 desktop_sign_in_unavailable from the edge record', async () => {
  await withEdge({ attempts: EDGE_ATTEMPT_DESKTOP_UNAVAILABLE }, async calls => {
    await assert.rejects(
      postOidcProfileFlow(
        'attempts',
        { browserBinding: BINDING, desktopSignIn: { codeChallenge: CODE_CHALLENGE } },
        profileRequest()
      ),
      flowError(409, 'desktop_sign_in_unavailable', false)
    )
    assert.deepEqual(
      calls.map(call => call.path),
      [ATTEMPTS_PATH]
    )
  })
})

test('forwards only the named attempt fields and returns the Desktop echo', async () => {
  // Extra keys reach beginOidcAttempt through a variable, so only the copy by name keeps them
  // from External REST.
  const desktopSignIn = { codeChallenge: CODE_CHALLENGE, desktopState: 'fixture-desktop-state' }
  await withEdge({ attempts: EDGE_ATTEMPT_DESKTOP_ECHO }, async calls => {
    const attempt = await beginOidcAttempt(BINDING, profileRequest(), { desktopSignIn })
    assert.deepEqual(calls[0]?.body, {
      browserBinding: BINDING,
      desktopSignIn: { codeChallenge: CODE_CHALLENGE },
    })
    assert.equal(
      attempt.signInContext,
      (edgeRecord(EDGE_ATTEMPT_DESKTOP_ECHO).body as { signInContext: string }).signInContext
    )
  })

  const invitation = { invitationToken: 'fixture-invitation-token', invitedEmail: 'x' }
  await withEdge({ attempts: EDGE_ATTEMPT_PLAIN }, async calls => {
    await beginOidcAttempt(BINDING, profileRequest(), invitation)
    assert.deepEqual(calls[0]?.body, {
      browserBinding: BINDING,
      invitationToken: 'fixture-invitation-token',
    })
  })

  await withEdge({ attempts: EDGE_ATTEMPT_PLAIN }, async calls => {
    await beginOidcAttempt(BINDING, profileRequest())
    assert.deepEqual(calls[0]?.body, { browserBinding: BINDING })
  })
})

test('parses desktop_code_issued from the edge record and rejects bad shapes', async () => {
  const recorded = edgeRecord(EDGE_DESKTOP_CODE_ISSUED).body as Record<string, unknown> & {
    code: string
    environment: string
  }
  await withEdge({ complete: EDGE_DESKTOP_CODE_ISSUED }, async calls => {
    assert.deepEqual(await settled(completeOidcProfileFlow(completeBody(), profileRequest())), {
      value: {
        kind: 'desktop_code_issued',
        code: recorded.code,
        environment: recorded.environment,
      },
    })
    assert.deepEqual(calls[0]?.body, completeBody())
  })

  const withoutEnvironment = { ...recorded } as Record<string, unknown>
  delete withoutEnvironment.environment
  // Derived variants of the recorded body, one field broken in each.
  for (const [label, body] of [
    ['a 42-character code', { ...recorded, code: recorded.code.slice(1) }],
    ['a missing environment', withoutEnvironment],
    ['memberAuthenticationActivated false', { ...recorded, memberAuthenticationActivated: false }],
  ] as const) {
    await withEdge({ complete: () => edgeVariant(EDGE_DESKTOP_CODE_ISSUED, body) }, async () => {
      await assert.rejects(
        completeOidcProfileFlow(completeBody(), profileRequest()),
        flowError(503, 'oidc_unavailable', false),
        label
      )
    })
  }
})

test('accepts invitation_email_mismatch from the edge record', async () => {
  const { reason } = edgeRecord(EDGE_INVITATION_EMAIL_MISMATCH).body as { reason: string }
  assert.equal(reason, 'invitation_email_mismatch')
  await withEdge({ complete: EDGE_INVITATION_EMAIL_MISMATCH }, async () => {
    assert.deepEqual(await settled(completeOidcProfileFlow(completeBody(), profileRequest())), {
      value: { kind: 'refused', reason },
    })
  })

  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_INVITATION_EMAIL_MISMATCH },
    async calls => {
      const response = await GET(
        callbackRequest(`state=${edgeState}&code=provider-code`, [bindingCookie])
      )
      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), `/oidc/result?reason=${reason}`)
      assert.deepEqual(response.headers.getSetCookie(), [clearCookie(browserCookieName(edgeState))])
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

test('reports an unknown provider error with its state', () => {
  for (const search of [
    `state=${edgeState}&error=login_required`,
    `state=${edgeState}&error=interaction_required&error_description=ignored`,
    `state=${edgeState}&error=invalid_scope&iss=https%3A%2F%2Fmember-sign-in.example.test`,
  ]) {
    assert.deepEqual(
      parseCallbackParameters(new Request(`${edgeCallbackUri}?${search}`)),
      { kind: 'provider-error', state: edgeState },
      search
    )
  }
})

test('still treats a malformed callback as invalid', () => {
  for (const search of [
    'error=login_required',
    'state=too-short&error=login_required',
    `state=${edgeState}&state=${edgeState}&error=login_required`,
    `state=${edgeState}&error=login_required&error=consent_required`,
    `state=${edgeState}&code=provider-code&error=login_required`,
    `state=${edgeState}&error=login_required&iss=a&iss=b`,
    `state=${edgeState}`,
  ]) {
    assert.deepEqual(
      parseCallbackParameters(new Request(`${edgeCallbackUri}?${search}`)),
      { kind: 'invalid' },
      search
    )
  }
})

test("a plain attempt's unknown provider error keeps today's 400 and calls nothing upstream", async () => {
  await withEdge({ configuration: EDGE_CONFIGURATION }, async calls => {
    const response = await GET(
      callbackRequest(`state=${edgeState}&error=login_required`, [bindingCookie, returnCookie])
    )
    assert.equal(response.status, 400)
    assert.equal(await response.text(), INVALID_TEXT)
    assert.deepEqual(response.headers.getSetCookie(), [])
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH]
    )
  })
})

test('a plain attempt answered desktop_code_issued gets the 503 terminal page', async () => {
  const { code } = edgeRecord(EDGE_DESKTOP_CODE_ISSUED).body as { code: string }
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_DESKTOP_CODE_ISSUED },
    async calls => {
      const response = await GET(
        callbackRequest(`state=${edgeState}&code=provider-code`, [bindingCookie, returnCookie])
      )
      const text = await response.text()
      assert.equal(response.status, 503)
      assert.equal(text, TERMINAL_TEXT)
      assert.doesNotMatch(text, /evenfire:\/\//)
      assert.doesNotMatch(text, /Identity proof was verified/)
      assert.equal(text.includes(code), false)
      assert.equal(response.headers.get('location'), null)
      assert.deepEqual(response.headers.getSetCookie(), [
        clearCookie(browserCookieName(edgeState)),
        clearCookie(returnToCookieName(edgeState)),
      ])
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

test('the fixture response carries retry-after for the edge 429', async () => {
  assert.equal(edgeResponse(EDGE_RATE_LIMITED).headers.get('retry-after'), '60')
  await withEdge({ complete: EDGE_RATE_LIMITED }, async () => {
    await assert.rejects(
      completeOidcProfileFlow(completeBody(), profileRequest()),
      flowError(429, 'oidc_unavailable', true, 60)
    )
  })
})

test("the edge's terminal 503 for an unrecognised outcome ends the attempt", async () => {
  // Derived variant of `complete storage-unavailable` with the code swapped: the edge's /complete
  // answers an outcome it does not recognise with exactly { error: 'oidc_unavailable',
  // retrySameAttempt: false } (external-rest-api/src/routes/oidcProfileFlow.ts), because
  // control-api has already consumed the attempt.
  const terminal = () =>
    edgeVariant(EDGE_STORAGE_UNAVAILABLE, {
      ...(edgeRecord(EDGE_STORAGE_UNAVAILABLE).body as Record<string, unknown>),
      error: 'oidc_unavailable',
    })
  await withEdge({ complete: terminal }, async () => {
    await assert.rejects(
      completeOidcProfileFlow(completeBody(), profileRequest()),
      flowError(503, 'oidc_unavailable', false)
    )
  })

  await withEdge({ configuration: EDGE_CONFIGURATION, complete: terminal }, async calls => {
    const response = await GET(
      callbackRequest(`state=${edgeState}&code=provider-code`, [bindingCookie, returnCookie])
    )
    assert.equal(response.status, 503)
    assert.equal(await response.text(), TERMINAL_TEXT)
    assert.deepEqual(response.headers.getSetCookie(), [
      clearCookie(browserCookieName(edgeState)),
      clearCookie(returnToCookieName(edgeState)),
    ])
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH, COMPLETE_PATH]
    )
  })
})
