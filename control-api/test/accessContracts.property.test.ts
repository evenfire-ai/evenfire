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

function randomFor(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target]!, result[index]!]
  }
  return result
}

function arbitraryCatalogSeeds(seed: number): CatalogSeed[] {
  const random = randomFor(seed)
  const count = 1 + Math.floor(random() * 30)
  const nullable = (label: string) =>
    random() < 0.45 ? null : `${label}-${Math.floor(random() * 4)}`
  return Array.from({ length: count }, (_, index) => {
    const resourceNumber = Math.floor(random() * 8)
    const team = random() < 0.5 ? null : `team-${Math.floor(random() * 4)}`
    const duplicateGrantSlot = Math.floor(index / 3)
    return {
      resource: canonicalResourceIdentity({
        environmentId: pick(random, ['env:a', 'env:b']),
        type: pick(random, ['host', 'context', 'workflow_recipe']),
        logicalId: `resource-${resourceNumber}`,
        displayName: `Shared label ${Math.floor(random() * 3)}`,
      }),
      relationships:
        random() < 0.5
          ? []
          : [
              {
                type: pick(random, ['context', 'host', 'recipe']),
                targetResourceId: `target:${Math.floor(random() * 5)}`,
              },
            ],
      pathSeeds: [
        {
          kind: team ? 'team' : 'direct',
          grantId: `grant-${duplicateGrantSlot}`,
          ...(team
            ? { teamId: team, teamName: `Team ${team}`, currentRole: 'member' as const }
            : {}),
          behavior: {
            capabilities: shuffled(random, ['host.read', 'context.read'] as const).slice(
              0,
              1 + Math.floor(random() * 2)
            ),
            budgetRef: nullable('budget'),
            credentialPolicyRef: nullable('credential'),
            approvalPolicyRef: nullable('approval'),
            filesystemScopeRef: nullable('filesystem'),
            runtimeRef: nullable('runtime'),
            providerModelPolicyRef: nullable('provider'),
            auditSubject: team ? `team:${team}` : `user:user-${Math.floor(random() * 3)}`,
          },
        },
      ],
      authorizationResourceRevision: 1 + Math.floor(random() * 20),
    }
  })
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
  it('preserves merge invariants across generated identities, nulls, and path behavior', () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const seeds = arbitraryCatalogSeeds(seed)
      const before = structuredClone(seeds)
      const canonical = mergeCatalogSeeds(seeds)
      const random = randomFor(seed ^ 0x9e3779b9)

      for (let iteration = 0; iteration < 5; iteration += 1) {
        expect(mergeCatalogSeeds(shuffled(random, seeds))).toEqual(canonical)
      }
      const split = Math.floor(random() * (seeds.length + 1))
      expect(
        mergeCatalogSeeds([
          ...mergeCatalogSeeds(seeds.slice(0, split)),
          ...mergeCatalogSeeds(seeds.slice(split)),
        ])
      ).toEqual(canonical)
      expect(mergeCatalogSeeds([...canonical, ...canonical])).toEqual(canonical)
      expect(new Set(canonical.map(item => resourceIdentityKey(item.resource))).size).toBe(
        canonical.length
      )
      expect(seeds).toEqual(before)
    }
  })

  it('keeps same grant provenance separate when any behavior dimension differs', () => {
    const base = catalogSeed({
      id: 'shared-filesystem',
      kind: 'direct',
      grantId: 'user_contexts:user-1:context-a',
    })
    const variants = [
      'budgetRef',
      'credentialPolicyRef',
      'approvalPolicyRef',
      'filesystemScopeRef',
      'runtimeRef',
      'providerModelPolicyRef',
      'auditSubject',
    ] as const
    const seeds = variants.map((field, index) => {
      const value = structuredClone(base)
      Object.assign(value.pathSeeds[0]!.behavior, { [field]: `${field}-${index}` })
      return value
    })

    const merged = mergeCatalogSeeds([...seeds, structuredClone(seeds[0]!)])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.pathSeeds).toHaveLength(variants.length)
  })

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
    const before = structuredClone(paths)

    for (const ordered of permutations(paths)) {
      expect(selectEquivalentAccessPath(ordered)?.id).toBe(paths[1]!.id)
      expect(ordered.every(path => accessPathsAreEquivalent(paths[0]!, path))).toBe(true)
    }
    expect(paths).toEqual(before)
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
