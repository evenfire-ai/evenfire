import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  consumePeriodQuota,
  deleteGrant,
  resolveRecipientProfiles,
  upsertGrant,
} from '../src/services/pluginWorkloadSdkDb.js'

const permissionEvents = vi.hoisted(() => ({ append: vi.fn() }))

// Mock the pg pool so we can inspect the exact SQL + bind parameters that the
// real consumePeriodQuota produces (the quota-tracker test mocks
// consumePeriodQuota itself, so it never exercises this SQL/param path).
vi.mock('../src/db.js', () => ({
  ...(() => {
    const query = vi.fn().mockResolvedValue({ rows: [{ prompt_bridge_count: 1 }], rowCount: 1 })
    return {
      pool: { query, connect: vi.fn() },
      withTransaction: (work: (db: { query: typeof query }) => unknown) => work({ query }),
    }
  })(),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: (...args: unknown[]) =>
    permissionEvents.append(...args),
}))

/** Highest $N placeholder referenced in a SQL string. */
function maxPlaceholder(sql: string): number {
  const matches = sql.match(/\$(\d+)/g) ?? []
  return matches.reduce((max, p) => Math.max(max, Number(p.slice(1))), 0)
}

describe('consumePeriodQuota — SQL bind parameter contract', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockClear()
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ prompt_bridge_count: 1 }],
      rowCount: 1,
    } as never)
  })

  // Regression: a malformed bind array (more params than placeholders) makes
  // node-postgres throw "bind message supplies N parameters, but prepared
  // statement requires M", which silently breaks every quota consumption.
  it('binds exactly as many params as the SQL references (foldEagerUsage=false → no $6)', async () => {
    await consumePeriodQuota('ns', 'name', 'promptBridge', 3, new Date(0), false)
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).not.toContain('$6')
    expect(params).toHaveLength(maxPlaceholder(sql))
    expect(params).toHaveLength(5)
  })

  it('binds the eager period as $6 only when folding eager usage (foldEagerUsage=true)', async () => {
    await consumePeriodQuota(
      'ns',
      'name',
      'promptBridge',
      3,
      new Date('2026-06-10T12:00:00Z'),
      true
    )
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('$6')
    expect(params).toHaveLength(maxPlaceholder(sql))
    expect(params).toHaveLength(6)
  })
})

describe('upsertGrant — provider column (R1)', () => {
  const grantRow = {
    id: 'g1',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'sdk-recipe',
    capability_family: 'promptBridge',
    provider: 'zai',
    allowed_models: ['glm-4.7'],
    allowed_event_types: [],
    allowed_target_refs: [],
    allowed_user_refs: [],
    allowed_callers: ['api'],
    quota_limits: {},
    model_policies: {},
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  }

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
  })

  it('persists the explicit provider and maps it back on the returned grant', async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [grantRow], rowCount: 1 } as never)
    const grant = await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'promptBridge',
        provider: 'zai',
        allowedModels: ['glm-4.7'],
        allowedCallers: ['api'],
      },
      'operator-1'
    )
    const [sql, params] = vi
      .mocked(pool.query)
      .mock.calls.find(([statement]) =>
        String(statement).includes('INSERT INTO plugin_workload_sdk_grants')
      ) as unknown as [string, unknown[]]
    // provider is bound as $4 (a scalar, not a jsonb param).
    expect(sql).toMatch(/\(recipe_namespace, recipe_name, capability_family, provider,/)
    expect(sql).toMatch(/provider = EXCLUDED\.provider/)
    expect(params[3]).toBe('zai')
    expect(grant.provider).toBe('zai')
  })

  it('binds NULL when no provider is supplied (clientNotifications)', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ ...grantRow, capability_family: 'clientNotifications', provider: null }],
      rowCount: 1,
    } as never)
    const grant = await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['api'],
      },
      'operator-1'
    )
    const [, params] = vi
      .mocked(pool.query)
      .mock.calls.find(([statement]) =>
        String(statement).includes('INSERT INTO plugin_workload_sdk_grants')
      ) as unknown as [string, unknown[]]
    expect(params[3]).toBeNull()
    expect(grant.provider).toBeNull()
  })

  it('reads a legacy grant with no provider column as null (undefined → null)', async () => {
    const { provider: _drop, ...legacyRow } = grantRow
    vi.mocked(pool.query).mockResolvedValue({ rows: [legacyRow], rowCount: 1 } as never)
    const grant = await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'promptBridge',
        provider: 'zai',
        allowedModels: ['glm-4.7'],
        allowedCallers: ['api'],
      },
      'operator-1'
    )
    expect(grant.provider).toBeNull()
  })

  it('writes ordered targets and default atomically while incrementing the policy revision', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        {
          ...grantRow,
          prompt_targets: [
            {
              targetRef: 'primary-zai',
              provider: 'zai',
              model: 'glm-4.7',
              credentialSlot: 'zai-api-key',
            },
          ],
          default_target_ref: 'primary-zai',
          policy_revision: 2,
        },
      ],
      rowCount: 1,
    } as never)
    const grant = await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'promptBridge',
        provider: 'zai',
        allowedCallers: ['api'],
        promptTargets: [
          {
            targetRef: 'primary-zai',
            provider: 'zai',
            model: 'glm-4.7',
            credentialSlot: 'zai-api-key',
          },
        ],
        defaultTargetRef: 'primary-zai',
      },
      'operator-1'
    )
    const [sql, params] = vi
      .mocked(pool.query)
      .mock.calls.find(([statement]) =>
        String(statement).includes('INSERT INTO plugin_workload_sdk_grants')
      ) as unknown as [string, unknown[]]
    expect(sql).toContain('prompt_targets, default_target_ref')
    expect(sql).toContain('policy_revision = plugin_workload_sdk_grants.policy_revision + 1')
    expect(JSON.parse(params[11] as string)).toEqual([
      expect.objectContaining({ targetRef: 'primary-zai', credentialSlot: 'zai-api-key' }),
    ])
    expect(params[12]).toBe('primary-zai')
    expect(grant).toMatchObject({
      defaultTargetRef: 'primary-zai',
      policyRevision: 2,
      promptTargets: [{ targetRef: 'primary-zai', provider: 'zai' }],
    })
  })
})

describe('resolveRecipientProfiles', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
  })

  it('returns [] without querying when no ref is a UUID', async () => {
    const result = await resolveRecipientProfiles(['not-a-uuid', ''])
    expect(result).toEqual([])
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('resolves the email handle preserving input order and binds only the UUID refs', async () => {
    // EvenFire users are identified by email — the picker shows it. DB returns
    // rows out of order, so the resolver must re-order by input.
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        { id: U2, email: 'bob@clerum.io' },
        { id: U1, email: 'ada@clerum.io' },
      ],
      rowCount: 2,
    } as never)
    const result = await resolveRecipientProfiles([U1, U2])
    expect(result).toEqual([
      { userRef: U1, displayName: 'ada@clerum.io' },
      { userRef: U2, displayName: 'bob@clerum.io' },
    ])
    const [, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([[U1, U2]])
  })

  it('drops a ref that no longer resolves to a user — never shows a bare UUID', async () => {
    // A deleted/unknown granted user has no row; it must be omitted, not echoed
    // as a UUID (the UUID is the internal id we never surface in the picker).
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: U1, email: 'ada@clerum.io' }],
      rowCount: 1,
    } as never)
    const result = await resolveRecipientProfiles([U1, U2])
    expect(result).toEqual([{ userRef: U1, displayName: 'ada@clerum.io' }])
  })

  it('drops a user row with a null email', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: U1, email: null }],
      rowCount: 1,
    } as never)
    const result = await resolveRecipientProfiles([U1])
    expect(result).toEqual([])
  })
})

describe('Plugin Workload SDK governed permission events', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  const GRANT_ID = '33333333-3333-4333-8333-333333333333'
  const OPERATOR_ID = '44444444-4444-4444-8444-444444444444'
  const grantRow = (allowedUserRefs: string[]) => ({
    id: GRANT_ID,
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'research',
    capability_family: 'promptBridge',
    allowed_models: ['gpt-5'],
    allowed_event_types: [],
    allowed_target_refs: [],
    allowed_user_refs: allowedUserRefs,
    allowed_callers: ['coordinator'],
    quota_limits: {},
    model_policies: {},
    created_at: '2026-07-14T12:00:00.000Z',
    updated_at: '2026-07-14T12:00:00.000Z',
  })

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
  })

  it('records the service configuration and only newly added canonical users', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ allowed_user_refs: [U1] }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [grantRow([U1, U2])], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: U2 }], rowCount: 1 } as never)

    await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'research',
        capabilityFamily: 'promptBridge',
        allowedModels: ['gpt-5'],
        allowedUserRefs: [U1, U2],
        allowedCallers: ['coordinator'],
      },
      OPERATOR_ID
    )

    expect(permissionEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ query: pool.query }),
      expect.objectContaining({
        operatorSub: OPERATOR_ID,
        changes: [
          expect.objectContaining({
            action: 'grant',
            resourceClass: 'plugin_workload_sdk_access',
            subject: { kind: 'service', id: 'promptBridge' },
            status: 'configured',
          }),
          expect.objectContaining({
            action: 'grant',
            subject: { kind: 'user', id: U2 },
          }),
        ],
      })
    )
  })

  it('records service revocation and omits user refs that no longer resolve', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [grantRow([U1, U2])], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: U1 }], rowCount: 1 } as never)

    await expect(deleteGrant(GRANT_ID, 'sandbox-recipes', 'research', OPERATOR_ID)).resolves.toBe(
      true
    )

    const changes = permissionEvents.append.mock.calls[0]?.[1]?.changes
    expect(changes).toEqual([
      expect.objectContaining({
        action: 'revoke',
        subject: { kind: 'service', id: 'promptBridge' },
      }),
      expect.objectContaining({ action: 'revoke', subject: { kind: 'user', id: U1 } }),
    ])
  })
})
