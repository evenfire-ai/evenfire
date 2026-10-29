import { beforeAll, describe, expect, it, vi } from 'vitest'
import { type BuildAuthorizeUrlDeps, buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import type { McpServerOAuthReader, McpServerOAuthSubject } from '../src/oauth/callback.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import {
  type InstalledMcpServer,
  WORKIQ_URL_SCOPE,
  installWorkIqServer,
} from './fixtures/perServerInstall.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'

/**
 * C4/DEC-23 — the remote authorize-URL mint. The URL is built from the pinned
 * discovery-derived `authorizationEndpoint` with the PUBLIC client_id (`oauth.id`),
 * mandatory PKCE S256, and the RFC 8707 `resource`. No secret material rides the
 * URL and no K8s Secret is read. The CR is the install's own output (T1): the real
 * discovery over the Linear probe (CIMD with RFC 9207) through `buildRemoteOAuthSpec`,
 * resolved by the REAL resolver.
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const MCP_NS = 'mcp-server'
const CLIENT_ID = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/remote'

let linear: DiscoveryResult

beforeAll(async () => {
  const outcome = await discoverRemoteOAuth(PILOTS.linear.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.linear),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  linear = outcome.result
})

function remoteSubject(): McpServerOAuthSubject {
  const oauth = buildRemoteOAuthSpec(linear, {
    clientMode: 'public',
    grantScope: 'user',
    cimdClientId: CLIENT_ID,
  })
  const resolved = resolveServerOAuthSubject(
    { spec: { contextRef: 'ctx-A', oauth: oauth as unknown as Record<string, unknown> } },
    'consent'
  )
  if (!resolved) throw new Error('fixture: remote resolve returned null')
  return { namespace: MCP_NS, ...resolved }
}

describe('buildAuthorizeUrl — remote mcp subject (DEC-23)', () => {
  it('builds a pinned-endpoint authorize URL with PKCE S256 + resource, no secret read', async () => {
    const secretRead = vi.fn(async () => ({}))
    const mcpServerReader: McpServerOAuthReader = { read: vi.fn(async () => remoteSubject()) }
    const deps: BuildAuthorizeUrlDeps = {
      recipeReader: { read: vi.fn(async () => null) },
      mcpServerReader,
      secretReader: { read: secretRead } as unknown as BuildAuthorizeUrlDeps['secretReader'],
      stateSecret: STATE_SECRET,
    }

    const result = await buildAuthorizeUrl(
      {
        subjectKind: 'mcp',
        mcpServerName: 'linear-remote',
        oauthClientId: CLIENT_ID,
        userId: 'user-9',
        grantKind: 'user',
        background: false,
        redirectUri: REDIRECT_URI,
      },
      deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const url = new URL(result.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://mcp.linear.app/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('resource')).toBe('https://mcp.linear.app/mcp')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('state')).toBeTruthy()
    // No secret material, and the client-id Secret was never read (public client).
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(secretRead).not.toHaveBeenCalled()
  })
})

describe('buildAuthorizeUrl — entra-v2 profile (I5, I7)', () => {
  const ENTRA_AUTHORIZE =
    'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/authorize'
  let workIq: InstalledMcpServer

  beforeAll(async () => {
    workIq = await installWorkIqServer({ scopes: [WORKIQ_URL_SCOPE] })
  })

  async function authorizeUrlFor(server: InstalledMcpServer): Promise<URL> {
    const resolved = resolveServerOAuthSubject(server, 'consent')
    if (!resolved) throw new Error('fixture: the Work IQ CR did not resolve')
    const secretRead = vi.fn(async () => ({}))
    const result = await buildAuthorizeUrl(
      {
        subjectKind: 'mcp',
        mcpServerName: server.metadata.name,
        oauthClientId: String(server.spec.oauth.id),
        userId: 'user-9',
        grantKind: 'user',
        background: false,
        redirectUri: `https://control.example.com/api/v1/oauth-callback/remote/${server.metadata.name}`,
      },
      {
        recipeReader: { read: vi.fn(async () => null) },
        mcpServerReader: { read: vi.fn(async () => ({ namespace: MCP_NS, ...resolved })) },
        secretReader: { read: secretRead } as unknown as BuildAuthorizeUrlDeps['secretReader'],
        stateSecret: STATE_SECRET,
      }
    )
    if (result.kind !== 'ok') throw new Error(`authorize-url failed: ${result.kind}`)
    expect(secretRead).not.toHaveBeenCalled()
    return new URL(result.authorizeUrl)
  }

  it('no resource, PKCE S256 and offline_access in scope', async () => {
    expect(workIq.spec.oauth.resource).toBe('https://workiq.svc.cloud.microsoft/mcp')
    const url = await authorizeUrlFor(workIq)
    expect(`${url.origin}${url.pathname}`).toBe(ENTRA_AUTHORIZE)
    expect(url.searchParams.has('resource')).toBe(false)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(`${WORKIQ_URL_SCOPE} offline_access`)
  })

  it('a CR edited to drop offline_access still asks for it', async () => {
    const edited: InstalledMcpServer = {
      ...workIq,
      spec: { ...workIq.spec, oauth: { ...workIq.spec.oauth, scopes: [WORKIQ_URL_SCOPE] } },
    }
    const url = await authorizeUrlFor(edited)
    expect(url.searchParams.get('scope')).toBe(`${WORKIQ_URL_SCOPE} offline_access`)
  })
})
