import { describe, expect, it } from 'vitest'
import { buildGfsGrantSubjectOptions, toGfsSubjectInput } from '../gfsGrantSubjectOptions'

describe('gfsGrantSubjectOptions', () => {
  const users = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'test@clerum.io',
      name: 'Test User',
      displayName: 'Test User',
      picture: null,
      activeTeamCount: 1,
    },
  ]
  const teams = [{ id: '22222222-2222-2222-2222-222222222222', name: 'Research', memberCount: 2 }]
  const hosts = [{ metadata: { name: 'chatllm' } }]
  const recipes = [{ metadata: { namespace: 'sandbox-recipes', name: 'daily-report' } }]

  it('keeps subject type selection separate from filtered subject options', () => {
    expect(
      buildGfsGrantSubjectOptions({ subjectType: 'user', users, teams, hosts, recipes })
    ).toEqual([
      expect.objectContaining({ value: `user:${users[0].id}`, id: users[0].id, badge: 'User' }),
    ])
    expect(
      buildGfsGrantSubjectOptions({ subjectType: 'team', users, teams, hosts, recipes })
    ).toEqual([
      expect.objectContaining({ value: `team:${teams[0].id}`, id: teams[0].id, badge: 'Team' }),
    ])
    expect(
      buildGfsGrantSubjectOptions({ subjectType: 'workflowPlugin', users, teams, hosts, recipes })
    ).toEqual([
      expect.objectContaining({
        value: 'host:3rd:sandbox-recipes/daily-report',
        id: '3rd:sandbox-recipes/daily-report',
        badge: 'Workflow',
      }),
    ])
  })

  it('maps first-party agents and workflow plugins to canonical host subjects', () => {
    const firstParty = buildGfsGrantSubjectOptions({
      subjectType: 'firstPartyAgent',
      users,
      teams,
      hosts,
      recipes,
    })[0]
    const workflow = buildGfsGrantSubjectOptions({
      subjectType: 'workflowPlugin',
      users,
      teams,
      hosts,
      recipes,
    })[0]

    expect(toGfsSubjectInput('firstPartyAgent', firstParty)).toEqual({
      type: 'host',
      id: '1st:mcp-host/standalone',
    })
    expect(toGfsSubjectInput('workflowPlugin', workflow)).toEqual({
      type: 'host',
      id: '3rd:sandbox-recipes/daily-report',
    })
    expect(toGfsSubjectInput('operator', null)).toEqual({ type: 'operator' })
  })
})
