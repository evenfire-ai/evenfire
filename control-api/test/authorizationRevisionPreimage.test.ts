import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { loadResourceAuthority } from '../src/services/access/accessAuthorityStore.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import type { AccessPathSeed } from '../src/services/access/accessPath.js'
import {
  authorizationRevision,
  revisionOfValues,
} from '../src/services/access/authorizationRevision.js'
import {
  type OperationalObjectProjection,
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import {
  type OperationalResourceGraphResult,
  buildOperationalResourceGraph,
} from '../src/services/access/operationalAccessReader.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  OPERATIONAL_NAMESPACES,
  type OperationalPlural,
  contextObject,
  hostObject,
  sharedFilesystemObject,
} from './helpers/fakeOperationalGateway.js'

// T-L6 (M-56, merge plan v2 §2.7): every fact the decision read changes the
// ar1_ revision, and the same facts give the same revision.

const environmentId = canonicalEnvironmentId()

function project(plural: OperationalPlural, object: unknown): OperationalObjectProjection {
  return projectOperationalObject({
    environmentId,
    plural,
    namespace: OPERATIONAL_NAMESPACES[plural],
    object,
    behaviorFingerprintKey: config.sessionJwtPrivateKey,
    relationshipNamespaces: {
      context: config.contextsNamespace,
      mcpServer: config.mcpServersNamespace,
      sharedFilesystem: config.sharedFilesystemsNamespace,
    },
  })
}

type Facts = Readonly<{
  principalUserId: string
  sessionRevision: string
  memberships: readonly Readonly<{
    teamId: string
    role: 'admin' | 'inviter' | 'member'
    membershipUpdatedAt: string
  }>[]
  candidates: readonly AccessPathSeed[]
}>

const behavior = (runtime: string) =>
  Object.freeze({
    capabilities: Object.freeze(['shared_filesystem.read' as const]),
    budget: { state: 'known' as const, value: null },
    credentialPolicy: { state: 'known' as const, value: null },
    approvalPolicy: { state: 'known' as const, value: null },
    filesystemScope: { state: 'known' as const, value: 'scope' },
    runtime: { state: 'known' as const, value: runtime },
    providerModelPolicy: { state: 'known' as const, value: null },
    audit: { state: 'known' as const, value: 'audit' },
  })

const baseFacts: Facts = Object.freeze({
  principalUserId: '10000000-0000-4000-8000-000000000001',
  sessionRevision: '4:30000000-0000-4000-8000-000000000003::2026-12-01',
  memberships: [
    {
      teamId: '50000000-0000-4000-8000-000000000005',
      role: 'member' as const,
      membershipUpdatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  candidates: [
    {
      kind: 'team' as const,
      grantId: 'user_contexts:grant-1',
      teamId: '50000000-0000-4000-8000-000000000005',
      currentRole: 'member' as const,
      behavior: behavior('runtime-1'),
    },
  ],
})

function revision(
  root: Readonly<{ type: 'shared_filesystem' | 'host'; logicalId: string }>,
  objects: readonly OperationalObjectProjection[],
  facts: Facts = baseFacts
): string {
  const graph: OperationalResourceGraphResult = buildOperationalResourceGraph({
    root: { resourceType: root.type, logicalId: root.logicalId },
    objects,
    operationClass: 'full',
  })
  if (graph.status !== 'current') throw new Error(`graph_${graph.status}`)
  return authorizationRevision({
    principalUserId: facts.principalUserId,
    sessionContract: 'v2',
    sessionRevision: facts.sessionRevision,
    memberships: facts.memberships,
    resource: canonicalResourceIdentity({
      environmentId,
      type: root.type,
      logicalId: root.logicalId,
    }),
    // The resolver's operational resource revision (liveAuthorizationResolver.ts).
    resourceRevision: revisionOfValues([
      graph.resource.providerUid,
      graph.resource.providerResourceVersion,
    ]),
    dependencyRevision: graph.dependencyRevision,
    relationshipsRevision: graph.relationshipsRevision,
    candidates: facts.candidates,
  })
}

function expectAllDistinct(cases: Record<string, string>, baseline: string): void {
  const values = [baseline, ...Object.values(cases)]
  // Witness: N + 1 revisions were computed, all of the ar1_ shape.
  expect(values).toHaveLength(Object.keys(cases).length + 1)
  for (const value of values) expect(value).toMatch(/^ar1_[A-Za-z0-9_-]{43}$/)
  for (const [label, value] of Object.entries(cases)) {
    expect(value, `${label} must change the revision`).not.toBe(baseline)
  }
  expect(new Set(values).size, JSON.stringify(cases)).toBe(values.length)
}

describe('ar1_ preimage completeness (T-L6)', () => {
  // A shared filesystem root has no edges of its own, so its UID and
  // resourceVersion reach the revision only through resourceRevision.
  const filesystemRoot = {
    type: 'shared_filesystem' as const,
    logicalId: `${OPERATIONAL_NAMESPACES.sharedfilesystems}/docs`,
  }
  const filesystemObjects = (
    overrides: Readonly<{
      docs?: Parameters<typeof sharedFilesystemObject>[1]
      context?: Parameters<typeof contextObject>[2]
    }> = {}
  ) => [
    project('sharedfilesystems', sharedFilesystemObject('docs', overrides.docs)),
    project('contexts', contextObject('ctx-a', { sharedFileSystems: ['docs'] }, overrides.context)),
  ]

  it('changes for every principal, membership, resource, dependency and candidate fact', () => {
    const baseline = revision(filesystemRoot, filesystemObjects())
    expect(revision(filesystemRoot, filesystemObjects())).toBe(baseline)
    const membership = baseFacts.memberships[0]!
    const candidate = baseFacts.candidates[0]!
    const withFacts = (facts: Partial<Facts>) =>
      revision(filesystemRoot, filesystemObjects(), { ...baseFacts, ...facts })
    expectAllDistinct(
      {
        principalUserId: withFacts({ principalUserId: '10000000-0000-4000-8000-000000000009' }),
        sessionRevision: withFacts({ sessionRevision: '5:other' }),
        membershipRole: withFacts({ memberships: [{ ...membership, role: 'admin' }] }),
        membershipUpdatedAt: withFacts({
          memberships: [{ ...membership, membershipUpdatedAt: '2026-11-02T00:00:00.000Z' }],
        }),
        membershipTeamId: withFacts({
          memberships: [{ ...membership, teamId: '50000000-0000-4000-8000-000000000006' }],
        }),
        rootUid: revision(filesystemRoot, filesystemObjects({ docs: { uid: 'uid-docs-new' } })),
        rootResourceVersion: revision(
          filesystemRoot,
          filesystemObjects({ docs: { resourceVersion: '2' } })
        ),
        dependencyUid: revision(
          filesystemRoot,
          filesystemObjects({ context: { uid: 'uid-ctx-a-new' } })
        ),
        dependencyGeneration: revision(
          filesystemRoot,
          filesystemObjects({ context: { generation: 2 } })
        ),
        candidateGrantId: withFacts({
          candidates: [{ ...candidate, grantId: 'user_contexts:grant-2' }],
        }),
        candidateKind: withFacts({ candidates: [{ ...candidate, kind: 'direct' }] }),
        candidateTeamId: withFacts({
          candidates: [{ ...candidate, teamId: '50000000-0000-4000-8000-000000000007' }],
        }),
        candidateBehavior: withFacts({
          candidates: [{ ...candidate, behavior: behavior('runtime-2') }],
        }),
      },
      baseline
    )
  })

  it('does not change for a dependency status write (resourceVersion only)', () => {
    const baseline = revision(filesystemRoot, filesystemObjects())
    // Witness: the generation of the same dependency does change it.
    expect(revision(filesystemRoot, filesystemObjects({ context: { generation: 3 } }))).not.toBe(
      baseline
    )
    expect(
      revision(filesystemRoot, filesystemObjects({ context: { resourceVersion: '99' } }))
    ).toBe(baseline)
  })

  it('changes for every field of the root relationships', () => {
    const hostRoot = { type: 'host' as const, logicalId: `${OPERATIONAL_NAMESPACES.hosts}/host-a` }
    const contexts = [
      project('contexts', contextObject('ctx-a')),
      project('contexts', contextObject('ctx-b')),
    ]
    const hostProjection = project('hosts', hostObject('host-a', { contextRef: 'ctx-a' }))
    const withEdge = (
      change: Partial<OperationalObjectProjection['relationships'][number]>
    ): OperationalObjectProjection => {
      expect(hostProjection.relationships).toHaveLength(1)
      return {
        ...hostProjection,
        relationships: [{ ...hostProjection.relationships[0]!, ...change }],
      }
    }
    const baseline = revision(hostRoot, [hostProjection, ...contexts])
    expect(revision(hostRoot, [withEdge({}), ...contexts])).toBe(baseline)
    expectAllDistinct(
      {
        targetId: revision(hostRoot, [
          withEdge({ targetId: `${OPERATIONAL_NAMESPACES.contexts}/ctx-b` }),
          ...contexts,
        ]),
        relationshipInstanceId: revision(hostRoot, [
          withEdge({ relationshipInstanceId: 'rel1_other' }),
          ...contexts,
        ]),
        behaviorAttributes: revision(hostRoot, [
          withEdge({ behaviorAttributes: { modelProvider: 'other' } }),
          ...contexts,
        ]),
        sourceProviderUid: revision(hostRoot, [
          withEdge({ sourceProviderUid: 'uid-other' }),
          ...contexts,
        ]),
        sourceResourceVersion: revision(hostRoot, [
          withEdge({ sourceResourceVersion: '77' }),
          ...contexts,
        ]),
      },
      baseline
    )
    // A target change also changes the dependency set, so check that the
    // target alone moves the relationships component of the preimage.
    const relationshipsRevision = (objects: readonly OperationalObjectProjection[]) => {
      const graph = buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: hostRoot.logicalId },
        objects,
        operationClass: 'full',
      })
      if (graph.status !== 'current') throw new Error(`graph_${graph.status}`)
      return graph.relationshipsRevision
    }
    const baseRelationships = relationshipsRevision([hostProjection, ...contexts])
    expect(baseRelationships).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(
      relationshipsRevision([
        withEdge({ targetId: `${OPERATIONAL_NAMESPACES.contexts}/ctx-b` }),
        ...contexts,
      ])
    ).not.toBe(baseRelationships)
  })
})

describe('Postgres-only resource revision (merge plan v2 §2.7)', () => {
  const runId = '22222222-2222-4222-8222-222222222222'
  const resource = canonicalResourceIdentity({
    environmentId,
    type: 'workflow_run',
    logicalId: runId,
  })
  const baseRow = Object.freeze({
    kind: 'team',
    grant_id: `workflow_runs:team:team-1:${runId}`,
    team_id: '50000000-0000-4000-8000-000000000005',
    current_role: 'member',
    permissions: null,
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'report',
    valid_until: new Date('2026-12-01T00:00:00.000Z'),
    related_team: '50000000-0000-4000-8000-000000000005',
    usage_team: null,
    drive: null,
    parent_resource: null,
  })

  async function rowsRevision(row: Record<string, unknown>): Promise<string> {
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }))
    const budget = AccessExecutionBudget.create('action')
    try {
      const result = await loadResourceAuthority({
        db: { query } as never,
        budget,
        snapshot: {
          userId: baseFacts.principalUserId,
          sessionContract: 'v2',
          sessionLive: true,
          sessionRevision: baseFacts.sessionRevision,
          memberships: [],
        },
        resource,
        operationTarget: null,
        operationalGraph: null,
        workflowRunRecipeGraph: null,
      })
      expect(query).toHaveBeenCalledTimes(1)
      if (result.candidateRowsRevision === null) throw new Error('rows_revision_missing')
      return result.candidateRowsRevision
    } finally {
      budget.close()
    }
  }

  it('changes for every column of a candidate row the decision read', async () => {
    const baseline = await rowsRevision({ ...baseRow })
    expect(await rowsRevision({ ...baseRow })).toBe(baseline)
    const cases: Record<string, string> = {}
    const changes: Record<string, unknown> = {
      kind: 'direct',
      grant_id: `workflow_runs:user:${runId}`,
      team_id: '50000000-0000-4000-8000-000000000006',
      current_role: 'admin',
      permissions: ['read'],
      recipe_namespace: 'other-namespace',
      recipe_name: 'other',
      valid_until: new Date('2026-12-02T00:00:00.000Z'),
      related_team: '50000000-0000-4000-8000-000000000008',
      usage_team: 'usage-team',
      drive: 'drive-1',
      parent_resource: 'parent-1',
    }
    for (const [column, value] of Object.entries(changes)) {
      cases[column] = await rowsRevision({ ...baseRow, [column]: value })
    }
    expect(Object.keys(cases)).toHaveLength(12)
    for (const [column, value] of Object.entries(cases)) {
      expect(value, `${column} must change the revision`).not.toBe(baseline)
    }
    expect(new Set([baseline, ...Object.values(cases)]).size).toBe(13)
  })
})
