import { describe, expect, it } from 'vitest'
import { type CatalogSeed, mergeCatalogSeeds } from '../src/services/access/accessCatalog.js'
import {
  accessPathsAreEquivalent,
  buildAccessPath,
  selectEquivalentAccessPath,
} from '../src/services/access/accessPath.js'
import { isCapability, requireKnownCapability } from '../src/services/access/capabilityRegistry.js'
import {
  canonicalResourceIdentity,
  resourceIdentityKey,
  sameResourceIdentity,
} from '../src/services/access/resourceIdentity.js'

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]]
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(rest => [
      value,
      ...rest,
    ])
  )
}

function catalogSeed(input: {
  id: string
  displayName?: string
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  revision?: number
  relationship?: string
}): CatalogSeed {
  return {
    resource: canonicalResourceIdentity({
      environmentId: 'control-api:mcp-host',
      type: 'host',
      logicalId: `mcp-host/${input.id}`,
      displayName: input.displayName ?? 'Shared label',
    }),
    relationships: input.relationship
      ? [{ type: 'context', targetResourceId: `context:${input.relationship}` }]
      : [],
    pathSeeds: [
      {
        kind: input.kind,
        grantId: input.grantId,
        ...(input.teamId
          ? {
              teamId: input.teamId,
              teamName: `Team ${input.teamId}`,
              currentRole: 'member' as const,
            }
          : {}),
        behavior: {
          capabilities: ['host.read'],
          budgetRef: null,
          credentialPolicyRef: null,
          approvalPolicyRef: null,
          filesystemScopeRef: null,
          runtimeRef: null,
          providerModelPolicyRef: null,
          auditSubject: input.teamId ? `team:${input.teamId}` : 'user:user-1',
        },
      },
    ],
    authorizationResourceRevision: input.revision ?? 1,
  }
}

describe('access contract properties', () => {
  it('exhaustively preserves catalog identity and paths across order and composition', () => {
    const seeds = [
      catalogSeed({
        id: 'agent-a',
        kind: 'direct',
        grantId: 'user_agents:user-1:agent-a',
        revision: 3,
        relationship: 'mcp-server/ctx-a',
      }),
      catalogSeed({
        id: 'agent-a',
        kind: 'team',
        grantId: 'team_agents:team-a:agent-a',
        teamId: 'team-a',
        revision: 4,
        relationship: 'mcp-server/ctx-a',
      }),
      catalogSeed({
        id: 'agent-b',
        kind: 'direct',
        grantId: 'user_agents:user-1:agent-b',
        revision: 2,
      }),
      catalogSeed({
        id: 'agent-a',
        displayName: 'Alternate producer label',
        kind: 'team',
        grantId: 'team_agents:team-b:agent-a',
        teamId: 'team-b',
        revision: 3,
      }),
    ]
    const canonical = mergeCatalogSeeds(seeds)

    for (const ordered of permutations(seeds)) {
      expect(mergeCatalogSeeds(ordered)).toEqual(canonical)
      for (let split = 0; split <= ordered.length; split += 1) {
        const composed = mergeCatalogSeeds([
          ...mergeCatalogSeeds(ordered.slice(0, split)),
          ...mergeCatalogSeeds(ordered.slice(split)),
        ])
        expect(composed).toEqual(canonical)
      }
    }

    expect(mergeCatalogSeeds([...canonical, ...canonical])).toEqual(canonical)
    expect(new Set(canonical.map(seed => resourceIdentityKey(seed.resource))).size).toBe(2)
    expect(
      canonical.find(seed => seed.resource.logicalId.endsWith('agent-a'))?.pathSeeds
    ).toHaveLength(3)
    expect(canonical.filter(seed => seed.resource.displayName.includes('label'))).toHaveLength(2)
  })

  it('keeps identity immutable and never merges same-name different-id resources', () => {
    const identities = Array.from({ length: 25 }, (_, index) =>
      canonicalResourceIdentity({
        environmentId: 'control-api:mcp-host',
        type: 'host',
        logicalId: `mcp-host/host-${index}`,
        displayName: `Shared label ${index % 3}`,
      })
    )

    for (const left of identities) {
      expect(sameResourceIdentity(left, left)).toBe(true)
      for (const right of identities) {
        expect(sameResourceIdentity(left, right)).toBe(left.logicalId === right.logicalId)
      }
    }
  })

  it('exhaustively normalizes equivalent paths independent of input order', () => {
    const resource = canonicalResourceIdentity({
      environmentId: 'control-api:mcp-host',
      type: 'host',
      logicalId: 'mcp-host/agent-a',
      displayName: 'Agent A',
    })
    const behavior = {
      capabilities: ['host.read'] as const,
      budgetRef: null,
      credentialPolicyRef: null,
      approvalPolicyRef: null,
      filesystemScopeRef: null,
      runtimeRef: null,
      providerModelPolicyRef: null,
      auditSubject: 'user:user-1',
    }
    const paths = [
      buildAccessPath({
        principalUserId: 'user-1',
        resource,
        kind: 'team',
        grantId: 'team_agents:team-b:agent-a',
        teamId: 'team-b',
        authorizationRevision: 'revision-1',
        behavior,
      }),
      buildAccessPath({
        principalUserId: 'user-1',
        resource,
        kind: 'direct',
        grantId: 'user_agents:user-1:agent-a',
        authorizationRevision: 'revision-1',
        behavior,
      }),
      buildAccessPath({
        principalUserId: 'user-1',
        resource,
        kind: 'team',
        grantId: 'team_agents:team-a:agent-a',
        teamId: 'team-a',
        authorizationRevision: 'revision-1',
        behavior,
      }),
    ]

    for (const ordered of permutations(paths)) {
      expect(selectEquivalentAccessPath(ordered)?.id).toBe(paths[1]!.id)
      expect(ordered.every(path => accessPathsAreEquivalent(paths[0]!, path))).toBe(true)
    }
    expect(paths.map(path => path.id)).toEqual([...paths.map(path => path.id)])
    expect(new Set(paths.map(path => path.id)).size).toBe(3)
    expect(paths[0]!.id).toMatch(/^ap1_[A-Za-z0-9_-]{43}$/)
  })

  it('exhaustively rejects implicit selection for non-equivalent paths', () => {
    const resource = canonicalResourceIdentity({
      environmentId: 'control-api:mcp-host',
      type: 'host',
      logicalId: 'mcp-host/agent-a',
      displayName: 'Agent A',
    })
    const path = (teamId: string, budgetRef: string) =>
      buildAccessPath({
        principalUserId: 'user-1',
        resource,
        kind: 'team',
        grantId: `team_agents:${teamId}:agent-a`,
        teamId,
        authorizationRevision: 'revision-1',
        behavior: {
          capabilities: ['host.read'],
          budgetRef,
          credentialPolicyRef: null,
          approvalPolicyRef: null,
          filesystemScopeRef: null,
          runtimeRef: null,
          providerModelPolicyRef: null,
          auditSubject: `team:${teamId}`,
        },
      })
    const paths = [
      path('team-a', 'budget-a'),
      path('team-b', 'budget-b'),
      path('team-c', 'budget-c'),
    ]

    for (const ordered of permutations(paths)) {
      expect(selectEquivalentAccessPath(ordered)).toBeNull()
    }
  })

  it('fails unknown capabilities closed', () => {
    expect(isCapability('workflow.approval.decide')).toBe(true)
    expect(isCapability('host.activity.read_all')).toBe(true)
    expect(isCapability('unknown.superpower')).toBe(false)
    expect(() => requireKnownCapability('unknown.superpower')).toThrow('unknown capability')
  })
})
