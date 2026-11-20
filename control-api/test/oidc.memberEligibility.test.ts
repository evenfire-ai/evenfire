import { describe, expect, it } from 'vitest'
import type { OidcMemberSignInPolicy } from '../src/oidc/configuration.js'
import {
  entraTenantIdp,
  evaluateOidcEligibility,
  oidcEmailState,
} from '../src/oidc/memberEligibility.js'
import type {
  OidcVerifiedClaimObservation,
  VerifiedOidcIdentityProof,
} from '../src/oidc/protocolEngine.js'

const TENANT = '11111111-2222-3333-4444-555555555555'

const present = (value: unknown): OidcVerifiedClaimObservation =>
  ({ status: 'present', value }) as OidcVerifiedClaimObservation
const missing: OidcVerifiedClaimObservation = { status: 'missing' }
const unsupported: OidcVerifiedClaimObservation = { status: 'unsupported' }

function proof(
  claims: Record<string, OidcVerifiedClaimObservation>,
  email: string | null = 'member@example.test'
): VerifiedOidcIdentityProof {
  return {
    attributes: { source: 'validated_id_token', ...(email === null ? {} : { email }) },
    verifiedClaims: { source: 'validated_id_token', claims },
  } as unknown as VerifiedOidcIdentityProof
}

function policy(overrides: Partial<OidcMemberSignInPolicy> = {}): OidcMemberSignInPolicy {
  return {
    entraTenantId: null,
    requiredRole: null,
    allowGuests: false,
    newMemberTeamId: null,
    accountCreation: 'disabled',
    allowedEmailDomains: [],
    ...overrides,
  }
}
const entra = (overrides: Partial<OidcMemberSignInPolicy> = {}) =>
  policy({ entraTenantId: TENANT, ...overrides })

describe('entraTenantIdp', () => {
  it('builds the v1 issuer literal for a tenant', () => {
    expect(entraTenantIdp(TENANT)).toBe(`https://sts.windows.net/${TENANT}/`)
  })
})

describe('evaluateOidcEligibility', () => {
  const ok = { eligible: true, guest: false }
  const guestOk = { eligible: true, guest: true }
  const no = { eligible: false, reason: 'not_eligible' }

  it.each([
    ['Auth0-style proof without tid under a non-Entra policy', proof({}), policy(), ok],
    [
      'non-Entra policy ignores a foreign tid and idp',
      proof({ tid: present('other'), idp: present('x') }),
      policy(),
      ok,
    ],
    ['Entra member with matching tid', proof({ tid: present(TENANT) }), entra(), ok],
    ['Entra with a different tid', proof({ tid: present('other') }), entra(), no],
    ['Entra with a missing tid', proof({ tid: missing }), entra(), no],
    ['Entra with a non-string tid', proof({ tid: present(7) }), entra(), no],
    ['Entra with an unsupported tid', proof({ tid: unsupported }), entra(), no],
    [
      'Entra member whose idp is the tenant issuer',
      proof({ tid: present(TENANT), idp: present(entraTenantIdp(TENANT)) }),
      entra(),
      ok,
    ],
    [
      'Entra guest by idp with allowGuests false',
      proof({ tid: present(TENANT), idp: present('live.com') }),
      entra({ allowGuests: false }),
      no,
    ],
    [
      'Entra guest by idp with allowGuests true',
      proof({ tid: present(TENANT), idp: present('live.com') }),
      entra({ allowGuests: true }),
      guestOk,
    ],
    [
      'Entra guest by non-string idp is a guest',
      proof({ tid: present(TENANT), idp: present(5) }),
      entra({ allowGuests: true }),
      guestOk,
    ],
    [
      'Entra guest by acct === 1 with allowGuests false',
      proof({ tid: present(TENANT), acct: present(1) }),
      entra(),
      no,
    ],
    [
      'Entra guest by acct === 1 with allowGuests true',
      proof({ tid: present(TENANT), acct: present(1) }),
      entra({ allowGuests: true }),
      guestOk,
    ],
    [
      'Entra member with acct === 0',
      proof({ tid: present(TENANT), acct: present(0) }),
      entra(),
      ok,
    ],
    [
      'Entra with an unsupported acct',
      proof({ tid: present(TENANT), acct: unsupported }),
      entra({ allowGuests: true }),
      no,
    ],
    [
      'Entra with an unsupported idp',
      proof({ tid: present(TENANT), idp: unsupported }),
      entra({ allowGuests: true }),
      no,
    ],
    [
      'required role present in roles',
      proof({ roles: present(['a', 'Evenfire.User']) }),
      policy({ requiredRole: 'Evenfire.User' }),
      ok,
    ],
    [
      'required role absent from roles',
      proof({ roles: present(['a']) }),
      policy({ requiredRole: 'Evenfire.User' }),
      no,
    ],
    [
      'required role with a missing roles claim',
      proof({ roles: missing }),
      policy({ requiredRole: 'Evenfire.User' }),
      no,
    ],
    [
      'required role with roles as a string rather than an array',
      proof({ roles: present('Evenfire.User') }),
      policy({ requiredRole: 'Evenfire.User' }),
      no,
    ],
    [
      'required role with a non-string entry in roles',
      proof({ roles: present(['Evenfire.User', 3]) }),
      policy({ requiredRole: 'Evenfire.User' }),
      no,
    ],
    [
      'unsupported roles',
      proof({ roles: unsupported }),
      policy({ requiredRole: 'Evenfire.User' }),
      no,
    ],
    ['unsupported roles without a required role', proof({ roles: unsupported }), policy(), no],
    ['unsupported email_verified', proof({ email_verified: unsupported }), policy(), no],
    ['an observation absent from the evidence is treated as missing', proof({}), entra(), no],
  ])('%s', (_name, input, pol, expected) => {
    expect(evaluateOidcEligibility(input, pol)).toEqual(expected)
  })
})

describe('oidcEmailState', () => {
  it.each([
    [
      'no email attribute',
      proof({ email_verified: present(true) }, null),
      policy(),
      false,
      'no_email',
    ],
    ['email_verified true', proof({ email_verified: present(true) }), policy(), false, 'verified'],
    [
      'email_verified false',
      proof({ email_verified: present(false) }),
      policy(),
      false,
      'unverified',
    ],
    [
      'email_verified false for an Entra member',
      proof({ email_verified: present(false) }),
      entra(),
      false,
      'unverified',
    ],
    [
      'email_verified a string',
      proof({ email_verified: present('true') }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing on a non-Entra policy',
      proof({ email_verified: missing }),
      policy(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra member',
      proof({ email_verified: missing }),
      entra(),
      false,
      'missing_claim',
    ],
    ['missing for an Entra guest', proof({ email_verified: missing }), entra(), true, 'unverified'],
    [
      'unsupported email_verified',
      proof({ email_verified: unsupported }),
      entra(),
      false,
      'unverified',
    ],
    [
      'no email wins over a verified claim',
      proof({ email_verified: present(true) }, null),
      entra(),
      false,
      'no_email',
    ],
  ])('%s', (_name, input, pol, guest, expected) => {
    expect(oidcEmailState(input, pol, guest)).toBe(expected)
  })
})
