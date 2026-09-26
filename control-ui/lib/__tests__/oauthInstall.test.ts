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
        // A malformed genericConfig (no recognised knob) is dropped defensively.
        genericConfig: { endpoints: {} },
      })
    )
    expect(block).toEqual({
      provider: 'google',
      grantScope: 'context',
      scopes: ['a.read', 'b.read'],
    })
    expect(block).not.toHaveProperty('genericConfig')
  })

  it('conserves a well-formed generic catalog suggestion (E-19.6)', () => {
    // T3: at b9a846a98 getCatalogOAuthBlock dropped genericConfig entirely, so this
    // assertion fails there. The generic carril needs the catalog suggestion to seed
    // the wizard (the admin confirms, control-api arbitrates — S-4).
    const block = getCatalogOAuthBlock(
      entryWithOAuth({
        provider: 'generic',
        scopes: ['openid'],
        genericConfig: {
          authorizationEndpoint: 'https://idp.example.com/authorize',
          tokenEndpoint: 'https://idp.example.com/token',
          tokenAuthMethod: 'basic',
          usePkce: false,
          // Unknown keys are dropped; a wrong-typed knob is ignored.
          bogus: 'nope',
          sendScope: 'yes-please',
        },
      })
    )
    expect(block?.genericConfig).toEqual({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      tokenAuthMethod: 'basic',
      usePkce: false,
    })
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

  it('surfaces a generic connector (source:generic, no provider) as non-null with knobs', () => {
    // T3: at b9a846a98 extractOAuthImmutables returned null for a generic CR (it required
    // a `provider`), so the edit view showed no immutables. It now returns a synthetic
    // `provider:'generic'` plus the read-only endpoints/knobs (D-B7).
    const result = extractOAuthImmutables({
      oauth: {
        source: 'generic',
        id: 'idp-abc',
        grantScope: 'user',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        tokenRequestFormat: 'form',
        tokenAuthMethod: 'body',
        scopeSeparator: 'space',
        sendScope: true,
        usePkce: true,
        includeResponseType: true,
        supportsRefresh: true,
      },
    })
    expect(result).not.toBeNull()
    expect(result?.provider).toBe('generic')
    expect(result?.id).toBe('idp-abc')
    expect(result?.grantScope).toBe('user')
    expect(result?.generic?.authorizationEndpoint).toBe('https://idp.example.com/authorize')
    expect(result?.generic?.clientMode).toBe('public')
  })

  it('marks a generic connector with client refs as a confidential client', () => {
    const result = extractOAuthImmutables({
      oauth: {
        source: 'generic',
        id: 'idp-abc',
        clientIdRef: { name: 'idp-abc-oauth-client', key: 'client_id' },
        clientSecretRef: { name: 'idp-abc-oauth-client', key: 'client_secret' },
      },
    })
    expect(result?.generic?.clientMode).toBe('confidential')
  })

  // The `spec.oauth` fixtures below are a PROJECTION of control-api's remote producer
  // `buildRemoteOAuthSpec` (control-api/src/routes/admin/remoteMcp.ts) — control-ui cannot
  // import that module across services, so field names/types are derived from that producer,
  // not from a re-imagined contract. This is a projection test, not a cross-service
  // contract test (same limitation recorded when the discovery tests were renamed, R1-M4).
  it('surfaces a remote connector (source:remote, no provider) as non-null with remote fields', () => {
    // T3: before this fix extractOAuthImmutables returned null for a remote CR (it required
    // a `provider`, which the remote producer omits by REMOTE-FORBID-PROVIDER), so the edit
    // view rendered a remote connector in the non-OAuth credentials panel. It now returns a
    // synthetic `provider:'remote'` plus the read-only remote fields (D-B7).
    const result = extractOAuthImmutables({
      oauth: {
        source: 'remote',
        id: 'client-abc',
        clientMode: 'public',
        grantScope: 'user',
        authorizationEndpoint: 'https://as.example.com/authorize',
        tokenEndpoint: 'https://as.example.com/token',
        issuer: 'https://as.example.com',
        resource: 'https://mcp.example.com',
        scopes: ['mcp.read'],
        bearerInBody: false,
        supportsRefresh: true,
      },
    })
    expect(result).not.toBeNull()
    expect(result?.provider).toBe('remote')
    expect(result?.id).toBe('client-abc')
    expect(result?.grantScope).toBe('user')
    expect(result?.remote).toEqual({
      clientMode: 'public',
      authorizationEndpoint: 'https://as.example.com/authorize',
      tokenEndpoint: 'https://as.example.com/token',
      registrationEndpoint: '',
      issuer: 'https://as.example.com',
      resource: 'https://mcp.example.com',
      issForCallback: '',
      bearerInBody: false,
      supportsRefresh: true,
      secretPosture: 'public',
    })
  })

  it('reads the remote pre-registered confidential posture and optional endpoints', () => {
    // Pre-registered confidential: paired client refs present ⇒ 'referenced'. Optional
    // registrationEndpoint/issForCallback are surfaced when the producer wrote them.
    const result = extractOAuthImmutables({
      oauth: {
        source: 'remote',
        id: 'client-conf',
        clientMode: 'confidential',
        authorizationEndpoint: 'https://as.example.com/authorize',
        tokenEndpoint: 'https://as.example.com/token',
        registrationEndpoint: 'https://as.example.com/register',
        issuer: 'https://as.example.com',
        resource: 'https://mcp.example.com',
        issForCallback: 'https://as.example.com',
        bearerInBody: true,
        supportsRefresh: false,
        clientIdRef: { name: 'client-conf-oauth-client', key: 'client_id' },
        clientSecretRef: { name: 'client-conf-oauth-client', key: 'client_secret' },
      },
    })
    expect(result?.remote?.secretPosture).toBe('referenced')
    expect(result?.remote?.registrationEndpoint).toBe('https://as.example.com/register')
    expect(result?.remote?.issForCallback).toBe('https://as.example.com')
    expect(result?.remote?.bearerInBody).toBe(true)
  })

  it('reads the remote DCR posture (confidential, no refs) as dynamic', () => {
    const result = extractOAuthImmutables({
      oauth: {
        source: 'remote',
        id: 'client-dcr',
        clientMode: 'confidential',
        authorizationEndpoint: 'https://as.example.com/authorize',
        tokenEndpoint: 'https://as.example.com/token',
        issuer: 'https://as.example.com',
        resource: 'https://mcp.example.com',
        bearerInBody: false,
        supportsRefresh: true,
      },
    })
    expect(result?.remote?.secretPosture).toBe('dynamic')
  })
})
