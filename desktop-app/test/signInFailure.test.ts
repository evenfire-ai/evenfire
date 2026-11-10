import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifySignInFailure } from '@lib/signInFailure'
import { AuthClient } from '../src/authClient.js'

function respondWith(status: number, body: string, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, statusText: 'Server Answer', headers }))
  )
}

/** What the renderer receives: the real rejection, wrapped by Electron's IPC. */
async function rendererMessage(): Promise<string> {
  const error = await new AuthClient().passwordLogin('user@example.com', 'secret').catch(e => e)
  expect(error).toBeInstanceOf(Error)
  return `Error invoking remote method 'auth:passwordLogin': Error: ${(error as Error).message}`
}

describe('classifySignInFailure on real AuthClient rejections', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a 401 as invalid credentials', async () => {
    respondWith(401, JSON.stringify({ error: 'invalid_credentials' }))
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind: 'invalid_credentials' })
  })

  it('reads a 429 with its wait', async () => {
    respondWith(429, JSON.stringify({ error: 'rate_limited' }), { 'retry-after': '900' })
    expect(classifySignInFailure(await rendererMessage())).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 900,
    })
  })

  it('reads a 429 without a wait', async () => {
    respondWith(429, JSON.stringify({ error: 'rate_limited' }))
    expect(classifySignInFailure(await rendererMessage())).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: null,
    })
  })

  it('reads a 503 as unavailable', async () => {
    respondWith(503, JSON.stringify({ error: 'service_unavailable' }))
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind: 'unavailable' })
  })

  it('reads a fetch failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind: 'unavailable' })
  })

  it('reads a 200 answer that is not JSON as unavailable', async () => {
    respondWith(200, 'proxy page httpStatus=401')
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind: 'unavailable' })
  })

  it.each([
    [400, 'bad request'],
    [404, 'not found'],
    [410, 'invitation_expired'],
    [426, 'upgrade required'],
  ])('leaves a %i answer unclassified', async (status, body) => {
    respondWith(status, body)
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind: 'other' })
  })

  it.each([
    [401, JSON.stringify({ detail: 'httpStatus=429' }), 'invalid_credentials'],
    [500, JSON.stringify({ detail: 'httpStatus=429 retryAfterSeconds=900' }), 'unavailable'],
    [400, 'signInTransport=noResponse', 'other'],
    [404, 'httpStatus=401', 'other'],
  ])('a %i body cannot imitate the marker', async (status, body, kind) => {
    respondWith(status, body, { 'retry-after': '17' })
    expect(classifySignInFailure(await rendererMessage())).toEqual({ kind })
  })
})

describe('classifySignInFailure on messages that never crossed the credential call', () => {
  it.each([
    [
      'a status in the prose',
      "Error invoking remote method 'auth:passwordLogin': Error: 401 Unauthorized: x",
    ],
    ['a token mid-message', 'Error: 500 upstream httpStatus=429 then failed'],
    ['the transport token mid-message', 'Error: signInTransport=noResponse then failed'],
    ['digits only', "Error invoking remote method 'auth:passwordLogin': 4010 retries exceeded"],
    ['an empty message', ''],
  ])('leaves %s unclassified', (_label, message) => {
    expect(classifySignInFailure(message)).toEqual({ kind: 'other' })
  })
})
