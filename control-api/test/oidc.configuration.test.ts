import { describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  currentOidcConfigurationGeneration,
  isEntraIssuerHost,
  loadOidcProviderConfiguration,
  readOidcClientSecret,
} from '../src/oidc/configuration.js'

const SECRET = 'a-test-only-oidc-provider-fixture-secret-that-must-never-escape'
const GENERATION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const OIDC_ENV = {
  CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
  CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
  CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant/v2.0',
  CONTROL_API_OIDC_CLIENT_ID: 'test-client-id',
  CONTROL_API_OIDC_CLIENT_SECRET: SECRET,
  CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
  CONTROL_API_OIDC_REDIRECT_URI: 'https://api.example.test/api/v1/oidc/callback',
  CONTROL_API_OIDC_RESPONSE_MODE: 'query',
  CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-10-27-1',
}

describe('OIDC deployment configuration', () => {
  it('leaves installations without OIDC configuration unchanged', () => {
    expect(loadOidcProviderConfiguration({}, GENERATION_KEY)).toBeUndefined()
  })

  it('accepts one complete provider as configured but not activated for member login', () => {
    const provider = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)
    expect(provider).toMatchObject({
      registrationId: 'company-login',
      displayLabel: 'Company login',
      issuer: OIDC_ENV.CONTROL_API_OIDC_ISSUER,
      clientId: 'test-client-id',
      clientSecretRef: 'CONTROL_API_OIDC_CLIENT_SECRET',
      clientAuthenticationMethod: 'client_secret_basic',
      redirectUri: OIDC_ENV.CONTROL_API_OIDC_REDIRECT_URI,
      responseType: 'code',
      responseMode: 'query',
      scopes: ['openid', 'profile', 'email'],
      memberAuthenticationActivated: false,
    })
    expect(provider?.configurationGeneration).toBe(
      currentOidcConfigurationGeneration(provider!, SECRET, GENERATION_KEY)
    )
    expect(readOidcClientSecret(provider!, OIDC_ENV)).toBe(SECRET)
    expect(JSON.stringify(provider)).not.toContain(SECRET)
  })

  it('changes the trust generation when any registration or secret changes', () => {
    const first = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    const rotated = loadOidcProviderConfiguration(
      { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_SECRET: `${SECRET}-rotated` },
      GENERATION_KEY
    )!
    const trustRevision = loadOidcProviderConfiguration(
      { ...OIDC_ENV, CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-10-28-1' },
      GENERATION_KEY
    )!
    expect(rotated.configurationGeneration).not.toBe(first.configurationGeneration)
    expect(trustRevision.configurationGeneration).not.toBe(first.configurationGeneration)
  })

  it('keys the trust generation with the configured generation key', () => {
    const first = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    const rotatedKey = loadOidcProviderConfiguration(
      OIDC_ENV,
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
    )!

    expect(rotatedKey.configurationGeneration).not.toBe(first.configurationGeneration)
    expect(first.configurationGeneration).not.toContain(SECRET)
    expect(rotatedKey.configurationGeneration).not.toContain(SECRET)
  })

  it('rejects incomplete and unknown OIDC settings without echoing the credential', () => {
    let missingClientId: unknown
    try {
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_ID: undefined },
        GENERATION_KEY
      )
    } catch (error) {
      missingClientId = error
    }
    expect(missingClientId).toBeInstanceOf(Error)
    expect(String(missingClientId)).toContain('CONTROL_API_OIDC_CLIENT_ID')
    expect(String(missingClientId)).not.toContain(SECRET)

    let unknownSetting: unknown
    try {
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_PROVIDERS: 'two' },
        GENERATION_KEY
      )
    } catch (error) {
      unknownSetting = error
    }
    expect(unknownSetting).toBeInstanceOf(Error)
    expect(String(unknownSetting)).toContain('Unsupported OIDC configuration field')
    expect(String(unknownSetting)).not.toContain(SECRET)
  })

  it.each([
    ['HTTP issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'http://issuer.example.test' }],
    ['localhost issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://localhost/issuer' }],
    ['private IP issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://10.1.2.3/issuer' }],
    [
      'userinfo issuer',
      { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://user@issuer.example.test' },
    ],
    [
      'query-bearing issuer',
      { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/?tenant=x' },
    ],
    [
      'fragment callback',
      { ...OIDC_ENV, CONTROL_API_OIDC_REDIRECT_URI: 'https://api.example.test/callback#fragment' },
    ],
    ['unsupported response mode', { ...OIDC_ENV, CONTROL_API_OIDC_RESPONSE_MODE: 'fragment' }],
    [
      'unsupported client authentication',
      { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'none' },
    ],
  ])('rejects %s configuration', (_label, environment) => {
    expect(() => loadOidcProviderConfiguration(environment, GENERATION_KEY)).toThrow()
  })

  it.each([
    'tenant.localhost',
    'service.local',
    'provider.internal',
    'issuer.svc',
    'api.svc.cluster.local',
    'issuer.cluster.local',
    'metadata.goog',
  ])('rejects reserved issuer host %s', host => {
    expect(() =>
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: `https://${host}/tenant` },
        GENERATION_KEY
      )
    ).toThrow(/public HTTPS DNS name/)
  })

  it('fails closed when the configured credential reference no longer resolves', () => {
    const provider = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    expect(() => readOidcClientSecret(provider, {})).toThrow(
      'OIDC client credential is unavailable'
    )
  })
})

const GUARD = { CONTROL_API_OIDC_UNRELEASED: 'acknowledged' }
const SWITCH = { CONTROL_API_OIDC_MEMBER_SIGN_IN: 'enabled' }
const TENANT = '11111111-2222-4333-8444-555555555555'
const ENTRA_ENV = {
  ...OIDC_ENV,
  CONTROL_API_OIDC_ISSUER: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  CONTROL_API_OIDC_TENANT_ID: TENANT,
}

function refusal(environment: Record<string, string>): string {
  let message = ''
  try {
    loadOidcProviderConfiguration(environment, GENERATION_KEY)
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).not.toBe('')
  expect(message).not.toContain(SECRET)
  return message
}

describe('OIDC member sign-in configuration', () => {
  it('is off without the switch and keeps the registration generation', () => {
    const provider = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    expect(provider.memberSignIn).toBeNull()
    expect(provider.memberAuthenticationActivated).toBe(false)
    // The pre-policy generation formula, unchanged for a registration with no policy settings.
    const legacyPayload = JSON.stringify([
      'oidc-registration-v1',
      'company-login',
      'Company login',
      OIDC_ENV.CONTROL_API_OIDC_ISSUER,
      'test-client-id',
      'client_secret_basic',
      OIDC_ENV.CONTROL_API_OIDC_REDIRECT_URI,
      'query',
      'config-2026-10-27-1',
      createHmac('sha256', deriveOAuthEncryptionKey(GENERATION_KEY))
        .update(SECRET)
        .digest('base64url'),
    ])
    expect(provider.configurationGeneration).toBe(
      `v1:${createHash('sha256').update(legacyPayload).digest('hex')}`
    )
  })

  it('refuses the switch without the release guard', () => {
    const message = refusal({ ...OIDC_ENV, ...SWITCH })
    expect(message).toBe(
      'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_UNRELEASED'
    )
  })

  it.each(['true', 'ENABLED', ''])('refuses guard value %j', value => {
    const message = refusal({ ...OIDC_ENV, ...SWITCH, CONTROL_API_OIDC_UNRELEASED: value })
    expect(message).toContain('CONTROL_API_OIDC_UNRELEASED')
  })

  it.each(['true', 'ENABLED', 'on', '', ' enabled'])('refuses switch value %j', value => {
    const message = refusal({ ...OIDC_ENV, ...GUARD, CONTROL_API_OIDC_MEMBER_SIGN_IN: value })
    expect(message).toContain('CONTROL_API_OIDC_MEMBER_SIGN_IN')
  })

  it('turns member sign-in on with the switch and the guard', () => {
    const off = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    const on = loadOidcProviderConfiguration({ ...OIDC_ENV, ...GUARD, ...SWITCH }, GENERATION_KEY)!
    expect(on.memberAuthenticationActivated).toBe(true)
    expect(on.memberSignIn).toEqual({
      entraTenantId: null,
      requiredRole: null,
      allowGuests: false,
      newMemberTeamId: null,
      accountCreation: 'disabled',
      allowedEmailDomains: [],
    })
    expect(on.configurationGeneration).toBe(off.configurationGeneration)
  })

  it('leaves OIDC unconfigured when only optional settings are set', () => {
    expect(
      loadOidcProviderConfiguration(
        { ...GUARD, ...SWITCH, CONTROL_API_OIDC_ALLOW_GUESTS: 'true' },
        GENERATION_KEY
      )
    ).toBeUndefined()
  })

  it('builds an allowed_domains policy for a non-Entra issuer', () => {
    const provider = loadOidcProviderConfiguration(
      {
        ...OIDC_ENV,
        ...GUARD,
        ...SWITCH,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: ' Example.TEST ,corp.example.test',
        CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: '11111111-2222-4333-8444-666666666666',
      },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn).toMatchObject({
      accountCreation: 'allowed_domains',
      allowedEmailDomains: ['example.test', 'corp.example.test'],
      newMemberTeamId: '11111111-2222-4333-8444-666666666666',
      entraTenantId: null,
    })
  })

  it('disables creation for a non-Entra issuer by default', () => {
    const provider = loadOidcProviderConfiguration(
      { ...OIDC_ENV, ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn?.accountCreation).toBe('disabled')
    expect(provider.memberSignIn?.allowedEmailDomains).toEqual([])
  })

  it('refuses ALLOWED_EMAIL_DOMAINS without ACCOUNT_CREATION=enabled, and on Entra', () => {
    for (const extra of [{}, { ...GUARD, ...SWITCH }]) {
      expect(
        refusal({ ...OIDC_ENV, ...extra, CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test' })
      ).toBe('Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS')
      expect(
        refusal({ ...ENTRA_ENV, ...extra, CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test' })
      ).toBe('Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS')
    }
    expect(
      refusal({
        ...ENTRA_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test',
      })
    ).toContain('CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS')
  })

  it('refuses account creation without domains, bad domains and a bad team id', () => {
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled' })).toContain(
      'CONTROL_API_OIDC_ACCOUNT_CREATION'
    )
    expect(
      refusal({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'true',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test',
      })
    ).toContain('CONTROL_API_OIDC_ACCOUNT_CREATION')
    for (const bad of ['localhost', '@example.test', 'a b.test', 'example.test,,x.test']) {
      expect(
        refusal({
          ...OIDC_ENV,
          CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
          CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: bad,
        })
      ).toContain('CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS')
    }
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: 'not-a-uuid' })).toContain(
      'CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID'
    )
  })

  it('requires the tenant pin for an Entra issuer', () => {
    const { CONTROL_API_OIDC_TENANT_ID: _omitted, ...withoutTenant } = ENTRA_ENV
    expect(refusal(withoutTenant)).toContain('CONTROL_API_OIDC_TENANT_ID')
    expect(refusal({ ...ENTRA_ENV, CONTROL_API_OIDC_TENANT_ID: 'not-a-guid' })).toContain(
      'CONTROL_API_OIDC_TENANT_ID'
    )
    expect(
      refusal({
        ...ENTRA_ENV,
        CONTROL_API_OIDC_TENANT_ID: '11111111-2222-4333-8444-777777777777',
      })
    ).toContain('CONTROL_API_OIDC_ISSUER')
    const provider = loadOidcProviderConfiguration(
      { ...ENTRA_ENV, ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn).toMatchObject({
      entraTenantId: TENANT,
      accountCreation: 'entra',
    })
  })

  it('refuses ACCOUNT_CREATION on an Entra issuer', () => {
    expect(
      refusal({
        ...ENTRA_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test',
      })
    ).toContain('CONTROL_API_OIDC_ACCOUNT_CREATION')
  })

  it.each(['common', 'organizations', 'consumers', '9188040d-6c67-4c5b-b112-36a304b66dad'])(
    'refuses the Entra %s authority',
    authority => {
      for (const extra of [{}, { ...GUARD, ...SWITCH }]) {
        const message = refusal({
          ...ENTRA_ENV,
          ...extra,
          CONTROL_API_OIDC_ISSUER: `https://login.microsoftonline.com/${authority}/v2.0`,
          CONTROL_API_OIDC_TENANT_ID: authority,
        })
        expect(message).toMatch(/CONTROL_API_OIDC_(TENANT_ID|ISSUER)/)
      }
    }
  )

  it('treats ciamlogin and b2clogin as non-Entra', () => {
    expect(isEntraIssuerHost('tenant.ciamlogin.com')).toBe(false)
    expect(isEntraIssuerHost('tenant.b2clogin.com')).toBe(false)
    for (const host of [
      'login.microsoftonline.com',
      'login.microsoftonline.us',
      'login.partner.microsoftonline.cn',
    ]) {
      expect(isEntraIssuerHost(host)).toBe(true)
    }
    const provider = loadOidcProviderConfiguration(
      {
        ...OIDC_ENV,
        ...GUARD,
        ...SWITCH,
        CONTROL_API_OIDC_ISSUER: `https://tenant.ciamlogin.com/${TENANT}/v2.0`,
      },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn?.entraTenantId).toBeNull()
  })

  it('refuses a tenant pin on a non-Entra issuer', () => {
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_TENANT_ID: TENANT })).toBe(
      'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_TENANT_ID'
    )
    expect(
      refusal({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ALLOW_GUESTS: 'true',
        CONTROL_API_OIDC_REQUIRED_ROLE: 'member',
        CONTROL_API_OIDC_TENANT_ID: TENANT,
      })
    ).toContain('CONTROL_API_OIDC_TENANT_ID')
    expect(
      refusal({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ALLOW_GUESTS: 'true',
        CONTROL_API_OIDC_REQUIRED_ROLE: 'member',
      })
    ).toContain('CONTROL_API_OIDC_ALLOW_GUESTS')
  })

  it('requires REQUIRED_ROLE and TENANT_ID with ALLOW_GUESTS', () => {
    const guests = { CONTROL_API_OIDC_ALLOW_GUESTS: 'true' }
    expect(refusal({ ...ENTRA_ENV, ...guests })).toContain('CONTROL_API_OIDC_ALLOW_GUESTS')
    expect(refusal({ ...OIDC_ENV, ...guests, CONTROL_API_OIDC_REQUIRED_ROLE: 'member' })).toContain(
      'CONTROL_API_OIDC_ALLOW_GUESTS'
    )
    expect(refusal({ ...ENTRA_ENV, CONTROL_API_OIDC_ALLOW_GUESTS: 'yes' })).toContain(
      'CONTROL_API_OIDC_ALLOW_GUESTS'
    )
    const provider = loadOidcProviderConfiguration(
      { ...ENTRA_ENV, ...guests, CONTROL_API_OIDC_REQUIRED_ROLE: 'member', ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn).toMatchObject({ allowGuests: true, requiredRole: 'member' })
  })

  it('changes the generation when an eligibility setting changes, not when the switch toggles', () => {
    const base = { ...ENTRA_ENV, CONTROL_API_OIDC_REQUIRED_ROLE: 'member' }
    const generation = (environment: Record<string, string>) =>
      loadOidcProviderConfiguration(environment, GENERATION_KEY)!.configurationGeneration
    const first = generation(base)
    expect(generation({ ...base, ...GUARD, ...SWITCH })).toBe(first)
    expect(generation({ ...base, CONTROL_API_OIDC_REQUIRED_ROLE: 'admin' })).not.toBe(first)
    expect(generation({ ...base, CONTROL_API_OIDC_ALLOW_GUESTS: 'true' })).not.toBe(first)
    const plain = generation(OIDC_ENV)
    expect(
      generation({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test',
      })
    ).not.toBe(plain)
    expect(
      generation({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test,other.test',
      })
    ).not.toBe(
      generation({
        ...OIDC_ENV,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: 'example.test',
      })
    )
    const provider = loadOidcProviderConfiguration(
      { ...base, ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.configurationGeneration).toBe(
      currentOidcConfigurationGeneration(provider, SECRET, GENERATION_KEY)
    )
  })

  it('rejects an unknown CONTROL_API_OIDC_ name next to the new ones', () => {
    expect(() =>
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...GUARD, ...SWITCH, CONTROL_API_OIDC_MEMBER_SIGN_INN: 'enabled' },
        GENERATION_KEY
      )
    ).toThrow('Unsupported OIDC configuration field: CONTROL_API_OIDC_MEMBER_SIGN_INN')
  })
})
