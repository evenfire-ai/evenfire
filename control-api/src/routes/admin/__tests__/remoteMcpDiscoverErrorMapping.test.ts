import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { DiscoveryError } from '../../../oauth/discovery.js'

// The discover route runs the kernel §4 pre-check (validateOAuthEndpointUrl) before
// reaching discovery, and that check does a REAL DNS lookup with no injectable
// resolver. This finding is about the discovery-error → HTTP-status mapping, not the
// kernel check, so stub the kernel to pass and drive discovery through the injected
// `discover` seam — keeping the test fully offline.
vi.mock('../../../http/validateMcpServerSpec.js', () => ({
  validateOAuthEndpointUrl: async () => [],
}))

// Auth is enforced by requireAuthForControlUI; stub it the same way the neighbouring
// admin-router tests do (mock path is resolved relative to THIS file).
vi.mock('../../../middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (req: any, _res: any, next: any) => {
    req.adminAuth = { sub: 'test-admin', jti: 'test-jti' }
    next()
  },
}))

// Import AFTER vi.mock so the mocked modules wire up.
const { createAdminRemoteMcpRouter, discoveryHttpStatus } = await import('../remoteMcp.js')

// A public URL that passes the (stubbed) kernel §4 pre-check.
const BASE_URL = 'https://as.example.test'

function fetchFailedDiscover() {
  return vi.fn().mockResolvedValue({
    ok: false,
    error: {
      kind: 'fetch_failed',
      url: 'https://as.example.test/.well-known/oauth-protected-resource',
      detail: 'connect ECONNREFUSED',
    },
  })
}

function buildApp(discover: ReturnType<typeof fetchFailedDiscover>) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  const gateway = {} as any
  app.use(
    '/api/v1',
    createAdminRemoteMcpRouter(gateway, {
      // Inject a fixed encryption key so router construction never touches config.
      encryptionKey: Buffer.alloc(32),
      discover: discover as any,
    })
  )
  return app
}

describe('discoveryHttpStatus — DiscoveryError → HTTP status decision table', () => {
  // One entry per DiscoveryError.kind. 502 = upstream transport failure (AS gave no
  // usable HTTP response); 400 = operator-actionable (bad input or reachable-but-
  // incompatible AS).
  const cases: Array<{ error: DiscoveryError; status: number }> = [
    {
      error: { kind: 'fetch_failed', url: 'https://as.example.test/x', detail: 'ECONNREFUSED' },
      status: 502,
    },
    {
      error: {
        kind: 'content_encoding_rejected',
        url: 'https://as.example.test/x',
        encoding: 'br',
      },
      status: 502,
    },
    { error: { kind: 'kernel_rejected', field: 'baseUrl', errors: [] }, status: 400 },
    {
      error: { kind: 'invalid_metadata', url: 'https://as.example.test/x', detail: 'bad json' },
      status: 400,
    },
    { error: { kind: 'no_s256', detail: 'S256 not advertised' }, status: 400 },
    {
      error: { kind: 'no_authorization_server', detail: 'no authorization_servers[0]' },
      status: 400,
    },
    {
      error: {
        kind: 'redirect_blocked',
        url: 'https://as.example.test/x',
        detail: 'missing Location',
      },
      status: 400,
    },
    {
      error: {
        kind: 'prm_resource_mismatch',
        url: 'https://as.example.test/x',
        detail: 'resource mismatch',
      },
      status: 400,
    },
    { error: { kind: 'issuer_mismatch', detail: 'issuer != base' }, status: 400 },
  ]

  for (const { error, status } of cases) {
    it(`maps ${error.kind} → ${status}`, () => {
      expect(discoveryHttpStatus(error)).toBe(status)
    })
  }
})

describe('POST /admin/mcp-servers/remote/discover — discovery error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 502 (not 400) when discovery fails with fetch_failed (upstream transport)', async () => {
    const discover = fetchFailedDiscover()
    const app = buildApp(discover)

    const res = await request(app)
      .post('/api/v1/admin/mcp-servers/remote/discover')
      .send({ baseUrl: BASE_URL })

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('discovery_failed')
    expect(res.body.detail.kind).toBe('fetch_failed')
    // Never hit the real network: the discovery seam was the only source of the outcome.
    expect(discover).toHaveBeenCalledTimes(1)
  })
})
