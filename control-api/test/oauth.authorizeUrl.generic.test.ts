import { describe, expect, it, vi } from 'vitest'
import { type BuildAuthorizeUrlDeps, buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import type { McpServerOAuthReader, McpServerOAuthSubject } from '../src/oauth/callback.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'

/**
 * S3.2 / DEC-28 — the generic authorize-URL mint end-to-end through the helper.
 * The URL is composed from the pinned `authorizationEndpoint` + wire knobs with
 * the PUBLIC client_id (`oauth.id`); the knobs (usePkce/sendScope/scopeSeparator/
 * includeResponseType/extraAuthorizeParams/resource) govern every param. No K8s
 * Secret is read on the public path. Subject decl comes from the REAL resolver.
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const MCP_NS = 'mcp-server'
const CLIENT_ID = 'my-generic-client'
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/my-generic-client'

function genericSubject(overrides: Record<string, unknown> = {}): McpServerOAuthSubject {
  const resolved = resolveServerOAuthSubject({
    spec: {
      contextRef: 'ctx-A',
      oauth: {
        source: 'generic',
        id: CLIENT_ID,
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        resource: 'https://api.example.com',
        tokenRequestFormat: 'form',
        tokenAuthMethod: 'body',
        scopeSeparator: 'comma',
        sendScope: true,
        usePkce: true,
        includeResponseType: true,
        supportsRefresh: true,
        grantScope: 'user',
        scopes: ['read', 'write'],
        extraAuthorizeParams: { audience: 'aud-1' },
        ...overrides,
      },
    },
  })
  if (!resolved) throw new Error('fixture: generic resolve returned null')
  return { namespace: MCP_NS, ...resolved }
}

async function mint(subject: McpServerOAuthSubject, secretRead = vi.fn(async () => ({}))) {
  const mcpServerReader: McpServerOAuthReader = { read: vi.fn(async () => subject) }
  const deps: BuildAuthorizeUrlDeps = {
    recipeReader: { read: vi.fn(async () => null) },
    mcpServerReader,
    secretReader: { read: secretRead } as unknown as BuildAuthorizeUrlDeps['secretReader'],
    stateSecret: STATE_SECRET,
  }
  const result = await buildAuthorizeUrl(
    {
      subjectKind: 'mcp',
      mcpServerName: 'gen-server',
      oauthClientId: CLIENT_ID,
      userId: 'user-9',
      grantKind: 'user',
      background: false,
      redirectUri: REDIRECT_URI,
    },
    deps
  )
  return { result, secretRead }
}

describe('buildAuthorizeUrl — generic mcp subject (DEC-28)', () => {
  it('honors all knobs and reads no Secret on the public path', async () => {
    const { result, secretRead } = await mint(genericSubject())
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const url = new URL(result.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example.com/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('resource')).toBe('https://api.example.com')
    // scopeSeparator=comma
    expect(url.searchParams.get('scope')).toBe('read,write')
    expect(url.searchParams.get('audience')).toBe('aud-1')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(secretRead).not.toHaveBeenCalled()
  })

  it('usePkce=false ⇒ no PKCE params and no challenge computed', async () => {
    const { result } = await mint(genericSubject({ usePkce: false }))
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const url = new URL(result.authorizeUrl)
    expect(url.searchParams.get('code_challenge')).toBeNull()
    expect(url.searchParams.get('code_challenge_method')).toBeNull()
  })

  it('sendScope=false ⇒ no scope param', async () => {
    const { result } = await mint(genericSubject({ sendScope: false }))
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(new URL(result.authorizeUrl).searchParams.get('scope')).toBeNull()
  })
})
