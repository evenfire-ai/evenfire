import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthClaims } from '../src/profileTypes.js'
import {
  AccessCatalogAuthorityUnavailableError,
  AccessCatalogCapacityError,
  AccessCatalogCursorError,
  buildAccessCatalog,
  catalogAuthoritySourceTypes,
  invalidateAccessCatalogOperationalCache,
} from '../src/services/access/accessCatalog.js'
import { resolveLiveAuthorizationInTransaction } from '../src/services/access/liveAuthorizationResolver.js'
import { sharedFilesystemScopeRef } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const state = vi.hoisted(() => ({
  snapshot: {
    user_id: '00000000-0000-4000-8000-000000000001',
    user_revision: 5,
    session_version: 1,
    session_live: true,
    memberships: [
      {
        teamId: '00000000-0000-4000-8000-000000000010',
        teamName: 'Team A',
        role: 'member',
        membershipUpdatedAt: '2026-08-10T12:00:00.000Z',
        teamRevision: 2,
      },
      {
        teamId: '00000000-0000-4000-8000-000000000020',
        teamName: 'Team B',
        role: 'admin',
        membershipUpdatedAt: '2026-08-10T12:01:00.000Z',
        teamRevision: 3,
      },
    ],
  },
  rows: [] as Record<string, unknown>[],
  failAuthority: false,
  queryCount: 0,
}))

vi.mock('../src/db.js', () => ({
  withTransaction: vi.fn(
    async (work: (db: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) =>
      work({
        query: async (sql: string) => {
          state.queryCount += 1
          if (state.failAuthority)
            throw new Error('secret-like database endpoint /var/run/postgresql')
          if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 }
          if (sql.includes('AS session_live')) return { rows: [state.snapshot], rowCount: 1 }
          if (sql.includes('catalog_paths AS'))
            return { rows: state.rows, rowCount: state.rows.length }
          throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
        },
      })
  ),
}))

const claims: AuthClaims = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'person@example.com',
  teamId: null,
  role: 'member',
  exp: 2_000_000_000,
  sessionContract: 'v2',
  sid: '00000000-0000-4000-8000-000000000100',
  jti: '00000000-0000-4000-8000-000000000101',
  sv: 1,
  ver: 2,
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    resource_type: 'host',
    logical_id: 'agent-a',
    display_name: 'Shared label',
    kind: 'direct',
    grant_id: 'user_agents:user-1:agent-a',
    team_id: null,
    team_name: null,
    current_role: null,
    capabilities: ['host.read'],
    permissions: null,
    resource_revision: '1',
    relationship_type: null,
    relationship_target_type: null,
    relationship_target_id: null,
    provider_uid: null,
    budget_ref: null,
    credential_policy_ref: null,
    approval_policy_ref: null,
    filesystem_scope_ref: null,
    runtime_ref: null,
    provider_model_policy_ref: null,
    authorization_resource_revision: 1,
    ...overrides,
  }
}

function gateway(options: { fail?: string } = {}) {
  const resources: Record<string, unknown[]> = {
    hosts: [
      {
        metadata: { name: 'agent-a', namespace: 'mcp-host', uid: 'host-a', resourceVersion: '8' },
        spec: { host: 'Shared label', contextRef: 'ctx-a' },
      },
      {
        metadata: { name: 'agent-b', namespace: 'mcp-host', uid: 'host-b', resourceVersion: '9' },
        spec: { host: 'Shared label', contextRef: 'ctx-a' },
      },
    ],
    contexts: [
      {
        metadata: { name: 'ctx-a', namespace: 'mcp-server', uid: 'ctx-a', resourceVersion: '3' },
        spec: {
          contextId: 'ctx-a',
          mcpServers: ['github'],
          sharedFileSystems: [{ name: 'shared-a', mountPath: '/workspace' }],
        },
      },
    ],
    mcpservers: [
      {
        metadata: { name: 'github', namespace: 'mcp-server', uid: 'mcp-a', resourceVersion: '2' },
        spec: { enabled: true },
      },
    ],
    workflowrecipes: [],
    sharedfilesystems: [
      {
        metadata: {
          name: 'shared-a',
          namespace: 'mcp-host',
          uid: 'sfs-a',
          resourceVersion: '4',
        },
      },
    ],
  }
  return {
    listResource: vi.fn(async (plural: string) => {
      if (options.fail === plural) throw new Error(`secret upstream failure for ${plural}`)
      return resources[plural] ?? []
    }),
  }
}

describe('aggregate access catalog', () => {
  beforeEach(() => {
    state.snapshot.user_revision = 5
    state.snapshot.memberships = [
      {
        teamId: '00000000-0000-4000-8000-000000000010',
        teamName: 'Team A',
        role: 'member',
        membershipUpdatedAt: '2026-08-10T12:00:00.000Z',
        teamRevision: 2,
      },
      {
        teamId: '00000000-0000-4000-8000-000000000020',
        teamName: 'Team B',
        role: 'admin',
        membershipUpdatedAt: '2026-08-10T12:01:00.000Z',
        teamRevision: 3,
      },
    ]
    state.rows = []
    state.failAuthority = false
    state.queryCount = 0
  })

  it('pushes final resource filters down to only their authority source families', () => {
    expect(catalogAuthoritySourceTypes(['mcp_server'])).toEqual(['context', 'host'])
    expect(catalogAuthoritySourceTypes(['shared_filesystem', 'sandbox_app'])).toEqual([
      'context',
      'workflow_recipe',
    ])
    expect(catalogAuthoritySourceTypes(['workflow_run', 'notification'])).toEqual([
      'notification',
      'workflow_run',
    ])
  })

  it('bounds repeated operational fan-out and supports active invalidation', async () => {
    state.rows = [row()]
    const cachedGateway = gateway()

    await buildAccessCatalog(claims, cachedGateway as never)
    await buildAccessCatalog(claims, cachedGateway as never)
    expect(cachedGateway.listResource).toHaveBeenCalledTimes(5)

    invalidateAccessCatalogOperationalCache(cachedGateway as never)
    await buildAccessCatalog(claims, cachedGateway as never)
    expect(cachedGateway.listResource).toHaveBeenCalledTimes(10)
  })

  it('merges one immutable resource across direct and every live team path', async () => {
    state.rows = [
      row(),
      row({
        kind: 'team',
        grant_id: 'team_agents:team-a:agent-a',
        team_id: '00000000-0000-4000-8000-000000000010',
        team_name: 'Team A',
        current_role: 'member',
      }),
      row({
        kind: 'team',
        grant_id: 'team_agents:team-b:agent-a',
        team_id: '00000000-0000-4000-8000-000000000020',
        team_name: 'Team B',
        current_role: 'admin',
      }),
      row({ logical_id: 'agent-b', grant_id: 'user_agents:user-1:agent-b' }),
      row({
        resource_type: 'context',
        logical_id: 'ctx-a',
        display_name: 'ctx-a',
        grant_id: 'user_contexts:user-1:ctx-a',
        capabilities: ['context.read'],
      }),
    ]
    const result = await buildAccessCatalog(
      claims,
      gateway() as never,
      { limit: 100 },
      {
        now: new Date('2026-08-10T13:00:00.000Z'),
        correlationId: 'corr-1',
      }
    )

    expect(result.complete).toBe(true)
    expect(result.generatedAt).toBe('2026-08-10T13:00:00.000Z')
    const agentA = result.items.find(item => item.resource.id === 'host:mcp-host/agent-a')
    expect(agentA?.accessPaths).toHaveLength(3)
    expect(
      agentA?.accessPaths
        .map(path => path.safeTeamDescriptor?.id)
        .filter(Boolean)
        .sort()
    ).toEqual(['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020'])
    expect(result.items.filter(item => item.resource.displayName === 'Shared label')).toHaveLength(
      2
    )
    const connector = result.items.find(item => item.resource.id === 'mcp_server:mcp-server/github')
    expect(connector?.accessPaths.length).toBeGreaterThanOrEqual(1)
    const filesystem = result.items.find(
      item => item.resource.id === 'shared_filesystem:mcp-host/shared-a'
    )
    expect(filesystem?.capabilities).toEqual(['shared_filesystem.read'])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(state.queryCount).toBe(3)
  })

  it('paginates after union/deduplication and rejects a changed revision', async () => {
    state.rows = [
      row(),
      row({
        kind: 'team',
        grant_id: 'team_agents:team-a:agent-a',
        team_id: '00000000-0000-4000-8000-000000000010',
        team_name: 'Team A',
        current_role: 'member',
      }),
      row({ logical_id: 'agent-b', grant_id: 'user_agents:user-1:agent-b' }),
    ]
    const first = await buildAccessCatalog(claims, gateway() as never, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toMatch(/^ac2\./)

    const second = await buildAccessCatalog(claims, gateway() as never, {
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.resource.id).not.toBe(first.items[0]?.resource.id)

    state.snapshot.memberships[0]!.teamRevision = 99
    await expect(
      buildAccessCatalog(claims, gateway() as never, { limit: 1, cursor: first.nextCursor })
    ).rejects.toEqual(
      expect.objectContaining<Partial<AccessCatalogCursorError>>({
        code: 'access_path_stale',
      })
    )
  })

  it('invalidates a cursor when only the canonical resource authorization revision changes', async () => {
    state.rows = [row({ authorization_resource_revision: 7 })]
    const first = await buildAccessCatalog(claims, gateway() as never, { limit: 1 })
    expect(first.nextCursor).toMatch(/^ac2\./)

    state.rows = [row({ authorization_resource_revision: 8 })]
    await expect(
      buildAccessCatalog(claims, gateway() as never, { limit: 1, cursor: first.nextCursor })
    ).rejects.toEqual(
      expect.objectContaining<Partial<AccessCatalogCursorError>>({
        code: 'access_path_stale',
      })
    )
  })

  it('does not invalidate a cursor for display-only or content-only changes', async () => {
    state.rows = [row(), row({ logical_id: 'agent-b', grant_id: 'user-1:agent-b' })]
    const first = await buildAccessCatalog(claims, gateway() as never, { limit: 1 })
    expect(first.nextCursor).toMatch(/^ac2\./)

    state.rows = [
      row({ display_name: 'Renamed host', resource_revision: 'content-99' }),
      row({ logical_id: 'agent-b', grant_id: 'user-1:agent-b' }),
    ]
    await expect(
      buildAccessCatalog(claims, gateway() as never, { limit: 1, cursor: first.nextCursor })
    ).resolves.toEqual(expect.objectContaining({ contractVersion: '2' }))
  })

  it('emits a path handle that the live resolver accepts for the same current grant', async () => {
    state.snapshot.memberships = []
    state.rows = [row()]
    const catalog = await buildAccessCatalog(claims, gateway() as never)
    const item = catalog.items.find(resource => resource.resource.type === 'host')!
    const accessPathId = item.accessPaths[0]!.accessPathId
    const resolverDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              user_id: claims.userId,
              user_revision: 5,
              resource_revision: 1,
              session_version: 1,
              session_live: true,
              memberships: [],
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              kind: 'direct',
              grant_id: 'user_agents:user-1:agent-a',
              capabilities: ['host.read'],
            },
          ],
          rowCount: 1,
        }),
    }

    const result = await resolveLiveAuthorizationInTransaction(
      {
        principalUserId: claims.userId,
        sid: claims.sid,
        requiredCapability: 'host.read',
        requestedAccessPathId: accessPathId,
        resource: canonicalResourceIdentity({
          environmentId: item.resource.environmentId,
          type: 'host',
          logicalId: item.resource.id.replace(/^host:/, ''),
          displayName: item.resource.displayName,
        }),
      },
      resolverDb,
      {
        relationships: [
          {
            type: 'context',
            targetResourceId: 'context:mcp-server/ctx-a',
          },
        ],
        relatedContextNames: [],
        relatedHostNames: [],
        filesystemScopes: new Map(),
      }
    )

    expect(result.status).toBe('allowed')
    if (result.status === 'allowed') expect(result.selectedPath?.id).toBe(accessPathId)
  })

  it('emits connector and filesystem paths reconstructible from current relationships', async () => {
    state.snapshot.memberships = []
    state.rows = [
      row({
        resource_type: 'context',
        logical_id: 'ctx-a',
        display_name: 'ctx-a',
        grant_id: 'user_contexts:user-1:ctx-a',
        capabilities: ['context.read'],
      }),
    ]
    const catalog = await buildAccessCatalog(claims, gateway() as never)
    const connector = catalog.items.find(
      item => item.resource.id === 'mcp_server:mcp-server/github'
    )!
    const filesystem = catalog.items.find(
      item => item.resource.id === 'shared_filesystem:mcp-host/shared-a'
    )!

    const resolveDerived = async (
      item: typeof connector,
      capability: 'mcp_server.read' | 'shared_filesystem.read'
    ) => {
      const db = {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                user_id: claims.userId,
                user_revision: 5,
                resource_revision: 1,
                session_version: 1,
                session_live: true,
                memberships: [],
              },
            ],
            rowCount: 1,
          })
          .mockResolvedValueOnce({
            rows: [
              {
                kind: 'direct',
                grant_id: 'user_contexts:user-1:ctx-a',
                source_type: 'context',
                source_id: 'ctx-a',
                authorization_resource_revision: 1,
              },
            ],
            rowCount: 1,
          }),
      }
      const isFilesystem = item.resource.type === 'shared_filesystem'
      return resolveLiveAuthorizationInTransaction(
        {
          principalUserId: claims.userId,
          sid: claims.sid,
          requiredCapability: capability,
          requestedAccessPathId: item.accessPaths[0]!.accessPathId,
          resource: canonicalResourceIdentity({
            environmentId: item.resource.environmentId,
            type: item.resource.type,
            logicalId: item.resource.id.slice(item.resource.type.length + 1),
            displayName: item.resource.displayName,
          }),
        },
        db,
        {
          relationships: [
            {
              type: 'context',
              targetResourceId: 'context:mcp-server/ctx-a',
            },
          ],
          relatedContextNames: ['ctx-a'],
          relatedHostNames: [],
          filesystemScopes: new Map(
            isFilesystem
              ? [
                  [
                    'ctx-a',
                    sharedFilesystemScopeRef({
                      contextLogicalId: 'mcp-server/ctx-a',
                      filesystemLogicalId: 'mcp-host/shared-a',
                      mountPath: '/workspace',
                    }),
                  ],
                ]
              : []
          ),
        }
      )
    }

    const connectorResult = await resolveDerived(connector, 'mcp_server.read')
    expect(connectorResult.status).toBe('allowed')
    const filesystemResult = await resolveDerived(filesystem, 'shared_filesystem.read')
    expect(filesystemResult.status).toBe('allowed')
  })

  it('emits run, approval, and notification paths reconstructible from live rows', async () => {
    state.snapshot.memberships = []
    const runId = '00000000-0000-4000-8000-000000000301'
    const approvalId = '00000000-0000-4000-8000-000000000302'
    const notificationId = '00000000-0000-4000-8000-000000000303'
    state.rows = [
      row({
        resource_type: 'workflow_run',
        logical_id: runId,
        display_name: runId,
        grant_id: `workflow_runs:user:${runId}`,
        capabilities: ['workflow.read'],
        relationship_type: 'recipe',
        relationship_target_type: 'workflow_recipe',
        relationship_target_id: 'sandbox-recipes/recipe-a',
      }),
      row({
        resource_type: 'workflow_approval',
        logical_id: approvalId,
        display_name: approvalId,
        grant_id: `workflow_approval_requests:user:${approvalId}`,
        capabilities: ['workflow.approval.decide'],
        approval_policy_ref: `approval:${approvalId}`,
        relationship_type: 'recipe',
        relationship_target_type: 'workflow_recipe',
        relationship_target_id: 'sandbox-recipes/recipe-a',
      }),
      row({
        resource_type: 'notification',
        logical_id: notificationId,
        display_name: 'workflow.completed',
        grant_id: `notification_deliveries:${notificationId}`,
        capabilities: ['notification.read'],
      }),
    ]
    const catalog = await buildAccessCatalog(claims, gateway() as never)

    const cases = [
      {
        type: 'workflow_run' as const,
        id: runId,
        capability: 'workflow.read' as const,
        grantId: `workflow_runs:user:${runId}`,
        relationship: {
          relationship_type: 'recipe',
          target_resource_id: 'workflow_recipe:sandbox-recipes/recipe-a',
        },
      },
      {
        type: 'workflow_approval' as const,
        id: approvalId,
        capability: 'workflow.approval.decide' as const,
        grantId: `workflow_approval_requests:user:${approvalId}`,
        relationship: {
          relationship_type: 'recipe',
          target_resource_id: 'workflow_recipe:sandbox-recipes/recipe-a',
        },
      },
      {
        type: 'notification' as const,
        id: notificationId,
        capability: 'notification.read' as const,
        grantId: `notification_deliveries:${notificationId}`,
      },
    ]

    for (const fixture of cases) {
      const item = catalog.items.find(
        candidate => candidate.resource.id === `${fixture.type}:${fixture.id}`
      )!
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              user_id: claims.userId,
              user_revision: 5,
              resource_revision: 1,
              session_version: 1,
              session_live: true,
              memberships: [],
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              kind: 'direct',
              grant_id: fixture.grantId,
              capabilities: [fixture.capability],
            },
          ],
          rowCount: 1,
        })
      if (fixture.relationship) {
        query.mockResolvedValueOnce({ rows: [fixture.relationship], rowCount: 1 })
      }
      const result = await resolveLiveAuthorizationInTransaction(
        {
          principalUserId: claims.userId,
          sid: claims.sid,
          requiredCapability: fixture.capability,
          requestedAccessPathId: item.accessPaths[0]!.accessPathId,
          resource: canonicalResourceIdentity({
            environmentId: item.resource.environmentId,
            type: fixture.type,
            logicalId: fixture.id,
            displayName: item.resource.displayName,
          }),
        },
        { query }
      )
      expect(result.status, fixture.type).toBe('allowed')
    }
  })

  it('preserves safe database items and marks an operational source failure partial', async () => {
    state.rows = [row()]
    const result = await buildAccessCatalog(claims, gateway({ fail: 'hosts' }) as never)

    expect(result.complete).toBe(false)
    expect(result.items.some(item => item.resource.id === 'host:mcp-host/agent-a')).toBe(true)
    expect(result.partialErrors).toEqual([
      {
        sourceCode: 'hosts',
        category: 'operational_source_unavailable',
        retryable: true,
      },
    ])
    expect(JSON.stringify(result)).not.toContain('secret upstream failure')
  })

  it('fails authority-store errors closed instead of returning a partial catalog', async () => {
    state.failAuthority = true
    await expect(buildAccessCatalog(claims, gateway() as never)).rejects.toBeInstanceOf(
      AccessCatalogAuthorityUnavailableError
    )
  })

  it('fails a truncated authority snapshot closed instead of dropping access paths', async () => {
    state.rows = [row({ snapshot_path_limit_exceeded: true })]
    await expect(buildAccessCatalog(claims, gateway() as never)).rejects.toBeInstanceOf(
      AccessCatalogCapacityError
    )
  })

  it('keeps authorization query count constant at high team cardinality', async () => {
    state.snapshot.memberships = Array.from({ length: 250 }, (_, index) => ({
      teamId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      teamName: `Team ${index + 1}`,
      role: 'member',
      membershipUpdatedAt: '2026-08-10T12:00:00.000Z',
      teamRevision: 1,
    }))
    state.rows = Array.from({ length: 250 }, (_, index) =>
      row({
        kind: 'team',
        grant_id: `team_agents:team-${index}:agent-a`,
        team_id: state.snapshot.memberships[index]!.teamId,
        team_name: state.snapshot.memberships[index]!.teamName,
        current_role: 'member',
      })
    )
    const result = await buildAccessCatalog(claims, gateway() as never, { limit: 100 })
    expect(result.items.find(item => item.resource.type === 'host')?.accessPaths).toHaveLength(250)
    expect(state.queryCount).toBe(3)
  })
})
