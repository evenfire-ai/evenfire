/**
 * Pure rules for remote-OAuth catalog connectors.
 *
 * Entry fixtures come from `registryEntryRow`, which mirrors the registry's
 * `createEntry` and its publish validation, and throws on what the registry would
 * reject. Shapes the registry rejects are built with `bad(...)` (`malformedRow`)
 * and test control-api's own defense. CR fixtures take
 * `spec.oauth` from the real producer chain (`discoverRemoteOAuth` →
 * `buildRemoteOAuthSpec`) and the catalog annotations from `catalogAnnotations`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type PushRemoteOAuthMeta,
  type RegistryPublisher,
  malformedRow,
  registryEntryRow,
} from '../../../../test/fixtures/registryEntryRow.js'
import { PILOTS, makeDiscoveryTransport } from '../../../../test/fixtures/remoteOAuthDiscovery.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../../oauth/discovery.js'
import {
  type CatalogEntryInput,
  type McpServerLike,
  REMOTE_OAUTH_PRESENTATION_KEYS,
  catalogInstanceIdentityChanges,
  deriveCatalogRemoteServerName,
  isCatalogRemoteOAuthInstance,
  isCuratorEntry,
  isRemoteOAuthEntry,
  normalizeRemoteBaseUrl,
  parseRemoteOAuthCatalogBlock,
  resolveRemoteOAuthEntry,
} from '../catalogRemoteOAuth.js'
import { catalogAnnotations, resolveHookTrustLevel } from '../registry.js'
import { buildRemoteOAuthSpec } from '../remoteMcp.js'

const CURATOR: RegistryPublisher = { kind: 'curator-machine' }
const ACME: RegistryPublisher = { kind: 'org-machine', org: 'acme' }

const GUIDE = '1. Open the console.\n2. Register an app with the redirect URI below.'
const CONSOLE = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps'

function oauthBlock(overrides: PushRemoteOAuthMeta = {}): PushRemoteOAuthMeta {
  return {
    source: 'remote',
    allowedGrantScopes: ['user', 'context'],
    expectedRegistration: 'dcr',
    ...overrides,
  }
}

function entry(
  oauth: PushRemoteOAuthMeta | undefined,
  opts: {
    name?: string
    publisher?: RegistryPublisher
    url?: string
    serverMode?: 'remote' | 'local'
    entryType?: 'mcp-server' | 'recipe'
    malformed?: boolean
  } = {}
): CatalogEntryInput {
  return (opts.malformed ? malformedRow : registryEntryRow)(
    {
      name: opts.name ?? '@evenfire/notion-remote',
      entryType: opts.entryType,
      mcpServer: {
        serverMode: opts.serverMode ?? 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: opts.url ?? 'https://mcp.notion.com/mcp' }],
        oauth,
      },
    },
    opts.publisher ?? CURATOR
  ) as unknown as CatalogEntryInput
}

/** A block the registry would reject at publish: exercises control-api's defense. */
function bad(oauth: PushRemoteOAuthMeta | undefined, opts: Parameters<typeof entry>[1] = {}) {
  return entry(oauth, { ...opts, malformed: true })
}

/** A real curator row with its name replaced by one the registry would never store. */
function curatorRowNamed(name: string): CatalogEntryInput {
  return { ...entry(oauthBlock(), { name: '@evenfire/notion-remote' }), name }
}

function oauthOf(e: CatalogEntryInput): Record<string, unknown> {
  return (e.mcp_server_meta as { oauth: Record<string, unknown> }).oauth
}

const preRegistered = (extra: PushRemoteOAuthMeta = {}) =>
  oauthBlock({ expectedRegistration: 'pre-registered', ...extra })

describe('isRemoteOAuthEntry', () => {
  it('is decided by oauth.source alone', () => {
    expect(isRemoteOAuthEntry(entry(oauthBlock()))).toBe(true)
    expect(isRemoteOAuthEntry(bad(oauthBlock({ provider: 'notion' })))).toBe(true)
    expect(isRemoteOAuthEntry(bad(oauthBlock(), { serverMode: 'local' }))).toBe(true)
    expect(isRemoteOAuthEntry(bad(oauthBlock({ source: 'generic' })))).toBe(false)
    expect(isRemoteOAuthEntry(entry(undefined))).toBe(false)
  })
})

describe('parseRemoteOAuthCatalogBlock (T-C3)', () => {
  it('accepts a minimal valid entry and returns the literal endpoint url', () => {
    const r = parseRemoteOAuthCatalogBlock(
      entry(oauthBlock(), { url: 'https://MCP.x.com:443/mcp/' }),
      {
        trusted: true,
      }
    )
    expect(r).toEqual({
      valid: true,
      url: 'https://MCP.x.com:443/mcp/',
      block: {
        source: 'remote',
        allowedGrantScopes: ['user', 'context'],
        expectedRegistration: 'dcr',
      },
    })
  })

  it.each([
    ['not an mcp-server', bad(oauthBlock(), { entryType: 'recipe' }), 'not_mcp_server'],
    ['local server', bad(oauthBlock(), { serverMode: 'local' }), 'not_remote_server'],
    ['no oauth block', entry(undefined), 'oauth_block_missing'],
    ['source other than remote', bad(oauthBlock({ source: 'generic' })), 'oauth_source_not_remote'],
    [
      'source remote AND provider',
      bad(oauthBlock({ provider: 'notion' })),
      'oauth_provider_not_allowed',
    ],
    [
      'http endpoint',
      bad(oauthBlock(), { url: 'http://mcp.x.com/mcp' }),
      'remote_endpoint_not_https',
    ],
    [
      'empty grant scopes',
      bad(oauthBlock({ allowedGrantScopes: [] })),
      'allowed_grant_scopes_invalid',
    ],
    [
      'grant scopes as a string',
      bad(oauthBlock({ allowedGrantScopes: 'user' })),
      'allowed_grant_scopes_invalid',
    ],
    [
      'unknown grant scope',
      bad(oauthBlock({ allowedGrantScopes: ['org'] })),
      'allowed_grant_scopes_invalid',
    ],
    [
      'duplicate grant scope',
      bad(oauthBlock({ allowedGrantScopes: ['user', 'user'] })),
      'allowed_grant_scopes_invalid',
    ],
    ['scopes not strings', bad(oauthBlock({ scopes: ['read', 7] })), 'scopes_invalid'],
    ['scopes as a string', bad(oauthBlock({ scopes: 'read' })), 'scopes_invalid'],
    [
      'hint not a string',
      bad(oauthBlock({ authorizationServerHint: 3 })),
      'authorization_server_hint_invalid',
    ],
    [
      'unknown registration',
      bad(oauthBlock({ expectedRegistration: 'manual' })),
      'expected_registration_invalid',
    ],
    [
      'unknown verification status',
      bad(oauthBlock({ verification: { status: 'ok' } })),
      'verification_invalid',
    ],
    [
      'known-issue without note',
      entry(oauthBlock({ verification: { status: 'known-issue' } })),
      'verification_note_required',
    ],
    [
      'guide over 4000 chars',
      bad(oauthBlock({ setupGuide: 'x'.repeat(4001) })),
      'setup_guide_too_long',
    ],
    [
      'console url not https',
      bad(oauthBlock({ providerConsoleUrl: 'http://console.x.com' })),
      'provider_console_url_not_https',
    ],
    [
      'console url javascript:',
      bad(oauthBlock({ providerConsoleUrl: 'javascript:alert(1)' })),
      'provider_console_url_not_https',
    ],
    [
      'console url https:\\\\host',
      bad(oauthBlock({ providerConsoleUrl: 'https:\\\\evil.example.com/x' })),
      'provider_console_url_not_https',
    ],
    [
      'console url https:host',
      bad(oauthBlock({ providerConsoleUrl: 'https:evil.example.com/x' })),
      'provider_console_url_not_https',
    ],
    [
      'console url https:///host',
      bad(oauthBlock({ providerConsoleUrl: 'https:///evil.example.com' })),
      'provider_console_url_not_https',
    ],
    [
      'console url with credentials',
      bad(oauthBlock({ providerConsoleUrl: 'https://u:p@console.x.com' })),
      'provider_console_url_not_https',
    ],
    [
      'console url with a backslash before the userinfo',
      bad(oauthBlock({ providerConsoleUrl: 'https://a.com\\@evil.com/' })),
      'provider_console_url_invalid',
    ],
    [
      'console url with an empty userinfo',
      bad(oauthBlock({ providerConsoleUrl: 'https://@host.com/' })),
      'provider_console_url_not_https',
    ],
    [
      'console url with a percent-encoded host',
      bad(oauthBlock({ providerConsoleUrl: 'https://%65vil.com/' })),
      'provider_console_url_invalid',
    ],
    [
      'console url that breaks out of an HTML attribute',
      bad(oauthBlock({ providerConsoleUrl: 'https://x.com/"><svg>' })),
      'provider_console_url_invalid',
    ],
    [
      'console url with interior space',
      bad(oauthBlock({ providerConsoleUrl: 'https://console.x.com/a b' })),
      'provider_console_url_invalid',
    ],
    [
      'console url with a tab',
      bad(oauthBlock({ providerConsoleUrl: 'https://console.x.com/\tx' })),
      'provider_console_url_invalid',
    ],
    [
      'console url with unicode host',
      bad(oauthBlock({ providerConsoleUrl: 'https://cоnsole.example.com' })),
      'provider_console_url_invalid',
    ],
    [
      'console url with zero-width char',
      bad(oauthBlock({ providerConsoleUrl: 'https://console\u200b.example.com' })),
      'provider_console_url_invalid',
    ],
    [
      'console url over 512 chars',
      bad(oauthBlock({ providerConsoleUrl: `https://c.example.com/${'a'.repeat(500)}` })),
      'provider_console_url_invalid',
    ],
    [
      'verification note over 500 chars',
      bad(oauthBlock({ verification: { status: 'untested', note: 'n'.repeat(501) } })),
      'verification_invalid',
    ],
    [
      'pre-registered without guide',
      entry(preRegistered({ providerConsoleUrl: CONSOLE })),
      'setup_guide_required',
    ],
    [
      'pre-registered without console',
      entry(preRegistered({ setupGuide: GUIDE })),
      'provider_console_url_required',
    ],
  ])('trusted: %s ⇒ invalid', (_label, e, reason) => {
    expect(parseRemoteOAuthCatalogBlock(e, { trusted: true })).toEqual({ valid: false, reason })
  })

  it('a console url of exactly 512 chars and a note of exactly 500 are accepted', () => {
    const url = `https://c.example.com/${'a'.repeat(512 - 'https://c.example.com/'.length)}`
    expect(url.length).toBe(512)
    const e = entry(
      oauthBlock({
        providerConsoleUrl: url,
        verification: { status: 'untested', note: 'n'.repeat(500) },
      })
    )
    expect(parseRemoteOAuthCatalogBlock(e, { trusted: true }).valid).toBe(true)
  })

  it('a console url with "@" and "%" outside the authority is accepted verbatim', () => {
    const url = 'https://console.example.com/u/@me?q=%7B#x'
    const r = parseRemoteOAuthCatalogBlock(entry(oauthBlock({ providerConsoleUrl: url })), {
      trusted: true,
    })
    expect(r.valid && r.block.providerConsoleUrl).toBe(url)
  })

  it('a guide of exactly 4000 chars is accepted', () => {
    const e = entry(preRegistered({ setupGuide: 'x'.repeat(4000), providerConsoleUrl: CONSOLE }))
    expect(parseRemoteOAuthCatalogBlock(e, { trusted: true }).valid).toBe(true)
  })

  it('known-issue with a note, and a console url with a fragment, are valid', () => {
    const e = entry(
      preRegistered({
        setupGuide: GUIDE,
        providerConsoleUrl: CONSOLE,
        verification: {
          status: 'known-issue',
          note: 'refresh fails after 24h',
          checkedAt: '2026-10-28',
        },
      })
    )
    const r = parseRemoteOAuthCatalogBlock(e, { trusted: true })
    expect(r.valid && r.block.verification).toEqual({
      status: 'known-issue',
      note: 'refresh fails after 24h',
      checkedAt: '2026-10-28',
    })
  })

  it('untrusted pre-registered without guide or console is VALID', () => {
    const r = parseRemoteOAuthCatalogBlock(
      entry(preRegistered(), { name: '@acme/notion', publisher: ACME }),
      {
        trusted: false,
      }
    )
    expect(r.valid).toBe(true)
  })

  it('untrusted still rejects the rules that do not depend on provenance', () => {
    const e = bad(oauthBlock({ provider: 'notion' }), { name: '@acme/notion', publisher: ACME })
    expect(parseRemoteOAuthCatalogBlock(e, { trusted: false })).toEqual({
      valid: false,
      reason: 'oauth_provider_not_allowed',
    })
  })
})

describe('isCuratorEntry (T-C5, pure part)', () => {
  it('unscoped name published by the curator (lands in @clerum) ⇒ curator', () => {
    expect(isCuratorEntry(entry(oauthBlock(), { name: 'notion-remote', publisher: CURATOR }))).toBe(
      true
    )
  })

  it.each(['@clerum/notion-remote', '@evenfire/notion-remote'])('%s ⇒ curator', name => {
    expect(isCuratorEntry(entry(oauthBlock(), { name, publisher: CURATOR }))).toBe(true)
  })

  it('another org scope ⇒ org', () => {
    expect(isCuratorEntry(entry(oauthBlock(), { name: '@acme/notion', publisher: ACME }))).toBe(
      false
    )
  })

  it('the demoted control-api scope @evenfire-dev ⇒ org', () => {
    const publisher: RegistryPublisher = { kind: 'org-machine', org: 'evenfire-dev' }
    expect(isCuratorEntry(entry(oauthBlock(), { name: '@evenfire-dev/notion', publisher }))).toBe(
      false
    )
  })

  it('owner_type user ⇒ org', () => {
    const publisher: RegistryPublisher = { kind: 'user', username: 'diego' }
    expect(isCuratorEntry(entry(oauthBlock(), { name: '@diego/notion', publisher }))).toBe(false)
  })

  it('no owner (legacy row), even unscoped or reserved-scoped ⇒ org', () => {
    const legacy: RegistryPublisher = { kind: 'legacy-null-owner' }
    expect(isCuratorEntry(entry(oauthBlock(), { name: 'notion-remote', publisher: legacy }))).toBe(
      false
    )
    expect(
      isCuratorEntry(entry(oauthBlock(), { name: '@evenfire/notion', publisher: legacy }))
    ).toBe(false)
  })

  it('owner fields missing entirely ⇒ org', () => {
    const e = { ...entry(oauthBlock(), { name: 'notion-remote' }) } as Record<string, unknown>
    delete e.owner_type
    delete e.owner_id
    expect(isCuratorEntry(e as unknown as CatalogEntryInput)).toBe(false)
  })

  // createEntry never stores these two shapes today (owner_type and owner_id are
  // stamped together, and a user cannot publish unscoped or under a reserved
  // scope). They are corrupted copies of a real curator row, so each half of the
  // owner check is shown to fail closed on its own if the registry ever changes.
  it('hardening: owner_type user on an otherwise curator row ⇒ org', () => {
    const row = { ...entry(oauthBlock(), { name: '@evenfire/notion-remote' }), owner_type: 'user' }
    expect(isCuratorEntry(row)).toBe(false)
  })

  it.each([null, ''])('hardening: owner_type org with owner_id %j ⇒ org', ownerId => {
    const row = { ...entry(oauthBlock(), { name: '@evenfire/notion-remote' }), owner_id: ownerId }
    expect(isCuratorEntry(row)).toBe(false)
  })

  // The registry's name grammar refuses these, so a real row never carries them;
  // each is a curator row with only the name corrupted.
  it.each([
    ' @acme/x',
    '\u200b@acme/x',
    'acme/x',
    '@evenfire/../x',
    '@clerum//x',
    ' notion-remote',
    'Notion-remote',
    '@evenfire/x',
  ])('name %j that the registry grammar refuses ⇒ org', name => {
    expect(isCuratorEntry(curatorRowNamed(name))).toBe(false)
  })

  it('the fixture refuses rows the registry would never store', () => {
    expect(() => entry(oauthBlock(), { name: '@evenfire/x-remote', publisher: ACME })).toThrow(
      /scope_reserved/
    )
    expect(() => entry(oauthBlock(), { name: 'notion-remote', publisher: ACME })).toThrow(
      /scope_required/
    )
    expect(() => entry(oauthBlock(), { name: '@acme/notion', publisher: CURATOR })).toThrow(
      /scope_not_bound/
    )
    expect(() => entry(oauthBlock(), { name: '@nobody/notion', publisher: CURATOR })).toThrow(
      /scope_not_found/
    )
    const outsider: RegistryPublisher = { kind: 'user', username: 'acme' }
    expect(() => entry(oauthBlock(), { name: '@acme/notion', publisher: outsider })).toThrow(
      /not_an_org_member/
    )
    for (const url of [
      'https://a.com\\@evil.com/',
      'https://@host.com/',
      'https://%65vil.com/',
      'https://x.com/"><svg>',
    ]) {
      expect(() => entry(oauthBlock({ providerConsoleUrl: url })), url).toThrow(
        /oauth\.providerConsoleUrl/
      )
    }
    expect(() => entry(oauthBlock(), { entryType: 'recipe' })).toThrow(
      /only valid for entryType 'mcp-server'/
    )
    expect(() => entry(oauthBlock({ provider: 'notion' }))).toThrow(/Unsupported field/)
    expect(() => entry(oauthBlock(), { serverMode: 'local' })).toThrow(/serverMode=remote/)
    expect(() => entry(oauthBlock({ expectedRegistration: 'manual' }))).toThrow(
      /expectedRegistration/
    )
  })
})

describe('resolveRemoteOAuthEntry', () => {
  const fullBlock = preRegistered({
    setupGuide: GUIDE,
    providerConsoleUrl: CONSOLE,
    verification: { status: 'verified', checkedAt: '2026-10-28' },
  })

  it('returns a non remote-OAuth entry as the same reference', () => {
    const e = entry(undefined)
    expect(resolveRemoteOAuthEntry(e)).toBe(e)
  })

  it('curator entry arrives intact, valid, without publisher', () => {
    const e = entry(fullBlock)
    const r = resolveRemoteOAuthEntry(e)
    expect(r).toMatchObject({ remoteOAuth: { valid: true } })
    expect(oauthOf(r)).toEqual(oauthOf(e))
    expect('publisher' in r).toBe(false)
  })

  it('org entry loses presentation metadata, gains publisher, and stays valid', () => {
    const e = entry(fullBlock, { name: '@acme/notion', publisher: ACME })
    const r = resolveRemoteOAuthEntry(e)
    expect(r).toMatchObject({ remoteOAuth: { valid: true }, publisher: '@acme' })
    for (const key of REMOTE_OAUTH_PRESENTATION_KEYS) expect(oauthOf(r)).not.toHaveProperty(key)
    expect(oauthOf(r)).toEqual({
      source: 'remote',
      allowedGrantScopes: ['user', 'context'],
      expectedRegistration: 'pre-registered',
    })
  })

  it('legacy unscoped entry with no owner is treated as org, publisher null', () => {
    const e = entry(fullBlock, { name: 'notion-remote', publisher: { kind: 'legacy-null-owner' } })
    const r = resolveRemoteOAuthEntry(e)
    expect(r).toMatchObject({ remoteOAuth: { valid: true }, publisher: null })
    expect(oauthOf(r)).not.toHaveProperty('verification')
  })

  it('curator entry with an invalid block loses presentation metadata', () => {
    const e = entry(
      preRegistered({ providerConsoleUrl: CONSOLE, verification: { status: 'verified' } })
    )
    const r = resolveRemoteOAuthEntry(e)
    expect(r).toMatchObject({ remoteOAuth: { valid: false, reason: 'setup_guide_required' } })
    expect(oauthOf(r)).toEqual({ source: 'remote' })
  })

  it('an invalid verdict survives a second pass even when stripping removed its cause', () => {
    const e = entry(oauthBlock({ verification: { status: 'known-issue' } }))
    const once = resolveRemoteOAuthEntry(e)
    expect(once).toMatchObject({
      remoteOAuth: { valid: false, reason: 'verification_note_required' },
    })
    expect(resolveRemoteOAuthEntry(once)).toEqual(once)
  })

  it('a valid:true already on the input is never trusted', () => {
    const e = { ...bad(oauthBlock({ provider: 'x' })), remoteOAuth: { valid: true } }
    expect(resolveRemoteOAuthEntry(e)).toMatchObject({
      remoteOAuth: { valid: false, reason: 'oauth_provider_not_allowed' },
    })
  })

  it.each([CURATOR, ACME])('near-miss and prototype keys never survive (%j)', publisher => {
    const raw = JSON.parse(
      '{"source":"remote","allowedGrantScopes":["user"],"expectedRegistration":"dcr",' +
        '"SetupGuide":"x","setup_guide":"x","__proto__":{"polluted":true}}'
    )
    const name = publisher === CURATOR ? '@evenfire/notion-remote' : '@acme/notion'
    const r = resolveRemoteOAuthEntry(bad(raw, { name, publisher }))
    const oauth = oauthOf(r)
    expect(r).toMatchObject({ remoteOAuth: { valid: true } })
    expect(Object.keys(oauth).sort()).toEqual([
      'allowedGrantScopes',
      'expectedRegistration',
      'source',
    ])
    expect(Object.prototype.hasOwnProperty.call(oauth, '__proto__')).toBe(false)
    expect((oauth as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('a malformed reserved-looking name is never presented as published by that scope', () => {
    const r = resolveRemoteOAuthEntry(curatorRowNamed('@evenfire/../x'))
    expect(r).toMatchObject({ publisher: null })
  })

  it('an invalid block is reduced to { source }, unknown keys included', () => {
    const raw = { ...oauthBlock({ provider: 'notion' }), extra: 'x', setupGuide: GUIDE }
    expect(oauthOf(resolveRemoteOAuthEntry(bad(raw)))).toEqual({ source: 'remote' })
  })

  it('does not mutate its input', () => {
    const e = entry(fullBlock, { name: '@acme/notion', publisher: ACME })
    const snapshot = structuredClone(e)
    resolveRemoteOAuthEntry(e)
    expect(e).toEqual(snapshot)
  })
})

describe('resolveRemoteOAuthEntry properties', () => {
  const publisherArb: fc.Arbitrary<{ name: string; publisher: RegistryPublisher }> = fc.oneof(
    fc.constant({ name: 'notion-remote', publisher: CURATOR }),
    fc.constant({ name: '@evenfire/notion-remote', publisher: CURATOR }),
    fc.constant({ name: '@clerum/notion-remote', publisher: CURATOR }),
    fc.constant({ name: '@acme/notion', publisher: ACME }),
    fc.constant({
      name: '@diego/notion',
      publisher: { kind: 'user', username: 'diego' } as RegistryPublisher,
    }),
    fc.constant({
      name: 'notion-remote',
      publisher: { kind: 'legacy-null-owner' } as RegistryPublisher,
    }),
    fc.constant({
      name: '@evenfire/notion',
      publisher: { kind: 'legacy-null-owner' } as RegistryPublisher,
    })
  )
  const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })
  const oauthArb: fc.Arbitrary<PushRemoteOAuthMeta> = fc.record(
    {
      source: fc.constantFrom('remote', 'generic'),
      allowedGrantScopes: fc.oneof(
        fc.subarray(['user', 'context']),
        fc.constant('user'),
        fc.constant(['user', 'user'])
      ),
      scopes: maybe(fc.array(fc.string(), { maxLength: 3 })),
      expectedRegistration: fc.constantFrom('cimd', 'dcr', 'pre-registered', 'bogus'),
      providerConsoleUrl: maybe(fc.constantFrom(CONSOLE, 'http://console.x.com')),
      setupGuide: maybe(fc.constantFrom(GUIDE, 'x'.repeat(4001))),
      verification: maybe(
        fc.record({
          status: fc.constantFrom('verified', 'untested', 'known-issue', 'nope'),
          note: maybe(fc.constantFrom('note', '')),
        })
      ),
      provider: maybe(fc.constant('notion')),
      SetupGuide: maybe(fc.constant('near-miss')),
    },
    { requiredKeys: ['source', 'allowedGrantScopes', 'expectedRegistration'] }
  )
  const entryArb = fc
    .tuple(publisherArb, oauthArb)
    // Mixes shapes the registry accepts and rejects, so it goes through malformedRow.
    .map(([p, oauth]) => bad(JSON.parse(JSON.stringify(oauth)), p))

  it('is idempotent', () => {
    fc.assert(
      fc.property(entryArb, e => {
        const once = resolveRemoteOAuthEntry(e)
        expect(resolveRemoteOAuthEntry(once)).toEqual(once)
      }),
      { numRuns: 2000 }
    )
  })

  it('never leaves presentation metadata on a non-curator or invalid entry', () => {
    fc.assert(
      fc.property(entryArb, e => {
        const r = resolveRemoteOAuthEntry(e) as CatalogEntryInput & {
          remoteOAuth?: { valid: boolean }
        }
        if (!isRemoteOAuthEntry(e)) return
        expect(oauthOf(r)).not.toHaveProperty('SetupGuide')
        expect(oauthOf(r)).not.toHaveProperty('provider')
        if (isCuratorEntry(e) && r.remoteOAuth?.valid) return
        for (const key of REMOTE_OAUTH_PRESENTATION_KEYS) expect(oauthOf(r)).not.toHaveProperty(key)
      }),
      { numRuns: 2000 }
    )
  })
})

describe('deriveCatalogRemoteServerName', () => {
  const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  const scopeArb = fc.constantFrom('user' as const, 'context' as const)
  const catalogIdArb = fc.oneof(
    fc.string({ maxLength: 120 }),
    fc
      .tuple(
        fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,62}$/),
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,62}$/)
      )
      .map(([org, name]) => `@${org}/${name}`)
  )

  it('golden names (a change here renames every installed slot)', () => {
    expect(deriveCatalogRemoteServerName('@evenfire/notion-remote', 'user')).toBe(
      'mcp-evenfire-notion-remote-u-51704373'
    )
    expect(deriveCatalogRemoteServerName('@evenfire/notion-remote', 'context')).toBe(
      'mcp-evenfire-notion-remote-c-65156605'
    )
  })

  it('matches the documented formula', () => {
    expect(deriveCatalogRemoteServerName('@evenfire/notion-remote', 'user')).toMatch(
      /^mcp-evenfire-notion-remote-u-[0-9a-f]{8}$/
    )
    expect(deriveCatalogRemoteServerName('@evenfire/notion-remote', 'context')).toMatch(
      /^mcp-evenfire-notion-remote-c-[0-9a-f]{8}$/
    )
  })

  it('keeps the hash when the catalog id is longer than the name budget', () => {
    const id = `@evenfire/${'a'.repeat(62)}`
    const name = deriveCatalogRemoteServerName(id, 'user')
    expect(name).toMatch(/-u-[0-9a-f]{8}$/)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('distinguishes names the slug collapses', () => {
    expect(deriveCatalogRemoteServerName('@acme/x-y', 'user')).not.toBe(
      deriveCatalogRemoteServerName('acme-x-y', 'user')
    )
  })

  it('is RFC 1123, at most 63 chars and deterministic', () => {
    fc.assert(
      fc.property(catalogIdArb, scopeArb, (id, scope) => {
        const name = deriveCatalogRemoteServerName(id, scope)
        expect(name.length).toBeLessThanOrEqual(63)
        expect(name).toMatch(RFC1123)
        expect(name).toMatch(/-[uc]-[0-9a-f]{8}$/)
        expect(deriveCatalogRemoteServerName(id, scope)).toBe(name)
      }),
      { numRuns: 5000 }
    )
  })

  it('is injective over (catalogId, scope)', () => {
    fc.assert(
      fc.property(catalogIdArb, scopeArb, catalogIdArb, scopeArb, (a, sa, b, sb) => {
        fc.pre(a !== b || sa !== sb)
        expect(deriveCatalogRemoteServerName(a, sa)).not.toBe(deriveCatalogRemoteServerName(b, sb))
      }),
      { numRuns: 5000 }
    )
  })

  it('rejects a grant scope outside the union', () => {
    expect(() => deriveCatalogRemoteServerName('x', 'org' as never)).toThrow(/invalid grant scope/)
  })
})

describe('normalizeRemoteBaseUrl', () => {
  it.each([
    ['https://MCP.Example.com/mcp/', 'https://mcp.example.com/mcp'],
    ['HTTPS://mcp.example.com:443/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com:8443/mcp//', 'https://mcp.example.com:8443/mcp'],
    ['https://mcp.example.com/', 'https://mcp.example.com'],
    ['https://mcp.example.com', 'https://mcp.example.com'],
    ['https://mcp.example.com/Mcp', 'https://mcp.example.com/Mcp'],
  ])('%s ⇒ %s', (input, expected) => {
    expect(normalizeRemoteBaseUrl(input)).toBe(expected)
  })

  it('returns null for something that is not a URL', () => {
    expect(normalizeRemoteBaseUrl('not a url')).toBeNull()
  })

  it.each([
    'https://user@mcp.example.com/mcp',
    'https://user:pw@mcp.example.com/mcp',
    'https://:pw@mcp.example.com/',
  ])('returns null for a URL with credentials: %s', url => {
    expect(normalizeRemoteBaseUrl(url)).toBeNull()
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), url => {
        const once = normalizeRemoteBaseUrl(url)
        expect(once).not.toBeNull()
        expect(normalizeRemoteBaseUrl(once as string)).toBe(once)
      }),
      { numRuns: 3000 }
    )
  })
})

describe('catalog instance identity', () => {
  let discovery: DiscoveryResult

  beforeAll(async () => {
    const pilot = PILOTS.notion
    const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
      transport: makeDiscoveryTransport(pilot),
      resolveDns: async () => ['93.184.216.34'],
    })
    if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
    discovery = outcome.result
  })

  /**
   * `spec.oauth` from the real builder; the surrounding spec mirrors the inline
   * object the install saga writes (remoteMcp.ts, `mcpServerSpec`), which is not
   * exported as a builder.
   */
  function catalogCr(): McpServerLike & { metadata: { annotations: Record<string, string> } } {
    const baseUrl = PILOTS.notion.mcpUrl
    const serverName = deriveCatalogRemoteServerName('@evenfire/notion-remote', 'user')
    return {
      metadata: {
        name: serverName,
        uid: 'uid-a',
        annotations: {
          ...catalogAnnotations('@evenfire/notion-remote', '1.0.0'),
          'team/owner': 'x',
        },
      } as McpServerLike['metadata'] & { annotations: Record<string, string> },
      spec: {
        enabled: true,
        managed: true,
        transport: {
          type: 'streamableHttp',
          port: 8080,
          url: `http://${serverName}.mcp.svc.cluster.local:8080/mcp`,
        },
        remote: { baseUrl },
        auth: { type: 'oauth' },
        oauth: buildRemoteOAuthSpec(discovery, {
          clientMode: 'public',
          grantScope: 'user',
          cimdClientId: 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client',
        }),
        egressBindings: [
          { egressClass: 'exact-host', dns: new URL(baseUrl).hostname, port: 443, protocol: 'TCP' },
        ],
      },
    }
  }

  function withSpec(cr: McpServerLike, patch: (spec: Record<string, any>) => void): McpServerLike {
    const next = structuredClone(cr)
    patch(next.spec as Record<string, any>)
    return next
  }

  it('isCatalogRemoteOAuthInstance needs the catalog-id annotation and source remote', () => {
    const cr = catalogCr()
    expect(isCatalogRemoteOAuthInstance(cr)).toBe(true)
    expect(isCatalogRemoteOAuthInstance({ ...cr, metadata: { annotations: {} } })).toBe(false)
    expect(isCatalogRemoteOAuthInstance(withSpec(cr, s => (s.oauth.source = 'generic')))).toBe(
      false
    )
    expect(isCatalogRemoteOAuthInstance(withSpec(cr, s => delete s.oauth))).toBe(false)
  })

  it('an unchanged replace has no identity changes', () => {
    const cr = catalogCr()
    expect(catalogInstanceIdentityChanges(cr, structuredClone(cr))).toEqual([])
  })

  it.each([
    ['spec.remote.baseUrl', (s: any) => (s.remote.baseUrl = 'https://evil.example.com/mcp')],
    [
      'spec.transport.url',
      (s: any) => (s.transport.url = 'http://other.mcp.svc.cluster.local:8080/mcp'),
    ],
    ['spec.oauth.source', (s: any) => (s.oauth.source = 'generic')],
    ['spec.oauth.grantScope', (s: any) => (s.oauth.grantScope = 'context')],
    ['spec.oauth.id', (s: any) => (s.oauth.id = 'another-client')],
    [
      'spec.oauth.authorizationEndpoint',
      (s: any) => (s.oauth.authorizationEndpoint = 'https://e/auth'),
    ],
    ['spec.oauth.tokenEndpoint', (s: any) => (s.oauth.tokenEndpoint = 'https://e/token')],
    [
      'spec.oauth.registrationEndpoint',
      (s: any) => (s.oauth.registrationEndpoint = 'https://e/reg'),
    ],
    ['spec.oauth.resource', (s: any) => (s.oauth.resource = 'https://e/mcp')],
  ])('detects a change to %s', (field, patch) => {
    const cr = catalogCr()
    expect(catalogInstanceIdentityChanges(cr, withSpec(cr, patch))).toEqual([field])
  })

  it('dropping spec.oauth counts as changing every oauth identity field it had', () => {
    const cr = catalogCr()
    const changes = catalogInstanceIdentityChanges(
      cr,
      withSpec(cr, s => delete s.oauth)
    )
    expect(changes).toEqual(
      expect.arrayContaining(['spec.oauth.source', 'spec.oauth.grantScope', 'spec.oauth.resource'])
    )
  })

  it('scopes and egressBindings are not identity', () => {
    const cr = catalogCr()
    const next = withSpec(cr, s => {
      s.oauth.scopes = ['read', 'write', 'admin']
      s.egressBindings = [...s.egressBindings, { egressClass: 'public-web' }]
    })
    expect(catalogInstanceIdentityChanges(cr, next)).toEqual([])
  })

  it('a body without the annotation map keeps the catalog annotations', () => {
    const cr = catalogCr()
    const next = structuredClone(cr) as McpServerLike
    next.metadata = {}
    expect(catalogInstanceIdentityChanges(cr, next)).toEqual([])
  })

  it('a map that omits the catalog keys keeps them (the replace re-adds platform keys)', () => {
    const cr = catalogCr()
    const next = structuredClone(cr) as McpServerLike
    next.metadata = { annotations: { 'team/owner': 'y' } }
    expect(catalogInstanceIdentityChanges(cr, next)).toEqual([])
  })

  it('a map that sets a catalog key to another value (including empty) is a change', () => {
    const cr = catalogCr()
    const retag = structuredClone(cr) as McpServerLike
    retag.metadata = { annotations: { ...cr.metadata.annotations, 'clerum.io/catalog-id': '' } }
    expect(catalogInstanceIdentityChanges(cr, retag)).toEqual([
      'metadata.annotations.clerum.io/catalog-id',
    ])
    const bump = structuredClone(cr) as McpServerLike
    bump.metadata = {
      annotations: { ...cr.metadata.annotations, 'clerum.io/catalog-version': '2.0.0' },
    }
    expect(catalogInstanceIdentityChanges(cr, bump)).toEqual([
      'metadata.annotations.clerum.io/catalog-version',
    ])
  })
})

describe('shared official scopes (hook trust unchanged)', () => {
  it('official evenfire scopes stay curated for hooks', () => {
    expect(resolveHookTrustLevel({ name: '@clerum/x', trust_level: 'high' }, null)).toBe('high')
    expect(resolveHookTrustLevel({ name: '@evenfire/x', trust_level: 'high' }, null)).toBe('high')
    expect(resolveHookTrustLevel({ name: '@evenfire-dev/x', trust_level: 'high' }, null)).toBe(
      'mid'
    )
  })
})
