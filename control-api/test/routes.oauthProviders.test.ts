import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import { discoverAuthorizationServerMetadata } from '../src/oauth/discovery.js'
import {
  type AdminOauthProvidersDeps,
  createAdminOauthProvidersRouter,
} from '../src/routes/admin/oauthProviders.js'
import { NOTION_AS_JSON } from './fixtures/remoteOAuthDiscovery.js'

// Route-level kernel §4 uses the default DNS resolver — mock it to a public IP so
// syntactically-public hosts pass without a real lookup (internal hosts are rejected
// pre-DNS regardless).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const PUBLIC_IP = ['93.184.216.34']

function makeApp(deps: AdminOauthProvidersDeps = {}) {
  const app = express()
  app.use(express.json())
  app.use(createAdminOauthProvidersRouter(deps))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

/** Transport that serves ONE AS well-known URL, 404 elsewhere. */
function asOnlyTransport(asWellKnownUrl: string, json: string): PinnedTransport {
  return async ({ url }: { url: string }) => {
    if (url === asWellKnownUrl) {
      return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: json }
    }
    return { status: 404, headers: {}, bodyText: 'not found' }
  }
}

/** A `discover` seam that supplies a transport + resolveDns so no real network runs. */
function discoverWith(transport: PinnedTransport): AdminOauthProvidersDeps['discover'] {
  return (url, d) =>
    discoverAuthorizationServerMetadata(url, {
      ...d,
      transport,
      resolveDns: vi.fn(async () => PUBLIC_IP),
    })
}

describe('GET /admin/oauth/providers/:id/credential-manifest', () => {
  it('returns the manifest for a known baked provider', async () => {
    const res = await request(makeApp())
      .get('/admin/oauth/providers/google/credential-manifest')
      .expect(200)
    expect(res.body.provider).toBe('google')
    const names = res.body.fields.map((f: { name: string }) => f.name)
    expect(names).toContain('client_id')
    expect(names).toContain('client_secret')
  })

  it('404s for an unknown provider id', async () => {
    const res = await request(makeApp())
      .get('/admin/oauth/providers/not-a-provider/credential-manifest')
      .expect(404)
    expect(res.body.error).toMatch(/Unknown OAuth provider/)
  })

  // S3-B4: the generic manifest is now served (confidential fields). Was 404.
  it("returns the confidential manifest for the 'generic' carril", async () => {
    const res = await request(makeApp())
      .get('/admin/oauth/providers/generic/credential-manifest')
      .expect(200)
    expect(res.body.provider).toBe('generic')
    const names = res.body.fields.map((f: { name: string }) => f.name)
    expect(names).toEqual(['client_id', 'client_secret'])
    // The public-mode hint is carried so the wizard can explain no-credential mode.
    expect(res.body.fields[0].help).toMatch(/public mode/i)
  })
})

describe('POST /admin/oauth/discover (E-19.5)', () => {
  it('400s when url is missing', async () => {
    const res = await request(makeApp()).post('/admin/oauth/discover').send({}).expect(400)
    expect(res.body.error).toMatch(/url is required/)
  })

  it('kernel-rejects an internal URL before discovery (400, discover not called)', async () => {
    const discover = vi.fn(discoverWith(asOnlyTransport('x', '{}')))
    const res = await request(makeApp({ discover }))
      .post('/admin/oauth/discover')
      .send({ url: 'https://as.svc.cluster.local' })
      .expect(400)
    expect(res.body.errors?.[0]?.field).toBe('url')
    expect(discover).not.toHaveBeenCalled()
  })

  it('200 with the generic prefill for a real AS issuer (notion, T1)', async () => {
    const asWellKnown = 'https://mcp.notion.com/.well-known/oauth-authorization-server'
    const res = await request(
      makeApp({ discover: discoverWith(asOnlyTransport(asWellKnown, NOTION_AS_JSON)) })
    )
      .post('/admin/oauth/discover')
      .send({ url: 'https://mcp.notion.com' })
      .expect(200)
    expect(res.body.issuer).toBe('https://mcp.notion.com')
    expect(res.body.endpoints.authorization).toBe('https://mcp.notion.com/authorize')
    expect(res.body.endpoints.token).toBe('https://mcp.notion.com/token')
    expect(res.body.suggested.usePkce).toBe(true)
    expect(res.body.suggested.tokenAuthMethod).toBe('body')
    expect(res.body.suggested.supportsRefresh).toBe(true)
  })

  it('maps a transport failure to 502 (discoveryHttpStatus)', async () => {
    const discover: AdminOauthProvidersDeps['discover'] = async () => ({
      ok: false,
      error: { kind: 'fetch_failed', url: 'https://mcp.notion.com', detail: 'boom' },
    })
    const res = await request(makeApp({ discover }))
      .post('/admin/oauth/discover')
      .send({ url: 'https://mcp.notion.com' })
      .expect(502)
    expect(res.body.error).toBe('discovery_failed')
    expect(res.body.detail.kind).toBe('fetch_failed')
  })

  it('maps an invalid-metadata failure to 400', async () => {
    const discover: AdminOauthProvidersDeps['discover'] = async () => ({
      ok: false,
      error: { kind: 'invalid_metadata', url: 'https://mcp.notion.com', detail: 'bad' },
    })
    await request(makeApp({ discover }))
      .post('/admin/oauth/discover')
      .send({ url: 'https://mcp.notion.com' })
      .expect(400)
  })
})
