import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  type AccessPathBehavior,
  type AccessPathSeed,
  accessPathsAreEquivalent,
  buildAccessPath,
  knownBehavior,
  selectEquivalentAccessPath,
  unknownBehavior,
} from '../src/services/access/accessPath.js'
import {
  type LiveAuthorizationInput,
  resolveLiveAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

vi.mock('../src/services/access/operationTarget.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/access/operationTarget.js')>()
  return {
    ...actual,
    validateOperationTarget: (input: Parameters<typeof actual.validateOperationTarget>[0]) =>
      input.capability === 'gfs.write' ? null : actual.validateOperationTarget(input),
  }
})

const environmentId = canonicalEnvironmentId()
const userId = '10000000-0000-4000-8000-000000000001'
const teamId = '20000000-0000-4000-8000-000000000002'
const sid = '30000000-0000-4000-8000-000000000003'
const jti = '40000000-0000-4000-8000-000000000004'

const session = Object.freeze({
  contract: 'v2' as const,
  userId,
  sid,
  jti,
  sessionVersion: 1,
})

function behavior(overrides: Partial<AccessPathBehavior> = {}): AccessPathBehavior {
  return Object.freeze({
    capabilities: Object.freeze(['host.read'] as const),
    budget: knownBehavior(null),
    credentialPolicy: knownBehavior(null),
    approvalPolicy: knownBehavior(null),
    filesystemScope: knownBehavior(null),
    runtime: knownBehavior(null),
    providerModelPolicy: knownBehavior(null),
    audit: knownBehavior(`user:${userId}`),
    ...overrides,
  })
}

function path(seed: AccessPathSeed) {
  return buildAccessPath({
    principalUserId: userId,
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: 'mcp-host/host-a',
    }),
    seed,
    authorizationRevision: 'ar1_test',
  })
}

type FakeDbOptions = Readonly<{
  memberships?: unknown[]
  sessionLive?: boolean
  hostGrantRows?: Record<string, unknown>[]
  providerUid?: string
}>

function fakeTransaction(options: FakeDbOptions = {}) {
  const query = vi.fn(async (text: string) => {
    if (text.startsWith('SET TRANSACTION') || text.includes("set_config('statement_timeout'")) {
      return { rows: [], rowCount: 0 }
    }
    if (text.includes('AS session_live')) {
      return {
        rows: [
          {
            user_id: userId,
            user_revision: '1',
            resource_revision: '1',
            session_live: options.sessionLive ?? true,
            session_revision: '1:current',
            memberships: options.memberships ?? [],
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('FROM operational_catalog_source_state')) {
      return {
        rows: [
          {
            source_family: 'host',
            generation: '7',
            resource_version: '91',
            status: 'current',
            safe_error_code: null,
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('FROM operational_resource_index')) {
      return {
        rows: [
          {
            environment_id: environmentId,
            resource_type: 'host',
            logical_id: 'mcp-host/host-a',
            source_family: 'host',
            provider_uid: options.providerUid ?? 'uid-host-a',
            provider_resource_version: '91',
            display_name: 'host-a',
            enabled: true,
            deleted_at: null,
            observed_generation: 1,
            content_bytes: 512,
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('FROM operational_resource_relationships')) {
      return { rows: [], rowCount: 0 }
    }
    if (text.includes('WITH candidates AS')) {
      const rows = options.hostGrantRows ?? [
        {
          kind: 'direct',
          grant_id: `user_agents:${userId}:host-a`,
          team_id: null,
          current_role: null,
        },
      ]
      return { rows, rowCount: rows.length }
    }
    throw new Error(`Unexpected query: ${text.slice(0, 80)}`)
  })
  const transaction = async <T>(work: (db: DbClient) => Promise<T>) =>
    work({ query } as unknown as DbClient)
  return { query, transaction }
}

function hostRequest(overrides: Partial<LiveAuthorizationInput> = {}): LiveAuthorizationInput {
  return {
    session,
    requiredCapability: 'host.read',
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: 'mcp-host/host-a',
    }),
    ...overrides,
  }
}

function gfsRequest(overrides: Partial<LiveAuthorizationInput> = {}): LiveAuthorizationInput {
  return {
    session,
    requiredCapability: 'gfs.read',
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'gfs_resource',
      logicalId: '50000000-0000-4000-8000-000000000005',
    }),
    ...overrides,
  }
}

describe('access-path behavior', () => {
  it('selects direct first only when every behavior dimension is known and equal', () => {
    const direct = path({ kind: 'direct', grantId: 'direct-a', behavior: behavior() })
    const team = path({
      kind: 'team',
      grantId: 'team-a',
      teamId,
      currentRole: 'member',
      behavior: behavior(),
    })

    expect(accessPathsAreEquivalent(direct, team)).toBe(true)
    expect(selectEquivalentAccessPath([team, direct])).toBe(direct)
  })

  it('treats equal unknown behavior dimensions as non-equivalent', () => {
    const direct = path({
      kind: 'direct',
      grantId: 'direct-a',
      behavior: behavior({ budget: unknownBehavior() }),
    })
    const team = path({
      kind: 'team',
      grantId: 'team-a',
      teamId,
      currentRole: 'member',
      behavior: behavior({ budget: unknownBehavior() }),
    })

    expect(accessPathsAreEquivalent(direct, team)).toBe(false)
    expect(selectEquivalentAccessPath([direct, team])).toBeNull()
  })
})

describe('live user-access resolution', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('fails a non-live session before reading the operational resource index', async () => {
    const db = fakeTransaction({ sessionLive: false })

    await expect(
      resolveLiveAuthorization(hostRequest(), { transaction: db.transaction })
    ).resolves.toEqual({ status: 'denied', code: 'session_not_live' })
    expect(
      db.query.mock.calls.some(([sql]) =>
        String(sql).includes('FROM operational_catalog_source_state')
      )
    ).toBe(false)
  })

  it('requires an explicit path when direct and team runtime behavior is unknown', async () => {
    const db = fakeTransaction({
      memberships: [
        {
          teamId,
          role: 'member',
          membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
          teamRevision: '1',
        },
      ],
      hostGrantRows: [
        {
          kind: 'direct',
          grant_id: `user_agents:${userId}:host-a`,
          team_id: null,
          current_role: null,
        },
        {
          kind: 'team',
          grant_id: `team_agents:${teamId}:host-a`,
          team_id: teamId,
          current_role: 'member',
        },
      ],
    })

    const result = await resolveLiveAuthorization(hostRequest(), {
      transaction: db.transaction,
    })

    expect(result.status).toBe('access_path_required')
    if (result.status === 'access_path_required') {
      expect(result.safePathDescriptors).toEqual([
        expect.objectContaining({ kind: 'direct' }),
        expect.objectContaining({ kind: 'team', teamId }),
      ])
    }
  })

  it('reports only the capabilities of the explicitly selected path', async () => {
    const db = fakeTransaction({
      memberships: [
        {
          teamId,
          role: 'member',
          membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
          teamRevision: '1',
        },
      ],
      hostGrantRows: [
        {
          kind: 'direct',
          grant_id: 'gfs_grants:direct',
          team_id: null,
          current_role: null,
          permissions: ['read', 'write'],
          drive: '3rd',
        },
        {
          kind: 'team',
          grant_id: 'gfs_grants:team',
          team_id: teamId,
          current_role: 'member',
          permissions: ['read'],
          drive: '3rd',
        },
      ],
    })

    const choice = await resolveLiveAuthorization(gfsRequest(), {
      transaction: db.transaction,
    })
    expect(choice.status).toBe('access_path_required')
    if (choice.status !== 'access_path_required') return
    const selectedTeamPath = choice.safePathDescriptors.find(path => path.kind === 'team')
    expect(selectedTeamPath).toBeDefined()

    const result = await resolveLiveAuthorization(
      gfsRequest({ requestedAccessPathId: selectedTeamPath!.id }),
      { transaction: db.transaction }
    )

    expect(result).toEqual(
      expect.objectContaining({
        status: 'allowed',
        effectiveCapabilities: ['gfs.read'],
        selectedPath: expect.objectContaining({ kind: 'team', teamId }),
      })
    )
  })

  it('preserves a path identity when capability selection filters a sibling path', async () => {
    const options = {
      memberships: [
        {
          teamId,
          role: 'member',
          membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
          teamRevision: '1',
        },
      ],
      hostGrantRows: [
        {
          kind: 'direct',
          grant_id: 'gfs_grants:direct',
          team_id: null,
          current_role: null,
          permissions: ['read', 'write'],
          drive: '3rd',
        },
        {
          kind: 'team',
          grant_id: 'gfs_grants:team',
          team_id: teamId,
          current_role: 'member',
          permissions: ['read'],
          drive: '3rd',
        },
      ],
    }
    const catalogEquivalent = await resolveLiveAuthorization(gfsRequest(), {
      transaction: fakeTransaction(options).transaction,
    })
    expect(catalogEquivalent.status).toBe('access_path_required')
    if (catalogEquivalent.status !== 'access_path_required') return
    const directPath = catalogEquivalent.safePathDescriptors.find(path => path.kind === 'direct')
    expect(directPath).toBeDefined()

    const write = await resolveLiveAuthorization(
      gfsRequest({
        requiredCapability: 'gfs.write',
        requestedAccessPathId: directPath!.id,
      }),
      { transaction: fakeTransaction(options).transaction }
    )

    expect(write).toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: directPath!.id, kind: 'direct' }),
      })
    )

    const unsupportedDb = fakeTransaction(options)
    await expect(
      resolveLiveAuthorization(gfsRequest({ requiredCapability: 'gfs.future.unsupported' }), {
        transaction: unsupportedDb.transaction,
      })
    ).resolves.toEqual({ status: 'denied', code: 'unknown_capability' })
    expect(unsupportedDb.query).not.toHaveBeenCalled()
  })

  it('charges the complete identity seed set before capability selection', async () => {
    const db = fakeTransaction({
      memberships: [
        {
          teamId,
          role: 'member',
          membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
          teamRevision: '1',
        },
      ],
      hostGrantRows: [
        {
          kind: 'direct',
          grant_id: 'gfs_grants:direct',
          team_id: null,
          current_role: null,
          permissions: ['read', 'write'],
          drive: '3rd',
        },
        {
          kind: 'team',
          grant_id: 'gfs_grants:team',
          team_id: teamId,
          current_role: 'member',
          permissions: ['read'],
          drive: '3rd',
        },
      ],
    })
    const budget = AccessExecutionBudget.create('action', { limits: { accessPaths: 1 } })
    try {
      await expect(
        resolveLiveAuthorization(gfsRequest({ requiredCapability: 'gfs.write' }), {
          transaction: db.transaction,
          budget,
        })
      ).resolves.toEqual({
        status: 'unavailable',
        dependencyClass: 'capacity',
        retryable: true,
      })
    } finally {
      budget.close()
    }
  })

  it('revalidates the exact provider incarnation for a selected operational path', async () => {
    const currentObject = {
      metadata: {
        name: 'host-a',
        namespace: 'mcp-host',
        uid: 'uid-host-a',
        resourceVersion: '91',
        generation: 1,
      },
      spec: { enabled: true },
    }
    const firstDb = fakeTransaction()
    const gateway = { getResourceExact: vi.fn().mockResolvedValue(currentObject) }
    const first = await resolveLiveAuthorization(hostRequest(), {
      transaction: firstDb.transaction,
      gateway,
    })
    expect(first.status).toBe('allowed')
    if (first.status !== 'allowed') return

    gateway.getResourceExact.mockResolvedValue({
      ...currentObject,
      metadata: { ...currentObject.metadata, uid: 'uid-host-recreated', resourceVersion: '1' },
    })
    const secondDb = fakeTransaction()
    const second = await resolveLiveAuthorization(
      hostRequest({ requestedAccessPathId: first.selectedPath.id }),
      { transaction: secondDb.transaction, gateway }
    )

    expect(second).toEqual(
      expect.objectContaining({ status: 'access_path_stale', code: 'access_path_stale' })
    )
  })

  it('rejects incomplete and role-escalating team invitation targets', async () => {
    const base = {
      session,
      requiredCapability: 'team.member.invite',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'team',
        logicalId: teamId,
      }),
    } satisfies LiveAuthorizationInput
    const db = fakeTransaction({
      memberships: [
        {
          teamId,
          role: 'inviter',
          membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
          teamRevision: '1',
        },
      ],
    })

    await expect(resolveLiveAuthorization(base, { transaction: db.transaction })).resolves.toEqual({
      status: 'invalid',
      code: 'invalid_operation_target',
    })

    await expect(
      resolveLiveAuthorization(
        {
          ...base,
          operationTarget: { teamId, action: 'create', role: 'admin' },
        },
        { transaction: db.transaction }
      )
    ).resolves.toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('rejects a caller-selected environment before authority or gateway work', async () => {
    const db = fakeTransaction()
    const gateway = { getResourceExact: vi.fn() }

    await expect(
      resolveLiveAuthorization(
        hostRequest({
          resource: canonicalResourceIdentity({
            environmentId: 'attacker:selected-environment',
            type: 'host',
            logicalId: 'mcp-host/host-a',
          }),
        }),
        { transaction: db.transaction, gateway }
      )
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_resource' })
    expect(db.query).not.toHaveBeenCalled()
    expect(gateway.getResourceExact).not.toHaveBeenCalled()
  })
})
