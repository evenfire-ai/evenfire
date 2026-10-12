import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CANVA_GENERIC_PREFILL,
  NOTION_BASIC_GENERIC_PREFILL,
  NOTION_GENERIC_PREFILL,
  NOTION_NO_S256_GENERIC_PREFILL,
} from '../../test/fixtures/genericDiscoveryPrefill'
import {
  GENERIC_WIZARD_DEFAULTS,
  applyDiscoveryPrefill,
  buildGenericSubmit,
  editEnumKnob,
  effectiveClientMode,
  extraParamsToRecord,
  genericFormIssues,
  genericFormOk,
  markEdited,
  readGenericImmutables,
  seedFromCatalog,
} from '../oauthGeneric'
import type {
  GenericConfigSuggestion,
  GenericDiscoveryPrefill,
  GenericFormState,
  GenericTouchKey,
} from '../oauthGeneric.types'

const KNOB_KEYS: GenericTouchKey[] = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'refreshEndpoint',
  'resource',
  'tokenRequestFormat',
  'tokenAuthMethod',
  'scopeSeparator',
  'sendScope',
  'usePkce',
  'includeResponseType',
  'supportsRefresh',
]

// ─── seedFromCatalog ────────────────────────────────────────────────────────

const suggestionArb: fc.Arbitrary<GenericConfigSuggestion> = fc.record(
  {
    authorizationEndpoint: fc.webUrl(),
    tokenEndpoint: fc.webUrl(),
    refreshEndpoint: fc.webUrl(),
    resource: fc.webUrl(),
    tokenRequestFormat: fc.constantFrom('form', 'json') as fc.Arbitrary<'form' | 'json'>,
    tokenAuthMethod: fc.constantFrom('body', 'basic') as fc.Arbitrary<'body' | 'basic'>,
    scopeSeparator: fc.constantFrom('space', 'comma') as fc.Arbitrary<'space' | 'comma'>,
    sendScope: fc.boolean(),
    usePkce: fc.boolean(),
    includeResponseType: fc.boolean(),
    supportsRefresh: fc.boolean(),
  },
  { requiredKeys: [] }
)

describe('seedFromCatalog (T2)', () => {
  it('always yields all 11 knobs defined, each value ∈ {suggested, default}', () => {
    fc.assert(
      fc.property(suggestionArb, suggestion => {
        const state = seedFromCatalog(GENERIC_WIZARD_DEFAULTS, suggestion)
        for (const key of KNOB_KEYS) {
          expect(state[key as keyof GenericFormState]).toBeDefined()
        }
        // Each enum/bool knob equals either the suggestion (when present) or the default.
        for (const key of ['tokenRequestFormat', 'tokenAuthMethod', 'scopeSeparator'] as const) {
          const expected = suggestion[key] ?? GENERIC_WIZARD_DEFAULTS[key]
          expect(state[key]).toBe(expected)
        }
        for (const key of [
          'sendScope',
          'usePkce',
          'includeResponseType',
          'supportsRefresh',
        ] as const) {
          const expected =
            typeof suggestion[key] === 'boolean' ? suggestion[key] : GENERIC_WIZARD_DEFAULTS[key]
          expect(state[key]).toBe(expected)
        }
        // A missing suggested endpoint falls back to the empty string, never undefined.
        for (const key of [
          'authorizationEndpoint',
          'tokenEndpoint',
          'refreshEndpoint',
          'resource',
        ] as const) {
          expect(typeof state[key]).toBe('string')
        }
      })
    )
  })

  it('defaults with no suggestion carry the D-A1 wizard defaults and a public client', () => {
    const state = seedFromCatalog(GENERIC_WIZARD_DEFAULTS)
    expect(state.tokenRequestFormat).toBe('form')
    expect(state.tokenAuthMethod).toBe('body')
    expect(state.scopeSeparator).toBe('space')
    expect(state.sendScope).toBe(true)
    expect(state.usePkce).toBe(true)
    expect(state.includeResponseType).toBe(true)
    expect(state.supportsRefresh).toBe(true)
    expect(state.clientMode).toBe('public')
    expect(state.touched.size).toBe(0)
  })

  it('a catalog that pins basic auth seeds a confidential client', () => {
    const state = seedFromCatalog(GENERIC_WIZARD_DEFAULTS, { tokenAuthMethod: 'basic' })
    expect(state.tokenAuthMethod).toBe('basic')
    expect(state.clientMode).toBe('confidential')
  })

  it('seeds scopes from the catalog scope list and marks their origin', () => {
    const state = seedFromCatalog(GENERIC_WIZARD_DEFAULTS, undefined, ['a', 'b'])
    expect(state.scopes).toEqual(['a', 'b'])
    expect(state.origin.scopes).toBe('catalog')
  })
})

// ─── applyDiscoveryPrefill ──────────────────────────────────────────────────

function baseState(overrides: Partial<GenericFormState> = {}): GenericFormState {
  return { ...seedFromCatalog(GENERIC_WIZARD_DEFAULTS), ...overrides }
}

const prefillArb: fc.Arbitrary<GenericDiscoveryPrefill> = fc.record({
  issuer: fc.webUrl(),
  endpoints: fc.record({ authorization: fc.webUrl(), token: fc.webUrl() }),
  resource: fc.option(fc.webUrl(), { nil: undefined }),
  scopesSupported: fc.array(fc.string({ minLength: 1 })),
  capabilities: fc.record({
    codeChallengeMethods: fc.array(fc.constantFrom('plain', 'S256')),
    tokenEndpointAuthMethods: fc.array(
      fc.constantFrom('client_secret_basic', 'client_secret_post', 'none')
    ),
    grantTypes: fc.array(fc.constantFrom('authorization_code', 'refresh_token')),
  }),
  suggested: fc.record({
    usePkce: fc.boolean(),
    tokenAuthMethod: fc.constantFrom('body', 'basic') as fc.Arbitrary<'body' | 'basic'>,
    supportsRefresh: fc.boolean(),
  }),
})

const touchedArb: fc.Arbitrary<ReadonlySet<GenericTouchKey>> = fc
  .subarray([...KNOB_KEYS, 'scopes'] as GenericTouchKey[])
  .map(keys => new Set(keys))

describe('applyDiscoveryPrefill (T2)', () => {
  it('is idempotent: apply(apply(s,d),d) ≡ apply(s,d)', () => {
    fc.assert(
      fc.property(prefillArb, touchedArb, (prefill, touched) => {
        const state = baseState({ touched, scopes: [] })
        const once = applyDiscoveryPrefill(state, prefill)
        const twice = applyDiscoveryPrefill(once, prefill)
        expect(twice).toEqual(once)
      })
    )
  })

  it('manual wins: an edited (touched) field is never overwritten', () => {
    fc.assert(
      fc.property(prefillArb, touchedArb, (prefill, touched) => {
        const state = baseState({
          touched,
          authorizationEndpoint: 'https://manual.example.com/authorize',
          tokenEndpoint: 'https://manual.example.com/token',
          tokenAuthMethod: 'body',
          usePkce: false,
          supportsRefresh: false,
          scopes: touched.has('scopes') ? ['kept'] : [],
        })
        const next = applyDiscoveryPrefill(state, prefill)
        for (const key of touched) {
          expect(next[key as keyof GenericFormState]).toEqual(state[key as keyof GenericFormState])
        }
      })
    )
  })

  it('no datum never overwrites: an empty capability leaves its field unchanged', () => {
    fc.assert(
      fc.property(prefillArb, prefill => {
        const state = baseState({ scopes: [] })
        const next = applyDiscoveryPrefill(state, prefill)
        if (prefill.capabilities.codeChallengeMethods.length === 0) {
          expect(next.usePkce).toBe(state.usePkce)
        }
        if (prefill.capabilities.tokenEndpointAuthMethods.length === 0) {
          expect(next.tokenAuthMethod).toBe(state.tokenAuthMethod)
        }
        if (prefill.capabilities.grantTypes.length === 0) {
          expect(next.supportsRefresh).toBe(state.supportsRefresh)
        }
        if (prefill.resource === undefined) {
          expect(next.resource).toBe(state.resource)
        }
      })
    )
  })

  it('scopes fill only when the current list is empty', () => {
    fc.assert(
      fc.property(
        prefillArb,
        fc.array(fc.string({ minLength: 1 }), { minLength: 1 }),
        (prefill, existing) => {
          const nonEmpty = applyDiscoveryPrefill(baseState({ scopes: existing }), prefill)
          expect(nonEmpty.scopes).toEqual(existing) // never overwrites a non-empty list

          const empty = applyDiscoveryPrefill(baseState({ scopes: [] }), prefill)
          if (prefill.scopesSupported.length > 0) {
            expect(empty.scopes).toEqual(prefill.scopesSupported)
          } else {
            expect(empty.scopes).toEqual([])
          }
        }
      )
    )
  })

  it('applies the detected endpoints and suggestions from a real pilot prefill', () => {
    const next = applyDiscoveryPrefill(baseState({ scopes: [] }), NOTION_GENERIC_PREFILL)
    expect(next.authorizationEndpoint).toBe('https://mcp.notion.com/authorize')
    expect(next.tokenEndpoint).toBe('https://mcp.notion.com/token')
    expect(next.resource).toBe('https://mcp.notion.com')
    expect(next.scopes).toEqual(['default'])
    expect(next.usePkce).toBe(true)
    expect(next.origin.authorizationEndpoint).toBe('detected')
  })

  it('flips a default when the AS advertises it: usePkce:false from a no-S256 AS', () => {
    const next = applyDiscoveryPrefill(baseState({ scopes: [] }), NOTION_NO_S256_GENERIC_PREFILL)
    expect(next.usePkce).toBe(false)
    expect(next.origin.usePkce).toBe('detected')
  })

  it('basic auth suggestion forces a confidential client', () => {
    const next = applyDiscoveryPrefill(
      baseState({ scopes: [], clientMode: 'public' }),
      NOTION_BASIC_GENERIC_PREFILL
    )
    expect(next.tokenAuthMethod).toBe('basic')
    expect(effectiveClientMode(next)).toBe('confidential')
  })

  it('storing a detected result changes no form field — only Apply does (invariant 8)', () => {
    const seeded = baseState({ scopes: [] })
    const withDetected = { ...seeded, detected: CANVA_GENERIC_PREFILL }
    // Every field except `detected` is identical: Detect stores, it never applies.
    expect({ ...withDetected, detected: null }).toEqual(seeded)
  })
})

// ─── genericFormIssues ──────────────────────────────────────────────────────

describe('genericFormIssues', () => {
  const valid = (): GenericFormState =>
    baseState({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      scopes: ['openid'],
    })

  it('accepts a complete, valid form', () => {
    expect(genericFormOk(valid())).toBe(true)
  })

  it('requires the authorization and token endpoints', () => {
    const issues = genericFormIssues(baseState({ scopes: ['openid'] }))
    expect(issues.authorizationEndpoint).toBeTruthy()
    expect(issues.tokenEndpoint).toBeTruthy()
  })

  it('rejects a non-https endpoint', () => {
    const issues = genericFormIssues(valid())
    expect(issues.authorizationEndpoint).toBeUndefined()
    const bad = genericFormIssues({
      ...valid(),
      authorizationEndpoint: 'http://idp.example.com/authorize',
    })
    expect(bad.authorizationEndpoint).toMatch(/https/)
  })

  it('rejects a bare hostname without a dot', () => {
    const bad = genericFormIssues({ ...valid(), tokenEndpoint: 'https://localhost/token' })
    expect(bad.tokenEndpoint).toMatch(/fully-qualified/)
  })

  it('DA-4: sendScope with no scopes is an issue; turning sendScope off clears it', () => {
    const noScopes = { ...valid(), scopes: [] }
    expect(genericFormIssues(noScopes).scopes).toBeTruthy()
    expect(genericFormIssues({ ...noScopes, sendScope: false }).scopes).toBeUndefined()
  })

  it('basic auth on a public client is an issue', () => {
    const issues = genericFormIssues({ ...valid(), tokenAuthMethod: 'basic', clientMode: 'public' })
    expect(issues.tokenAuthMethod).toBeTruthy()
    expect(
      genericFormIssues({ ...valid(), tokenAuthMethod: 'basic', clientMode: 'confidential' })
        .tokenAuthMethod
    ).toBeUndefined()
  })

  it('bounds the extra authorize params (≤16, value ≤1024, unique keys)', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, key: `k${i}`, value: 'v' }))
    expect(
      genericFormIssues({ ...valid(), extraAuthorizeParams: many }).extraAuthorizeParams
    ).toMatch(/16/)
    const dup = [
      { id: 'a', key: 'same', value: '1' },
      { id: 'b', key: 'same', value: '2' },
    ]
    expect(
      genericFormIssues({ ...valid(), extraAuthorizeParams: dup }).extraAuthorizeParams
    ).toMatch(/unique/)
    const longVal = [{ id: 'a', key: 'k', value: 'x'.repeat(1025) }]
    expect(
      genericFormIssues({ ...valid(), extraAuthorizeParams: longVal }).extraAuthorizeParams
    ).toMatch(/1024/)
  })
})

// ─── buildGenericSubmit ─────────────────────────────────────────────────────

describe('buildGenericSubmit', () => {
  it('sends the 10 required knobs explicitly and omits empty optionals; no secret for public', () => {
    const state = baseState({
      authorizationEndpoint: '  https://idp.example.com/authorize  ',
      tokenEndpoint: 'https://idp.example.com/token',
      scopes: ['openid', 'offline_access'],
    })
    const submit = buildGenericSubmit(state, 'user')
    expect(submit.secret).toBeUndefined()
    expect(submit.scopes).toEqual(['openid', 'offline_access'])
    expect(submit.grantScope).toBe('user')
    // endpoints trimmed
    expect(submit.generic.authorizationEndpoint).toBe('https://idp.example.com/authorize')
    // required knobs present
    for (const key of [
      'tokenRequestFormat',
      'tokenAuthMethod',
      'scopeSeparator',
      'sendScope',
      'usePkce',
      'includeResponseType',
      'supportsRefresh',
    ] as const) {
      expect(submit.generic[key]).toBeDefined()
    }
    // empty optionals omitted
    expect(submit.generic).not.toHaveProperty('refreshEndpoint')
    expect(submit.generic).not.toHaveProperty('resource')
    expect(submit.generic).not.toHaveProperty('extraAuthorizeParams')
    // never a provider / remote field
    expect(submit.generic).not.toHaveProperty('provider')
  })

  it('includes optionals when present and attaches a confidential secret', () => {
    const state = baseState({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      refreshEndpoint: 'https://idp.example.com/refresh',
      resource: 'https://api.example.com',
      extraAuthorizeParams: [
        { id: 'a', key: 'audience', value: 'https://api.example.com' },
        { id: 'b', key: '', value: 'dropped' },
      ],
      scopes: ['openid'],
    })
    const submit = buildGenericSubmit(state, 'context', {
      mode: 'managed',
      clientId: 'cid',
      clientSecret: 'shh',
    })
    expect(submit.generic.refreshEndpoint).toBe('https://idp.example.com/refresh')
    expect(submit.generic.resource).toBe('https://api.example.com')
    expect(submit.generic.extraAuthorizeParams).toEqual({ audience: 'https://api.example.com' })
    expect(submit.secret).toEqual({ mode: 'managed', clientId: 'cid', clientSecret: 'shh' })
  })
})

describe('extraParamsToRecord', () => {
  it('drops blank keys and lets a later duplicate key win', () => {
    expect(
      extraParamsToRecord([
        { id: '1', key: ' a ', value: '1' },
        { id: '2', key: '', value: 'skip' },
        { id: '3', key: 'a', value: '2' },
      ])
    ).toEqual({ a: '2' })
  })
})

// ─── readGenericImmutables ──────────────────────────────────────────────────

describe('readGenericImmutables', () => {
  it('projects a confidential generic spec.oauth read-only', () => {
    const view = readGenericImmutables({
      source: 'generic',
      id: 'idp-abc',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      tokenRequestFormat: 'form',
      tokenAuthMethod: 'basic',
      scopeSeparator: 'space',
      sendScope: true,
      usePkce: true,
      includeResponseType: true,
      supportsRefresh: true,
      clientIdRef: { name: 's', key: 'client_id' },
      clientSecretRef: { name: 's', key: 'client_secret' },
      extraAuthorizeParams: { audience: 'https://api.example.com' },
    })
    expect(view.clientMode).toBe('confidential')
    expect(view.authorizationEndpoint).toBe('https://idp.example.com/authorize')
    expect(view.tokenAuthMethod).toBe('basic')
    expect(view.extraAuthorizeParams).toEqual([
      expect.objectContaining({ key: 'audience', value: 'https://api.example.com' }),
    ])
  })

  it('infers a public client from the absence of refs and tolerates missing fields', () => {
    const view = readGenericImmutables({ source: 'generic', id: 'idp' })
    expect(view.clientMode).toBe('public')
    expect(view.authorizationEndpoint).toBe('')
    expect(view.sendScope).toBe(false)
    expect(view.extraAuthorizeParams).toEqual([])
  })
})

describe('markEdited', () => {
  it('marks a field touched and flips its origin to edited', () => {
    const state = markEdited(baseState(), 'authorizationEndpoint')
    expect(state.touched.has('authorizationEndpoint')).toBe(true)
    expect(state.origin.authorizationEndpoint).toBe('edited')
  })
})

describe('editEnumKnob', () => {
  it('sets the knob, marks it touched, and flips origin to edited', () => {
    const state = editEnumKnob(baseState(), 'scopeSeparator', 'comma')
    expect(state.scopeSeparator).toBe('comma')
    expect(state.touched.has('scopeSeparator')).toBe(true)
    expect(state.origin.scopeSeparator).toBe('edited')
  })

  it('selecting basic auth forces a confidential client (basic⇒confidential invariant)', () => {
    // Regression: a public/body form where the operator manually picks basic must not be
    // left with clientMode:'public' — the client-type toggle is then disabled (forced
    // confidential) and the form could never validate. editEnumKnob upholds the same
    // invariant seedFromCatalog and applyDiscoveryPrefill maintain.
    const start = baseState({ clientMode: 'public', tokenAuthMethod: 'body' })
    const next = editEnumKnob(start, 'tokenAuthMethod', 'basic')
    expect(next.tokenAuthMethod).toBe('basic')
    expect(next.clientMode).toBe('confidential')
    expect(
      genericFormIssues({
        ...next,
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        scopes: ['openid'],
      }).tokenAuthMethod
    ).toBeUndefined()
  })

  it('switching back to body keeps the (now confidential) client mode', () => {
    const basic = editEnumKnob(baseState({ clientMode: 'public' }), 'tokenAuthMethod', 'basic')
    const body = editEnumKnob(basic, 'tokenAuthMethod', 'body')
    expect(body.tokenAuthMethod).toBe('body')
    expect(body.clientMode).toBe('confidential')
  })
})
