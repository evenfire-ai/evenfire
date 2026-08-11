import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteManagedUser } from '../lib/api'

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
