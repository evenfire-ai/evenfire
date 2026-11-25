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
  returnToCookieName,
} from '../app/api/oidc/_flow'
import { GET } from '../app/api/oidc/callback/route'
import { POST as desktopStart } from '../app/api/oidc/desktop-start/route'
import { POST as plainStart } from '../app/api/oidc/start/route'
import { DESKTOP_SIGN_IN_COPY, OIDC_REFUSAL_MESSAGES } from '../app/constants/oidc'
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
  const oversized = [...DESKTOP_FORM, ['pad', 'x'.repeat(2048)]] as const
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
