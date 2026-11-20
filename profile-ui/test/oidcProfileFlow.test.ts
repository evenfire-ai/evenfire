import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type OidcProfileConfiguration,
  browserCookieName,
  oidcBrowserClientIp,
  oidcClientKey,
} from '../app/api/oidc/_flow'
import { GET } from '../app/api/oidc/callback/route'
import { POST } from '../app/api/oidc/start/route'

const callbackUri = 'https://profile.example.test/api/oidc/callback'
const configuration: OidcProfileConfiguration = {
  redirectUri: callbackUri,
  memberAuthenticationActivated: false,
}
const browserBinding = 'A'.repeat(43)
const state = 'S'.repeat(43)

function authorizationUrl(): string {
  const url = new URL('https://issuer.example.test/authorize')
  url.searchParams.set('client_id', 'test-client')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('redirect_uri', callbackUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', 'C'.repeat(43))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('nonce', 'N'.repeat(43))
  return url.href
}

/**
 * `next start -p 3001` (the Profile UI image command) builds `request.url` from its
 * own listener, not from Host or X-Forwarded-Host: `<proto>://localhost:3001`, with
 * the scheme taken from X-Forwarded-Proto. Behind the proxy the route therefore never
 * sees the public origin.
 */
function internalListenerUrl(protocol: 'http:' | 'https:', pathname: string, search = ''): string {
  const url = new URL(callbackUri)
  url.protocol = protocol
  url.hostname = 'localhost'
  url.port = '3001'
  url.pathname = pathname
  url.search = search
  return url.href
}

function mockExternalApi(
  implementation: (url: URL, init: RequestInit) => Response | Promise<Response>
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    return implementation(new URL(String(input)), init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function configurationResponse(): Response {
  return Response.json(configuration)
}

test('Profile OIDC start binds the browser cookie to the validated provider state', async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const restore = mockExternalApi((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      authorizationUrl: authorizationUrl(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
  })
  try {
    const response = await POST(
      new Request('https://profile.example.test/api/oidc/start', {
        method: 'POST',
        headers: { origin: 'https://profile.example.test' },
      })
    )
    const cookie = response.headers.get('set-cookie') ?? ''
    const location = new URL(response.headers.get('location') ?? '')

    assert.equal(response.status, 303)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(location.origin, 'https://issuer.example.test')
    assert.match(cookie, /^__Host-ef_oidc_[a-f0-9]{24}=/)
    assert.match(cookie, /; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.path, '/api/v1/oidc/profile-flow/attempts')
    assert.deepEqual(Object.keys(calls[1]?.body as object), ['browserBinding'])
    assert.match(
      String((calls[1]?.body as { browserBinding: string }).browserBinding),
      /^[A-Za-z0-9_-]{43}$/
    )
  } finally {
    restore()
  }
})

test('Profile OIDC start accepts a small clock skew and still caps the cookie', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      authorizationUrl: authorizationUrl(),
      expiresAt: new Date(Date.now() + 601_000).toISOString(),
    })
  })
  try {
    const response = await POST(
      new Request('https://profile.example.test/api/oidc/start', {
        method: 'POST',
        headers: { origin: 'https://profile.example.test' },
      })
    )
    assert.equal(response.status, 303)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=600/)
  } finally {
    restore()
  }
})

test('Profile OIDC start rejects an attempt expiry far beyond the protocol lifetime', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      authorizationUrl: authorizationUrl(),
      expiresAt: new Date(Date.now() + 720_000).toISOString(),
    })
  })
  try {
    const response = await POST(
      new Request('https://profile.example.test/api/oidc/start', {
        method: 'POST',
        headers: { origin: 'https://profile.example.test' },
      })
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('set-cookie'), null)
  } finally {
    restore()
  }
})

test('Profile OIDC start rejects cross-origin requests before creating an attempt', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await POST(
      new Request('https://profile.example.test/api/oidc/start', {
        method: 'POST',
        headers: { origin: 'https://attacker.example.test' },
      })
    )
    assert.equal(response.status, 403)
    assert.equal(paths.length, 1)
    assert.ok(paths[0]?.endsWith('/configuration'))
  } finally {
    restore()
  }
})

test('Profile OIDC callback rejects a missing browser binding before completion', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await GET(new Request(`${callbackUri}?state=${state}&code=provider-code`))
    assert.equal(response.status, 400)
    assert.equal(paths.length, 1)
    assert.ok(paths[0]?.endsWith('/configuration'))
  } finally {
    restore()
  }
})

test('Profile OIDC callback submits another browser binding for authoritative rejection', async () => {
  const paths: string[] = []
  const calls: Array<{ path: string; body?: unknown }> = []
  const restore = mockExternalApi((url, init) => {
    paths.push(url.pathname)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({ error: 'oidc_attempt_rejected' }, { status: 400 })
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${'C'.repeat(43)}` },
      })
    )
    assert.equal(response.status, 400)
    assert.equal(paths.length, 2)
    assert.ok(paths[1]?.endsWith('/complete'))
    assert.deepEqual(calls.find(call => call.path.endsWith('/complete'))?.body, {
      state,
      code: 'provider-code',
      browserBinding: 'C'.repeat(43),
    })
    assert.doesNotMatch(await response.text(), /provider-code|binding/)
  } finally {
    restore()
  }
})

test('Profile OIDC callback binds completion to its cookie and never returns proof data', async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const restore = mockExternalApi((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
      // A malformed bridge response must not be echoed to the browser.
      proof: { subject: 'must-not-escape', email: 'private@example.test' },
    })
  })
  try {
    const response = await GET(
      new Request(
        `${callbackUri}?state=${state}&code=provider-code&iss=https%3A%2F%2Fissuer.example.test`,
        {
          headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
        }
      )
    )
    const body = await response.text()
    const complete = calls.find(call => call.path.endsWith('/complete'))

    assert.equal(response.status, 200)
    assert.match(body, /Identity proof was verified/)
    assert.doesNotMatch(body, /must-not-escape|private@example\.test|provider-code/)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
    assert.deepEqual(complete?.body, {
      state,
      code: 'provider-code',
      browserBinding,
      issuer: 'https://issuer.example.test',
    })
  } finally {
    restore()
  }
})

test('provider cancellation cancels only the state with the matching browser cookie', async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const restore = mockExternalApi((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    if (url.pathname.endsWith('/cancel')) return Response.json({ outcome: 'attempt_cancelled' })
    return Response.json({ error: 'unexpected_route' }, { status: 404 })
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&error=access_denied&error_description=ignored`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    const cancel = calls.find(call => call.path.endsWith('/cancel'))
    assert.equal(response.status, 400)
    assert.deepEqual(cancel?.body, { state, browserBinding })
    assert.equal(
      calls.some(call => call.path.endsWith('/complete')),
      false
    )
    assert.doesNotMatch((await response.text()).toLowerCase(), /error_description/)
  } finally {
    restore()
  }
})

test('provider outage during completion preserves the browser cookie for retry', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json(
      { error: 'oidc_provider_unavailable', retrySameAttempt: true },
      { status: 503 }
    )
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(await response.text(), /temporarily unavailable/)
  } finally {
    restore()
  }
})

test('an unknown completion outcome keeps the browser cookie', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    throw new Error('upstream outcome unavailable')
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    const text = await response.text()
    assert.equal(response.status, 503)
    assert.match(text, /retry this attempt/i)
    assert.equal(response.headers.get('set-cookie'), null)
  } finally {
    restore()
  }
})

test('a rate limit before completion keeps the browser cookie and Retry-After', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json(
      { error: 'oidc_unavailable' },
      { status: 429, headers: { 'retry-after': '30' } }
    )
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '30')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(await response.text(), /retry this attempt later/i)
  } finally {
    restore()
  }
})

test('a consumed provider failure clears its cookie and requires a new attempt', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json(
      { error: 'oidc_provider_unavailable', retrySameAttempt: false },
      { status: 503 }
    )
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    const text = await response.text()
    assert.equal(response.status, 503)
    assert.doesNotMatch(text, /retry this attempt/i)
    assert.match(text, /start a new sign-in attempt/i)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
  } finally {
    restore()
  }
})

test('a malformed completion response clears the cookie and requires a new attempt', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({ outcome: 'unexpected' })
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&code=provider-code`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    const text = await response.text()
    assert.equal(response.status, 503)
    assert.doesNotMatch(text, /retry this attempt/i)
    assert.match(text, /start a new sign-in attempt/i)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
  } finally {
    restore()
  }
})

test('a malformed cancellation response clears the cookie and requires a new attempt', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({ outcome: 'unexpected' })
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&error=access_denied`, {
        headers: { cookie: `${browserCookieName(state)}=${browserBinding}` },
      })
    )
    const text = await response.text()
    assert.equal(response.status, 503)
    assert.doesNotMatch(text, /retry this attempt/i)
    assert.match(text, /start a new sign-in attempt/i)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
  } finally {
    restore()
  }
})

test('duplicate callback state parameters are rejected without consuming an attempt', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await GET(
      new Request(`${callbackUri}?state=${state}&state=${state}&code=provider-code`)
    )
    assert.equal(response.status, 400)
    assert.equal(paths.length, 1)
    assert.ok(paths[0]?.endsWith('/configuration'))
  } finally {
    restore()
  }
})

test('duplicate callback issuer parameters are rejected before completion', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await GET(
      new Request(
        `${callbackUri}?state=${state}&code=provider-code&iss=https%3A%2F%2Fissuer.example.test&iss=https%3A%2F%2Fissuer.example.test`,
        { headers: { cookie: `${browserCookieName(state)}=${browserBinding}` } }
      )
    )
    assert.equal(response.status, 400)
    assert.equal(paths.length, 1)
    assert.ok(paths[0]?.endsWith('/configuration'))
    assert.doesNotMatch(await response.text(), /issuer\.example\.test|provider-code/)
  } finally {
    restore()
  }
})

for (const protocol of ['http:', 'https:'] as const) {
  test(`Profile OIDC callback completes at the internal ${protocol} listener URL Next reports`, async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    const restore = mockExternalApi((url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/configuration')) return configurationResponse()
      return Response.json({ outcome: 'identity_proof_verified' })
    })
    try {
      const response = await GET(
        new Request(
          internalListenerUrl(protocol, '/api/oidc/callback', `?state=${state}&code=provider-code`),
          { headers: { cookie: `${browserCookieName(state)}=${browserBinding}` } }
        )
      )
      assert.equal(response.status, 200)
      assert.match(await response.text(), /Identity proof was verified/)
      assert.deepEqual(
        calls.map(call => call.path),
        ['/api/v1/oidc/profile-flow/configuration', '/api/v1/oidc/profile-flow/complete']
      )
      assert.deepEqual(calls[1]?.body, { state, code: 'provider-code', browserBinding })
    } finally {
      restore()
    }
  })
}

test('Profile OIDC callback at the internal listener URL still requires the host-only binding cookie', async () => {
  // A browser that reaches the callback on any host other than the configured
  // redirect origin never carries the __Host- cookie that /start set there.
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await GET(
      new Request(
        internalListenerUrl('https:', '/api/oidc/callback', `?state=${state}&code=provider-code`)
      )
    )
    assert.equal(response.status, 400)
    assert.match(await response.text(), /Identity proof could not be verified/)
    assert.deepEqual(paths, ['/api/v1/oidc/profile-flow/configuration'])
  } finally {
    restore()
  }
})

test('Profile OIDC callback rejects a request path other than the configured callback path', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    return configurationResponse()
  })
  try {
    const response = await GET(
      new Request(
        internalListenerUrl(
          'https:',
          '/api/oidc/not-callback',
          `?state=${state}&code=provider-code`
        ),
        { headers: { cookie: `${browserCookieName(state)}=${browserBinding}` } }
      )
    )
    assert.equal(response.status, 403)
    assert.deepEqual(paths, ['/api/v1/oidc/profile-flow/configuration'])
  } finally {
    restore()
  }
})

test('Profile OIDC start sets a binding cookie only for the configured public origin', async () => {
  // The callback relies on this: only a page on the redirect URI origin can mint
  // the binding, whatever request.url reports.
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      authorizationUrl: authorizationUrl(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
  })
  try {
    const startUrl = internalListenerUrl('https:', '/api/oidc/start')
    const accepted = await POST(
      new Request(startUrl, { method: 'POST', headers: { origin: new URL(callbackUri).origin } })
    )
    assert.equal(accepted.status, 303)
    assert.match(accepted.headers.get('set-cookie') ?? '', /^__Host-ef_oidc_[a-f0-9]{24}=/)

    paths.length = 0
    const rejected = await POST(
      new Request(startUrl, { method: 'POST', headers: { origin: new URL(startUrl).origin } })
    )
    assert.equal(rejected.status, 403)
    assert.equal(rejected.headers.get('set-cookie'), null)
    assert.deepEqual(paths, ['/api/v1/oidc/profile-flow/configuration'])
  } finally {
    restore()
  }
})

// OIDC member sign-in relays External REST's password-login session cookie.
// Shape copied from Express `res.cookie` output, including the comma inside Expires.
const upstreamSessionCookie =
  'profile_session=session-token-fixture; Max-Age=43200; Path=/; Expires=Sat, 21 Nov 2026 04:48:01 GMT; HttpOnly; Secure; SameSite=Lax'
const signedInMarkerCookie = '__Host-ef_oidc_signed_in=1; Path=/; Max-Age=60; Secure; SameSite=Lax'

function memberSignInResponse(body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(body), { status: 200, headers })
}

function signInConfiguration(): Response {
  return Response.json({ ...configuration, memberAuthenticationActivated: true })
}

function callbackRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${callbackUri}?state=${state}&code=provider-code`, {
    headers: { cookie: `${browserCookieName(state)}=${browserBinding}`, ...headers },
  })
}

const bindingClearCookie = () =>
  `${browserCookieName(state)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`

test('success redirects to /oidc/signed-in with the session and binding-clear cookies', async () => {
  const paths: string[] = []
  const restore = mockExternalApi(url => {
    paths.push(url.pathname)
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse(
      { outcome: 'member_signed_in', memberAuthenticationActivated: true },
      [upstreamSessionCookie, 'unrelated=1; Path=/']
    )
  })
  try {
    const response = await GET(callbackRequest())
    const cookies = response.headers.getSetCookie()
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/oidc/signed-in')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.ok(cookies.includes(upstreamSessionCookie))
    assert.ok(cookies.includes(bindingClearCookie()))
    assert.equal(cookies.length, 3)
    assert.equal(await response.text(), '')
    assert.deepEqual(paths, [
      '/api/v1/oidc/profile-flow/configuration',
      '/api/v1/oidc/profile-flow/complete',
    ])
  } finally {
    restore()
  }
})

test('success sets the signed-in marker cookie', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse(
      { outcome: 'member_signed_in', memberAuthenticationActivated: true },
      [upstreamSessionCookie]
    )
  })
  try {
    const response = await GET(callbackRequest())
    assert.deepEqual(response.headers.getSetCookie(), [
      upstreamSessionCookie,
      bindingClearCookie(),
      signedInMarkerCookie,
    ])
  } finally {
    restore()
  }
})

const refusalReasons = [
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
] as const

test('each refusal redirects to /oidc/result?reason=<reason>', async () => {
  for (const reason of refusalReasons) {
    const restore = mockExternalApi(url => {
      if (url.pathname.endsWith('/configuration')) return signInConfiguration()
      return memberSignInResponse(
        { outcome: 'refused', memberAuthenticationActivated: true, reason },
        // A session cookie on a refusal must never reach the browser.
        [upstreamSessionCookie]
      )
    })
    try {
      const response = await GET(callbackRequest())
      assert.equal(response.status, 303, reason)
      assert.equal(response.headers.get('location'), `/oidc/result?reason=${reason}`)
      assert.deepEqual(response.headers.getSetCookie(), [bindingClearCookie()], reason)
    } finally {
      restore()
    }
  }
})

test('a refusal with an unlisted reason fails closed with 503 and no session cookie', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse(
      { outcome: 'refused', memberAuthenticationActivated: true, reason: 'made_up' },
      [upstreamSessionCookie]
    )
  })
  try {
    const response = await GET(callbackRequest())
    assert.equal(response.status, 503)
    assert.doesNotMatch(response.headers.getSetCookie().join('\n'), /profile_session/)
  } finally {
    restore()
  }
})

test('an unknown outcome fails closed with 503 and no session cookie', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse({ outcome: 'something_new', memberAuthenticationActivated: true }, [
      upstreamSessionCookie,
    ])
  })
  try {
    const response = await GET(callbackRequest())
    const setCookies = response.headers.getSetCookie()
    assert.equal(response.status, 503)
    assert.match(await response.text(), /start a new sign-in attempt/i)
    assert.equal(setCookies.length, 1)
    assert.doesNotMatch(setCookies[0] ?? '', /profile_session/)
  } finally {
    restore()
  }
})

test('switch off still returns the identity-proof text page', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return configurationResponse()
    return Response.json({
      outcome: 'identity_proof_verified',
      memberAuthenticationActivated: false,
    })
  })
  try {
    const response = await GET(callbackRequest())
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Identity proof was verified/)
    assert.equal(response.headers.getSetCookie().length, 1)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
  } finally {
    restore()
  }
})

for (const [label, cookies] of [
  ['no session cookie', []],
  ['two session cookies', [upstreamSessionCookie, upstreamSessionCookie]],
] as const) {
  test(`a signed-in answer with ${label} fails closed and needs a new attempt`, async () => {
    const restore = mockExternalApi(url => {
      if (url.pathname.endsWith('/configuration')) return signInConfiguration()
      return memberSignInResponse(
        { outcome: 'member_signed_in', memberAuthenticationActivated: true },
        [...cookies]
      )
    })
    try {
      const response = await GET(callbackRequest())
      const setCookies = response.headers.getSetCookie()
      assert.equal(response.status, 503)
      assert.match(await response.text(), /start a new sign-in attempt/i)
      assert.equal(setCookies.length, 1)
      assert.doesNotMatch(setCookies[0] ?? '', /profile_session/)
    } finally {
      restore()
    }
  })
}

test('Profile OIDC start still works when member sign-in is on', async () => {
  const restore = mockExternalApi(url => {
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return Response.json({
      authorizationUrl: authorizationUrl(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
  })
  try {
    const response = await POST(
      new Request('https://profile.example.test/api/oidc/start', {
        method: 'POST',
        headers: { origin: 'https://profile.example.test' },
      })
    )
    assert.equal(response.status, 303)
    assert.match(response.headers.get('set-cookie') ?? '', /^__Host-ef_oidc_[a-f0-9]{24}=/)
  } finally {
    restore()
  }
})

function forwardedFor(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.['x-forwarded-for']
}

test('the browser IP from cf-connecting-ip is forwarded as x-forwarded-for', async () => {
  const seen: Array<string | undefined> = []
  const restore = mockExternalApi((url, init) => {
    seen.push(forwardedFor(init))
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse({ outcome: 'identity_proof_verified' })
  })
  try {
    await GET(
      callbackRequest({
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.9, 10.0.0.1',
      })
    )
    assert.deepEqual(seen, ['203.0.113.7', '203.0.113.7'])
  } finally {
    restore()
  }
})

test('the left-most x-forwarded-for entry is used without cf-connecting-ip', async () => {
  const seen: Array<string | undefined> = []
  const restore = mockExternalApi((url, init) => {
    seen.push(forwardedFor(init))
    if (url.pathname.endsWith('/configuration')) return signInConfiguration()
    return memberSignInResponse({ outcome: 'identity_proof_verified' })
  })
  try {
    await GET(callbackRequest({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))
    assert.deepEqual(seen, ['198.51.100.9', '198.51.100.9'])
    assert.equal(
      oidcClientKey(new Request(callbackUri, { headers: { 'cf-connecting-ip': '203.0.113.7' } })),
      oidcClientKey(new Request(callbackUri, { headers: { 'x-forwarded-for': '203.0.113.7' } }))
    )
  } finally {
    restore()
  }
})

test('no x-forwarded-for is sent when the request carries no valid browser IP', async () => {
  const seen: Array<string | undefined> = []
  const restore = mockExternalApi((url, init) => {
    seen.push(forwardedFor(init))
    return url.pathname.endsWith('/configuration')
      ? signInConfiguration()
      : memberSignInResponse({ outcome: 'identity_proof_verified' })
  })
  try {
    await GET(callbackRequest({ 'x-forwarded-for': 'not-an-ip' }))
    assert.deepEqual(seen, [undefined, undefined])
    assert.equal(oidcBrowserClientIp(callbackRequest({ 'cf-connecting-ip': 'nope' })), undefined)
  } finally {
    restore()
  }
})
