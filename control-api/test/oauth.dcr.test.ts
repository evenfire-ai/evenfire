import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { buildDcrRequest, registerDynamicClient } from '../src/oauth/dcr.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import {
  DCR_BASIC_REGISTRATION_RESPONSE,
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  DCR_REGISTRATION_ENDPOINT,
  makeDcrTransport,
} from './fixtures/remoteOAuthDiscovery.js'

const PUBLIC_IP = async () => ['93.184.216.34']

function discoveryWith(supportsRefresh: boolean): DiscoveryResult {
  return {
    prm: { resource: 'https://mcp.notion.com' },
    as: {
      issuer: 'https://mcp.notion.com',
      authorization_endpoint: 'https://mcp.notion.com/authorize',
      token_endpoint: 'https://mcp.notion.com/token',
    },
    resource: 'https://mcp.notion.com',
    issuer: 'https://mcp.notion.com',
    endpoints: {
      authorization: 'https://mcp.notion.com/authorize',
      token: 'https://mcp.notion.com/token',
      registration: DCR_REGISTRATION_ENDPOINT,
    },
    registrationMode: 'dcr',
    quirks: { bearerInBody: false, supportsRefresh },
  }
}

const REDIRECT_URIS = ['https://control.example.com/api/v1/oauth-callback/remote']

describe('buildDcrRequest (RFC 7591, pure) — T2 property', () => {
  it('always: response_types=[code], auth method by mode, redirect_uris passthrough, refresh iff advertised', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'public' | 'confidential'>('public', 'confidential'),
        fc.boolean(),
        fc.array(fc.webUrl(), { minLength: 1, maxLength: 3 }),
        fc.option(fc.array(fc.string({ minLength: 1 }), { maxLength: 4 }), { nil: undefined }),
        (clientMode, supportsRefresh, redirectUris, scopes) => {
          const req = buildDcrRequest(discoveryWith(supportsRefresh), {
            clientMode,
            redirectUris,
            scopes,
          })
          expect(req.response_types).toEqual(['code'])
          expect(req.client_name).toBe('Evenfire')
          expect(req.application_type).toBe('web')
          expect(req.token_endpoint_auth_method).toBe(
            clientMode === 'public' ? 'none' : 'client_secret_post'
          )
          expect(req.redirect_uris).toEqual(redirectUris)
          expect(req.grant_types).toContain('authorization_code')
          expect(req.grant_types.includes('refresh_token')).toBe(supportsRefresh)
          if (scopes && scopes.length > 0) {
            expect(req.scope).toBe(scopes.join(' '))
          } else {
            expect(req.scope).toBeUndefined()
          }
        }
      )
    )
  })
})

describe('registerDynamicClient (RFC 7591, effectful via injected pinned transport)', () => {
  const publicReq = buildDcrRequest(discoveryWith(true), {
    clientMode: 'public',
    redirectUris: REDIRECT_URIS,
  })
  const confReq = buildDcrRequest(discoveryWith(true), {
    clientMode: 'confidential',
    redirectUris: REDIRECT_URIS,
  })

  it('public: parses the RFC 7591 response and returns the assigned client_id', async () => {
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      publicReq
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.response.client_id).toBe('dyn-public-6f1c2a')
    // Single hop POST with content-type + content-length.
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(calls[0].headers['content-length']).toBe(String(Buffer.byteLength(calls[0].body ?? '')))
  })

  it('confidential: returns the client_secret + registration_access_token', async () => {
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      confReq
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.response.client_secret).toBe('fixture-client-secret-not-probed')
      expect(outcome.response.registration_access_token).toBe('fixture-reg-access-token-not-probed')
    }
  })

  it('FAIL-CLOSED: AS assigns client_secret_basic → auth_method_unsupported (nothing usable)', async () => {
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_BASIC_REGISTRATION_RESPONSE),
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      confReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('auth_method_unsupported')
  })

  it('a 3xx on the registration POST is redirect_blocked (never re-POSTed to Location)', async () => {
    const { transport } = makeDcrTransport({ responseJson: '', status: 302 })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      publicReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('redirect_blocked')
  })

  it('a 4xx with an OAuth error body surfaces error/error_description', async () => {
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify({
        error: 'invalid_redirect_uri',
        error_description: 'unregistered uri',
      }),
      status: 400,
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      publicReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('fetch_failed')
      if (outcome.error.kind === 'fetch_failed') {
        expect(outcome.error.status).toBe(400)
        expect(outcome.error.detail).toContain('invalid_redirect_uri')
        expect(outcome.error.detail).toContain('unregistered uri')
      }
    }
  })

  it('a 2xx body without client_id is invalid_response', async () => {
    const { transport } = makeDcrTransport({ responseJson: JSON.stringify({ foo: 'bar' }) })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      publicReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('invalid_response')
  })

  it('a confidential registration that returns no client_secret is invalid_response', async () => {
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify({
        client_id: 'x',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      DCR_REGISTRATION_ENDPOINT,
      confReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('invalid_response')
  })

  it('a non-https registration endpoint is kernel_rejected before any POST', async () => {
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const outcome = await registerDynamicClient(
      { transport, resolveDns: PUBLIC_IP },
      'http://mcp.notion.com/register',
      publicReq
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    // Fail-closed: the transport was never invoked.
    expect(calls).toHaveLength(0)
  })
})
