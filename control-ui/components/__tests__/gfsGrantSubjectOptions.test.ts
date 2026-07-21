import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeResource } from '@lib/api'
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
  const hosts = [
    { metadata: { namespace: 'mcp-host', name: 'chatllm' } },
    {
      metadata: { namespace: 'mcp-host', name: 'chatllm-stateless' },
      spec: { lifecycle: { stateless: true } },
    },
  ]
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

  it('maps each first-party agent and workflow plugin to an independent canonical host subject', () => {
    const firstParty = buildGfsGrantSubjectOptions({
      subjectType: 'firstPartyAgent',
      users,
      teams,
      hosts,
      recipes,
    })
    const workflow = buildGfsGrantSubjectOptions({
      subjectType: 'workflowPlugin',
      users,
      teams,
      hosts,
      recipes,
    })[0]

    expect(firstParty).toEqual([
      expect.objectContaining({
        value: 'host:1st:mcp-host/chatllm',
        id: '1st:mcp-host/chatllm',
        label: 'chatllm (Stateful)',
      }),
      expect.objectContaining({
        value: 'host:1st:mcp-host/chatllm-stateless',
        id: '1st:mcp-host/chatllm-stateless',
        label: 'chatllm-stateless (Stateless)',
      }),
    ])
    expect(firstParty.map(option => option.id)).not.toContain('1st:mcp-host/standalone')
    expect(toGfsSubjectInput('firstPartyAgent', firstParty[0])).toEqual({
      type: 'host',
      id: '1st:mcp-host/chatllm',
    })
    expect(toGfsSubjectInput('firstPartyAgent', firstParty[1])).toEqual({
      type: 'host',
      id: '1st:mcp-host/chatllm-stateless',
    })
    expect(toGfsSubjectInput('workflowPlugin', workflow)).toEqual({
      type: 'host',
      id: '3rd:sandbox-recipes/daily-report',
    })
    expect(toGfsSubjectInput('operator', null)).toEqual({ type: 'operator' })
  })

  it('omits first-party hosts without an exact namespace and name instead of synthesizing identities', () => {
    const firstParty = buildGfsGrantSubjectOptions({
      subjectType: 'firstPartyAgent',
      users,
      teams,
      hosts: [
        { metadata: { namespace: 'mcp-host', name: 'chatllm' } },
        { metadata: { namespace: '', name: 'chatllm' } },
        { metadata: { namespace: '   ', name: 'chatllm' } },
        { metadata: { name: 'chatllm' } },
        { metadata: { namespace: 'mcp-host', name: '' } },
        { metadata: { namespace: 'mcp-host', name: '   ' } },
        { metadata: { namespace: 'mcp-host' } },
        {},
      ],
      recipes,
    })

    expect(firstParty.map(option => option.id)).toEqual(['1st:mcp-host/chatllm'])
    expect(firstParty).not.toContainEqual(
      expect.objectContaining({ id: '1st:mcp-host/standalone' })
    )
  })

  it('omits workflows without an exact namespace and name instead of creating colliding fallbacks', () => {
    const malformedRecipes = [
      { metadata: { namespace: 'sandbox-recipes', name: 'daily-report' } },
      { metadata: { namespace: '', name: 'daily-report' } },
      { metadata: { namespace: '   ', name: 'daily-report' } },
      { metadata: { name: 'daily-report' } },
      { metadata: { namespace: 'sandbox-recipes', name: '' } },
      { metadata: { namespace: 'sandbox-recipes', name: '   ' } },
      { metadata: { namespace: 'sandbox-recipes' } },
      {},
    ] as unknown as WorkflowRecipeResource[]
    const workflow = buildGfsGrantSubjectOptions({
      subjectType: 'workflowPlugin',
      users,
      teams,
      hosts,
      recipes: malformedRecipes,
    })

    expect(workflow.map(option => option.id)).toEqual(['3rd:sandbox-recipes/daily-report'])
    expect(workflow).not.toContainEqual(
      expect.objectContaining({ id: '3rd:sandbox-recipes/unnamed-recipe' })
    )
  })

  it('keeps same-named hosts and workflows in different exact namespaces collision-free', () => {
    const firstParty = buildGfsGrantSubjectOptions({
      subjectType: 'firstPartyAgent',
      users,
      teams,
      hosts: [
        { metadata: { namespace: 'mcp-host', name: 'runtime' } },
        { metadata: { namespace: 'mcp-host-canary', name: 'runtime' } },
      ],
      recipes,
    })
    const workflow = buildGfsGrantSubjectOptions({
      subjectType: 'workflowPlugin',
      users,
      teams,
      hosts,
      recipes: [
        { metadata: { namespace: 'sandbox-recipes', name: 'runtime' } },
        { metadata: { namespace: 'sandbox-recipes-canary', name: 'runtime' } },
      ],
    })

    expect(firstParty.map(option => option.id)).toEqual([
      '1st:mcp-host/runtime',
      '1st:mcp-host-canary/runtime',
    ])
    expect(workflow.map(option => option.id)).toEqual([
      '3rd:sandbox-recipes/runtime',
      '3rd:sandbox-recipes-canary/runtime',
    ])
    expect(new Set([...firstParty, ...workflow].map(option => option.id)).size).toBe(4)
  })
})
