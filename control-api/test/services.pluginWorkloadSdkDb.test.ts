import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
  buildGrantUpdateNotifyPayload,
  deleteGrant,
  failStaleInvocations,
  finalizePluginWorkloadSdkRevocation,
  getPluginWorkloadSdkLegacyGrantInventory,
  hasUsableClientNotificationRecipients,
  hashPromptTargetPolicy,
  markPluginWorkloadSdkProviderAttemptStatus,
  redeemPluginWorkloadSdkCredentialTicketJti,
  registerPluginWorkloadSdkCredentialTicketJti,
  reservePluginWorkloadSdkProviderAttempt,
  resolveRecipientProfiles,
  revokePluginWorkloadSdkForRecipe,
  updateInvocationStatus,
  upsertGrant,
} from '../src/services/pluginWorkloadSdkDb.js'

const permissionEvents = vi.hoisted(() => ({ append: vi.fn() }))

// issue #375 M3 (jozer review): the client handed out by the mocked
// withTransaction is DISTINGUISHABLE from the pool. Its query spy DELEGATES to
// pool.query (so the per-test mockResolvedValueOnce queues keep driving row
// responses) but records its own calls — so an out-of-transaction refactor
// (`notifyGrantUpdate(pool, …)` instead of the in-transaction `db`) never
// reaches `txClient` and turns the NOTIFY assertions below RED. The previous
// mock passed `work({ query: pool.query })`, making the transaction client and
// the pool literally the same object and that distinction unrepresentable.
const txClient = vi.hoisted(() => ({ query: vi.fn() }))

// Mock the pg pool so we can inspect the exact SQL + bind parameters the real
// db-layer functions produce.
vi.mock('../src/db.js', () => ({
  ...(() => {
    const query = vi.fn().mockResolvedValue({ rows: [{ prompt_bridge_count: 1 }], rowCount: 1 })
    txClient.query.mockImplementation((...args: unknown[]) =>
      (query as (...inner: unknown[]) => unknown)(...args)
    )
    return {
      pool: { query, connect: vi.fn() },
      withTransaction: (work: (db: { query: typeof txClient.query }) => unknown) => work(txClient),
    }
  })(),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: (...args: unknown[]) =>
    permissionEvents.append(...args),
}))

function mockUpsertGrantQueries(row: Record<string, unknown>): void {
  // recipe advisory lock → family row → recipe kill-switch guard → upsert.
  const responses = [
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ] as Array<{ rows: unknown[]; rowCount: number }>
  if (row.capability_family === 'clientNotifications') {
    responses.push({ rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 })
  }
  responses.push({ rows: [row], rowCount: 1 })
  if (row.capability_family === 'clientNotifications') {
    // Permission-event materialization resolves newly added control-plane
    // users after the upsert has returned its row.
    responses.push({ rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 })
  }
  for (const response of responses) {
    vi.mocked(pool.query).mockResolvedValueOnce(response as never)
  }
}

// The `consumePeriodQuota — SQL bind parameter contract` block was removed
// with the function itself (issue #348, plan §1.6 dead-code sweep).

describe('JIT credential ticket jti registry', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
  })

  it('registers a non-secret, invocation-bound jti and reports insertion conflicts', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ policy_state: 'active' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            status: 'in_progress',
            attempt_generation: 1,
            lease_expires_at: new Date(Date.now() + 60_000),
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: '33333333-3333-4333-8333-333333333333' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await expect(
      registerPluginWorkloadSdkCredentialTicketJti({
        jti: '11111111-1111-4111-8111-111111111111',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        invocationId: '22222222-2222-4222-8222-222222222222',
        targetRef: 'openai-fallback',
        attemptGeneration: 1,
        providerAttemptId: '33333333-3333-4333-8333-333333333333',
        expiresAt: new Date('2026-08-02T12:01:00.000Z'),
      })
    ).resolves.toBe(true)
    const [sql, params] = vi
      .mocked(pool.query)
      .mock.calls.find(([statement]) =>
        String(statement).includes('INSERT INTO plugin_workload_sdk_credential_ticket_jtis')
      ) as unknown as [string, unknown[]]
    expect(sql).toContain('plugin_workload_sdk_credential_ticket_jtis')
    expect(sql).toContain('ON CONFLICT (jti) DO NOTHING')
    expect(params).toHaveLength(8)
    expect(JSON.stringify(params)).not.toContain('secret-value')
  })

  it('redeems a jti atomically once and binds every identifying field in SQL', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ policy_state: 'active' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await expect(
      redeemPluginWorkloadSdkCredentialTicketJti({
        jti: '11111111-1111-4111-8111-111111111111',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        invocationId: '22222222-2222-4222-8222-222222222222',
        targetRef: 'openai-fallback',
        attemptGeneration: 1,
        providerAttemptId: '33333333-3333-4333-8333-333333333333',
      })
    ).resolves.toBe(true)
    const [sql, params] = vi.mocked(pool.query).mock.calls[2] as unknown as [string, unknown[]]
    expect(sql).toContain('redeemed_at IS NULL')
    expect(sql).toContain('expires_at > now()')
    expect(params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'sandbox-recipes',
      'sdk-recipe',
      '22222222-2222-4222-8222-222222222222',
      'openai-fallback',
      1,
      '33333333-3333-4333-8333-333333333333',
    ])
  })
})

describe('ordered provider-attempt reservation', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
  })

  it('reserves only the next authorized target after an eligible prior failure', async () => {
    const primary = {
      targetRef: 'primary-openai',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credentialSlot: 'openai-api-key',
    }
    const fallback = {
      targetRef: 'fallback-claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      credentialSlot: 'claude-api-key',
    }
    const policyHash = hashPromptTargetPolicy({
      policyRevision: 7,
      defaultTargetRef: primary.targetRef,
      promptTargets: [primary, fallback],
    })
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe lock
      .mockResolvedValueOnce({
        rows: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            method: 'promptBridge',
            status: 'in_progress',
            attempt_generation: 1,
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            prompt_authorization: {
              policyRevision: 7,
              policyHash,
              authorizedTargetRefs: [primary.targetRef, fallback.targetRef],
            },
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            policy_state: 'active',
            policy_revision: 7,
            prompt_targets: [primary, fallback],
            default_target_ref: primary.targetRef,
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ attempt_index: 1, target_ref: primary.targetRef, status: 'failed' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            invocation_id: '22222222-2222-4222-8222-222222222222',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
            attempt_generation: 1,
            attempt_index: 2,
            target_ref: fallback.targetRef,
            provider: fallback.provider,
            model: fallback.model,
            credential_slot: fallback.credentialSlot,
            status: 'reserved',
            credential_jti: null,
            started_at: new Date().toISOString(),
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            completed_at: null,
            usage_request_id: null,
          },
        ],
        rowCount: 1,
      } as never)

    const result = await reservePluginWorkloadSdkProviderAttempt({
      invocationId: '22222222-2222-4222-8222-222222222222',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'sdk-recipe',
      attemptGeneration: 1,
      target: fallback,
    })

    expect(result).toMatchObject({ attemptIndex: 2, targetRef: fallback.targetRef })
    const sqls = vi.mocked(pool.query).mock.calls.map(([sql]) => String(sql))
    expect(sqls[0]).toContain('pg_advisory_xact_lock')
    expect(sqls[1]).toContain('FOR UPDATE')
    expect(sqls[2]).toContain("capability_family = 'promptBridge'")
    expect(sqls[3]).toContain('ORDER BY attempt_index ASC')
    expect(sqls[3]).toContain('FOR UPDATE')
    expect(sqls[4]).toContain('attempt_index')
  })
})

describe('legacy promptBridge inventory', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
  })

  it('reports legacy shape without rewriting policy or exposing secrets', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          id: 'grant-legacy',
          recipe_namespace: 'sandbox-recipes',
          recipe_name: 'legacy-recipe',
          policy_state: 'legacy_unreviewed',
          policy_revision: 0,
          provider: null,
          prompt_targets: [],
          default_target_ref: null,
          policy_reviewed_at: null,
          policy_reviewed_by: null,
        },
        {
          id: 'grant-active',
          recipe_namespace: 'sandbox-recipes',
          recipe_name: 'active-recipe',
          policy_state: 'active',
          policy_revision: 2,
          provider: 'openai',
          prompt_targets: [
            {
              targetRef: 'primary-openai',
              provider: 'openai',
              model: 'gpt-5.4-mini',
              credentialSlot: 'openai-api-key',
            },
          ],
          default_target_ref: 'primary-openai',
          policy_reviewed_at: '2026-08-05T00:00:00.000Z',
          policy_reviewed_by: 'operator-1',
        },
      ],
      rowCount: 2,
    } as never)
    await expect(
      getPluginWorkloadSdkLegacyGrantInventory({ recipeNamespace: 'sandbox-recipes' })
    ).resolves.toEqual({
      totalPromptBridgeGrants: 2,
      legacyPromptBridgeGrants: 1,
      activationReady: false,
      items: [
        expect.objectContaining({
          id: 'grant-legacy',
          recipeName: 'legacy-recipe',
          reasons: expect.arrayContaining([
            'legacy_policy_state',
            'missing_provider',
            'empty_prompt_targets',
            'missing_default_target',
            'invalid_policy_revision',
          ]),
        }),
      ],
    })
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("capability_family = 'promptBridge'")
    expect(params).toEqual(['sandbox-recipes'])
    expect(sql).not.toContain('credential')
  })
})

describe('invocation retry lifecycle timestamps', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    vi.mocked(pool.query).mockResolvedValue({ rows: [], rowCount: 1 } as never)
  })

  it('touches updated_at on every status transition and preserves the CAS guard', async () => {
    await expect(
      updateInvocationStatus('inv-1', 'in_progress', {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        expectedCurrentStatus: 'failed',
        leaseSeconds: 180,
      })
    ).resolves.toBe(true)
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('updated_at = now()')
    expect(sql).toContain('status = $7')
    expect(params).toEqual([
      'inv-1',
      'in_progress',
      false,
      180,
      'sandbox-recipes',
      'sdk-recipe',
      'failed',
    ])
  })

  it('rejects an in-progress transition without a positive lease', async () => {
    await expect(
      updateInvocationStatus('inv-1', 'in_progress', {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
      })
    ).resolves.toBe(false)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('accepts a repeated terminal invocation report without weakening the CAS guard', async () => {
    await expect(
      updateInvocationStatus('inv-1', 'complete', {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        expectedCurrentStatus: 'in_progress',
        expectedAttemptGeneration: 1,
      })
    ).resolves.toBe(true)
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('status = $7')
    expect(sql).toContain("status = $2 AND $2 NOT IN ('in_progress', 'accepted')")
  })

  it('makes provider-attempt terminal reports idempotent and outcome-specific', async () => {
    await expect(
      markPluginWorkloadSdkProviderAttemptStatus({
        id: 'attempt-1',
        invocationId: 'inv-1',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        attemptGeneration: 1,
        status: 'complete',
      })
    ).resolves.toBe(true)
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('status = $6')
    expect(sql).toContain("status IN ('reserved', 'in_progress')")
  })

  it('sweeps by the latest retry timestamp rather than the original reservation', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'inv-1',
            attempt_generation: 2,
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'attempt-2',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
            attempt_generation: 2,
            attempt_index: 1,
            target_ref: 'primary-openai',
            provider: 'openai',
            model: 'gpt-5.4-mini',
            credential_slot: 'openai-api-key',
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValue({ rows: [{ id: 'inv-1' }], rowCount: 1 } as never)
    await expect(failStaleInvocations(150)).resolves.toBe(1)
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('FROM plugin_workload_sdk_invocations')
    expect(sql).toContain('lease_expires_at < now()')
    expect(sql).toContain('lease_expires_at IS NULL')
    expect(sql).toContain('updated_at < now()')
    expect(sql).toContain('FOR UPDATE')
    expect(pool.query).toHaveBeenCalledTimes(7)
    expect(vi.mocked(pool.query).mock.calls[1]?.[0] as string).toContain('pg_advisory_xact_lock')
    expect(vi.mocked(pool.query).mock.calls[2]?.[0] as string).toContain(
      'FROM plugin_workload_sdk_provider_attempts'
    )
    expect(vi.mocked(pool.query).mock.calls[3]?.[0] as string).toContain(
      "SET status = 'provider_unavailable'"
    )
    expect(vi.mocked(pool.query).mock.calls[4]?.[0] as string).toContain(
      'INSERT INTO plugin_workload_sdk_spend_outcomes'
    )
    expect(vi.mocked(pool.query).mock.calls[5]?.[0] as string).toContain(
      "SET status = 'provider_unavailable'"
    )
    expect(vi.mocked(pool.query).mock.calls[6]?.[0] as string).toContain(
      "SET status = 'provider_unavailable'"
    )
  })

  it('does not freeze oauth spend while a linked Codex attempt is still in flight', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'inv-codex',
            attempt_generation: 1,
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'attempt-codex',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
            attempt_generation: 1,
            attempt_index: 1,
            target_ref: 'primary-codex',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credential_slot: '',
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'codex-1',
            caller_kind: 'recipe',
            host_ref: 'sandbox-recipes/sdk-recipe',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'sdk-recipe',
            invocation_id: 'inv-codex',
            attempt_generation: 1,
            provider_attempt_index: 1,
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            request_hash: 'hash',
            policy_revision: 1,
            policy_hash: 'a'.repeat(64),
            budget_reservation_id: 'budget-1',
            connection_revision: 1,
            plugin_workload_sdk_provider_attempt_id: 'attempt-codex',
            status: 'authorized',
            outcome: null,
            usage_input_tokens: null,
            usage_output_tokens: null,
            created_at: new Date('2026-09-01T00:00:00.000Z'),
          },
        ],
        rowCount: 1,
      } as never)
    await expect(failStaleInvocations(150)).resolves.toBe(0)
    expect(
      vi
        .mocked(pool.query)
        .mock.calls.some(([sql]: [string]) =>
          sql.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
        )
    ).toBe(false)
    expect(
      vi
        .mocked(pool.query)
        .mock.calls.some(([sql]: [string]) => sql.includes("SET status = 'provider_unavailable'"))
    ).toBe(false)
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
    prompt_targets: [],
    default_target_ref: null,
    policy_state: 'active',
    policy_revision: 1,
    revocation_id: null,
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  }

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
  })

  it('persists the explicit provider and maps it back on the returned grant', async () => {
    mockUpsertGrantQueries(grantRow)
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
    mockUpsertGrantQueries({
      ...grantRow,
      capability_family: 'clientNotifications',
      provider: null,
      allowed_user_refs: ['11111111-1111-4111-8111-111111111111'],
    })
    const grant = await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'sdk-recipe',
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['api'],
        allowedUserRefs: ['11111111-1111-4111-8111-111111111111'],
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
    mockUpsertGrantQueries(legacyRow)
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
    mockUpsertGrantQueries({
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
    })
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
    txClient.query.mockClear()
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

describe('hasUsableClientNotificationRecipients', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'

  it('accepts an existing user with a deliverable email address', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: U1 }], rowCount: 1 }) }
    await expect(
      hasUsableClientNotificationRecipients({ allowedUserRefs: [U1], allowedTargetRefs: [] }, db)
    ).resolves.toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('email IS NOT NULL')
  })

  it('accepts a verified non-disabled medium target when no user is selected', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }) }
    await expect(
      hasUsableClientNotificationRecipients(
        { allowedUserRefs: [], allowedTargetRefs: ['telegram-user-1'] },
        db
      )
    ).resolves.toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('FROM workflow_approval_medium_accounts')
  })

  it('rejects deleted users and disabled/unknown targets instead of treating a non-empty list as ready', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    }
    await expect(
      hasUsableClientNotificationRecipients(
        { allowedUserRefs: [U1], allowedTargetRefs: ['unknown-target'] },
        db
      )
    ).resolves.toBe(false)
    expect(db.query).toHaveBeenCalledTimes(2)
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
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
  })

  it('records the service configuration and only newly added canonical users', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ allowed_user_refs: [U1] }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
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
      // issue #375 M3: the audit append must receive the TRANSACTION client
      // handed out by withTransaction, never the pool.
      expect.objectContaining({ query: txClient.query }),
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

describe('Plugin Workload SDK internal revocation audit actor', () => {
  const REVOCATION_ID = '55555555-5555-4555-8555-555555555555'
  const internalPrincipal = {
    kind: 'wrc_internal_control',
    sourceService: 'workflow-recipes',
    serviceSub: 'wrc-provisioner',
    credentialId: 'wrc-revocation-jti',
    allowedKinds: ['linked_outcome', 'service_action'],
  } as const
  const actor = { operatorSub: 'wrc-provisioner', internalPrincipal }

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
  })

  it('forwards the WRC principal through the transactional revoke audit', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
            policy_state: 'active',
            revocation_id: null,
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(
      revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'sdk-recipe', actor)
    ).resolves.toMatchObject({ state: 'revoking', revoked: 1 })
    expect(permissionEvents.append).toHaveBeenCalledWith(
      // issue #375 M3: the audit append must receive the TRANSACTION client
      // handed out by withTransaction, never the pool.
      expect.objectContaining({ query: txClient.query }),
      expect.objectContaining({
        operatorSub: 'wrc-provisioner',
        internalPrincipal,
        changes: [expect.objectContaining({ status: 'revoking' })],
      })
    )
  })

  it('forwards the same WRC principal when finalizing the fenced epoch', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
            policy_state: 'revoking',
            revocation_id: REVOCATION_ID,
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
          },
        ],
        rowCount: 1,
      } as never)

    await expect(
      finalizePluginWorkloadSdkRevocation('sandbox-recipes', 'sdk-recipe', REVOCATION_ID, actor)
    ).resolves.toMatchObject({ state: 'disabled', disabled: 1 })
    expect(permissionEvents.append).toHaveBeenCalledWith(
      // issue #375 M3: the audit append must receive the TRANSACTION client
      // handed out by withTransaction, never the pool.
      expect.objectContaining({ query: txClient.query }),
      expect.objectContaining({
        operatorSub: 'wrc-provisioner',
        internalPrincipal,
        changes: [expect.objectContaining({ status: 'disabled' })],
      })
    )
  })

  it('treats an already-disabled grant as an idempotent revoke', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
            policy_state: 'disabled',
            revocation_id: REVOCATION_ID,
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(
      revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'sdk-recipe', actor)
    ).resolves.toMatchObject({ state: 'disabled', revocationId: REVOCATION_ID })
    expect(permissionEvents.append).not.toHaveBeenCalled()
  })
})

// issue #375 (P3): the grant→WRC event-driven nudge. control-api emits a
// transactional pg_notify on the grant channel inside upsert/delete/revoke so
// the WRC re-reconciles the recipe immediately instead of waiting for the ≤30s
// watchdog. Delivered on COMMIT (transactional NOTIFY), discarded on rollback.
describe('Plugin Workload SDK grant-update NOTIFY (issue #375 P3)', () => {
  it('builds a typed, JSON payload carrying the recipe coordinates and family', () => {
    expect(
      JSON.parse(
        buildGrantUpdateNotifyPayload({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'research',
          capabilityFamily: 'promptBridge',
        })
      )
    ).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
  })

  it('omits capabilityFamily when it is not supplied (whole-recipe revoke)', () => {
    expect(
      JSON.parse(
        buildGrantUpdateNotifyPayload({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'research',
        })
      )
    ).toEqual({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' })
  })

  it('exposes the shared channel name used by the WRC LISTEN side', () => {
    expect(PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL).toBe('plugin_workload_sdk_grant_update')
  })

  it('upsertGrant emits a transactional pg_notify on the grant-update channel', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // family FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // kill-switch guard
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'research',
            capability_family: 'promptBridge',
            provider: 'openai',
            allowed_models: ['gpt-5'],
            allowed_event_types: [],
            allowed_target_refs: [],
            allowed_user_refs: [],
            allowed_callers: ['coordinator'],
            quota_limits: {},
            model_policies: {},
            policy_revision: 2,
            created_at: '2026-08-17T00:00:00.000Z',
            updated_at: '2026-08-17T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      } as never) // upsert RETURNING
      .mockResolvedValue({ rows: [], rowCount: 0 } as never) // notify + any trailing

    await upsertGrant(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'research',
        capabilityFamily: 'promptBridge',
        provider: 'openai',
        allowedModels: ['gpt-5'],
        allowedCallers: ['coordinator'],
      },
      'operator-1'
    )

    // issue #375 M3: the pg_notify MUST run on the in-transaction client, not
    // the pool — searching txClient (not pool.query) is what turns the
    // `notifyGrantUpdate(pool, …)` refactor RED (a pool-issued NOTIFY is
    // autocommitted and escapes the mutation's COMMIT/ROLLBACK coupling).
    const notifyCall = txClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_notify')
    ) as unknown as [string, unknown[]] | undefined
    expect(notifyCall, 'pg_notify must be issued on the transaction client').toBeDefined()
    const [, params] = notifyCall as [string, unknown[]]
    expect(params[0]).toBe(PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL)
    expect(JSON.parse(String(params[1]))).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
  })

  it('deleteGrant emits a transactional pg_notify on the grant-update channel', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'research',
            capability_family: 'clientNotifications',
            allowed_user_refs: [],
            allowed_models: [],
            allowed_event_types: [],
            allowed_target_refs: [],
            allowed_callers: [],
            quota_limits: {},
            model_policies: {},
            created_at: '2026-08-17T00:00:00.000Z',
            updated_at: '2026-08-17T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      } as never) // DELETE RETURNING
      .mockResolvedValue({ rows: [], rowCount: 0 } as never) // notify + trailing

    await deleteGrant(
      '33333333-3333-4333-8333-333333333333',
      'sandbox-recipes',
      'research',
      'operator-1'
    )

    // issue #375 M3: the pg_notify MUST run on the in-transaction client, not
    // the pool — searching txClient (not pool.query) is what turns the
    // `notifyGrantUpdate(pool, …)` refactor RED (a pool-issued NOTIFY is
    // autocommitted and escapes the mutation's COMMIT/ROLLBACK coupling).
    const notifyCall = txClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_notify')
    ) as unknown as [string, unknown[]] | undefined
    expect(notifyCall, 'pg_notify must be issued on the transaction client').toBeDefined()
    const [, params] = notifyCall as [string, unknown[]]
    expect(params[0]).toBe(PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL)
    expect(JSON.parse(String(params[1]))).toMatchObject({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
    })
  })

  it('revokePluginWorkloadSdkForRecipe emits a transactional pg_notify on the grant-update channel', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
            policy_state: 'active',
            revocation_id: null,
          },
        ],
        rowCount: 1,
      } as never) // grants FOR UPDATE
      .mockResolvedValue({ rows: [], rowCount: 0 } as never) // updates + notify

    await revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'research', {
      operatorSub: 'operator-1',
    })

    // issue #375 M3: the pg_notify MUST run on the in-transaction client, not
    // the pool — searching txClient (not pool.query) is what turns the
    // `notifyGrantUpdate(pool, …)` refactor RED (a pool-issued NOTIFY is
    // autocommitted and escapes the mutation's COMMIT/ROLLBACK coupling).
    const notifyCall = txClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_notify')
    ) as unknown as [string, unknown[]] | undefined
    expect(notifyCall, 'pg_notify must be issued on the transaction client').toBeDefined()
    const [, params] = notifyCall as [string, unknown[]]
    expect(params[0]).toBe(PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL)
    expect(JSON.parse(String(params[1]))).toMatchObject({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
    })
  })

  it('does NOT emit pg_notify on a NO-OP revoke (issue #375 B2 — no self-sustaining spin)', async () => {
    // Every grant already revoking/disabled: nothing transitions (revoked
    // rowCount 0, zero permission changes). Emitting a NOTIFY here would make the
    // WRC force-reconcile the still-cached recipe, which can re-enter revoke and
    // NOTIFY again — a reconcile+pg_notify spin. Match upsert/delete: notify only
    // on a real mutation.
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-id')
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            capability_family: 'promptBridge',
            policy_state: 'disabled',
            revocation_id: '55555555-5555-4555-8555-555555555555',
          },
        ],
        rowCount: 1,
      } as never) // grants FOR UPDATE (all already disabled)
      .mockResolvedValue({ rows: [], rowCount: 0 } as never) // UPDATEs affect 0 rows

    await revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'research', {
      operatorSub: 'operator-1',
    })

    const notifyCall = vi
      .mocked(pool.query)
      .mock.calls.find(([sql]) => String(sql).includes('pg_notify'))
    expect(notifyCall, 'a no-op revoke must not emit a grant-update NOTIFY').toBeUndefined()
    expect(permissionEvents.append).not.toHaveBeenCalled()
  })

  it('does NOT emit pg_notify when deleteGrant matches no row (rowCount 0)', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // DELETE RETURNING (no match)

    await expect(
      deleteGrant(
        '33333333-3333-4333-8333-333333333333',
        'sandbox-recipes',
        'research',
        'operator-1'
      )
    ).resolves.toBe(false)

    const notifyCall = vi
      .mocked(pool.query)
      .mock.calls.find(([sql]) => String(sql).includes('pg_notify'))
    expect(notifyCall, 'a delete that removed nothing must not NOTIFY').toBeUndefined()
  })

  it('does NOT emit pg_notify on a revoke that finds no grants (state=missing)', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // grants FOR UPDATE (none)

    await expect(
      revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'research', { operatorSub: 'operator-1' })
    ).resolves.toMatchObject({ state: 'missing' })

    const notifyCall = vi
      .mocked(pool.query)
      .mock.calls.find(([sql]) => String(sql).includes('pg_notify'))
    expect(notifyCall, 'a missing revoke must not NOTIFY').toBeUndefined()
  })

  it('does NOT emit pg_notify on a revoke that conflicts on revocation epoch (state=conflict)', async () => {
    vi.mocked(pool.query).mockReset()
    txClient.query.mockClear()
    permissionEvents.append.mockReset()
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recipe advisory lock
      .mockResolvedValueOnce({
        rows: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            capability_family: 'promptBridge',
            policy_state: 'revoking',
            revocation_id: '55555555-5555-4555-8555-555555555555',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            capability_family: 'clientNotifications',
            policy_state: 'revoking',
            revocation_id: '66666666-6666-4666-8666-666666666666',
          },
        ],
        rowCount: 2,
      } as never) // grants FOR UPDATE — two distinct revocation epochs

    await expect(
      revokePluginWorkloadSdkForRecipe('sandbox-recipes', 'research', { operatorSub: 'operator-1' })
    ).resolves.toMatchObject({ state: 'conflict' })

    const notifyCall = vi
      .mocked(pool.query)
      .mock.calls.find(([sql]) => String(sql).includes('pg_notify'))
    expect(notifyCall, 'a conflicting revoke must not NOTIFY').toBeUndefined()
  })
})
