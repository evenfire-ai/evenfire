import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegistryEntry } from '../api'
import {
  buildOAuthRedirectUri,
  deriveOAuthClientIdPreview,
  extractOAuthImmutables,
  formatScopesForInput,
  getCatalogOAuthBlock,
  oauthCallbackBaseUrl,
  parseScopesInput,
  referenceSecretIssue,
  scopesAreSatisfied,
} from '../oauthInstall'

// Minimal RegistryEntry with only the fields getCatalogOAuthBlock reads. The
// `mcp_server_meta.oauth` shape is the frozen S1-U1 catalog contract (spec §5).
function entryWithOAuth(oauth: unknown): RegistryEntry {
  return {
    name: 'acme',
    version: '1.0.0',
    entry_type: 'mcp-server',
    mcp_server_meta: { oauth } as Record<string, unknown>,
  } as RegistryEntry
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('deriveOAuthClientIdPreview', () => {
  it('mirrors the control-api derivation (lowercase, hyphen-collapsed, trimmed)', () => {
    // Matches control-api deriveOAuthClientId (routes/admin/registry.ts).
    expect(deriveOAuthClientIdPreview('Acme_Connector')).toBe('acme-connector')
    expect(deriveOAuthClientIdPreview('--a--b--')).toBe('a-b')
    expect(deriveOAuthClientIdPreview('UPPER')).toBe('upper')
  })

  it('truncates to 63 characters', () => {
    expect(deriveOAuthClientIdPreview('a'.repeat(80))).toHaveLength(63)
  })
})

describe('buildOAuthRedirectUri', () => {
  it('joins the base and callback path with the id encoded', () => {
    expect(buildOAuthRedirectUri('https://oauth.example.com', 'acme')).toBe(
      'https://oauth.example.com/api/v1/oauth-callback/acme'
    )
  })

  it('strips a trailing slash from the base', () => {
    expect(buildOAuthRedirectUri('https://oauth.example.com/', 'acme')).toBe(
      'https://oauth.example.com/api/v1/oauth-callback/acme'
    )
  })

  it('returns null when the base is missing or blank (no broken URI)', () => {
    expect(buildOAuthRedirectUri('', 'acme')).toBeNull()
    expect(buildOAuthRedirectUri('   ', 'acme')).toBeNull()
    expect(buildOAuthRedirectUri(undefined, 'acme')).toBeNull()
  })

  it('returns null when the id is empty', () => {
    expect(buildOAuthRedirectUri('https://oauth.example.com', '')).toBeNull()
  })
})

describe('oauthCallbackBaseUrl', () => {
  it('reads the NEXT_PUBLIC env lazily and trims it', () => {
    vi.stubEnv('NEXT_PUBLIC_CONTROL_API_OAUTH_CALLBACK_BASE_URL', '  https://oauth.example.com  ')
    expect(oauthCallbackBaseUrl()).toBe('https://oauth.example.com')
  })

  it('is empty when the env is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_CONTROL_API_OAUTH_CALLBACK_BASE_URL', '')
    expect(oauthCallbackBaseUrl()).toBe('')
  })
})

describe('getCatalogOAuthBlock', () => {
  it('extracts a valid block and keeps only understood fields', () => {
    const block = getCatalogOAuthBlock(
      entryWithOAuth({
        provider: 'google',
        grantScope: 'context',
        scopes: ['a.read', 'b.read'],
        genericConfig: { endpoints: {} },
      })
    )
    expect(block).toEqual({
      provider: 'google',
      grantScope: 'context',
      scopes: ['a.read', 'b.read'],
    })
    // genericConfig is Slice-3-only and must never leak into Slice-1 state.
    expect(block).not.toHaveProperty('genericConfig')
  })

  it('returns null when there is no oauth block', () => {
    expect(getCatalogOAuthBlock(entryWithOAuth(undefined))).toBeNull()
    expect(getCatalogOAuthBlock({ mcp_server_meta: null } as RegistryEntry)).toBeNull()
    expect(getCatalogOAuthBlock(null)).toBeNull()
  })

  it('returns null when the provider is missing', () => {
    expect(getCatalogOAuthBlock(entryWithOAuth({ scopes: ['x'] }))).toBeNull()
  })

  it('drops an invalid grantScope rather than trusting it', () => {
    const block = getCatalogOAuthBlock(entryWithOAuth({ provider: 'slack', grantScope: 'admin' }))
    expect(block).toEqual({ provider: 'slack' })
  })
})

describe('parseScopesInput / formatScopesForInput', () => {
  it('splits on whitespace, newlines and commas and de-duplicates', () => {
    expect(parseScopesInput('a.read  b.read\nc.read, a.read')).toEqual([
      'a.read',
      'b.read',
      'c.read',
    ])
  })

  it('is empty for whitespace-only input', () => {
    expect(parseScopesInput('   \n  ')).toEqual([])
  })

  it('round-trips a list to one-per-line text', () => {
    expect(formatScopesForInput(['a', 'b'])).toBe('a\nb')
  })
})

describe('scopesAreSatisfied', () => {
  it('requires at least one scope (GAP-6)', () => {
    expect(scopesAreSatisfied([])).toBe(false)
    expect(scopesAreSatisfied(['a.read'])).toBe(true)
  })
})

describe('referenceSecretIssue', () => {
  const secrets = [{ name: 'gh-oauth', keys: ['client_id', 'client_secret'] }]

  it('accepts an existing Secret with both keys present', () => {
    expect(
      referenceSecretIssue(
        { secretName: 'gh-oauth', clientIdKey: 'client_id', clientSecretKey: 'client_secret' },
        secrets
      )
    ).toBeNull()
  })

  it('flags a missing Secret', () => {
    expect(
      referenceSecretIssue(
        { secretName: 'absent', clientIdKey: 'client_id', clientSecretKey: 'client_secret' },
        secrets
      )
    ).toMatch(/not found/)
  })

  it('flags a missing key on an existing Secret', () => {
    expect(
      referenceSecretIssue(
        { secretName: 'gh-oauth', clientIdKey: 'client_id', clientSecretKey: 'nope' },
        secrets
      )
    ).toMatch(/missing key\(s\): nope/)
  })

  it('requires a chosen Secret and named keys', () => {
    expect(
      referenceSecretIssue({ secretName: '', clientIdKey: 'a', clientSecretKey: 'b' }, secrets)
    ).toMatch(/Choose an existing Secret/)
    expect(
      referenceSecretIssue(
        { secretName: 'gh-oauth', clientIdKey: '', clientSecretKey: '' },
        secrets
      )
    ).toMatch(/Name the Client ID key/)
  })
})

describe('extractOAuthImmutables', () => {
  it('reads id, provider, and grantScope off spec.oauth', () => {
    expect(
      extractOAuthImmutables({
        oauth: { id: 'acme', provider: 'google', grantScope: 'user', scopes: ['x'] },
      })
    ).toEqual({ id: 'acme', provider: 'google', grantScope: 'user' })
  })

  it('returns null when there is no oauth block', () => {
    expect(extractOAuthImmutables({})).toBeNull()
    expect(extractOAuthImmutables(undefined)).toBeNull()
  })

  it('blanks an invalid grantScope', () => {
    expect(
      extractOAuthImmutables({ oauth: { id: 'a', provider: 'slack', grantScope: 'x' } })
    ).toEqual({ id: 'a', provider: 'slack', grantScope: '' })
  })
})
