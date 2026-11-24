import { describe, expect, it } from 'vitest'
import type { OidcMemberSignInPolicy } from '../src/oidc/configuration.js'
import {
  BASE_MEMBER_POLICY_EVIDENCE_CLAIM_NAMES,
  evaluateOidcEligibility,
  memberPolicyEvidenceClaimNames,
  oidcEmailState,
} from '../src/oidc/memberEligibility.js'
import type {
  OidcVerifiedClaimObservation,
  VerifiedOidcIdentityProof,
} from '../src/oidc/protocolEngine.js'

const TENANT = '11111111-2222-3333-4444-555555555555'
const ISSUER = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'

const present = (value: unknown): OidcVerifiedClaimObservation =>
  ({ status: 'present', value }) as OidcVerifiedClaimObservation
const missing: OidcVerifiedClaimObservation = { status: 'missing' }
const unsupported: OidcVerifiedClaimObservation = { status: 'unsupported' }

function proof(
  claims: Record<string, OidcVerifiedClaimObservation>,
  email: string | null = 'member@example.test'
): VerifiedOidcIdentityProof {
  return {
    issuer: ISSUER,
    attributes: { source: 'validated_id_token', ...(email === null ? {} : { email }) },
    verifiedClaims: { source: 'validated_id_token', claims },
  } as unknown as VerifiedOidcIdentityProof
}

function policy(overrides: Partial<OidcMemberSignInPolicy> = {}): OidcMemberSignInPolicy {
  return {
    entraTenantId: null,
    requiredClaim: null,
    allowGuests: false,
    newMemberTeamId: null,
    accountCreation: 'disabled',
    ...overrides,
  }
}
const entra = (overrides: Partial<OidcMemberSignInPolicy> = {}) =>
  policy({ entraTenantId: TENANT, ...overrides })
const requiresRole = policy({ requiredClaim: { name: 'roles', value: 'Evenfire.User' } })
const requires = (name: string, value: string) => policy({ requiredClaim: { name, value } })

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
      'Entra with an unsupported xms_edov',
      proof({ tid: present(TENANT), xms_edov: unsupported }),
      entra(),
      no,
    ],
    [
      'Entra member whose idp is the tenant issuer',
      proof({
        tid: present(TENANT),
        idp: present('https://sts.windows.net/11111111-2222-3333-4444-555555555555/'),
      }),
      entra(),
      ok,
    ],
    [
      'Entra member whose idp equals the v2.0 issuer (documented same-tenant value)',
      proof({
        tid: present(TENANT),
        idp: present('https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'),
      }),
      entra(),
      ok,
    ],
    ...(
      [
        [
          'another tenant v2.0 issuer',
          `https://login.microsoftonline.com/${'99999999-8888-7777-6666-555555555555'}/v2.0`,
        ],
        [
          'another tenant v1 issuer',
          'https://sts.windows.net/99999999-8888-7777-6666-555555555555/',
        ],
        ['live.com', 'live.com'],
      ] as const
    ).flatMap(([shape, value]) => [
      [
        `Entra guest by idp ${shape} with allowGuests false`,
        proof({ tid: present(TENANT), idp: present(value) }),
        entra(),
        no,
      ] as const,
      [
        `Entra guest by idp ${shape} with allowGuests true`,
        proof({ tid: present(TENANT), idp: present(value) }),
        entra({ allowGuests: true }),
        guestOk,
      ] as const,
    ]),
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
    // The member check fails closed: any present acct other than the number 0
    // is a guest, and is refused without ALLOW_GUESTS.
    ...(
      [
        ['the string "0"', '0'],
        ['the string "1"', '1'],
        ['the number 2', 2],
        ['true', true],
      ] as const
    ).flatMap(([shape, value]) => [
      [
        `Entra guest by acct ${shape} with allowGuests false`,
        proof({ tid: present(TENANT), acct: present(value) }),
        entra(),
        no,
      ] as const,
      [
        `Entra guest by acct ${shape} with allowGuests true`,
        proof({ tid: present(TENANT), acct: present(value) }),
        entra({ allowGuests: true }),
        guestOk,
      ] as const,
    ]),
    [
      'Entra member with acct === 0 and no idp (control)',
      proof({ tid: present(TENANT), acct: present(0), idp: missing }),
      entra(),
      ok,
    ],
    [
      'Entra guest by a foreign idp despite acct === 0',
      proof({ tid: present(TENANT), acct: present(0), idp: present('live.com') }),
      entra(),
      no,
    ],
    [
      'Entra member with acct === 0 and the tenant idp (control)',
      proof({
        tid: present(TENANT),
        acct: present(0),
        idp: present('https://sts.windows.net/11111111-2222-3333-4444-555555555555/'),
      }),
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
      'required roles claim present in roles',
      proof({ roles: present(['a', 'Evenfire.User']) }),
      requiresRole,
      ok,
    ],
    ['required roles claim absent from roles', proof({ roles: present(['a']) }), requiresRole, no],
    [
      'required roles claim with a missing roles claim',
      proof({ roles: missing }),
      requiresRole,
      no,
    ],
    [
      'required roles claim with roles as a matching string',
      proof({ roles: present('Evenfire.User') }),
      requiresRole,
      ok,
    ],
    [
      'required roles claim with a non-string entry in roles',
      proof({ roles: present(['Evenfire.User', 3]) }),
      requiresRole,
      no,
    ],
    ['unsupported roles', proof({ roles: unsupported }), requiresRole, no],
    ['unsupported roles without a required claim', proof({ roles: unsupported }), policy(), no],
    ['unsupported email_verified', proof({ email_verified: unsupported }), policy(), no],
    ['an observation absent from the evidence is treated as missing', proof({}), entra(), no],
  ])('%s', (_name, input, pol, expected) => {
    expect(evaluateOidcEligibility(input, pol)).toEqual(expected)
  })
})

describe('the required claim', () => {
  const ok = { eligible: true, guest: false }
  const no = { eligible: false, reason: 'not_eligible' }
  const groups = requires('groups', 'Evenfire Members')

  it('matches a string claim exactly', () => {
    expect(evaluateOidcEligibility(proof({ groups: present('Evenfire Members') }), groups)).toEqual(
      ok
    )
    for (const near of ['evenfire members', 'Evenfire Members ', 'Evenfire', 'Evenfire Members+']) {
      expect(evaluateOidcEligibility(proof({ groups: present(near) }), groups)).toEqual(no)
    }
  })

  it('matches an array of strings containing the value', () => {
    expect(
      evaluateOidcEligibility(
        proof({ groups: present(['Staff', 'Evenfire Members', 'Contractors']) }),
        groups
      )
    ).toEqual(ok)
    expect(evaluateOidcEligibility(proof({ groups: present(['Staff']) }), groups)).toEqual(no)
    expect(evaluateOidcEligibility(proof({ groups: present([]) }), groups)).toEqual(no)
  })

  it('refuses an array element that is only part of the value', () => {
    for (const part of ['Evenfire', 'Members', '', 'Evenfire Members Plus']) {
      expect(evaluateOidcEligibility(proof({ groups: present([part]) }), groups)).toEqual(no)
      expect(evaluateOidcEligibility(proof({ groups: present(part) }), groups)).toEqual(no)
    }
    const superadmin = requires('roles', 'superadmin')
    for (const part of [['admin'], ['super'], ['super', 'admin']]) {
      expect(evaluateOidcEligibility(proof({ roles: present(part) }), superadmin)).toEqual(no)
    }
    // Positive control: the whole value as an element matches.
    expect(
      evaluateOidcEligibility(proof({ groups: present(['Evenfire', 'Evenfire Members']) }), groups)
    ).toEqual(ok)
    expect(evaluateOidcEligibility(proof({ roles: present(['superadmin']) }), superadmin)).toEqual(
      ok
    )
  })

  it('refuses superadmin and administrators for admin, as a string and as an array element', () => {
    const admin = requires('roles', 'admin')
    for (const value of ['superadmin', 'administrators']) {
      expect(evaluateOidcEligibility(proof({ roles: present(value) }), admin)).toEqual(no)
      expect(evaluateOidcEligibility(proof({ roles: present([value]) }), admin)).toEqual(no)
    }
    // Positive control: the exact value matches in both shapes.
    expect(evaluateOidcEligibility(proof({ roles: present('admin') }), admin)).toEqual(ok)
    expect(evaluateOidcEligibility(proof({ roles: present(['admin']) }), admin)).toEqual(ok)
  })

  it('refuses a mixed array', () => {
    for (const mixed of [
      ['Evenfire Members', 3],
      ['Evenfire Members', null],
      ['Evenfire Members', ['Evenfire Members']],
      ['Evenfire Members', { name: 'Evenfire Members' }],
    ]) {
      expect(evaluateOidcEligibility(proof({ groups: present(mixed) }), groups)).toEqual(no)
    }
    // Positive control: the same array without the non-string element matches.
    expect(
      evaluateOidcEligibility(proof({ groups: present(['Evenfire Members']) }), groups)
    ).toEqual(ok)
  })

  it.each([
    ['a number', 7],
    ['a boolean', true],
    ['null', null],
    ['an object', { 'Evenfire Members': true }],
  ])('refuses a claim that is %s', (_shape, value) => {
    expect(evaluateOidcEligibility(proof({ groups: present(value) }), groups)).toEqual(no)
    // Positive control: the same claim as a matching string is eligible.
    expect(evaluateOidcEligibility(proof({ groups: present('Evenfire Members') }), groups)).toEqual(
      ok
    )
  })

  it('refuses a missing claim', () => {
    expect(evaluateOidcEligibility(proof({ groups: missing }), groups)).toEqual(no)
    // A claim the evidence does not carry at all is missing too.
    expect(evaluateOidcEligibility(proof({}), groups)).toEqual(no)
    // Positive control: the same proof shape with the claim present matches.
    expect(evaluateOidcEligibility(proof({ groups: present('Evenfire Members') }), groups)).toEqual(
      ok
    )
  })

  it('refuses an unsupported claim', () => {
    expect(evaluateOidcEligibility(proof({ groups: unsupported }), groups)).toEqual(no)
    // An unsupported `roles` still refuses when another claim is required.
    expect(
      evaluateOidcEligibility(
        proof({ groups: present('Evenfire Members'), roles: unsupported }),
        groups
      )
    ).toEqual(no)
    // Positive control: the same claim present, with roles not unsupported, matches.
    expect(
      evaluateOidcEligibility(
        proof({ groups: present('Evenfire Members'), roles: missing }),
        groups
      )
    ).toEqual(ok)
  })

  it('applies alongside the Entra tenant check', () => {
    const entraGroups = entra({ requiredClaim: { name: 'groups', value: 'Evenfire Members' } })
    expect(
      evaluateOidcEligibility(
        proof({ tid: present(TENANT), groups: present(['Evenfire Members']) }),
        entraGroups
      )
    ).toEqual(ok)
    expect(
      evaluateOidcEligibility(
        proof({ tid: present('other'), groups: present(['Evenfire Members']) }),
        entraGroups
      )
    ).toEqual(no)
    expect(
      evaluateOidcEligibility(proof({ tid: present(TENANT), groups: missing }), entraGroups)
    ).toEqual(no)
  })
})

describe('memberPolicyEvidenceClaimNames', () => {
  it('keeps collecting roles when no claim is required', () => {
    expect(BASE_MEMBER_POLICY_EVIDENCE_CLAIM_NAMES).toEqual([
      'tid',
      'idp',
      'roles',
      'acct',
      'xms_edov',
    ])
    expect(memberPolicyEvidenceClaimNames(policy())).toEqual([
      'acct',
      'idp',
      'roles',
      'tid',
      'xms_edov',
    ])
    expect(memberPolicyEvidenceClaimNames(entra())).toEqual([
      'acct',
      'idp',
      'roles',
      'tid',
      'xms_edov',
    ])
  })

  it('adds the configured claim name once, sorted', () => {
    expect(memberPolicyEvidenceClaimNames(requires('groups', 'Evenfire Members'))).toEqual([
      'acct',
      'groups',
      'idp',
      'roles',
      'tid',
      'xms_edov',
    ])
    expect(memberPolicyEvidenceClaimNames(requires('hd', 'example.test'))).toEqual([
      'acct',
      'hd',
      'idp',
      'roles',
      'tid',
      'xms_edov',
    ])
    expect(memberPolicyEvidenceClaimNames(requiresRole)).toEqual([
      'acct',
      'idp',
      'roles',
      'tid',
      'xms_edov',
    ])
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
      'missing for an Entra member with xms_edov true',
      proof({ email_verified: missing, xms_edov: present(true) }),
      entra(),
      false,
      'verified',
    ],
    [
      'missing for an Entra member with xms_edov false',
      proof({ email_verified: missing, xms_edov: present(false) }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra member with xms_edov the string "true"',
      proof({ email_verified: missing, xms_edov: present('true') }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra member with xms_edov the number 1',
      proof({ email_verified: missing, xms_edov: present(1) }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra member with an unsupported xms_edov',
      proof({ email_verified: missing, xms_edov: unsupported }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra member with no xms_edov',
      proof({ email_verified: missing }),
      entra(),
      false,
      'domain_claim_missing',
    ],
    [
      'missing for an Entra member with xms_edov missing',
      proof({ email_verified: missing, xms_edov: missing }),
      entra(),
      false,
      'domain_claim_missing',
    ],
    [
      'email_verified false wins over xms_edov true for an Entra member',
      proof({ email_verified: present(false), xms_edov: present(true) }),
      entra(),
      false,
      'unverified',
    ],
    [
      'missing for an Entra guest, xms_edov true does not help',
      proof({ email_verified: missing, xms_edov: present(true) }),
      entra(),
      true,
      'unverified',
    ],
    ['missing for an Entra guest', proof({ email_verified: missing }), entra(), true, 'unverified'],
    [
      'missing on a non-Entra policy ignores xms_edov true',
      proof({ email_verified: missing, xms_edov: present(true) }),
      policy(),
      false,
      'unverified',
    ],
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
    ...(
      [
        ['leading whitespace', ' member@example.test'],
        ['trailing whitespace', 'member@example.test '],
        ['inner whitespace', 'mem ber@example.test'],
        ['a control character', 'member\u007f@example.test'],
        ['no @', 'member.example.test'],
        ['two @', 'member@other@example.test'],
        ['no dot in the domain', 'member@example'],
        ['more than 320 characters', `${'a'.repeat(308)}@example.test`],
        ['a dotted capital I (U+0130) in the domain', 'member@\u0130nfo.example.test'],
        ['a Kelvin sign (U+212A) in the domain', 'member@\u212Aelvin.example.test'],
        ['a non-ASCII local part', 'jos\u00e9@example.test'],
      ] as const
    ).map(
      ([shape, email]) =>
        [
          `a verified claim with ${shape} is no email`,
          proof({ email_verified: present(true) }, email),
          entra(),
          false,
          'no_email',
        ] as const
    ),
    [
      'a verified 320-character address is verified',
      proof({ email_verified: present(true) }, `${'a'.repeat(307)}@example.test`),
      entra(),
      false,
      'verified',
    ],
  ])('%s', (_name, input, pol, guest, expected) => {
    expect(oidcEmailState(input, pol, guest)).toBe(expected)
  })
})
