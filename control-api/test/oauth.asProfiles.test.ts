import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  AS_PROFILE_IDS,
  ENTRA_BLOCKED_RESOURCE_APPS,
  ENTRA_KNOWN_RESOURCE_APPS,
  ENTRA_TENANT_AUTHORITY_TEMPLATE,
  ENTRA_TENANT_ISSUER_PATTERN,
  SCOPE_TOKEN_RE,
  asProfileById,
  detectAsProfile,
  isAsProfileId,
  isEntraMultiTenantAuthority,
  isEntraTenantAuthority,
  profileHasResourceScope,
  profileScopeViolation,
  profileUnverifiedScopes,
  remoteWireForProfile,
  withProfileScopes,
} from '../src/oauth/asProfiles.js'
import { ENTRA_AGENT365_MAIL_PILOT, ENTRA_WORKIQ_PILOT } from './fixtures/remoteOAuthDiscovery.js'

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const TENANT_ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`
const WORKIQ_URL = ENTRA_WORKIQ_PILOT.mcpUrl
const AGENT365_URL = ENTRA_AGENT365_MAIL_PILOT.mcpUrl
const WORKIQ_GUID_SCOPE = 'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask'
const AGENT365_GUID_SCOPE = '05879165-0320-489e-b644-f72b33f3edf0/McpServers.Mail.All'
const UNKNOWN_GUID_SCOPE = '11111111-2222-3333-4444-555555555555/Tools.Read'

// Literal copies of the closed tables: a typo or a dropped entry in the module must
// turn this red, so these are written out, never derived from the Map under test.
const BLOCKED_LITERAL: Array<[string, string]> = [
  ['00000003-0000-0000-c000-000000000000', 'Microsoft Graph'],
  ['00000003-0000-0ff1-ce00-000000000000', 'SharePoint Online'],
  ['00000002-0000-0ff1-ce00-000000000000', 'Exchange Online'],
  ['797f4846-ba00-4fd7-ba43-dac1f8f63013', 'Azure Service Management'],
  ['00000002-0000-0000-c000-000000000000', 'Azure AD Graph'],
  ['cfa8b339-82a2-471a-a3c9-0fc0be7a4093', 'Azure Key Vault'],
  ['e406a681-f3d4-42a8-90b6-c2b029497af1', 'Azure Storage'],
  ['c5393580-f805-4401-95e8-94b7a6ef2fc2', 'Office 365 Management APIs'],
  ['0000000a-0000-0000-c000-000000000000', 'Microsoft Intune'],
  ['fc780465-2017-40d4-a0c5-307022471b92', 'WindowsDefenderATP'],
  ['00000004-0000-0ff1-ce00-000000000000', 'Skype for Business Online'],
  ['00000007-0000-0000-c000-000000000000', 'Dynamics CRM'],
  ['022907d3-0f1b-48f7-badc-1ba6abab6d66', 'Azure SQL Database'],
  ['ca7f3f0b-7d91-482c-8e09-c5d840d0eac5', 'Log Analytics API'],
  ['48ac35b8-9aa8-4d74-927d-1f4a14a0b239', 'Skype and Teams Tenant Admin API'],
  ['cc15fd57-2c6c-4117-a88c-83b1d56b4bbe', 'Microsoft Teams Services'],
]
const KNOWN_LITERAL: Array<[string, string]> = [
  ['fdcc1f02-fc51-4226-8753-f668596af7f7', 'workiq.svc.cloud.microsoft'],
  ['05879165-0320-489e-b644-f72b33f3edf0', 'agent365.svc.cloud.microsoft'],
]

describe('closed tables', () => {
  it('ENTRA_BLOCKED_RESOURCE_APPS is exactly the 16 high-impact first-party APIs', () => {
    expect([...ENTRA_BLOCKED_RESOURCE_APPS.entries()]).toEqual(BLOCKED_LITERAL)
  })

  it('ENTRA_KNOWN_RESOURCE_APPS ties exactly Work IQ and Agent 365 Tools to their hosts', () => {
    expect([...ENTRA_KNOWN_RESOURCE_APPS.entries()]).toEqual(KNOWN_LITERAL)
  })

  it('constants', () => {
    expect(AS_PROFILE_IDS).toEqual(['entra-v2'])
    expect(ENTRA_TENANT_AUTHORITY_TEMPLATE).toBe(
      'https://login.microsoftonline.com/{tenantId}/v2.0'
    )
    expect(ENTRA_TENANT_ISSUER_PATTERN).toBe(
      '^https://login[.]microsoftonline[.]com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/v2[.]0$'
    )
  })
})

describe('detectAsProfile / isEntraTenantAuthority', () => {
  it('recognises the tenant issuer the real Entra tenant metadata declares', () => {
    const issuer = JSON.parse(ENTRA_WORKIQ_PILOT.as.json).issuer as string
    expect(issuer).toBe(TENANT_ISSUER)
    const profile = detectAsProfile(issuer)
    expect(profile).toEqual({
      id: 'entra-v2',
      pkceS256: true,
      supportsRefresh: true,
      requiredScopes: ['offline_access'],
    })
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile?.requiredScopes)).toBe(true)
    expect(profile).toBe(asProfileById('entra-v2'))
    expect(isEntraTenantAuthority(issuer)).toBe(true)
  })

  const organizationsIssuer = JSON.parse(ENTRA_WORKIQ_PILOT.asExtra?.[0].json ?? '{}')
    .issuer as string
  for (const issuer of [
    `https://login.microsoftonline.com/${TENANT.toUpperCase()}/v2.0`,
    'https://login.microsoftonline.com/common/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0',
    organizationsIssuer,
    'https://login.microsoftonline.com/{tenantid}/v2.0',
    `${TENANT_ISSUER}/`,
    `https://login.microsoftonline.us/${TENANT}/v2.0`,
    `https://login.partner.microsoftonline.cn/${TENANT}/v2.0`,
    `https://login.microsoftonline.de/${TENANT}/v2.0`,
    `http://login.microsoftonline.com/${TENANT}/v2.0`,
    `${TENANT_ISSUER}?`,
    `${TENANT_ISSUER}?x=1`,
    `${TENANT_ISSUER}#`,
    `${TENANT_ISSUER}#f`,
    `https://login.microsoftonline.com:443/${TENANT}/v2.0`,
    `https://u@login.microsoftonline.com/${TENANT}/v2.0`,
    `https://login.microsoftonline.com/${TENANT}/v2.0\n`,
    `https://loginXmicrosoftonline.com/${TENANT}/v2.0`,
    `https://login.microsoftonline.com/${TENANT}/v2x0`,
    `https://sts.windows.net/${TENANT}/`,
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
    '',
  ]) {
    it(`null for ${JSON.stringify(issuer)}`, () => {
      expect(detectAsProfile(issuer)).toBeNull()
      expect(isEntraTenantAuthority(issuer)).toBe(false)
    })
  }

  const guidArb = fc.uuid().map(u => u.toLowerCase())
  const issuerArb = fc.oneof(
    fc.string(),
    fc.stringMatching(new RegExp(ENTRA_TENANT_ISSUER_PATTERN)),
    fc
      .tuple(
        fc.constantFrom('https://', 'http://', 'https://u@'),
        fc.constantFrom(
          'login.microsoftonline.com',
          'login.microsoftonline.us',
          'LOGIN.microsoftonline.com'
        ),
        fc.oneof(
          guidArb,
          guidArb.map(g => g.toUpperCase()),
          fc.constantFrom('common', 'organizations')
        ),
        fc.constantFrom('/v2.0', '/v2.0/', '/v2.0?', '/v2.0#', '/v1.0', '')
      )
      .map(([scheme, host, tenant, tail]) => `${scheme}${host}/${tenant}${tail}`)
  )

  it('property: detectAsProfile(s) !== null iff s matches ENTRA_TENANT_ISSUER_PATTERN', () => {
    const re = new RegExp(ENTRA_TENANT_ISSUER_PATTERN)
    fc.assert(
      fc.property(issuerArb, s => {
        expect(detectAsProfile(s) !== null).toBe(re.test(s))
      })
    )
  })

  it('property: isEntraTenantAuthority agrees with detectAsProfile', () => {
    fc.assert(
      fc.property(issuerArb, s => {
        expect(isEntraTenantAuthority(s)).toBe(detectAsProfile(s) !== null)
      })
    )
  })
})

describe('isAsProfileId / asProfileById / remoteWireForProfile', () => {
  it('isAsProfileId accepts only entra-v2', () => {
    expect(isAsProfileId('entra-v2')).toBe(true)
    for (const v of ['Entra-v2', 'entra-v1', 'entra', '', undefined, null, 1, {}, ['entra-v2']]) {
      expect(isAsProfileId(v)).toBe(false)
    }
  })

  it('remoteWireForProfile', () => {
    expect(remoteWireForProfile(undefined)).toEqual({
      sendResource: true,
      scopeOnTokenRequests: false,
    })
    expect(remoteWireForProfile('entra-v2')).toEqual({
      sendResource: false,
      scopeOnTokenRequests: true,
    })
  })
})

describe('withProfileScopes', () => {
  it('without a profile returns a copy of the scopes as-is', () => {
    const scopes = ['a', 'b', 'a']
    const out = withProfileScopes(scopes, undefined)
    expect(out).toEqual(['a', 'b', 'a'])
    expect(out).not.toBe(scopes)
  })

  it('entra-v2 appends offline_access when missing, dedupes and keeps order', () => {
    expect(withProfileScopes([WORKIQ_GUID_SCOPE], 'entra-v2')).toEqual([
      WORKIQ_GUID_SCOPE,
      'offline_access',
    ])
    expect(withProfileScopes(['offline_access', 'x', 'x'], 'entra-v2')).toEqual([
      'offline_access',
      'x',
    ])
    expect(withProfileScopes([], 'entra-v2')).toEqual(['offline_access'])
  })

  it('entra-v2 does not duplicate the offline_access the real Agent 365 PRM already carries', () => {
    const prmScopes = JSON.parse(ENTRA_AGENT365_MAIL_PILOT.prm.json).scopes_supported as string[]
    expect(withProfileScopes(prmScopes, 'entra-v2')).toEqual(prmScopes)
  })

  it('property: idempotent, duplicate-free and always contains offline_access with the profile', () => {
    const scopeArb = fc.array(fc.constantFrom('a', 'b', 'offline_access', 'openid', 'c/x'), {
      maxLength: 8,
    })
    fc.assert(
      fc.property(scopeArb, scopes => {
        const once = withProfileScopes(scopes, 'entra-v2')
        expect(withProfileScopes(once, 'entra-v2')).toEqual(once)
        expect(new Set(once).size).toBe(once.length)
        expect(once).toContain('offline_access')
        expect(once.filter(s => s !== 'offline_access')).toEqual(
          [...new Set(scopes)].filter(s => s !== 'offline_access')
        )
      })
    )
  })
})

describe('profileScopeViolation', () => {
  it('null without a profile, whatever the scopes', () => {
    expect(profileScopeViolation(undefined, WORKIQ_URL, ['Mail.Read', 'bad scope'])).toBeNull()
  })

  const accepted: Array<[string, string]> = [
    [WORKIQ_URL, WORKIQ_GUID_SCOPE],
    [WORKIQ_URL, 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'],
    [WORKIQ_URL, 'https://workiq.svc.cloud.microsoft/WorkIQAgent.Ask'],
    [
      AGENT365_URL,
      `https://agent365.svc.cloud.microsoft/agents/tenants/${TENANT}/servers/mcp_MailTools/.default`,
    ],
    [WORKIQ_URL, 'offline_access'],
    [WORKIQ_URL, 'openid'],
    [WORKIQ_URL, 'profile'],
    [WORKIQ_URL, 'email'],
    [AGENT365_URL, AGENT365_GUID_SCOPE],
    [AGENT365_URL, `api://${AGENT365_GUID_SCOPE}`],
    // Not rejected: whether it can be tied to the host is profileUnverifiedScopes' call.
    [WORKIQ_URL, UNKNOWN_GUID_SCOPE],
  ]
  for (const [base, scope] of accepted) {
    it(`accepts ${scope}`, () => {
      expect(profileScopeViolation('entra-v2', base, [scope])).toBeNull()
    })
  }

  it('accepts every scope of the real Work IQ and Agent 365 PRMs', () => {
    for (const pilot of [ENTRA_WORKIQ_PILOT, ENTRA_AGENT365_MAIL_PILOT]) {
      const scopes = JSON.parse(pilot.prm.json).scopes_supported as string[]
      expect(profileScopeViolation('entra-v2', pilot.mcpUrl, scopes)).toBeNull()
    }
  })

  const blockedGuids = [
    '00000003-0000-0000-c000-000000000000',
    '00000003-0000-0ff1-ce00-000000000000',
    '00000002-0000-0ff1-ce00-000000000000',
    '797f4846-ba00-4fd7-ba43-dac1f8f63013',
    '00000002-0000-0000-c000-000000000000',
    'cfa8b339-82a2-471a-a3c9-0fc0be7a4093',
    'e406a681-f3d4-42a8-90b6-c2b029497af1',
    'c5393580-f805-4401-95e8-94b7a6ef2fc2',
    '0000000a-0000-0000-c000-000000000000',
    'fc780465-2017-40d4-a0c5-307022471b92',
    '00000004-0000-0ff1-ce00-000000000000',
    '00000007-0000-0000-c000-000000000000',
    '022907d3-0f1b-48f7-badc-1ba6abab6d66',
    'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5',
    '48ac35b8-9aa8-4d74-927d-1f4a14a0b239',
    'cc15fd57-2c6c-4117-a88c-83b1d56b4bbe',
  ]
  const rejected = [
    'https://graph.microsoft.com/Mail.Read',
    'Mail.Read',
    ...blockedGuids.flatMap(guid => [`${guid}/x`, `api://${guid}/x`]),
    'api://evil.example/x',
    'https://[mal',
    'api://00000003-0000-0000-c000-000000000000@workiq.svc.cloud.microsoft/Mail.Read',
    'https://graph.microsoft.com@workiq.svc.cloud.microsoft/Mail.Read',
    'https://workiq.svc.cloud.microsoft:443/x',
    'https://WORKIQ.svc.cloud.microsoft/x',
    `api://${TENANT}/myapp/Read`,
    'https://workiq.svc.cloud.microsoft\\x',
    'https://workiq.svc.cloud.microsoft/a b',
    'api://workiq.svc.cloud.microsoft/a"b',
    'https://workiq.svc.cloud.microsoft.evil.example/x',
    'https://workiq.svc.cloud.microsoft',
    'FDCC1F02-FC51-4226-8753-F668596AF7F7/WorkIQAgent.Ask',
    AGENT365_GUID_SCOPE,
    `api://${AGENT365_GUID_SCOPE}`,
    '',
  ]
  for (const scope of rejected) {
    it(`rejects ${JSON.stringify(scope)}`, () => {
      expect(profileScopeViolation('entra-v2', WORKIQ_URL, [scope])).toBe(scope)
    })
  }

  it('the 16 blocked GUIDs are rejected in both forms (written as literals)', () => {
    expect(blockedGuids).toHaveLength(16)
    for (const guid of blockedGuids) {
      expect(profileScopeViolation('entra-v2', WORKIQ_URL, [`${guid}/x`])).toBe(`${guid}/x`)
      expect(profileScopeViolation('entra-v2', WORKIQ_URL, [`api://${guid}/x`])).toBe(
        `api://${guid}/x`
      )
    }
  })

  it('a known GUID is accepted only on the host tied to it', () => {
    for (const [scope, ownBase] of [
      [WORKIQ_GUID_SCOPE, WORKIQ_URL],
      [AGENT365_GUID_SCOPE, AGENT365_URL],
    ]) {
      expect(profileScopeViolation('entra-v2', ownBase, [scope])).toBeNull()
      for (const base of [WORKIQ_URL, AGENT365_URL, 'https://evil.example/mcp']) {
        if (base === ownBase) continue
        expect(profileScopeViolation('entra-v2', base, [scope])).toBe(scope)
        expect(profileScopeViolation('entra-v2', base, [`api://${scope}`])).toBe(`api://${scope}`)
      }
    }
  })

  it('returns the first rejected scope, in order', () => {
    expect(
      profileScopeViolation('entra-v2', WORKIQ_URL, [
        WORKIQ_GUID_SCOPE,
        'offline_access',
        'Mail.Read',
        'https://graph.microsoft.com/x',
      ])
    ).toBe('Mail.Read')
  })
})

describe('profileHasResourceScope', () => {
  it('false with the profile when only OIDC scopes (or none) are requested', () => {
    for (const scopes of [
      ['offline_access'],
      ['openid', 'profile', 'email', 'offline_access'],
      [],
    ]) {
      expect(profileHasResourceScope('entra-v2', WORKIQ_URL, scopes)).toBe(false)
    }
  })

  it('true with any scope accepted by the GUID or host-URL rule', () => {
    for (const scope of [
      WORKIQ_GUID_SCOPE,
      UNKNOWN_GUID_SCOPE,
      'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask',
      'https://workiq.svc.cloud.microsoft/x',
    ]) {
      expect(profileHasResourceScope('entra-v2', WORKIQ_URL, ['offline_access', scope])).toBe(true)
    }
  })

  it('false when the only non-OIDC scopes are rejected ones', () => {
    for (const scope of [
      'Mail.Read',
      'https://graph.microsoft.com/x',
      '00000003-0000-0000-c000-000000000000/x',
      'https://workiq.svc.cloud.microsoft/a b',
    ]) {
      expect(profileHasResourceScope('entra-v2', WORKIQ_URL, ['openid', scope])).toBe(false)
    }
  })

  it('true without a profile', () => {
    expect(profileHasResourceScope(undefined, WORKIQ_URL, [])).toBe(true)
    expect(profileHasResourceScope(undefined, WORKIQ_URL, ['offline_access'])).toBe(true)
  })
})

describe('profileUnverifiedScopes', () => {
  it('[] for the known GUIDs on their own host (both forms), the URL form and OIDC', () => {
    expect(
      profileUnverifiedScopes('entra-v2', WORKIQ_URL, [
        WORKIQ_GUID_SCOPE,
        `api://${WORKIQ_GUID_SCOPE}`,
        'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask',
        'openid',
        'profile',
        'email',
        'offline_access',
      ])
    ).toEqual([])
    expect(
      profileUnverifiedScopes('entra-v2', AGENT365_URL, [
        AGENT365_GUID_SCOPE,
        `api://${AGENT365_GUID_SCOPE}`,
        `https://agent365.svc.cloud.microsoft/agents/tenants/${TENANT}/servers/mcp_MailTools/.default`,
      ])
    ).toEqual([])
  })

  it('an unknown GUID is unverified (order kept, no duplicates)', () => {
    expect(
      profileUnverifiedScopes('entra-v2', WORKIQ_URL, [
        UNKNOWN_GUID_SCOPE,
        WORKIQ_GUID_SCOPE,
        `api://${UNKNOWN_GUID_SCOPE}`,
        UNKNOWN_GUID_SCOPE,
      ])
    ).toEqual([UNKNOWN_GUID_SCOPE, `api://${UNKNOWN_GUID_SCOPE}`])
  })

  it('a known GUID on another host is never unverified (it is rejected instead)', () => {
    expect(profileUnverifiedScopes('entra-v2', WORKIQ_URL, [AGENT365_GUID_SCOPE])).toEqual([])
    expect(profileUnverifiedScopes('entra-v2', AGENT365_URL, [WORKIQ_GUID_SCOPE])).toEqual([])
    expect(
      profileUnverifiedScopes('entra-v2', 'https://evil.example/mcp', [WORKIQ_GUID_SCOPE])
    ).toEqual([])
  })

  it('a blocked GUID is never unverified (it is rejected instead)', () => {
    expect(
      profileUnverifiedScopes('entra-v2', WORKIQ_URL, ['00000003-0000-0000-c000-000000000000/x'])
    ).toEqual([])
  })

  it('[] without a profile', () => {
    expect(profileUnverifiedScopes(undefined, WORKIQ_URL, [UNKNOWN_GUID_SCOPE])).toEqual([])
  })
})

describe('high-impact first-party data APIs are blocked, not confirmable', () => {
  const dataApiGuids = [
    '00000007-0000-0000-c000-000000000000', // Dynamics CRM
    '022907d3-0f1b-48f7-badc-1ba6abab6d66', // Azure SQL Database
    'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5', // Log Analytics API
    '48ac35b8-9aa8-4d74-927d-1f4a14a0b239', // Skype and Teams Tenant Admin API
    'cc15fd57-2c6c-4117-a88c-83b1d56b4bbe', // Microsoft Teams Services
  ]

  for (const guid of dataApiGuids) {
    for (const scope of [`${guid}/x`, `api://${guid}/x`]) {
      it(`${scope} is a violation and never unverified`, () => {
        expect(profileScopeViolation('entra-v2', WORKIQ_URL, [scope])).toBe(scope)
        expect(profileUnverifiedScopes('entra-v2', WORKIQ_URL, [scope])).toEqual([])
      })
    }
  }

  // Their URL-form audience lives on a host other than their MCP server, so the GUID form
  // is the only way to connect them and must stay confirmable rather than blocked.
  for (const [name, scope] of [
    ['Azure DevOps', '499b84ac-1321-427f-aa17-267ca6975798/.default'],
    ['Power BI Service', '00000009-0000-0000-c000-000000000000/.default'],
  ]) {
    it(`${name} stays an unknown GUID that needs confirmation`, () => {
      expect(profileScopeViolation('entra-v2', WORKIQ_URL, [scope])).toBeNull()
      expect(profileUnverifiedScopes('entra-v2', WORKIQ_URL, [scope])).toEqual([scope])
    })
  }
})

describe('audience classification properties', () => {
  const knownOrBlockedGuid = fc.constantFrom(
    ...BLOCKED_LITERAL.map(([g]) => g),
    ...KNOWN_LITERAL.map(([g]) => g)
  )
  const guidArb = fc.oneof(
    knownOrBlockedGuid,
    fc.uuid().map(u => u.toLowerCase()),
    fc.uuid()
  )
  const hostArb = fc.constantFrom(
    'workiq.svc.cloud.microsoft',
    'agent365.svc.cloud.microsoft',
    'graph.microsoft.com',
    'evil.example'
  )
  const scopeArb = fc.oneof(
    fc.string(),
    fc.constantFrom('openid', 'profile', 'email', 'offline_access', 'Mail.Read'),
    fc
      .tuple(fc.constantFrom('', 'api://'), guidArb, fc.string({ minLength: 1 }))
      .map(([p, g, name]) => `${p}${g}/${name}`),
    fc
      .tuple(
        fc.constantFrom('https://', 'api://'),
        hostArb,
        fc.constantFrom('/', ':443/', '@x/'),
        fc.string()
      )
      .map(([p, h, sep, rest]) => `${p}${h}${sep}${rest}`)
  )
  const baseArb = hostArb.map(h => `https://${h}/mcp`)

  it('no scope is both a violation and unverified; a blocked GUID is never unverified', () => {
    fc.assert(
      fc.property(baseArb, scopeArb, (base, scope) => {
        const violation = profileScopeViolation('entra-v2', base, [scope])
        const unverified = profileUnverifiedScopes('entra-v2', base, [scope])
        expect(violation !== null && unverified.includes(scope)).toBe(false)
        const guid = /^(?:api:\/\/)?([0-9a-f-]{36})\//.exec(scope)?.[1]
        if (guid !== undefined && BLOCKED_LITERAL.some(([g]) => g === guid)) {
          expect(unverified).toEqual([])
        }
      })
    )
  })

  it('a known GUID is a violation exactly when the base URL is not on its host', () => {
    fc.assert(
      fc.property(
        hostArb,
        fc.constantFrom(...KNOWN_LITERAL),
        fc.constantFrom('', 'api://'),
        (host, [guid, knownHost], prefix) => {
          const scope = `${prefix}${guid}/Read`
          const violation = profileScopeViolation('entra-v2', `https://${host}/mcp`, [scope])
          expect(violation).toBe(host === knownHost ? null : scope)
        }
      )
    )
  })

  it('every scope the profile accepts is an RFC 6749 scope-token', () => {
    fc.assert(
      fc.property(baseArb, scopeArb, (base, scope) => {
        if (profileScopeViolation('entra-v2', base, [scope]) === null) {
          expect(SCOPE_TOKEN_RE.test(scope)).toBe(true)
        }
      })
    )
  })
})

describe('isEntraMultiTenantAuthority', () => {
  const yes = [
    'https://login.microsoftonline.com/organizations/v2.0',
    'https://login.microsoftonline.com/common/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0/',
    'https://login.microsoftonline.com/common/v2.0//',
    JSON.parse(ENTRA_WORKIQ_PILOT.prm.json).authorization_servers[0] as string,
    JSON.parse(ENTRA_AGENT365_MAIL_PILOT.prm.json).authorization_servers[0] as string,
  ]
  const no = [
    TENANT_ISSUER,
    'http://login.microsoftonline.com/organizations/v2.0',
    'https://login.microsoftonline.com:8443/organizations/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0?x=1',
    'https://login.microsoftonline.com/organizations/v2.0#f',
    'https://u:p@login.microsoftonline.com/organizations/v2.0',
    'https://login.microsoftonline.us/organizations/v2.0',
    'https://login.microsoftonline.com/consumers/v2.0',
    'https://login.microsoftonline.com/organizations',
    'https://login.microsoftonline.com/organizations/v2.0/extra',
    'https://evil.example/organizations/v2.0',
  ]
  for (const url of yes) {
    it(`true for ${url}`, () => expect(isEntraMultiTenantAuthority(new URL(url))).toBe(true))
  }
  for (const url of no) {
    it(`false for ${url}`, () => expect(isEntraMultiTenantAuthority(new URL(url))).toBe(false))
  }
})

describe('CRD parity', () => {
  it('the mcpserver.yaml AS-PROFILE-ISSUER rule carries ENTRA_TENANT_ISSUER_PATTERN verbatim', () => {
    const crdPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../charts/clerum-crds/crds/mcpserver.yaml'
    )
    const crd = parse(readFileSync(crdPath, 'utf8')) as {
      spec: {
        versions: Array<{
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: { 'x-kubernetes-validations': Array<{ rule: string; message: string }> }
              }
            }
          }
        }>
      }
    }
    const rules =
      crd.spec.versions[0].schema.openAPIV3Schema.properties.spec['x-kubernetes-validations']
    const asProfileIssuer = rules.find(r =>
      r.message.startsWith('spec.oauth.asProfile entra-v2 requires')
    )
    expect(asProfileIssuer, 'AS-PROFILE-ISSUER rule present').toBeDefined()
    expect(asProfileIssuer?.rule).toContain(`.matches('${ENTRA_TENANT_ISSUER_PATTERN}')`)
  })
})
