import { describe, expect, it, vi } from 'vitest'
import { type BuildAuthorizeUrlDeps, buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import type { McpServerOAuthReader, McpServerOAuthSubject } from '../src/oauth/callback.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'

/**
 * C4/DEC-23 — the remote authorize-URL mint. The URL is built from the pinned
 * discovery-derived `authorizationEndpoint` with the PUBLIC client_id (`oauth.id`),
 * mandatory PKCE S256, and the RFC 8707 `resource`. No secret material rides the
 * URL and no K8s Secret is read. Subject decl comes from the REAL resolver.
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const MCP_NS = 'mcp-server'
const CLIENT_ID = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/remote'

function remoteSubject(): McpServerOAuthSubject {
  const resolved = resolveServerOAuthSubject({
    spec: {
      contextRef: 'ctx-A',
      oauth: {
        source: 'remote',
        id: CLIENT_ID,
        clientMode: 'public',
        authorizationEndpoint: 'https://mcp.notion.com/authorize',
        tokenEndpoint: 'https://mcp.notion.com/token',
        issuer: 'https://mcp.notion.com',
        resource: 'https://mcp.notion.com',
        grantScope: 'user',
        scopes: ['read', 'write'],
        bearerInBody: false,
        supportsRefresh: true,
      },
    },
  })
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
        mcpServerName: 'notion-remote',
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
    expect(`${url.origin}${url.pathname}`).toBe('https://mcp.notion.com/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('resource')).toBe('https://mcp.notion.com')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('state')).toBeTruthy()
    // No secret material, and the client-id Secret was never read (public client).
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(secretRead).not.toHaveBeenCalled()
  })
})
