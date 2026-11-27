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
/** Distinctive, with inner spaces, so a refusal message that echoed it would be caught. */
const CLAIM_VALUE = 'Evenfire Fixture Claim Members'
const CLAIM_NAME_REFUSED =
  'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_REQUIRED_CLAIM_NAME'
const CLAIM_VALUE_REFUSED =
  'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE'
const ACCOUNT_CREATION_REFUSED =
  'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ACCOUNT_CREATION'
const NEW_MEMBER_TEAM = '11111111-2222-4333-8444-666666666666'

function requiredClaim(value: string, name?: string): Record<string, string> {
  return {
    CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE: value,
    ...(name === undefined ? {} : { CONTROL_API_OIDC_REQUIRED_CLAIM_NAME: name }),
  }
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

  it.each([
    'true',
    'ENABLED',
    '',
    'Acknowledged',
    'ACKNOWLEDGED',
    ' acknowledged',
    'acknowledged ',
  ])('refuses guard value %j', value => {
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
      requiredClaim: null,
      allowGuests: false,
      newMemberTeamId: null,
      accountCreation: 'disabled',
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

  it.each([
    'https://issuer.example.test/tenant/v2.0',
    'https://appleid.apple.com',
    'https://gitlab.com',
    'https://securetoken.google.com/fixture-project',
    `https://fixture.ciamlogin.com/${TENANT}/v2.0`,
    `https://fixture.b2clogin.com/${TENANT}/v2.0/`,
    'https://login.salesforce.com',
  ])('refuses ACCOUNT_CREATION=enabled without a required claim value on %s', issuer => {
    const generic = { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: issuer }
    for (const extra of [{}, { ...GUARD, ...SWITCH }]) {
      expect(
        refusal({
          ...generic,
          ...extra,
          CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
          CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: NEW_MEMBER_TEAM,
        })
      ).toBe(ACCOUNT_CREATION_REFUSED)
    }
    // Positive control: the same issuer loads once a required claim value is set.
    const provider = loadOidcProviderConfiguration(
      {
        ...generic,
        ...GUARD,
        ...SWITCH,
        ...requiredClaim(CLAIM_VALUE, 'groups'),
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: NEW_MEMBER_TEAM,
      },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn).toEqual({
      entraTenantId: null,
      requiredClaim: { name: 'groups', value: CLAIM_VALUE },
      allowGuests: false,
      newMemberTeamId: NEW_MEMBER_TEAM,
      accountCreation: 'enabled',
    })
  })

  it('loads ACCOUNT_CREATION=any_issuer_account without a required claim on a non-Entra issuer', () => {
    const environment = {
      ...OIDC_ENV,
      CONTROL_API_OIDC_ACCOUNT_CREATION: 'any_issuer_account',
      CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: NEW_MEMBER_TEAM,
    }
    const expected = {
      entraTenantId: null,
      requiredClaim: null,
      allowGuests: false,
      newMemberTeamId: NEW_MEMBER_TEAM,
      accountCreation: 'enabled',
    }
    expect(loadOidcProviderConfiguration(environment, GENERATION_KEY)!.memberEligibility).toEqual(
      expected
    )
    expect(
      loadOidcProviderConfiguration({ ...environment, ...GUARD, ...SWITCH }, GENERATION_KEY)!
        .memberSignIn
    ).toEqual(expected)
  })

  it('refuses ACCOUNT_CREATION=any_issuer_account beside a required claim value, on Google and on Entra', () => {
    const anyIssuerAccount = { CONTROL_API_OIDC_ACCOUNT_CREATION: 'any_issuer_account' }
    for (const claim of [requiredClaim(CLAIM_VALUE), requiredClaim(CLAIM_VALUE, 'groups')]) {
      const message = refusal({ ...OIDC_ENV, ...GUARD, ...SWITCH, ...anyIssuerAccount, ...claim })
      expect(message).toBe(ACCOUNT_CREATION_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
    }
    const google = { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://accounts.google.com' }
    expect(
      refusal({ ...google, ...anyIssuerAccount, ...requiredClaim('fixture.example.test', 'hd') })
    ).toBe(ACCOUNT_CREATION_REFUSED)
    expect(refusal({ ...google, ...anyIssuerAccount })).toContain(
      'CONTROL_API_OIDC_REQUIRED_CLAIM_NAME'
    )
    for (const claim of [{}, requiredClaim(CLAIM_VALUE)]) {
      expect(refusal({ ...ENTRA_ENV, ...anyIssuerAccount, ...claim })).toBe(
        ACCOUNT_CREATION_REFUSED
      )
    }
  })

  it('loads ACCOUNT_CREATION=enabled with a required claim value, on Google with hd too', () => {
    const creating = { ...GUARD, ...SWITCH, CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled' }
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...creating, ...requiredClaim(CLAIM_VALUE) },
        GENERATION_KEY
      )!.memberSignIn
    ).toEqual({
      entraTenantId: null,
      requiredClaim: { name: 'roles', value: CLAIM_VALUE },
      allowGuests: false,
      newMemberTeamId: null,
      accountCreation: 'enabled',
    })
    expect(
      loadOidcProviderConfiguration(
        {
          ...OIDC_ENV,
          ...creating,
          ...requiredClaim('fixture.example.test', 'hd'),
          CONTROL_API_OIDC_ISSUER: 'https://accounts.google.com',
        },
        GENERATION_KEY
      )!.memberSignIn
    ).toMatchObject({
      requiredClaim: { name: 'hd', value: 'fixture.example.test' },
      accountCreation: 'enabled',
    })
  })

  it('disables creation for a non-Entra issuer by default', () => {
    const provider = loadOidcProviderConfiguration(
      { ...OIDC_ENV, ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn?.accountCreation).toBe('disabled')
  })

  it.each([
    ['CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS', 'retired-domain-list.example.test'],
    ['CONTROL_API_OIDC_REQUIRED_ROLE', 'Retired.Role.Assignment'],
  ])('fails to load with the removed setting %s', (name, value) => {
    for (const extra of [{}, { ...GUARD, ...SWITCH }]) {
      const message = refusal({
        ...OIDC_ENV,
        ...extra,
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        [name]: value,
      })
      expect(message).toBe(`Unsupported OIDC configuration field: ${name}`)
      expect(message).not.toContain(value)
    }
  })

  it.each([
    ['CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS', 'retired-domain-list.example.test'],
    ['CONTROL_API_OIDC_REQUIRED_ROLE', 'Retired.Role.Assignment'],
  ])('fails to load a leftover %s when no registration is set', (name, value) => {
    const message = refusal({ [name]: value })
    expect(message).toBe(`Unsupported OIDC configuration field: ${name}`)
    expect(message).not.toContain(value)
    // No OIDC settings at all leaves the provider unconfigured.
    expect(loadOidcProviderConfiguration({}, GENERATION_KEY)).toBeUndefined()
  })

  it('refuses a bad ACCOUNT_CREATION value and a bad team id', () => {
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_ACCOUNT_CREATION: 'true' })).toBe(
      'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ACCOUNT_CREATION'
    )
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: 'not-a-uuid' })).toContain(
      'CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID'
    )
  })

  it.each(['', 'ENABLED', 'Any_Issuer_Account', 'any-issuer-account', ' any_issuer_account'])(
    'refuses the ACCOUNT_CREATION value %j with or without a required claim',
    value => {
      for (const claim of [{}, requiredClaim(CLAIM_VALUE)]) {
        expect(refusal({ ...OIDC_ENV, ...claim, CONTROL_API_OIDC_ACCOUNT_CREATION: value })).toBe(
          ACCOUNT_CREATION_REFUSED
        )
      }
    }
  )

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

  it('refuses an Entra issuer with a trailing slash', () => {
    for (const extra of [{}, { ...GUARD, ...SWITCH }]) {
      expect(
        refusal({
          ...ENTRA_ENV,
          ...extra,
          CONTROL_API_OIDC_ISSUER: `https://login.microsoftonline.com/${TENANT}/v2.0/`,
        })
      ).toContain('CONTROL_API_OIDC_ISSUER')
    }
  })

  it('still refuses ACCOUNT_CREATION on an Entra issuer', () => {
    expect(refusal({ ...ENTRA_ENV, CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled' })).toBe(
      'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ACCOUNT_CREATION'
    )
    // Positive control: the same setting loads on a non-Entra issuer, which
    // needs a required claim value for it.
    expect(
      loadOidcProviderConfiguration(
        {
          ...OIDC_ENV,
          ...requiredClaim(CLAIM_VALUE),
          CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        },
        GENERATION_KEY
      )?.memberEligibility.accountCreation
    ).toBe('enabled')
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
        ...requiredClaim('member'),
        CONTROL_API_OIDC_ALLOW_GUESTS: 'true',
        CONTROL_API_OIDC_TENANT_ID: TENANT,
      })
    ).toContain('CONTROL_API_OIDC_TENANT_ID')
    expect(
      refusal({ ...OIDC_ENV, ...requiredClaim('member'), CONTROL_API_OIDC_ALLOW_GUESTS: 'true' })
    ).toContain('CONTROL_API_OIDC_ALLOW_GUESTS')
  })

  it('requires a required claim and TENANT_ID with ALLOW_GUESTS', () => {
    const guests = { CONTROL_API_OIDC_ALLOW_GUESTS: 'true' }
    expect(refusal({ ...ENTRA_ENV, ...guests })).toContain('CONTROL_API_OIDC_ALLOW_GUESTS')
    expect(refusal({ ...OIDC_ENV, ...guests, ...requiredClaim('member') })).toContain(
      'CONTROL_API_OIDC_ALLOW_GUESTS'
    )
    expect(refusal({ ...ENTRA_ENV, CONTROL_API_OIDC_ALLOW_GUESTS: 'yes' })).toContain(
      'CONTROL_API_OIDC_ALLOW_GUESTS'
    )
    const provider = loadOidcProviderConfiguration(
      { ...ENTRA_ENV, ...guests, ...requiredClaim('member'), ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn).toMatchObject({
      allowGuests: true,
      requiredClaim: { name: 'roles', value: 'member' },
    })
  })

  it('requires the roles claim name for Entra with ALLOW_GUESTS', () => {
    const guests = { ...ENTRA_ENV, CONTROL_API_OIDC_ALLOW_GUESTS: 'true' }
    const message = refusal({ ...guests, ...requiredClaim(CLAIM_VALUE, 'groups') })
    expect(message).toBe(
      'Invalid OIDC provider configuration field(s): CONTROL_API_OIDC_ALLOW_GUESTS'
    )
    expect(message).not.toContain(CLAIM_VALUE)
    // Positive control: `roles`, written or defaulted, loads with guests.
    for (const claim of [requiredClaim(CLAIM_VALUE), requiredClaim(CLAIM_VALUE, 'roles')]) {
      expect(
        loadOidcProviderConfiguration({ ...guests, ...claim }, GENERATION_KEY)!.memberEligibility
          .requiredClaim
      ).toEqual({ name: 'roles', value: CLAIM_VALUE })
    }
    // Without guests, an Entra registration may require another claim.
    expect(
      loadOidcProviderConfiguration(
        { ...ENTRA_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toEqual({ name: 'groups', value: CLAIM_VALUE })
  })

  it('defaults the claim name to roles', () => {
    const provider = loadOidcProviderConfiguration(
      { ...OIDC_ENV, ...GUARD, ...SWITCH, ...requiredClaim(CLAIM_VALUE) },
      GENERATION_KEY
    )!
    expect(provider.memberSignIn?.requiredClaim).toEqual({ name: 'roles', value: CLAIM_VALUE })
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toEqual({ name: 'groups', value: CLAIM_VALUE })
  })

  it('refuses a claim name without a value', () => {
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_REQUIRED_CLAIM_NAME: 'groups' })).toBe(
      CLAIM_NAME_REFUSED
    )
  })

  it.each(['sub', 'iss', 'tid', 'idp', 'acct', 'email', 'email_verified', 'xms_edov'])(
    'refuses the claim name %s',
    name => {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, name) })
      expect(message).toBe(CLAIM_NAME_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
    }
  )

  it.each(['tid', 'idp'])('refuses the claim name %s on an Entra issuer', name => {
    const message = refusal({ ...ENTRA_ENV, ...requiredClaim(CLAIM_VALUE, name) })
    expect(message).toBe(CLAIM_NAME_REFUSED)
    expect(message).not.toContain(CLAIM_VALUE)
    // Positive control: an unreserved name loads on the same issuer.
    expect(
      loadOidcProviderConfiguration(
        { ...ENTRA_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toEqual({ name: 'groups', value: CLAIM_VALUE })
  })

  it('refuses a claim name over 128 characters', () => {
    const message = refusal({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'c'.repeat(129)) })
    expect(message).toBe(CLAIM_NAME_REFUSED)
    expect(message).not.toContain(CLAIM_VALUE)
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'c'.repeat(128)) },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toEqual({ name: 'c'.repeat(128), value: CLAIM_VALUE })
  })

  it('refuses a claim name with a control character', () => {
    for (const name of ['gro\u0000ups', 'groups\n', 'gro\tups', 'groups\u007f']) {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, name) })
      expect(message).toBe(CLAIM_NAME_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
    }
  })

  it('refuses a claim name or value that contains a format character', () => {
    for (const name of ['groups\u200b', 'gro\u200cups', 'groups\u2060']) {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, name) })
      expect(message).toBe(CLAIM_NAME_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
      expect(message).not.toContain('groups')
    }
    const value = `${CLAIM_VALUE}\u200b`
    const message = refusal({ ...OIDC_ENV, ...requiredClaim(value) })
    expect(message).toBe(CLAIM_VALUE_REFUSED)
    expect(message).not.toContain(CLAIM_VALUE)
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toEqual({ name: 'groups', value: CLAIM_VALUE })
  })

  it('refuses a claim name with leading or trailing whitespace', () => {
    for (const name of [' roles', 'roles ', ' groups', 'groups ']) {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, name) })
      expect(message).toBe(CLAIM_NAME_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
    }
    // Positive control: the same names without the whitespace load.
    for (const name of ['roles', 'groups']) {
      expect(
        loadOidcProviderConfiguration(
          { ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, name) },
          GENERATION_KEY
        )!.memberEligibility.requiredClaim
      ).toEqual({ name, value: CLAIM_VALUE })
    }
  })

  it('accepts a value with inner spaces and refuses leading or trailing whitespace', () => {
    expect(
      loadOidcProviderConfiguration({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE) }, GENERATION_KEY)!
        .memberEligibility.requiredClaim
    ).toEqual({ name: 'roles', value: CLAIM_VALUE })
    for (const value of [` ${CLAIM_VALUE}`, `${CLAIM_VALUE} `, `${CLAIM_VALUE}\t`]) {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(value) })
      expect(message).toBe(CLAIM_VALUE_REFUSED)
      expect(message).not.toContain(CLAIM_VALUE)
    }
  })

  it('refuses an empty, over-256-character or control-character value', () => {
    expect(refusal({ ...OIDC_ENV, ...requiredClaim('') })).toBe(CLAIM_VALUE_REFUSED)
    for (const value of ['v'.repeat(257), 'Evenfire\u0000Fixture', 'Evenfire\nFixture']) {
      const message = refusal({ ...OIDC_ENV, ...requiredClaim(value) })
      expect(message).toBe(CLAIM_VALUE_REFUSED)
      expect(message).not.toContain(value)
    }
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, ...requiredClaim('v'.repeat(256)) },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim?.value
    ).toBe('v'.repeat(256))
  })

  it('requires hd for accounts.google.com, written in any case', () => {
    for (const issuer of ['https://accounts.google.com', 'https://Accounts.Google.COM']) {
      const google = { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: issuer }
      for (const claim of [
        {},
        requiredClaim(CLAIM_VALUE),
        requiredClaim(CLAIM_VALUE, 'groups'),
        { CONTROL_API_OIDC_REQUIRED_CLAIM_NAME: 'hd' },
      ]) {
        const message = refusal({ ...google, ...claim })
        expect(message).toBe(CLAIM_NAME_REFUSED)
        expect(message).not.toContain(CLAIM_VALUE)
      }
      expect(
        loadOidcProviderConfiguration(
          { ...google, ...GUARD, ...SWITCH, ...requiredClaim('fixture.example.test', 'hd') },
          GENERATION_KEY
        )!.memberSignIn?.requiredClaim
      ).toEqual({ name: 'hd', value: 'fixture.example.test' })
    }
  })

  it('does not treat accounts.google.com.evil.example as Google', () => {
    expect(
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://accounts.google.com.evil.example' },
        GENERATION_KEY
      )!.memberEligibility.requiredClaim
    ).toBeNull()
    // Positive control: the Google host itself is refused without hd.
    expect(refusal({ ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://accounts.google.com' })).toBe(
      CLAIM_NAME_REFUSED
    )
  })

  it('changes the generation when an eligibility setting changes, not when the switch toggles', () => {
    const base = { ...ENTRA_ENV, ...requiredClaim('member') }
    const generation = (environment: Record<string, string>) =>
      loadOidcProviderConfiguration(environment, GENERATION_KEY)!.configurationGeneration
    const first = generation(base)
    expect(generation({ ...base, ...GUARD, ...SWITCH })).toBe(first)
    expect(generation({ ...base, ...requiredClaim('admin') })).not.toBe(first)
    expect(generation({ ...base, CONTROL_API_OIDC_ALLOW_GUESTS: 'true' })).not.toBe(first)
    expect(
      generation({ ...OIDC_ENV, CONTROL_API_OIDC_ACCOUNT_CREATION: 'any_issuer_account' })
    ).not.toBe(generation(OIDC_ENV))
    const provider = loadOidcProviderConfiguration(
      { ...base, ...GUARD, ...SWITCH },
      GENERATION_KEY
    )!
    expect(provider.configurationGeneration).toBe(
      currentOidcConfigurationGeneration(provider, SECRET, GENERATION_KEY)
    )
  })

  it('changes the generation when account creation changes with the same required claim', () => {
    const generation = (environment: Record<string, string>) =>
      loadOidcProviderConfiguration(environment, GENERATION_KEY)!.configurationGeneration
    const claim = { ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') }
    const invitationOnly = generation(claim)
    const creating = generation({ ...claim, CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled' })
    // Both carry an eligibility part, so this compares account creation alone.
    expect(invitationOnly).not.toBe(generation(OIDC_ENV))
    expect(creating).not.toBe(invitationOnly)
  })

  it('changes the generation when the claim name or value changes', () => {
    const generation = (environment: Record<string, string>) =>
      loadOidcProviderConfiguration(environment, GENERATION_KEY)!.configurationGeneration
    const defaulted = generation({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE) })
    expect(defaulted).not.toBe(generation(OIDC_ENV))
    expect(generation({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'roles') })).toBe(defaulted)
    expect(generation({ ...OIDC_ENV, ...requiredClaim(CLAIM_VALUE, 'groups') })).not.toBe(defaulted)
    expect(generation({ ...OIDC_ENV, ...requiredClaim(`${CLAIM_VALUE} Two`) })).not.toBe(defaulted)
    const provider = loadOidcProviderConfiguration(
      { ...OIDC_ENV, ...GUARD, ...SWITCH, ...requiredClaim(CLAIM_VALUE, 'groups') },
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
