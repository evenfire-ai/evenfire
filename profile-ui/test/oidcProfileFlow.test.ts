import assert from 'node:assert/strict'
import test from 'node:test'
import { type OidcProfileConfiguration, browserCookieName } from '../app/api/oidc/_flow'
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

test('an unknown completion outcome does not claim the attempt can be retried', async () => {
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
    assert.doesNotMatch(text, /retry this attempt/i)
    assert.match(text, /start a new sign-in attempt/i)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
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
