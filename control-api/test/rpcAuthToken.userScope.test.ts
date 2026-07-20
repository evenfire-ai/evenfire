import { describe, expect, it } from 'vitest'
import {
  classifyRpcTokenDenial,
  issueRpcAccessToken,
  signRpcAccessToken,
  verifyRpcAccessToken,
} from '../src/utils/auth/rpcAuthToken.js'

describe('RPC access token scope binding', () => {
  it('issues and verifies a user-scoped token without a team id', () => {
    const issued = issueRpcAccessToken(
      { userId: 'user-1', teamId: null, role: 'member' },
      ['host:message:invoke'],
      ['pro-agent']
    )

    expect(issued).toMatchObject({
      accessScope: 'user',
      teamId: null,
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
    })
    expect(verifyRpcAccessToken(issued!.token)).toMatchObject({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'user',
      teamId: null,
      hostRefs: ['pro-agent'],
    })
  })

  it('keeps team-scoped issuance unchanged', () => {
    const issued = issueRpcAccessToken(
      { userId: 'user-1', teamId: 'team-1', role: 'member' },
      ['host:message:invoke', 'desktop:view'],
      ['pro-agent']
    )

    expect(issued).toMatchObject({
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke', 'desktop:view'],
    })
    expect(verifyRpcAccessToken(issued!.token)).toMatchObject({
      accessScope: 'team',
      teamId: 'team-1',
    })
  })

  it('allows sandbox UI but drops desktop view from user-scoped tokens', () => {
    const issued = issueRpcAccessToken(
      { userId: 'user-1', teamId: null, role: 'member' },
      ['host:message:invoke', 'desktop:view', 'sandbox:ui:view'],
      ['pro-agent'],
      ['sandbox:ui:view']
    )

    expect(issued).toMatchObject({
      accessScope: 'user',
      teamId: null,
      scopes: ['host:message:invoke', 'sandbox:ui:view'],
      droppedScopes: ['desktop:view'],
    })
    expect(verifyRpcAccessToken(issued!.token)?.scopes).toEqual([
      'host:message:invoke',
      'sandbox:ui:view',
    ])
  })

  it('does not issue user-scoped tokens with only desktop view', () => {
    expect(
      issueRpcAccessToken(
        { userId: 'user-1', teamId: null, role: 'member' },
        ['desktop:view'],
        ['pro-agent']
      )
    ).toBeNull()
  })

  it('accepts legacy team tokens that predate the accessScope claim', () => {
    const token = signRpcAccessToken({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      jti: 'legacy-team-token',
    })

    expect(verifyRpcAccessToken(token)).toMatchObject({
      accessScope: 'team',
      teamId: 'team-1',
    })
  })

  it('rejects inconsistent scope/team combinations and wildcard hosts', () => {
    const userScopeWithTeam = signRpcAccessToken({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'user',
      teamId: 'team-1',
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      jti: 'invalid-user-team',
    })
    const teamScopeWithoutTeam = signRpcAccessToken({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: null,
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      jti: 'invalid-teamless-team-scope',
    })
    const wildcardHost = signRpcAccessToken({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'user',
      teamId: null,
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent', '*'],
      jti: 'invalid-wildcard',
    })

    expect(verifyRpcAccessToken(userScopeWithTeam)).toBeNull()
    expect(verifyRpcAccessToken(teamScopeWithoutTeam)).toBeNull()
    expect(verifyRpcAccessToken(wildcardHost)).toBeNull()
  })
})

describe('host:model:write default grant (spec §8.2)', () => {
  // Per-session model selection is granted to every role: the blast radius is the
  // caller's own session and the operator's control is the model allowlist.
  it.each(['admin', 'inviter', 'member'] as const)(
    'includes host:model:write in the default scopes for %s',
    role => {
      const issued = issueRpcAccessToken(
        { userId: 'user-1', teamId: 'team-1', role },
        [],
        ['pro-agent']
      )
      expect(issued?.scopes).toContain('host:model:write')
    }
  )

  it('grants host:model:write when explicitly requested by a member', () => {
    const issued = issueRpcAccessToken(
      { userId: 'user-1', teamId: 'team-1', role: 'member' },
      ['host:model:write'],
      ['pro-agent']
    )
    expect(issued?.scopes).toEqual(['host:model:write'])
  })
})

describe('classifyRpcTokenDenial', () => {
  it('reports desktop_requires_team when a teamless caller is denied only team-only scopes', () => {
    // desktop:view is permitted by the member role but team-only, so a teamless
    // (user-scoped) caller gets it stripped to an empty scope set — the denial
    // is solely the missing team.
    expect(
      classifyRpcTokenDenial({ userId: 'u1', teamId: null, role: 'member' }, ['desktop:view'])
    ).toBe('desktop_requires_team')
  })

  it('reports no_permitted_scopes when a teamed caller requests a scope the role never grants', () => {
    expect(
      classifyRpcTokenDenial({ userId: 'u1', teamId: 't1', role: 'member' }, ['host:cron:ack'])
    ).toBe('no_permitted_scopes')
  })

  it('does not claim a team upgrade when the scope is unobtainable even with a team', () => {
    // host:cron:ack is not in the role defaults at all, so being teamless is not
    // the reason it was denied — a team would not help.
    expect(
      classifyRpcTokenDenial({ userId: 'u1', teamId: null, role: 'member' }, ['host:cron:ack'])
    ).toBe('no_permitted_scopes')
  })
})
