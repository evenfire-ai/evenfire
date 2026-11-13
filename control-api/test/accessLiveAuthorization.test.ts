import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
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
  type LiveActionAuthorizationInput,
  resolveLiveActionAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  type AccessTransactionTripwire,
  type TripwireQueryResult,
  installAccessTransactionTripwire,
} from './helpers/accessTransactionTripwire.js'
import { createFakeOperationalGateway, hostObject } from './helpers/fakeOperationalGateway.js'

// The live resolver's selected-path rules, reseeded from index rows to a live
// Kubernetes gateway (merge plan v2 §2, C5): Kubernetes objects come from the
// fake gateway, Postgres facts from the db.ts pool tripwire.

const environmentId = canonicalEnvironmentId()
const userId = '10000000-0000-4000-8000-000000000001'
const teamId = '20000000-0000-4000-8000-000000000002'
const sid = '30000000-0000-4000-8000-000000000003'
const jti = '40000000-0000-4000-8000-000000000004'
const gfsResourceId = '50000000-0000-4000-8000-000000000005'

const session = Object.freeze({
  contract: 'v2' as const,
  userId,
  sid,
  jti,
  sessionVersion: 1,
})

const hostA = hostObject('host-a', {}, { uid: 'uid-host-a', resourceVersion: '91' })
const hostLogicalId = `${config.hostsNamespace}/host-a`

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
      logicalId: hostLogicalId,
    }),
    seed,
    authorizationRevision: 'ar1_test',
  })
}

const teamMembership = Object.freeze({
  teamId,
  role: 'member',
  membershipUpdatedAt: '2026-08-10T00:00:00.000Z',
})

const directHostGrant = Object.freeze({
  kind: 'direct',
  grant_id: `user_agents:${userId}:host-a`,
  team_id: null,
  current_role: null,
})

const gfsGrants = Object.freeze([
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
])

type FakePostgres = Readonly<{
  memberships?: unknown[]
  sessionLive?: boolean
  grantRows?: readonly Record<string, unknown>[]
}>

function rows(values: readonly unknown[]): TripwireQueryResult {
  return { rows: [...values], rowCount: values.length }
}

/** Phase P's statements; anything else is a test failure. */
function postgres(options: FakePostgres = {}) {
  return (text: string): TripwireQueryResult => {
    if (text.startsWith('SET TRANSACTION') || text.includes("set_config('statement_timeout'")) {
      return rows([])
    }
    if (text.includes('AS session_live')) {
      return rows([
        {
          user_id: userId,
          session_live: options.sessionLive ?? true,
          session_revision: '1:current',
          memberships: options.memberships ?? [],
        },
      ])
    }
    if (text.includes('FROM token_budgets')) return rows([])
    if (text.includes('FROM llm_allowed_models')) return rows([])
    if (text.includes('SELECT DISTINCT ON (context_id)')) return rows([])
    if (text.includes('WITH candidates AS')) return rows(options.grantRows ?? [directHostGrant])
    throw new Error(`Unexpected query: ${text.slice(0, 100)}`)
  }
}

let tripwire: AccessTransactionTripwire
let fake: ReturnType<typeof createFakeOperationalGateway>

function install(options: FakePostgres = {}, hosts: readonly unknown[] = [hostA]) {
  tripwire = installAccessTransactionTripwire(postgres(options))
  fake = createFakeOperationalGateway({ objects: { hosts }, tripwire })
}

afterEach(() => {
  vi.restoreAllMocks()
})

function hostRequest(
  overrides: Partial<LiveActionAuthorizationInput> = {}
): LiveActionAuthorizationInput {
  return {
    session,
    operationId: 'host.status.read',
    resource: canonicalResourceIdentity({ environmentId, type: 'host', logicalId: hostLogicalId }),
    operationTarget: { hostRef: hostLogicalId },
    ...overrides,
  }
}

function gfsRequest(
  overrides: Partial<LiveActionAuthorizationInput> = {}
): LiveActionAuthorizationInput {
  return {
    session,
    operationId: 'gfs.read',
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'gfs_resource',
      logicalId: gfsResourceId,
    }),
    operationTarget: { drive: '3rd', resourceId: gfsResourceId },
    ...overrides,
  }
}

function resolve(input: LiveActionAuthorizationInput, budget?: AccessExecutionBudget) {
  return resolveLiveActionAuthorization(input, {
    gateway: fake.gateway,
    ...(budget ? { budget } : {}),
  })
}

/** K2's exact GETs: every GET after the last LIST of phase K1. */
const gfsWriteTarget = Object.freeze({ drive: '3rd', resourceId: gfsResourceId, action: 'update' })

const exactGets = () => {
  const lastList = fake.calls.map(call => call.method).lastIndexOf('listResourcePage')
  return fake.calls.slice(lastList + 1).filter(call => call.method === 'getResourceExact')
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
  it('denies a non-live session before exact-validating any operational binding', async () => {
    install({ sessionLive: false })

    await expect(resolve(hostRequest())).resolves.toEqual({
      status: 'denied',
      code: 'session_not_live',
    })
    // Witness: K1 read the Host graph and phase P read the session; K2 never ran.
    expect(fake.calls.map(call => `${call.method}:${call.plural}`)).toContain(
      'listResourcePage:contexts'
    )
    expect(tripwire.events).toContain('BEGIN')
    expect(exactGets()).toEqual([])
  })

  it('fails a Host closed when its configured Context does not resolve', async () => {
    install({}, [hostObject('host-a', { contextRef: 'missing' }, { uid: 'uid-host-a' })])

    await expect(resolve(hostRequest())).resolves.toEqual({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    })
    expect(fake.calls.map(call => `${call.method}:${call.plural}`)).toContain(
      'listResourcePage:contexts'
    )
    expect(exactGets()).toEqual([])

    vi.restoreAllMocks()
    install()
    await expect(resolve(hostRequest())).resolves.toEqual(
      expect.objectContaining({ status: 'allowed' })
    )
    expect(exactGets().map(call => `${call.plural}/${call.name}`)).toEqual(['hosts/host-a'])
  })

  it('requires an explicit path when direct and team runtime behavior is unknown', async () => {
    install({
      memberships: [teamMembership],
      grantRows: [
        directHostGrant,
        {
          kind: 'team',
          grant_id: `team_agents:${teamId}:host-a`,
          team_id: teamId,
          current_role: 'member',
        },
      ],
    })

    const result = await resolve(
      hostRequest({
        operationId: 'chat.message.invoke',
        operationTarget: {
          hostRef: hostLogicalId,
          channelType: 'rpc',
          channelId: 'host-a',
          messageId: '60000000-0000-4000-8000-000000000006',
        },
      })
    )

    expect(result.status, JSON.stringify(result)).toBe('access_path_required')
    if (result.status === 'access_path_required') {
      expect(result.safePathDescriptors).toEqual([
        expect.objectContaining({ kind: 'direct' }),
        expect.objectContaining({ kind: 'team', teamId }),
      ])
    }
  })

  it('reports only the capabilities of the explicitly selected path', async () => {
    install({ memberships: [teamMembership], grantRows: gfsGrants })

    const choice = await resolve(gfsRequest())
    expect(choice.status, JSON.stringify(choice)).toBe('access_path_required')
    if (choice.status !== 'access_path_required') return
    const selectedTeamPath = choice.safePathDescriptors.find(value => value.kind === 'team')
    expect(selectedTeamPath).toBeDefined()

    const result = await resolve(gfsRequest({ requestedAccessPathId: selectedTeamPath!.id }))

    expect(result).toEqual(
      expect.objectContaining({
        status: 'allowed',
        effectiveCapabilities: ['gfs.read'],
        selectedPath: expect.objectContaining({ kind: 'team', teamId }),
      })
    )
    // A Postgres-only resource reads nothing from Kubernetes.
    expect(fake.calls).toEqual([])
  })

  it('preserves a path identity when capability selection filters a sibling path', async () => {
    install({ memberships: [teamMembership], grantRows: gfsGrants })
    const readChoice = await resolve(gfsRequest())
    expect(readChoice.status).toBe('access_path_required')
    if (readChoice.status !== 'access_path_required') return
    const directPath = readChoice.safePathDescriptors.find(value => value.kind === 'direct')
    const teamPath = readChoice.safePathDescriptors.find(value => value.kind === 'team')
    expect(directPath).toBeDefined()
    expect(teamPath).toBeDefined()

    const write = await resolve(
      gfsRequest({
        operationId: 'gfs.write',
        operationTarget: gfsWriteTarget,
        requestedAccessPathId: directPath!.id,
      })
    )
    expect(write).toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: directPath!.id, kind: 'direct' }),
      })
    )

    await expect(
      resolve(
        gfsRequest({
          operationId: 'gfs.write',
          operationTarget: gfsWriteTarget,
          requestedAccessPathId: teamPath!.id,
        })
      )
    ).resolves.toEqual(
      expect.objectContaining({ status: 'access_path_stale', code: 'access_path_stale' })
    )

    const statementsBefore = tripwire.events.length
    await expect(resolve(gfsRequest({ operationId: 'gfs.delete' }))).resolves.toEqual({
      status: 'denied',
      code: 'forbidden',
    })
    // Witness: the denial came from the grants read in phase P.
    expect(tripwire.events.slice(statementsBefore)).toContain('BEGIN')
  })

  it('charges the complete identity seed set before capability selection', async () => {
    install({ memberships: [teamMembership], grantRows: gfsGrants })
    const budget = AccessExecutionBudget.create('action', { limits: { accessPaths: 1 } })
    try {
      await expect(
        resolve(gfsRequest({ operationId: 'gfs.write', operationTarget: gfsWriteTarget }), budget)
      ).resolves.toEqual({
        status: 'unavailable',
        dependencyClass: 'capacity',
        retryable: true,
      })
      expect(budget.remaining('accessPaths')).toBe(1)
      expect(tripwire.events).toContain('BEGIN')
    } finally {
      budget.close()
    }
  })

  it('revalidates the exact provider incarnation for a selected operational path', async () => {
    install()
    const first = await resolve(hostRequest())
    expect(first.status, JSON.stringify(first)).toBe('allowed')
    if (first.status !== 'allowed') return

    // The Host is recreated between K1's read and K2's exact GET.
    const listPage = fake.gateway.listResourcePage
    vi.spyOn(fake.gateway, 'listResourcePage').mockImplementation(async (...args) => {
      const page = await listPage(...args)
      fake.objects.hosts.splice(
        0,
        fake.objects.hosts.length,
        hostObject('host-a', {}, { uid: 'uid-host-recreated', resourceVersion: '1' })
      )
      return page
    })
    const second = await resolve(hostRequest({ requestedAccessPathId: first.selectedPath.id }))

    expect(second).toEqual(
      expect.objectContaining({ status: 'access_path_stale', code: 'access_path_stale' })
    )
    // Witness: K2 re-read the Host after the recreation.
    expect(exactGets().at(-1)).toMatchObject({ plural: 'hosts', name: 'host-a' })
  })

  it('rejects a caller-selected environment before authority or gateway work', async () => {
    install()

    await expect(
      resolve(
        hostRequest({
          resource: canonicalResourceIdentity({
            environmentId: 'attacker:selected-environment',
            type: 'host',
            logicalId: hostLogicalId,
          }),
        })
      )
    ).resolves.toEqual({ status: 'invalid', code: 'invalid_resource' })
    expect(tripwire.events).toEqual([])
    expect(fake.calls).toEqual([])

    // Witness that the same request with the canonical environment does reach
    // both stores.
    await expect(resolve(hostRequest())).resolves.toEqual(
      expect.objectContaining({ status: 'allowed' })
    )
    expect(tripwire.events).toContain('BEGIN')
    expect(fake.calls.length).toBeGreaterThan(0)
  })
})
