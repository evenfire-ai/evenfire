import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { CallbackResult } from '../src/oauth/callback.js'
import { MockGateway } from './mockGateway.js'

/**
 * Every outcome the callback handler can return must turn into an HTTP
 * response. A kind the route does not map would leave the provider redirect
 * hanging until the client gives up, with no error anywhere; this suite feeds
 * each kind of the union through the real route and requires an answer.
 */

const handler = vi.hoisted(() => ({ result: undefined as unknown }))

vi.mock('../src/oauth/callback.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth/callback.js')>()
  return { ...actual, handleOAuthCallback: vi.fn(async () => handler.result) }
})

const { createOAuthCallbackRouter } = await import('../src/routes/external/oauthCallback.js')

// Typed as a total record over the union's kinds, so an editor flags a kind
// missing from this table. That is documentation only: test/ is outside the
// tsconfig that `npm run build` and CI typecheck. The enforced exhaustiveness
// is the `satisfies never` default in src/routes/external/oauthCallback.ts,
// which fails the build when the route stops mapping a kind.
const EXPECTED: { [K in CallbackResult['kind']]: [Extract<CallbackResult, { kind: K }>, number] } =
  {
    ok: [
      {
        kind: 'ok',
        provider: 'google',
        userId: 'u',
        grantKind: 'user',
        backgroundRequested: false,
        backgroundEnabled: false,
        source: 'mcp',
        mcpServerName: 'shared-drive',
      },
      200,
    ],
    invalid_state: [{ kind: 'invalid_state', reason: 'expired' }, 400],
    oauth_state_outdated: [{ kind: 'oauth_state_outdated' }, 400],
    issuer_mismatch: [{ kind: 'issuer_mismatch' }, 400],
    issuer_binding_required: [{ kind: 'issuer_binding_required' }, 400],
    callback_base_url_unconfigured: [{ kind: 'callback_base_url_unconfigured' }, 503],
    unknown_oauth_client: [{ kind: 'unknown_oauth_client' }, 400],
    recipe_not_found: [{ kind: 'recipe_not_found' }, 404],
    server_not_found: [{ kind: 'server_not_found' }, 404],
    context_membership_denied: [{ kind: 'context_membership_denied' }, 403],
    remote_oauth_spec_incoherent: [
      { kind: 'remote_oauth_spec_incoherent', reason: 'bearer_in_body' },
      409,
    ],
    secret_missing: [{ kind: 'secret_missing', secret: 's' }, 503],
    unsupported_provider: [{ kind: 'unsupported_provider', provider: 'p' }, 500],
    provider_token_exchange_failed: [
      { kind: 'provider_token_exchange_failed', status: 400, body: 'x' },
      502,
    ],
    provider_response_invalid: [{ kind: 'provider_response_invalid', detail: 'd' }, 502],
  }

describe('oauth callback route maps every CallbackResult kind to a response', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use('/api/v1', createOAuthCallbackRouter(new MockGateway() as never))
  })

  it.each(Object.entries(EXPECTED))('%s', async (_kind, [result, status]) => {
    handler.result = result
    const res = await request(app)
      .get('/api/v1/oauth-callback/some-client')
      .query({ code: 'CODE', state: 'STATE' })
      .timeout(2_000)
    expect(res.status).toBe(status)
  })

  it('oauth_state_outdated answers its own error code', async () => {
    handler.result = { kind: 'oauth_state_outdated' }
    const res = await request(app)
      .get('/api/v1/oauth-callback/some-client')
      .query({ code: 'CODE', state: 'STATE' })
      .timeout(2_000)
    expect(res.body).toEqual({ error: 'oauth_state_outdated' })
  })

  it('a kind outside the union answers 500 instead of hanging', async () => {
    handler.result = { kind: 'not_a_real_kind' }
    const res = await request(app)
      .get('/api/v1/oauth-callback/some-client')
      .query({ code: 'CODE', state: 'STATE' })
      .timeout(2_000)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
  })
})
