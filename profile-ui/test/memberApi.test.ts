import assert from 'node:assert/strict'
import test from 'node:test'
import { EXTERNAL_REST_API_BASE_URL } from '../app/constants/api'
import { createDesktopAuthorization, deleteManagedUser } from '../lib/api'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222'

test('deleteManagedUser sends the governed retirement contract', async () => {
  const previousFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify({ deleted: true, id: USER_ID }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await deleteManagedUser(USER_ID, {
      reason: 'access review complete',
      idempotencyKey: 'profile-retire-v1',
      correlationId: CORRELATION_ID,
    })
    assert.deepEqual(result, { deleted: true, id: USER_ID })
    const capturedRequest = request
    assert.ok(capturedRequest)
    assert.equal(capturedRequest.init?.method, 'DELETE')
    const headers = new Headers(capturedRequest.init?.headers)
    assert.equal(headers.get('Idempotency-Key'), 'profile-retire-v1')
    assert.equal(headers.get('x-correlation-id'), CORRELATION_ID)
    assert.deepEqual(JSON.parse(String(capturedRequest.init?.body)), {
      reason: 'access review complete',
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('deleteManagedUser default caller path supplies generated idempotency and correlation values', async () => {
  const previousFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify({ deleted: true, id: USER_ID }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await deleteManagedUser(USER_ID)
    assert.ok(request)
    const headers = new Headers(request.init?.headers)
    assert.match(
      headers.get('Idempotency-Key') || '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    assert.match(
      headers.get('x-correlation-id') || '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      reason: 'profile_ui_user_retirement',
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('createDesktopAuthorization posts an empty body to the desktop authorization route', async () => {
  const previousFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | undefined
  // Only the request is asserted. The answer has DesktopAuthorizationResponse's shape with the
  // synthetic token DesktopSetupPanel.test.tsx uses.
  const authorization = {
    authorizationToken: 'fixture-desktop-auth-token-00000',
    expiresInSeconds: 120,
  }
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify(authorization), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    assert.deepEqual(await createDesktopAuthorization(), authorization)
    const capturedRequest = request
    assert.ok(capturedRequest)
    assert.equal(capturedRequest.init?.method, 'POST')
    assert.equal(
      capturedRequest.url,
      `${EXTERNAL_REST_API_BASE_URL}/api/v1/invitations/desktop-authorization`
    )
    // The signed-in session is the only authority, so the body names nothing.
    assert.equal(capturedRequest.init?.body, '{}')
  } finally {
    globalThis.fetch = previousFetch
  }
})
