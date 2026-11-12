import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { GET as profileCallback } from '../../profile-ui/app/api/oidc/callback/route'
import { POST as profileStart } from '../../profile-ui/app/api/oidc/start/route'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { OIDC_R5_PUBLIC_IP, createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

const CALLBACK_URI = 'https://profile.example.test/api/oidc/callback'

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  transport: vi.fn(),
  routes: new Map<string, (input: unknown) => Promise<unknown>>(),
}))

vi.mock('node:dns/promises', () => ({
  lookup: (hostname: string) => network.lookup(hostname),
}))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: PinnedFetchOptions = {}) =>
      actual.pinnedFetch(url, field, {
        ...options,
        transport: input => network.transport(input),
      }),
  }
})

function registerFixture(fixture: ReturnType<typeof createOidcR5ProtocolFixture>): void {
  for (const endpoint of [
    fixture.issuer,
    fixture.authorizationEndpoint,
    fixture.tokenEndpoint,
    fixture.jwksUri,
  ]) {
    network.routes.set(new URL(endpoint).hostname, input => fixture.transport(input as never))
  }
}

function makeControlApi(fixture: ReturnType<typeof createOidcR5ProtocolFixture>) {
  const app = express()
  app.use(express.json())
  app.use(
    '/external',
    createExternalOidcProfileFlowRouter({
      getProvider: () => fixture.provider,
      createEngine: () => fixture.engine,
    })
  )
  return app
}

function installControlApiFetch(app: express.Express): () => void {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const upstreamUrl = new URL(String(input))
    const path = upstreamUrl.pathname.replace(/^\/api\/v1/, '/external')
    const method = (init.method ?? 'GET').toLowerCase()
    const operation = request(app)[method as 'get' | 'post'](path)
    const response = init.body
      ? await operation.set('content-type', 'application/json').send(String(init.body))
      : await operation
    return Response.json(response.body, { status: response.status })
  }) as typeof fetch
  return () => {
    globalThis.fetch = previousFetch
  }
}

function startRequest(): Request {
  return new Request('https://profile.example.test/api/oidc/start', {
    method: 'POST',
    headers: { origin: 'https://profile.example.test' },
  })
}

function cookieValue(response: Response): string {
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toBeTruthy()
  return cookie!.split(';', 1)[0]!
}

beforeEach(() => {
  network.routes.clear()
  network.lookup.mockReset().mockResolvedValue([{ address: OIDC_R5_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation((input: { url: string }) => {
    const route = network.routes.get(new URL(input.url).hostname)
    if (!route) throw new Error('Unexpected OIDC provider request')
    return route(input)
  })
})

afterEach(() => vi.restoreAllMocks())

describe('Profile browser binding through the actual Control API producer', () => {
  it('persists the browser binding digest and completes only the initiating browser', async () => {
    const fixture = createOidcR5ProtocolFixture({
      hostPrefix: 'profile-browser-binding',
      redirectUri: CALLBACK_URI,
    })
    registerFixture(fixture)
    const restoreFetch = installControlApiFetch(makeControlApi(fixture))
    try {
      const started = await profileStart(startRequest())
      const location = new URL(started.headers.get('location') ?? '')
      fixture.expectAuthorizationResponse(location.href)
      const state = location.searchParams.get('state')!
      const bindingCookie = cookieValue(started)
      const browserBinding = bindingCookie.slice(bindingCookie.indexOf('=') + 1)
      const row = [...fixture.db.rows.values()].find(
        attempt => attempt.stateHash === createHash('sha256').update(state).digest('hex')
      )

      expect(started.status).toBe(303)
      expect(location.origin).toBe('https://login.profile-browser-binding.example.test')
      expect(row?.browserBindingHash).toBe(
        createHash('sha256').update(browserBinding).digest('hex')
      )
      expect(row?.browserBindingHash).not.toContain(browserBinding)

      const completed = await profileCallback(
        new Request(
          `${CALLBACK_URI}?state=${encodeURIComponent(state)}&code=r5-fixture-code&iss=${encodeURIComponent(fixture.issuer)}`,
          {
            headers: { cookie: bindingCookie },
          }
        )
      )
      const message = await completed.text()
      expect(completed.status).toBe(200)
      expect(message).toContain('Member sign-in is not enabled')
      expect(message).not.toMatch(/subject-|email|controlled-code|access_token/i)
      expect(fixture.tokenRequests).toHaveLength(1)
      expect(
        [...fixture.db.rows.values()].find(
          attempt => attempt.stateHash === createHash('sha256').update(state).digest('hex')
        )?.status
      ).toBe('completed')
    } finally {
      restoreFetch()
    }
  })

  it('rejects a second browser before provider I/O and leaves the first attempt pending', async () => {
    const fixture = createOidcR5ProtocolFixture({
      hostPrefix: 'profile-cross-browser',
      redirectUri: CALLBACK_URI,
    })
    registerFixture(fixture)
    const restoreFetch = installControlApiFetch(makeControlApi(fixture))
    try {
      const first = await profileStart(startRequest())
      const firstUrl = new URL(first.headers.get('location') ?? '')
      const firstState = firstUrl.searchParams.get('state')!
      const second = await profileStart(startRequest())
      fixture.expectAuthorizationResponse(second.headers.get('location') ?? '')
      const secondCookie = cookieValue(second)
      const networkCallsBeforeCallback = network.transport.mock.calls.length

      const rejected = await profileCallback(
        new Request(
          `${CALLBACK_URI}?state=${encodeURIComponent(firstState)}&code=controlled-code`,
          { headers: { cookie: secondCookie } }
        )
      )

      const firstRow = [...fixture.db.rows.values()].find(
        attempt => attempt.stateHash === createHash('sha256').update(firstState).digest('hex')
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).toBe('Identity proof could not be verified.')
      expect(network.transport.mock.calls.length).toBe(networkCallsBeforeCallback)
      expect(fixture.tokenRequests).toHaveLength(0)
      expect(firstRow?.status).toBe('pending')
      expect(firstRow?.verifierEncrypted).not.toBeNull()
      expect(firstRow?.nonceEncrypted).not.toBeNull()
    } finally {
      restoreFetch()
    }
  })
})
