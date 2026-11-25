import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  buildDesktopLoginCodeLink,
  buildDesktopLoginErrorLink,
  parseDesktopLoginLink,
} from '@clerum/desktop-app-links'
import {
  DESKTOP_BINDING_COOKIE_RE,
  desktopBindingCookieValue,
  desktopLoginErrorPage,
  desktopLoginPage,
  readDesktopBindingCookie,
} from '../app/api/oidc/_desktop'
import {
  OidcProfileFlowError,
  PROFILE_SESSION_COOKIE_PREFIX,
  beginOidcAttempt,
  browserCookieName,
  completeOidcProfileFlow,
  newBrowserBinding,
  parseCallbackParameters,
  postOidcProfileFlow,
  readSingleCookie,
  responseForFlowError,
  returnToCookieName,
} from '../app/api/oidc/_flow'
import { GET } from '../app/api/oidc/callback/route'
import { POST as desktopStart } from '../app/api/oidc/desktop-start/route'
import { POST as plainStart } from '../app/api/oidc/start/route'
import {
  DESKTOP_SIGN_IN_COPY,
  OIDC_REFUSAL_MESSAGES,
  OIDC_SIGNED_IN_MARKER_COOKIE,
} from '../app/constants/oidc'
import { PROFILE_ROUTES } from '../app/constants/routes'
import { buildEvenfireDesktopAppContentSecurityPolicy } from '../lib/desktopAppLinks'
import { edgeRecord, edgeResponse, edgeSetCookies } from './edgeFixtures'

// Every upstream body below is External REST's recorded answer
// (external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json). A derived variant says so
// where it is built.
const EDGE_CONFIGURATION = 'GET /api/v1/oidc/profile-flow/configuration activated'
const EDGE_ATTEMPT_PLAIN = 'POST /api/v1/oidc/profile-flow/attempts plain'
const EDGE_ATTEMPT_DESKTOP_ECHO = 'POST /api/v1/oidc/profile-flow/attempts desktop-echo'
const EDGE_ATTEMPT_DESKTOP_UNAVAILABLE =
  'POST /api/v1/oidc/profile-flow/attempts desktop-unavailable'
const EDGE_ATTEMPT_INVALID = 'POST /api/v1/oidc/profile-flow/attempts invalid'
const EDGE_MEMBER_SIGNED_IN = 'POST /api/v1/oidc/profile-flow/complete member-signed-in'
const EDGE_DESKTOP_CODE_ISSUED = 'POST /api/v1/oidc/profile-flow/complete desktop-code-issued'
const EDGE_INVITATION_EMAIL_MISMATCH =
  'POST /api/v1/oidc/profile-flow/complete refused-invitation-email-mismatch'
const EDGE_RATE_LIMITED = 'POST /api/v1/oidc/profile-flow/complete rate-limited'
const EDGE_STORAGE_UNAVAILABLE = 'POST /api/v1/oidc/profile-flow/complete storage-unavailable'
const EDGE_REFUSED = 'POST /api/v1/oidc/profile-flow/complete refused'
const EDGE_IDENTITY_PROOF_VERIFIED =
  'POST /api/v1/oidc/profile-flow/complete identity-proof-verified'
const EDGE_CANCELLED = 'POST /api/v1/oidc/profile-flow/cancel cancelled'

const CONFIGURATION_PATH = '/api/v1/oidc/profile-flow/configuration'
const ATTEMPTS_PATH = '/api/v1/oidc/profile-flow/attempts'
const COMPLETE_PATH = '/api/v1/oidc/profile-flow/complete'
const CANCEL_PATH = '/api/v1/oidc/profile-flow/cancel'

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
/** The state Evenfire Desktop puts in the sign-in page's fragment. */
const DESKTOP_STATE = randomBytes(32).toString('base64url')
const returnCookie = `${returnToCookieName(edgeState)}=desktop-setup`

type UpstreamCall = Readonly<{ path: string; body: unknown }>
/** An edge.json key, or a function that builds a derived variant of a record. */
type EdgeAnswer = string | (() => Response)

/**
 * Answers External REST by the last path segment and records every request. A segment with no
 * answer gets a 404 that no test expects.
 */
async function withEdge(
  answers: Readonly<
    Partial<Record<'configuration' | 'attempts' | 'complete' | 'cancel', EdgeAnswer>>
  >,
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

function cookieRequest(cookie: string): Request {
  return new Request(edgeCallbackUri, { headers: { cookie } })
}

test('a frozen copy of PR2 binding rule rejects the Desktop cookie value, as the live reader does', () => {
  // profile-ui/app/api/oidc/_flow.ts:17 at 85ca44ca5: the binding rule of a callback without
  // Desktop sign-in.
  const FROZEN_PR2_BINDING_RE = /^[A-Za-z0-9_-]{43}$/
  const name = browserCookieName(edgeState)
  const value = desktopBindingCookieValue(BINDING, DESKTOP_STATE)

  assert.equal(value, `desktop.${BINDING}.${DESKTOP_STATE}`)
  assert.match(value, DESKTOP_BINDING_COOKIE_RE)
  assert.doesNotMatch(value, FROZEN_PR2_BINDING_RE)
  assert.equal(readSingleCookie(cookieRequest(`${name}=${value}`), name), undefined)
  assert.deepEqual(readDesktopBindingCookie(cookieRequest(`${name}=${value}`), name), {
    binding: BINDING,
    desktopState: DESKTOP_STATE,
  })
})

test('reads a Desktop binding only from exactly one well-formed cookie', () => {
  const name = browserCookieName(edgeState)
  const value = desktopBindingCookieValue(BINDING, DESKTOP_STATE)
  for (const [label, cookie] of [
    ['a duplicate', `${name}=${value}; ${name}=${value}`],
    ['another prefix', `${name}=profile.${BINDING}.${DESKTOP_STATE}`],
    ['a 42-character binding', `${name}=desktop.${BINDING.slice(1)}.${DESKTOP_STATE}`],
    ['a 42-character state', `${name}=desktop.${BINDING}.${DESKTOP_STATE.slice(1)}`],
    ['a plain binding', `${name}=${BINDING}`],
    ['an oversized header', `${name}=${value}; padding=${'x'.repeat(16_384)}`],
    // One character swapped in place, so each segment keeps its 43 characters.
    ['a "+" in the binding', `${name}=desktop.+${BINDING.slice(1)}.${DESKTOP_STATE}`],
    ['a "/" in the state', `${name}=desktop.${BINDING}.${DESKTOP_STATE.slice(1)}/`],
    ['an "=" in the binding', `${name}=desktop.${BINDING.slice(1)}=.${DESKTOP_STATE}`],
    ['an extra segment', `${name}=desktop.${BINDING}.${DESKTOP_STATE}.x`],
  ] as const) {
    assert.equal(readDesktopBindingCookie(cookieRequest(cookie), name), undefined, label)
  }
  assert.deepEqual(
    readDesktopBindingCookie(cookieRequest(`other=1; ${name}=${value}`), name),
    { binding: BINDING, desktopState: DESKTOP_STATE },
    'one well-formed cookie among others'
  )
  assert.throws(() => desktopBindingCookieValue(BINDING.slice(1), DESKTOP_STATE), /binding/)
  assert.throws(() => desktopBindingCookieValue(BINDING, `${DESKTOP_STATE}.`), /binding/)
})

/** The link the page's one script fires, read back from its `const link = "…";`. */
function scriptLink(body: string): string {
  const match = body.match(/<script nonce="[^"]+">const link = ("[^"]*");/)
  assert.ok(match?.[1], 'expected the handoff script to name its link')
  return JSON.parse(match[1]) as string
}

test('the Desktop handoff page sends no-store, no-referrer, a nonce CSP and only the given cookies', async () => {
  const { code, environment } = edgeRecord(EDGE_DESKTOP_CODE_ISSUED).body as {
    code: string
    environment: string
  }
  const link = buildDesktopLoginCodeLink({ state: DESKTOP_STATE, code, environment })
  const cookies = [clearCookie(browserCookieName(edgeState))]
  const response = desktopLoginPage({
    link,
    message: DESKTOP_SIGN_IN_COPY.handoffMessage,
    status: 200,
    cookies,
  })
  const body = await response.text()
  const nonce = body.match(/<script nonce="([^"]+)">/)?.[1] ?? ''

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(
    response.headers.get('content-security-policy'),
    buildEvenfireDesktopAppContentSecurityPolicy(nonce)
  )
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.deepEqual(response.headers.getSetCookie(), cookies)
  assert.ok(body.includes(`<title>${DESKTOP_SIGN_IN_COPY.handoffTitle}</title>`))
  assert.ok(body.includes(`<p class="body-copy">${DESKTOP_SIGN_IN_COPY.handoffMessage}</p>`))
  assert.equal(scriptLink(body), link)

  assert.throws(
    () =>
      desktopLoginPage({
        link,
        message: DESKTOP_SIGN_IN_COPY.handoffMessage,
        status: 200,
        cookies: [...cookies, 'profile_session=fixture-session; Path=/; Secure; HttpOnly'],
      }),
    /profile_session/
  )
})

test("the Desktop error page fires the package's error link for the Desktop state", async () => {
  for (const [error, reason, message, status] of [
    ['refused', 'account_disabled', OIDC_REFUSAL_MESSAGES.account_disabled, 403],
    ['failed', undefined, DESKTOP_SIGN_IN_COPY.failed, 503],
  ] as const) {
    const cookies = [clearCookie(browserCookieName(edgeState))]
    const response = desktopLoginErrorPage({
      desktopState: DESKTOP_STATE,
      error,
      ...(reason ? { reason } : {}),
      message,
      status,
      cookies,
    })
    const body = await response.text()
    const link = scriptLink(body)

    assert.equal(response.status, status, error)
    assert.deepEqual(response.headers.getSetCookie(), cookies, error)
    assert.equal(link, buildDesktopLoginErrorLink({ state: DESKTOP_STATE, error, reason }), error)
    assert.deepEqual(
      parseDesktopLoginLink(link),
      reason
        ? { kind: 'error', state: DESKTOP_STATE, error, reason }
        : { kind: 'error', state: DESKTOP_STATE, error },
      error
    )
    assert.ok(body.includes(`<p class="body-copy">${message}</p>`), error)
  }
})

// /api/oidc/desktop-start. The Origin is the origin of `configuration activated`'s redirectUri.
const profileOrigin = new URL(edgeCallbackUri).origin
const desktopEchoUrl = (edgeRecord(EDGE_ATTEMPT_DESKTOP_ECHO).body as { authorizationUrl: string })
  .authorizationUrl
const desktopEchoState = new URL(desktopEchoUrl).searchParams.get('state') ?? ''
const DESKTOP_FORM = [
  ['desktopChallenge', CODE_CHALLENGE],
  ['desktopState', DESKTOP_STATE],
] as const
const ATTEMPT_COOKIE = /^([^=;]+)=([^;]*); Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/

/** A urlencoded form POST to `path`, as a browser sends it, with its Content-Length. */
function formPost(
  path: string,
  fields: ReadonlyArray<readonly [string, string]>,
  headers: Record<string, string> = {}
): Request {
  const body = new URLSearchParams(fields.map(([key, value]) => [key, value])).toString()
  return new Request(new URL(path, profileOrigin), {
    method: 'POST',
    headers: {
      origin: profileOrigin,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  })
}

function desktopStartForm(
  fields: ReadonlyArray<readonly [string, string]> = DESKTOP_FORM,
  headers: Record<string, string> = {}
): Request {
  return formPost(PROFILE_ROUTES.oidcDesktopStart, fields, headers)
}

/** The attempt cookie's name and value, with the attributes every attempt cookie carries. */
function attemptCookie(setCookie: string | undefined): Readonly<{ name: string; value: string }> {
  const match = ATTEMPT_COOKIE.exec(setCookie ?? '')
  assert.ok(match, `expected an attempt cookie, got ${setCookie}`)
  return { name: match[1], value: match[2] }
}

function attemptBody(calls: readonly UpstreamCall[]): Record<string, unknown> {
  const attempt = calls.find(call => call.path === ATTEMPTS_PATH)?.body
  assert.ok(attempt && typeof attempt === 'object', 'expected an /attempts request')
  return attempt as Record<string, unknown>
}

/**
 * The Desktop page that fires `unavailable` for the posted state, with `message` (its apostrophes
 * escaped, as the page writes them), `status`, no redirect and no cookie.
 */
async function assertUnavailablePage(
  response: Response,
  message: string,
  status: number,
  label: string
): Promise<void> {
  const body = await response.text()
  assert.equal(response.status, status, label)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label)
  assert.ok(
    body.includes(`evenfire://desktop-login?state=${DESKTOP_STATE}&error=unavailable`),
    label
  )
  assert.equal(
    scriptLink(body),
    buildDesktopLoginErrorLink({ state: DESKTOP_STATE, error: 'unavailable' }),
    label
  )
  assert.ok(body.includes(`<p class="body-copy">${message.replaceAll("'", '&#39;')}</p>`), label)
  assert.equal(response.headers.get('location'), null, label)
  assert.deepEqual(response.headers.getSetCookie(), [], label)
}

test('posts only the challenge upstream and keeps the state inside the binding cookie', async () => {
  await withEdge(
    { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
    async calls => {
      const response = await desktopStart(desktopStartForm())
      const attempt = attemptBody(calls)
      const cookies = response.headers.getSetCookie()
      const cookie = attemptCookie(cookies[0])
      const value = DESKTOP_BINDING_COOKIE_RE.exec(cookie.value)

      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), desktopEchoUrl)
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, ATTEMPTS_PATH]
      )
      assert.deepEqual(Object.keys(attempt), ['browserBinding', 'desktopSignIn'])
      assert.deepEqual(attempt.desktopSignIn, { codeChallenge: CODE_CHALLENGE })
      assert.equal(cookies.length, 1)
      assert.equal(cookie.name, browserCookieName(desktopEchoState))
      assert.ok(value, `expected a Desktop binding cookie value, got ${cookie.value}`)
      assert.equal(value[1], attempt.browserBinding)
      assert.equal(value[2], DESKTOP_STATE)
      for (const call of calls) {
        assert.equal(JSON.stringify(call.body ?? null).includes(DESKTOP_STATE), false, call.path)
      }
    }
  )
})

for (const [label, attempts, message, status] of [
  ['attempts plain', EDGE_ATTEMPT_PLAIN, DESKTOP_SIGN_IN_COPY.unavailable, 409],
  [
    'attempts desktop-unavailable',
    EDGE_ATTEMPT_DESKTOP_UNAVAILABLE,
    DESKTOP_SIGN_IN_COPY.unavailable,
    409,
  ],
  ['attempts invalid', EDGE_ATTEMPT_INVALID, DESKTOP_SIGN_IN_COPY.invalidLink, 400],
  [
    'a transport failure',
    (): Response => {
      throw new TypeError('fetch failed')
    },
    DESKTOP_SIGN_IN_COPY.startFailed,
    503,
  ],
] as const) {
  test(`fires unavailable and sets no cookie for ${label}`, async () => {
    await withEdge({ configuration: EDGE_CONFIGURATION, attempts }, async calls => {
      const response = await desktopStart(desktopStartForm())
      await assertUnavailablePage(response, message, status, label)
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, ATTEMPTS_PATH]
      )
    })
  })
}

test('chooses the unavailable copy by the desktop_sign_in_unavailable code, not by 409', async () => {
  // Derived variant of `attempts desktop-unavailable` with the code swapped. Profile UI keeps any
  // upstream 409, so only the code says that Desktop sign-in is off here.
  const otherConflict = () =>
    edgeVariant(EDGE_ATTEMPT_DESKTOP_UNAVAILABLE, { error: 'oidc_attempt_rejected' })
  await withEdge({ configuration: EDGE_CONFIGURATION, attempts: otherConflict }, async () => {
    const response = await desktopStart(desktopStartForm())
    await assertUnavailablePage(response, DESKTOP_SIGN_IN_COPY.startFailed, 503, 'another 409')
  })
})

test('fires unavailable for a cross-origin post, a configuration failure or an unusable attempt', async () => {
  // Derived variant of `attempts desktop-echo` whose expiry has already passed.
  const expired = () =>
    edgeVariant(EDGE_ATTEMPT_DESKTOP_ECHO, {
      ...(edgeRecord(EDGE_ATTEMPT_DESKTOP_ECHO).body as Record<string, unknown>),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
  const unreachable = (): Response => {
    throw new TypeError('fetch failed')
  }
  for (const [label, answers, headers, status, paths] of [
    [
      'a cross-origin post',
      { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
      { origin: 'https://other.example.test' },
      403,
      [CONFIGURATION_PATH],
    ],
    [
      'an unreachable configuration',
      { configuration: unreachable, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
      {},
      503,
      [CONFIGURATION_PATH],
    ],
    [
      // Derived: `complete rate-limited` replayed for the configuration call. The edge's
      // per-client limiter covers every /oidc/profile-flow route (router.use in
      // external-rest-api/src/routes/oidcProfileFlow.ts) and answers each one this way.
      'a rate-limited configuration',
      { configuration: EDGE_RATE_LIMITED, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
      {},
      429,
      [CONFIGURATION_PATH],
    ],
    [
      'an expired attempt',
      { configuration: EDGE_CONFIGURATION, attempts: expired },
      {},
      503,
      [CONFIGURATION_PATH, ATTEMPTS_PATH],
    ],
  ] as const) {
    await withEdge(answers, async calls => {
      const response = await desktopStart(desktopStartForm(DESKTOP_FORM, headers))
      await assertUnavailablePage(response, DESKTOP_SIGN_IN_COPY.startFailed, status, label)
      assert.deepEqual(
        calls.map(call => call.path),
        paths,
        label
      )
    })
  }
})

test('answers a malformed state with plain text and no link', async () => {
  const challenge = ['desktopChallenge', CODE_CHALLENGE] as const
  // Past the 8 KiB form cap (OIDC_START_FORM_MAX_BYTES) on its own, whatever the other fields.
  const oversized = [...DESKTOP_FORM, ['pad', 'x'.repeat(8192)]] as const
  for (const [label, request] of [
    ['no desktopState', desktopStartForm([challenge])],
    [
      'a 42-character desktopState',
      desktopStartForm([challenge, ['desktopState', DESKTOP_STATE.slice(1)]]),
    ],
    [
      'a desktopState outside base64url',
      desktopStartForm([challenge, ['desktopState', `+${DESKTOP_STATE.slice(1)}`]]),
    ],
    [
      'two desktopState values',
      desktopStartForm([...DESKTOP_FORM, ['desktopState', DESKTOP_STATE]]),
    ],
    ['a form above the length cap', desktopStartForm(oversized)],
    ['a form sent as text/plain', desktopStartForm(DESKTOP_FORM, { 'content-type': 'text/plain' })],
  ] as const) {
    await withEdge(
      { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
      async calls => {
        const response = await desktopStart(request)
        const text = await response.text()
        assert.equal(response.status, 400, label)
        assert.equal(text, DESKTOP_SIGN_IN_COPY.invalidLink, label)
        assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', label)
        assert.equal(response.headers.get('cache-control'), 'no-store', label)
        assert.equal(text.includes('evenfire://'), false, label)
        assert.equal(response.headers.get('location'), null, label)
        assert.deepEqual(response.headers.getSetCookie(), [], label)
        assert.deepEqual(calls, [], label)
      }
    )
  }
})

test('fires unavailable for a malformed challenge with a valid state', async () => {
  const state = ['desktopState', DESKTOP_STATE] as const
  for (const [label, fields] of [
    ['no desktopChallenge', [state]],
    ['a 42-character desktopChallenge', [['desktopChallenge', CODE_CHALLENGE.slice(1)], state]],
    // `.` is not base64url, and the route's re-encoding leaves it as it is, so only the value rule
    // can refuse it (a `+` reaches the parser percent-encoded). The value keeps its 43 characters.
    [
      'a desktopChallenge outside base64url',
      [['desktopChallenge', `.${CODE_CHALLENGE.slice(1)}`], state],
    ],
    ['two desktopChallenge values', [...DESKTOP_FORM, ['desktopChallenge', CODE_CHALLENGE]]],
    // Strict parsing: a form with any other field is not a Desktop sign-in form.
    ['an extra returnTo field', [...DESKTOP_FORM, ['returnTo', 'desktop-setup']]],
    // A field named like a fragment key never stands in for a Desktop field.
    ['an extra field named state', [...DESKTOP_FORM, ['state', DESKTOP_STATE]]],
  ] as const) {
    await withEdge(
      { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
      async calls => {
        const response = await desktopStart(desktopStartForm(fields))
        await assertUnavailablePage(response, DESKTOP_SIGN_IN_COPY.invalidLink, 400, label)
        assert.deepEqual(calls, [], label)
      }
    )
  }
})

test('plain /api/oidc/start never forwards Desktop fields', async () => {
  await withEdge(
    { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_PLAIN },
    async calls => {
      const response = await plainStart(formPost(PROFILE_ROUTES.oidcStart, DESKTOP_FORM))
      const attempt = attemptBody(calls)
      const cookies = response.headers.getSetCookie()

      assert.equal(response.status, 303)
      assert.deepEqual(Object.keys(attempt), ['browserBinding'])
      assert.equal(cookies.length, 1)
      assert.equal(attemptCookie(cookies[0]).value, attempt.browserBinding)
      for (const call of calls) {
        const body = JSON.stringify(call.body ?? null)
        assert.equal(
          body.includes(CODE_CHALLENGE) || body.includes(DESKTOP_STATE),
          false,
          call.path
        )
      }
    }
  )
})

test('starts a provider round trip even with a Profile session cookie present', async () => {
  // The session cookie as External REST sets it on a member sign-in, sent back by the browser.
  const [sessionSetCookie = ''] = edgeSetCookies(EDGE_MEMBER_SIGNED_IN)
  const sessionCookie = sessionSetCookie.slice(0, sessionSetCookie.indexOf(';'))
  assert.ok(sessionCookie.startsWith(PROFILE_SESSION_COOKIE_PREFIX))
  const request = desktopStartForm(DESKTOP_FORM, { cookie: sessionCookie })
  // Records every header the route reads, so a read of the Cookie header shows.
  const headersRead: string[] = []
  const readHeader = request.headers.get.bind(request.headers)
  request.headers.get = (name: string) => {
    headersRead.push(name.toLowerCase())
    return readHeader(name)
  }

  await withEdge(
    { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_DESKTOP_ECHO },
    async calls => {
      const response = await desktopStart(request)
      const cookies = response.headers.getSetCookie()

      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), desktopEchoUrl)
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, ATTEMPTS_PATH]
      )
      assert.equal(cookies.length, 1)
      assert.match(attemptCookie(cookies[0]).value, DESKTOP_BINDING_COOKIE_RE)
      assert.ok(headersRead.includes('origin'), 'expected the route to read Origin')
      assert.equal(headersRead.includes('cookie'), false)
    }
  )
})

// /api/oidc/start from the invitation page. The edge answers an attempt that carries a token with
// a plain attempt (`attempts plain`): nothing about the invitation is echoed.
const plainAttemptUrl = (edgeRecord(EDGE_ATTEMPT_PLAIN).body as { authorizationUrl: string })
  .authorizationUrl
/** Printable ASCII, with characters a form percent-encodes, so a re-encoded token shows. */
const INVITATION_TOKEN = `fixture-invitation-token+/=%20&?#~'"\\`

/** The invitation page's form posted to /api/oidc/start, with the upstream calls it made. */
async function startFromInvitationForm(
  fields: ReadonlyArray<readonly [string, string]>
): Promise<Readonly<{ response: Response; calls: readonly UpstreamCall[] }>> {
  let result: Readonly<{ response: Response; calls: readonly UpstreamCall[] }> | undefined
  await withEdge(
    { configuration: EDGE_CONFIGURATION, attempts: EDGE_ATTEMPT_PLAIN },
    async calls => {
      result = { response: await plainStart(formPost(PROFILE_ROUTES.oidcStart, fields)), calls }
    }
  )
  assert.ok(result)
  return result
}

/**
 * A 303 to the provider that set only the binding cookie, after one configuration read and one
 * attempt.
 */
function assertStartedWithBindingOnly(
  response: Response,
  calls: readonly UpstreamCall[],
  label: string
): void {
  const cookies = response.headers.getSetCookie()
  assert.equal(response.status, 303, label)
  assert.equal(response.headers.get('location'), plainAttemptUrl, label)
  assert.deepEqual(
    calls.map(call => call.path),
    [CONFIGURATION_PATH, ATTEMPTS_PATH],
    label
  )
  assert.equal(cookies.length, 1, label)
  const cookie = attemptCookie(cookies[0])
  assert.equal(cookie.name, browserCookieName(edgeState), label)
  assert.equal(cookie.value, attemptBody(calls).browserBinding, label)
}

test('forwards a well-formed invitationToken with the binding', async () => {
  const { response, calls } = await startFromInvitationForm([['invitationToken', INVITATION_TOKEN]])
  const attempt = attemptBody(calls)

  assertStartedWithBindingOnly(response, calls, 'a well-formed token')
  assert.deepEqual(Object.keys(attempt), ['browserBinding', 'invitationToken'])
  assert.equal(attempt.invitationToken, INVITATION_TOKEN)
})

test('forwards a 2048-character invitationToken exactly when its form is over 1 KiB', async () => {
  // Every character after the prefix is one a form percent-encodes, so the token alone takes
  // 6128 bytes: past PR 1's 1 KiB form cap, inside the 8 KiB one with returnTo beside it.
  const token = `fixture-${'%&+=/?#!'.repeat(255)}`
  const fields = [
    ['invitationToken', token],
    ['returnTo', 'desktop-setup'],
  ] as const
  const formBytes = Buffer.byteLength(
    new URLSearchParams(fields.map(field => [...field])).toString()
  )
  assert.equal(token.length, 2048)
  assert.ok(formBytes > 1024 && formBytes <= 8192, `form is ${formBytes} bytes`)

  const { response, calls } = await startFromInvitationForm(fields)
  const attempt = attemptBody(calls)
  const cookies = response.headers.getSetCookie()

  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), plainAttemptUrl)
  assert.deepEqual(Object.keys(attempt), ['browserBinding', 'invitationToken'])
  assert.equal(attempt.invitationToken, token)
  assert.equal(cookies.length, 2)
  assert.equal(attemptCookie(cookies[0]).value, attempt.browserBinding)
  assert.deepEqual(attemptCookie(cookies[1]), {
    name: returnToCookieName(edgeState),
    value: 'desktop-setup',
  })
})

test('drops an oversize or non-printable invitationToken and still starts', async () => {
  const oversize = `fixture-${'t'.repeat(2041)}`
  assert.equal(oversize.length, 2049)
  for (const [label, fields] of [
    ['2049 characters', [['invitationToken', oversize]]],
    ['a space', [['invitationToken', 'fixture invitation token']]],
    // What Next.js hands the page for a percent-encoded non-ASCII path segment.
    ['a character outside ASCII', [['invitationToken', 'fixture-invitation-tokén']]],
    ['a control character', [['invitationToken', 'fixture-invitation-token\t']]],
    ['an empty value', [['invitationToken', '']]],
    [
      'two values',
      [
        ['invitationToken', INVITATION_TOKEN],
        ['invitationToken', INVITATION_TOKEN],
      ],
    ],
    // The form is not read at all, so even a well-formed token stays behind.
    [
      'a form over the 8 KiB cap',
      [
        ['invitationToken', INVITATION_TOKEN],
        ['pad', 'x'.repeat(8192)],
      ],
    ],
  ] as const) {
    const { response, calls } = await startFromInvitationForm(fields)
    assertStartedWithBindingOnly(response, calls, label)
    assert.deepEqual(Object.keys(attemptBody(calls)), ['browserBinding'], label)
  }
})

// /api/oidc/callback for a Desktop attempt. The provider's callback state names the binding
// cookie; the cookie's value carries the Desktop marker, the binding and the state Evenfire
// Desktop chose.
const desktopCookie = `${browserCookieName(edgeState)}=${desktopBindingCookieValue(BINDING, DESKTOP_STATE)}`
const bindingClear = clearCookie(browserCookieName(edgeState))
const SIGNED_IN_MARKER_PREFIX = `${OIDC_SIGNED_IN_MARKER_COOKIE}=`
const FAILED_LINK = buildDesktopLoginErrorLink({ state: DESKTOP_STATE, error: 'failed' })
const SUCCESS_SEARCH = `state=${edgeState}&code=provider-code`
const DENIED_SEARCH = `state=${edgeState}&error=access_denied`
const PROVIDER_RETRY_TEXT = 'The identity provider is temporarily unavailable. Retry this attempt.'

/** The copy as the handoff page writes it, with its apostrophes escaped. */
function pageCopy(message: string): string {
  return `<p class="body-copy">${message.replaceAll("'", '&#39;')}</p>`
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

/**
 * A Desktop handoff page: HTML, no-store and no-referrer, no redirect, exactly `cookies` (never a
 * Profile session or the signed-in marker), the escaped `message`, no anchor, and one link, the
 * one its script fires. Returns the body.
 */
async function assertDesktopPage(
  response: Response,
  expected: Readonly<{
    link: string
    message: string
    status: number
    cookies: readonly string[]
  }>,
  label: string
): Promise<string> {
  const body = await response.text()
  const cookies = response.headers.getSetCookie()
  assert.equal(response.status, expected.status, label)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label)
  assert.equal(response.headers.get('cache-control'), 'no-store', label)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer', label)
  assert.equal(response.headers.get('location'), null, label)
  assert.deepEqual(cookies, expected.cookies, label)
  for (const cookie of cookies) {
    assert.equal(cookie.startsWith(PROFILE_SESSION_COOKIE_PREFIX), false, label)
    assert.equal(cookie.startsWith(SIGNED_IN_MARKER_PREFIX), false, label)
  }
  assert.equal(occurrences(body, 'evenfire://'), 1, label)
  assert.equal(scriptLink(body), expected.link, label)
  assert.equal(body.includes('<a'), false, label)
  assert.ok(body.includes(pageCopy(expected.message)), label)
  return body
}

/** Today's plain-text answer: no page, no link, no redirect, and exactly `cookies`. */
async function assertNoLink(
  response: Response,
  expected: Readonly<{
    text: string
    status: number
    cookies: readonly string[]
    retryAfter?: string
  }>,
  label: string
): Promise<void> {
  assert.equal(response.status, expected.status, label)
  assert.equal(await response.text(), expected.text, label)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', label)
  assert.equal(response.headers.get('location'), null, label)
  assert.equal(response.headers.get('retry-after'), expected.retryAfter ?? null, label)
  assert.deepEqual(response.headers.getSetCookie(), expected.cookies, label)
}

test('serves the handoff page for a Desktop attempt answered desktop_code_issued', async () => {
  const { code, environment } = edgeRecord(EDGE_DESKTOP_CODE_ISSUED).body as {
    code: string
    environment: string
  }
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_DESKTOP_CODE_ISSUED },
    async calls => {
      const response = await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie]))
      const csp = response.headers.get('content-security-policy') ?? ''
      const body = await assertDesktopPage(
        response,
        {
          link: buildDesktopLoginCodeLink({ state: DESKTOP_STATE, code, environment }),
          message: DESKTOP_SIGN_IN_COPY.handoffMessage,
          status: 200,
          cookies: [bindingClear],
        },
        'desktop_code_issued'
      )
      const nonce = body.match(/<script nonce="([^"]+)">/)?.[1] ?? ''

      assert.ok(nonce, 'expected a script nonce')
      assert.equal(csp, buildEvenfireDesktopAppContentSecurityPolicy(nonce))
      assert.match(csp, /frame-ancestors 'none'/)
      assert.ok(
        body.includes(
          `evenfire://desktop-login?state=${DESKTOP_STATE}&code=${code}` +
            `&environment=${encodeURIComponent(environment)}`
        )
      )
      assert.equal(occurrences(body, code), 1)
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

for (const [label, record] of [
  ['complete member-signed-in', EDGE_MEMBER_SIGNED_IN],
  ['complete identity-proof-verified', EDGE_IDENTITY_PROOF_VERIFIED],
] as const) {
  test(`refuses ${label} for a Desktop attempt with no Profile cookie and fires failed`, async () => {
    await withEdge({ configuration: EDGE_CONFIGURATION, complete: record }, async calls => {
      const response = await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie]))
      const body = await assertDesktopPage(
        response,
        {
          link: FAILED_LINK,
          message: DESKTOP_SIGN_IN_COPY.failed,
          status: 503,
          cookies: [bindingClear],
        },
        label
      )
      assert.ok(
        body.includes(`evenfire://desktop-login?state=${DESKTOP_STATE}&error=failed`),
        label
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH],
        label
      )
    })
  })
}

test('a plain attempt answered complete member-signed-in gets the 303 and the Profile cookie', async () => {
  const [sessionCookie] = edgeSetCookies(EDGE_MEMBER_SIGNED_IN)
  assert.ok(sessionCookie?.startsWith(PROFILE_SESSION_COOKIE_PREFIX))
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_MEMBER_SIGNED_IN },
    async calls => {
      const response = await GET(callbackRequest(SUCCESS_SEARCH, [bindingCookie]))
      const cookies = response.headers.getSetCookie()
      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), PROFILE_ROUTES.oidcSignedIn)
      assert.equal(cookies.length, 3)
      assert.equal(cookies[0], sessionCookie)
      assert.equal(cookies[1], bindingClear)
      assert.ok(cookies[2]?.startsWith(SIGNED_IN_MARKER_PREFIX))
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

test('fires refused with the reason', async () => {
  const { reason } = edgeRecord(EDGE_REFUSED).body as {
    reason: keyof typeof OIDC_REFUSAL_MESSAGES
  }
  // The recorded reason's copy has an apostrophe, so the page's escaping is exercised.
  assert.ok(OIDC_REFUSAL_MESSAGES[reason].includes("'"))
  await withEdge({ configuration: EDGE_CONFIGURATION, complete: EDGE_REFUSED }, async calls => {
    const response = await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie]))
    const body = await assertDesktopPage(
      response,
      {
        link: buildDesktopLoginErrorLink({ state: DESKTOP_STATE, error: 'refused', reason }),
        message: OIDC_REFUSAL_MESSAGES[reason],
        status: 403,
        cookies: [bindingClear],
      },
      'complete refused'
    )
    assert.ok(
      body.includes(
        `evenfire://desktop-login?state=${DESKTOP_STATE}&error=refused&reason=${reason}`
      )
    )
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH, COMPLETE_PATH]
    )
  })
})

test('fires failed for a refusal reason the Desktop link does not carry', async () => {
  const { reason } = edgeRecord(EDGE_INVITATION_EMAIL_MISMATCH).body as {
    reason: keyof typeof OIDC_REFUSAL_MESSAGES
  }
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_INVITATION_EMAIL_MISMATCH },
    async () => {
      const response = await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie]))
      const body = await assertDesktopPage(
        response,
        {
          link: FAILED_LINK,
          message: OIDC_REFUSAL_MESSAGES[reason],
          status: 403,
          cookies: [bindingClear],
        },
        'complete refused-invitation-email-mismatch'
      )
      assert.deepEqual(parseDesktopLoginLink(scriptLink(body)), {
        kind: 'error',
        state: DESKTOP_STATE,
        error: 'failed',
      })
      assert.equal(body.includes(reason), false)
    }
  )
})

test('fires cancelled once the denial is confirmed', async () => {
  await withEdge({ configuration: EDGE_CONFIGURATION, cancel: EDGE_CANCELLED }, async calls => {
    const response = await GET(callbackRequest(DENIED_SEARCH, [desktopCookie]))
    await assertDesktopPage(
      response,
      {
        link: buildDesktopLoginErrorLink({ state: DESKTOP_STATE, error: 'cancelled' }),
        message: DESKTOP_SIGN_IN_COPY.cancelled,
        status: 400,
        cookies: [bindingClear],
      },
      'cancel cancelled'
    )
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH, CANCEL_PATH]
    )
  })
})

test('answers a retryable cancel error with text and a terminal one with failed', async () => {
  // Derived: `complete rate-limited` and `complete storage-unavailable` replayed for /cancel. The
  // edge's per-client limiter covers every /oidc/profile-flow route, and /cancel forwards
  // control-api's failures through the same forwardFailure as /complete
  // (external-rest-api/src/routes/oidcProfileFlow.ts).
  await withEdge({ configuration: EDGE_CONFIGURATION, cancel: EDGE_RATE_LIMITED }, async calls => {
    await assertNoLink(
      await GET(callbackRequest(DENIED_SEARCH, [desktopCookie])),
      {
        text: 'The cancellation could not be confirmed. Retry this attempt.',
        status: 429,
        cookies: [],
        retryAfter: '60',
      },
      'a rate-limited cancel'
    )
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH, CANCEL_PATH]
    )
  })
  await withEdge(
    { configuration: EDGE_CONFIGURATION, cancel: EDGE_STORAGE_UNAVAILABLE },
    async calls => {
      await assertDesktopPage(
        await GET(callbackRequest(DENIED_SEARCH, [desktopCookie])),
        {
          link: FAILED_LINK,
          message: DESKTOP_SIGN_IN_COPY.failed,
          status: 503,
          cookies: [bindingClear],
        },
        'a terminal cancel'
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, CANCEL_PATH]
      )
    }
  )
})

test('fires failed for a terminal storage 503 and nothing for a retryable 429', async () => {
  const { retrySameAttempt } = edgeRecord(EDGE_STORAGE_UNAVAILABLE).body as {
    retrySameAttempt: unknown
  }
  assert.equal(retrySameAttempt, false)
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_STORAGE_UNAVAILABLE },
    async calls => {
      await assertDesktopPage(
        await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie])),
        {
          link: FAILED_LINK,
          message: DESKTOP_SIGN_IN_COPY.failed,
          status: 503,
          cookies: [bindingClear],
        },
        'complete storage-unavailable'
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_RATE_LIMITED },
    async calls => {
      await assertNoLink(
        await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie])),
        {
          text: 'Too many sign-in attempts. Retry this attempt later.',
          status: 429,
          cookies: [],
          retryAfter: '60',
        },
        'complete rate-limited'
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

test('keys failed on retrySameAttempt false, not on the error code', async () => {
  // Derived variant of `complete storage-unavailable` without retrySameAttempt. control-api also
  // sends oidc_storage_unavailable without the flag, and that answer leaves the attempt retryable.
  const retryable = { ...(edgeRecord(EDGE_STORAGE_UNAVAILABLE).body as Record<string, unknown>) }
  delete retryable.retrySameAttempt
  await withEdge(
    {
      configuration: EDGE_CONFIGURATION,
      complete: () => edgeVariant(EDGE_STORAGE_UNAVAILABLE, retryable),
    },
    async calls => {
      await assertNoLink(
        await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie])),
        { text: PROVIDER_RETRY_TEXT, status: 503, cookies: [] },
        'oidc_storage_unavailable without retrySameAttempt'
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH, COMPLETE_PATH]
      )
    }
  )
})

test('fires failed for an unknown provider error on a Desktop attempt', async () => {
  for (const search of [
    `state=${edgeState}&error=login_required`,
    `state=${edgeState}&error=interaction_required&error_description=ignored`,
  ]) {
    await withEdge({ configuration: EDGE_CONFIGURATION }, async calls => {
      await assertDesktopPage(
        await GET(callbackRequest(search, [desktopCookie])),
        {
          link: FAILED_LINK,
          message: DESKTOP_SIGN_IN_COPY.failed,
          status: 400,
          cookies: [bindingClear],
        },
        search
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH],
        search
      )
    })
  }
})

test('fires no link for a retryable provider error on a Desktop attempt', async () => {
  for (const error of ['server_error', 'temporarily_unavailable']) {
    await withEdge({ configuration: EDGE_CONFIGURATION }, async calls => {
      await assertNoLink(
        await GET(callbackRequest(`state=${edgeState}&error=${error}`, [desktopCookie])),
        { text: PROVIDER_RETRY_TEXT, status: 503, cookies: [] },
        error
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH],
        error
      )
    })
  }
})

test('fires no link when the Desktop cookie is missing', async () => {
  const name = browserCookieName(edgeState)
  for (const [label, cookies] of [
    ['no cookie', []],
    ['a 42-character state', [`${name}=desktop.${BINDING}.${DESKTOP_STATE.slice(1)}`]],
    ['the Desktop cookie twice', [desktopCookie, desktopCookie]],
    ['a plain and a Desktop cookie', [bindingCookie, desktopCookie]],
  ] as const) {
    for (const search of [
      SUCCESS_SEARCH,
      DENIED_SEARCH,
      `state=${edgeState}&error=login_required`,
    ]) {
      await withEdge(
        {
          configuration: EDGE_CONFIGURATION,
          complete: EDGE_DESKTOP_CODE_ISSUED,
          cancel: EDGE_CANCELLED,
        },
        async calls => {
          await assertNoLink(
            await GET(callbackRequest(search, cookies)),
            { text: INVALID_TEXT, status: 400, cookies: [] },
            `${label}: ${search}`
          )
          assert.deepEqual(
            calls.map(call => call.path),
            [CONFIGURATION_PATH],
            `${label}: ${search}`
          )
        }
      )
    }
  }
})

test('sends exactly the cookie binding to /complete and /cancel, and never the state', async () => {
  const cookieBinding = DESKTOP_BINDING_COOKIE_RE.exec(
    desktopCookie.slice(desktopCookie.indexOf('=') + 1)
  )?.[1]
  assert.equal(cookieBinding, BINDING)
  await withEdge(
    {
      configuration: EDGE_CONFIGURATION,
      complete: EDGE_DESKTOP_CODE_ISSUED,
      cancel: EDGE_CANCELLED,
    },
    async calls => {
      assert.equal((await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie]))).status, 200)
      assert.equal((await GET(callbackRequest(DENIED_SEARCH, [desktopCookie]))).status, 400)
      const complete = calls.find(call => call.path === COMPLETE_PATH)?.body
      const cancel = calls.find(call => call.path === CANCEL_PATH)?.body

      assert.deepEqual(complete, {
        state: edgeState,
        code: 'provider-code',
        browserBinding: cookieBinding,
      })
      assert.deepEqual(cancel, { state: edgeState, browserBinding: cookieBinding })
      for (const body of [complete, cancel]) {
        const sent = JSON.stringify(body)
        assert.match((body as { browserBinding: string }).browserBinding, /^[A-Za-z0-9_-]{43}$/)
        assert.equal(sent.includes(DESKTOP_STATE), false)
        assert.equal(sent.includes('desktop.'), false)
      }
    }
  )
})

test("forwards the provider's issuer to /complete for a Desktop attempt", async () => {
  // The issuer of the recorded attempt's authorization URL, returned as the callback's iss.
  const issuer = new URL(desktopEchoUrl).origin
  await withEdge(
    { configuration: EDGE_CONFIGURATION, complete: EDGE_DESKTOP_CODE_ISSUED },
    async calls => {
      const search = `${SUCCESS_SEARCH}&iss=${encodeURIComponent(issuer)}`
      assert.equal((await GET(callbackRequest(search, [desktopCookie]))).status, 200)
      assert.deepEqual(calls.find(call => call.path === COMPLETE_PATH)?.body, {
        state: edgeState,
        code: 'provider-code',
        browserBinding: BINDING,
        issuer,
      })
    }
  )
})

test('fires failed for a /cancel answer other than attempt_cancelled', async () => {
  // Derived variant of `cancel cancelled` with the outcome swapped. The edge answers an outcome it
  // does not recognise with a 503 instead, so only a misbehaving edge sends this.
  const otherOutcome = () => edgeVariant(EDGE_CANCELLED, { outcome: 'attempt_pending' })
  await withEdge({ configuration: EDGE_CONFIGURATION, cancel: otherOutcome }, async calls => {
    await assertDesktopPage(
      await GET(callbackRequest(DENIED_SEARCH, [desktopCookie])),
      {
        link: FAILED_LINK,
        message: DESKTOP_SIGN_IN_COPY.failed,
        status: 503,
        cookies: [bindingClear],
      },
      'another /cancel outcome'
    )
    assert.deepEqual(
      calls.map(call => call.path),
      [CONFIGURATION_PATH, CANCEL_PATH]
    )
  })
})

test("fires failed when the edge's environment cannot make a code link", async () => {
  const recorded = edgeRecord(EDGE_DESKTOP_CODE_ISSUED).body as Record<string, unknown> & {
    code: string
  }
  // Derived variants of `complete desktop-code-issued` with a bad environment. Profile UI checks
  // the environment only as a string; buildDesktopLoginCodeLink refuses a value that is not a
  // URL or whose scheme is not http or https.
  for (const [label, environment] of [
    ['an environment that is not a URL', 'not a url'],
    ['an ftp environment', 'ftp://edge-fixture.example.test'],
  ] as const) {
    await withEdge(
      {
        configuration: EDGE_CONFIGURATION,
        complete: () => edgeVariant(EDGE_DESKTOP_CODE_ISSUED, { ...recorded, environment }),
      },
      async calls => {
        const body = await assertDesktopPage(
          await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie])),
          {
            link: FAILED_LINK,
            message: DESKTOP_SIGN_IN_COPY.failed,
            status: 503,
            cookies: [bindingClear],
          },
          label
        )
        assert.equal(body.includes(recorded.code), false, label)
        assert.deepEqual(
          calls.map(call => call.path),
          [CONFIGURATION_PATH, COMPLETE_PATH],
          label
        )
      }
    )
  }
})

test('no Desktop page sets or carries profile_session or the signed-in marker', async () => {
  // The browser already holds a Profile session, as External REST sets it, and a marker.
  const [sessionSetCookie = ''] = edgeSetCookies(EDGE_MEMBER_SIGNED_IN)
  const sessionCookie = sessionSetCookie.slice(0, sessionSetCookie.indexOf(';'))
  const sessionValue = sessionCookie.slice(PROFILE_SESSION_COOKIE_PREFIX.length)
  assert.ok(sessionCookie.startsWith(PROFILE_SESSION_COOKIE_PREFIX) && sessionValue)
  const cookies = [sessionCookie, `${OIDC_SIGNED_IN_MARKER_COOKIE}=1`, desktopCookie]
  for (const [label, search, answers] of [
    ['desktop_code_issued', SUCCESS_SEARCH, { complete: EDGE_DESKTOP_CODE_ISSUED }],
    ['refused', SUCCESS_SEARCH, { complete: EDGE_REFUSED }],
    ['member_signed_in', SUCCESS_SEARCH, { complete: EDGE_MEMBER_SIGNED_IN }],
    ['identity_proof_verified', SUCCESS_SEARCH, { complete: EDGE_IDENTITY_PROOF_VERIFIED }],
    ['a terminal storage 503', SUCCESS_SEARCH, { complete: EDGE_STORAGE_UNAVAILABLE }],
    ['cancelled', DENIED_SEARCH, { cancel: EDGE_CANCELLED }],
    ['an unknown provider error', `state=${edgeState}&error=login_required`, {}],
  ] as const) {
    await withEdge({ configuration: EDGE_CONFIGURATION, ...answers }, async calls => {
      const response = await GET(callbackRequest(search, cookies))
      const body = await response.text()
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label)
      assert.deepEqual(response.headers.getSetCookie(), [bindingClear], label)
      assert.equal(occurrences(body, 'evenfire://desktop-login?'), 1, label)
      assert.equal(body.includes(sessionValue), false, label)
      for (const call of calls) {
        assert.equal(JSON.stringify(call.body ?? null).includes(sessionValue), false, label)
      }
    })
  }
})

test('a Desktop terminal page also clears a return cookie under its state', async () => {
  for (const [label, complete] of [
    ['complete desktop-code-issued', EDGE_DESKTOP_CODE_ISSUED],
    ['complete storage-unavailable', EDGE_STORAGE_UNAVAILABLE],
  ] as const) {
    await withEdge({ configuration: EDGE_CONFIGURATION, complete }, async () => {
      const response = await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie, returnCookie]))
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label)
      assert.deepEqual(
        response.headers.getSetCookie(),
        [bindingClear, clearCookie(returnToCookieName(edgeState))],
        label
      )
    })
  }
})

// A configuration failure as the edge forwards control-api's answer: 404 oidc_not_configured when
// no provider is configured, and 503 oidc_configuration_unavailable when its settings are unusable
// (configuredProvider in control-api/src/routes/external/oidcProfileFlow.ts; the edge's
// forwardFailure keeps both). Both are outside the retryable codes, so a reload cannot pass them.
// edge.json records only `configuration activated`, so each is a derived variant of a recorded
// edge answer with that status and the code swapped in.
const EDGE_NOT_FOUND = 'GET /api/v1/auth/methods not-found'
const configurationNotConfigured = () =>
  edgeVariant(EDGE_NOT_FOUND, { error: 'oidc_not_configured' })
const configurationUnusable = () =>
  edgeVariant(EDGE_STORAGE_UNAVAILABLE, { error: 'oidc_configuration_unavailable' })
const NON_RETRYABLE_CONFIGURATION = [
  ['oidc_not_configured 404', configurationNotConfigured, 404, 'oidc_not_configured'],
  [
    'oidc_configuration_unavailable 503',
    configurationUnusable,
    503,
    'oidc_configuration_unavailable',
  ],
] as const

/**
 * Today's JSON answer for a configuration failure, byte for byte: what `responseForFlowError`
 * answers for that failure, with no cookie and no link.
 */
async function assertConfigurationJson(
  response: Response,
  failure: OidcProfileFlowError,
  label: string
): Promise<void> {
  const expected = responseForFlowError(failure)
  const text = await response.text()
  assert.equal(response.status, failure.status, label)
  assert.equal(text, JSON.stringify({ error: failure.code }), label)
  assert.equal(text, await expected.text(), label)
  assert.deepEqual([...response.headers.entries()], [...expected.headers.entries()], label)
  assert.deepEqual(response.headers.getSetCookie(), [], label)
  assert.equal(text.includes('evenfire://'), false, label)
}

test("fires failed for a Desktop attempt's non-retryable configuration failure", async () => {
  for (const [label, configuration, status] of NON_RETRYABLE_CONFIGURATION) {
    for (const search of [SUCCESS_SEARCH, DENIED_SEARCH]) {
      await withEdge(
        { configuration, complete: EDGE_DESKTOP_CODE_ISSUED, cancel: EDGE_CANCELLED },
        async calls => {
          await assertDesktopPage(
            await GET(callbackRequest(search, [desktopCookie, returnCookie])),
            {
              link: FAILED_LINK,
              message: DESKTOP_SIGN_IN_COPY.failed,
              status,
              cookies: [bindingClear, clearCookie(returnToCookieName(edgeState))],
            },
            `${label}: ${search}`
          )
          assert.deepEqual(
            calls.map(call => call.path),
            [CONFIGURATION_PATH],
            `${label}: ${search}`
          )
        }
      )
    }
  }
})

test("keeps today's answer and the cookie for a Desktop attempt's retryable configuration failure", async () => {
  // Derived: `complete rate-limited` replayed for the configuration call (the edge's per-client
  // limiter covers every /oidc/profile-flow route), and a transport failure.
  const unreachable = (): Response => {
    throw new TypeError('fetch failed')
  }
  for (const [label, configuration, status] of [
    ['a rate-limited configuration', EDGE_RATE_LIMITED, 429],
    ['an unreachable configuration', unreachable, 503],
  ] as const) {
    await withEdge({ configuration }, async calls => {
      await assertConfigurationJson(
        await GET(callbackRequest(SUCCESS_SEARCH, [desktopCookie, returnCookie])),
        new OidcProfileFlowError(status, 'oidc_unavailable', true),
        label
      )
      assert.deepEqual(
        calls.map(call => call.path),
        [CONFIGURATION_PATH],
        label
      )
    })
  }
})

test("keeps today's JSON for a configuration failure on a plain attempt or without a Desktop cookie", async () => {
  const name = browserCookieName(edgeState)
  for (const [label, configuration, status, code] of NON_RETRYABLE_CONFIGURATION) {
    for (const [cookieLabel, cookies] of [
      ['a plain attempt', [bindingCookie, returnCookie]],
      ['no cookie', []],
      ['a 42-character Desktop state', [`${name}=desktop.${BINDING}.${DESKTOP_STATE.slice(1)}`]],
      ['a plain and a Desktop cookie', [bindingCookie, desktopCookie]],
    ] as const) {
      await withEdge({ configuration }, async calls => {
        await assertConfigurationJson(
          await GET(callbackRequest(SUCCESS_SEARCH, cookies)),
          new OidcProfileFlowError(status, code, false),
          `${label}, ${cookieLabel}`
        )
        assert.deepEqual(
          calls.map(call => call.path),
          [CONFIGURATION_PATH],
          `${label}, ${cookieLabel}`
        )
      })
    }
  }
})
