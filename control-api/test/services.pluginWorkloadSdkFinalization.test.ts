import { describe, expect, it, vi } from 'vitest'
import {
  PromptBridgeFinalizationError,
  deriveEffectiveSpend,
  finalizePromptBridgeInTransaction,
} from '../src/services/pluginWorkloadSdkFinalization.js'

const ingest = vi.hoisted(() => vi.fn())
const project = vi.hoisted(() => vi.fn())

vi.mock('../src/services/usageEvents.js', () => ({
  ingestUsageEventsInTransaction: ingest,
}))
vi.mock('../src/services/tracing/usageProjection.js', () => ({
  projectAcceptedUsageEvents: project,
}))

const IDS = {
  invocation: '11111111-1111-4111-8111-111111111111',
  providerAttempt: '22222222-2222-4222-8222-222222222222',
}

const inputBase = {
  invocationId: IDS.invocation,
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'prompt-notify',
  hostRef: 'sandbox-recipes/prompt-notify',
  attemptGeneration: 1,
  providerAttemptId: IDS.providerAttempt,
  providerAttemptIndex: 1,
  target: {
    targetRef: 'primary-openai',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    credentialSlot: 'openai-api-key',
  },
  reason: 'provider_completed',
} as const

function dbWithRows(...rows: unknown[]) {
  const query = vi.fn()
  for (const row of rows)
    query.mockResolvedValueOnce({ rows: Array.isArray(row) ? row : [row], rowCount: 1 })
  return { query }
}

const CODEX_TARGET = {
  targetRef: 'codex-primary',
  provider: 'codex-subscription',
  model: 'gpt-5.1',
  credentialSlot: '',
} as const

/**
 * The row PostgreSQL echoes from the spend-ledger INSERT's RETURNING clause.
 * The finalizer derives its reported outcome from this row, so a mock that
 * returns a placeholder would hide the derivation instead of exercising it.
 */
function spendRow(overrides: Record<string, unknown> = {}) {
  return {
    provider_attempt_id: IDS.providerAttempt,
    invocation_id: IDS.invocation,
    recipe_namespace: inputBase.recipeNamespace,
    recipe_name: inputBase.recipeName,
    attempt_generation: 1,
    attempt_index: 1,
    target_ref: inputBase.target.targetRef,
    host_ref: inputBase.hostRef,
    provider: inputBase.target.provider,
    model: inputBase.target.model,
    credential_slot: inputBase.target.credentialSlot,
    outcome: 'unknown',
    input_tokens: null,
    output_tokens: null,
    ...overrides,
  }
}

function codexSpendRow(overrides: Record<string, unknown> = {}) {
  return spendRow({
    target_ref: CODEX_TARGET.targetRef,
    provider: CODEX_TARGET.provider,
    model: CODEX_TARGET.model,
    credential_slot: CODEX_TARGET.credentialSlot,
    ...overrides,
  })
}

/** A linked `llm_provider_attempts` row as the store maps it back. */
function linkedCodexRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    caller_kind: 'recipe',
    host_ref: inputBase.hostRef,
    recipe_namespace: inputBase.recipeNamespace,
    recipe_name: inputBase.recipeName,
    invocation_id: IDS.invocation,
    attempt_generation: 1,
    provider_attempt_index: 1,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    request_hash: 'hash',
    policy_revision: 1,
    policy_hash: 'a'.repeat(64),
    budget_reservation_id: 'budget-1',
    connection_revision: 1,
    plugin_workload_sdk_provider_attempt_id: IDS.providerAttempt,
    status: 'finalized',
    outcome: 'success',
    usage_input_tokens: 12,
    usage_output_tokens: 7,
    created_at: new Date(),
    ...overrides,
  }
}

/** invocations / invocation_attempts / provider_attempts rows for the fence. */
function fenceRows(providerAttempt: Record<string, unknown> = {}) {
  return [
    {
      id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      method: 'promptBridge',
      status: 'in_progress',
      attempt_generation: 1,
    },
    {
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      method: 'promptBridge',
      status: 'in_progress',
    },
    {
      id: IDS.providerAttempt,
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      attempt_index: 1,
      target_ref: inputBase.target.targetRef,
      host_ref: inputBase.hostRef,
      provider: inputBase.target.provider,
      model: inputBase.target.model,
      credential_slot: inputBase.target.credentialSlot,
      status: 'in_progress',
      ...providerAttempt,
    },
  ]
}

function statementsOf(db: { query: { mock: { calls: unknown[][] } } }): string[] {
  return db.query.mock.calls.map(call => String(call[0]))
}

function insertParams(db: { query: { mock: { calls: unknown[][] } } }): unknown[] | undefined {
  const call = db.query.mock.calls.find(([statement]) =>
    String(statement).includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
  )
  return call?.[1] as unknown[] | undefined
}

function updateParams(
  db: { query: { mock: { calls: unknown[][] } } },
  table: string
): unknown[] | undefined {
  const call = db.query.mock.calls.find(([statement]) =>
    String(statement).includes(`UPDATE ${table}`)
  )
  return call?.[1] as unknown[] | undefined
}

describe('Plugin Workload SDK promptBridge finalization', () => {
  it('atomically records exact usage and terminalizes the physical/logical receipts', async () => {
    const usageEvent = { request_id: IDS.providerAttempt }
    ingest.mockResolvedValueOnce({
      result: { accepted: 1, duplicates: 0, rejected: 0 },
      acceptedEvents: [usageEvent],
    })
    project.mockResolvedValueOnce(1)
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: inputBase.target.targetRef,
        host_ref: inputBase.hostRef,
        provider: inputBase.target.provider,
        model: inputBase.target.model,
        credential_slot: inputBase.target.credentialSlot,
        status: 'in_progress',
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      spendRow({ outcome: 'exact', input_tokens: 12, output_tokens: 7 })
    )

    const result = await finalizePromptBridgeInTransaction(
      {
        ...inputBase,
        status: 'complete',
        usage: {
          llmSecretName: 'openai-api-key',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 12,
          outputTokens: 7,
        },
      },
      db as never
    )

    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'exact',
      idempotent: false,
      usageAccepted: true,
    })
    expect(ingest).toHaveBeenCalledWith(
      [expect.objectContaining({ request_id: IDS.providerAttempt })],
      db,
      { recipeNamespace: inputBase.recipeNamespace, recipeName: inputBase.recipeName }
    )
    expect(project).toHaveBeenCalledWith(db, [usageEvent], expect.any(Map), {
      recipeNamespace: inputBase.recipeNamespace,
      recipeName: inputBase.recipeName,
      hostRef: inputBase.hostRef,
    })
    const sql = db.query.mock.calls.map(([statement]: [string]) => statement).join('\n')
    expect(sql).toContain('plugin_workload_sdk_spend_outcomes')
    expect(sql).toContain('usage_request_id')
    const spendLookup = db.query.mock.calls.find(([statement]: [string]) =>
      statement.includes('FROM plugin_workload_sdk_spend_outcomes')
    )
    expect(spendLookup?.[0]).not.toMatch(/FOR UPDATE/i)
  })

  it('persists an explicit unknown spend outcome without inventing token counts', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: inputBase.target.targetRef,
        provider: inputBase.target.provider,
        model: inputBase.target.model,
        credential_slot: inputBase.target.credentialSlot,
        status: 'in_progress',
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      spendRow()
    )

    const result = await finalizePromptBridgeInTransaction(
      { ...inputBase, status: 'provider_unavailable', reason: 'outcome_unknown' },
      db as never
    )

    expect(result).toMatchObject({
      status: 'provider_unavailable',
      outcome: 'unknown',
      usageAccepted: false,
    })
    expect(ingest).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    const insert = db.query.mock.calls.find(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect(insert?.[1]).toEqual([
      IDS.providerAttempt,
      IDS.invocation,
      inputBase.recipeNamespace,
      inputBase.recipeName,
      1,
      1,
      inputBase.target.targetRef,
      inputBase.hostRef,
      inputBase.target.provider,
      inputBase.target.model,
      inputBase.target.credentialSlot,
      'unknown',
      'outcome_unknown',
      null,
      null,
      null,
    ])
  })

  it('atomically records a pre-provider failure as not_executed without usage', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: inputBase.target.targetRef,
        provider: inputBase.target.provider,
        model: inputBase.target.model,
        credential_slot: inputBase.target.credentialSlot,
        status: 'reserved',
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      spendRow({ outcome: 'not_executed' })
    )

    const result = await finalizePromptBridgeInTransaction(
      { ...inputBase, status: 'failed', reason: 'credential_unavailable' },
      db as never
    )

    expect(result).toMatchObject({
      status: 'failed',
      outcome: 'not_executed',
      idempotent: false,
      usageAccepted: false,
    })
    expect(ingest).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    const insert = db.query.mock.calls.find(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect(insert?.[1]).toEqual([
      IDS.providerAttempt,
      IDS.invocation,
      inputBase.recipeNamespace,
      inputBase.recipeName,
      1,
      1,
      inputBase.target.targetRef,
      inputBase.hostRef,
      inputBase.target.provider,
      inputBase.target.model,
      inputBase.target.credentialSlot,
      'not_executed',
      'credential_unavailable',
      null,
      null,
      null,
    ])
  })

  it('converts a previously acknowledged physical attempt into a durable unknown outcome', async () => {
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: inputBase.target.targetRef,
        provider: inputBase.target.provider,
        model: inputBase.target.model,
        credential_slot: inputBase.target.credentialSlot,
        status: 'complete',
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      spendRow()
    )

    await expect(
      finalizePromptBridgeInTransaction(
        { ...inputBase, status: 'provider_unavailable', reason: 'outcome_unknown' },
        db as never
      )
    ).resolves.toMatchObject({ outcome: 'unknown', usageAccepted: false })
    expect(
      db.query.mock.calls.some(([statement]: [string]) =>
        statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
      )
    ).toBe(true)
  })

  it('replays the same physical finalization and rejects a conflicting outcome', async () => {
    const row = {
      provider_attempt_id: IDS.providerAttempt,
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      attempt_index: 1,
      target_ref: inputBase.target.targetRef,
      host_ref: inputBase.hostRef,
      provider: inputBase.target.provider,
      model: inputBase.target.model,
      credential_slot: inputBase.target.credentialSlot,
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: null,
    }
    const db = dbWithRows([], row)
    const unknown = {
      ...inputBase,
      status: 'provider_unavailable' as const,
      reason: 'outcome_unknown',
    }
    await expect(finalizePromptBridgeInTransaction(unknown, db as never)).resolves.toMatchObject({
      idempotent: true,
      outcome: 'unknown',
    })
    const conflictingDb = dbWithRows([], row)
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          status: 'complete',
          reason: 'provider_completed',
          usage: {
            llmSecretName: 'openai-api-key',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        conflictingDb as never
      )
    ).rejects.toMatchObject<PromptBridgeFinalizationError>({ code: 'conflict', httpStatus: 409 })
  })

  it('replays a not_executed finalization idempotently', async () => {
    const row = {
      provider_attempt_id: IDS.providerAttempt,
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      attempt_index: 1,
      target_ref: inputBase.target.targetRef,
      host_ref: inputBase.hostRef,
      provider: inputBase.target.provider,
      model: inputBase.target.model,
      credential_slot: inputBase.target.credentialSlot,
      outcome: 'not_executed',
      input_tokens: null,
      output_tokens: null,
    }
    await expect(
      finalizePromptBridgeInTransaction(
        { ...inputBase, status: 'failed', reason: 'credential_unavailable' },
        dbWithRows([], row) as never
      )
    ).resolves.toMatchObject({
      status: 'failed',
      outcome: 'not_executed',
      idempotent: true,
      usageAccepted: false,
    })
  })

  it('does not ingest Codex prompt-bridge usage because proxy finalize owns the ledger', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: 'codex-primary',
        host_ref: inputBase.hostRef,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        credential_slot: '',
        status: 'in_progress',
      },
      linkedCodexRow(),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ outcome: 'exact', input_tokens: 12, output_tokens: 7 })
    )

    const result = await finalizePromptBridgeInTransaction(
      {
        ...inputBase,
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          credentialSlot: '',
        },
        status: 'complete',
        usage: {
          llmSecretName: '',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 12,
          outputTokens: 7,
        },
      },
      db as never
    )

    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'exact',
      usageAccepted: false,
    })
    expect(ingest).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    const insert = db.query.mock.calls.find(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect(insert?.[1]).toEqual(expect.arrayContaining([IDS.providerAttempt, 'exact', 12, 7]))
  })

  it('refuses Codex complete while a linked attempt is still in flight', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: 'codex-primary',
        host_ref: inputBase.hostRef,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        credential_slot: '',
        status: 'in_progress',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        caller_kind: 'recipe',
        host_ref: inputBase.hostRef,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        invocation_id: IDS.invocation,
        attempt_generation: 1,
        provider_attempt_index: 1,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        request_hash: 'hash',
        policy_revision: 1,
        policy_hash: 'a'.repeat(64),
        budget_reservation_id: 'budget-1',
        connection_revision: 1,
        status: 'authorized',
        outcome: null,
        usage_input_tokens: null,
        usage_output_tokens: null,
        created_at: new Date(),
      }
    )

    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        db as never
      )
    ).rejects.toMatchObject({
      code: 'ledger_pending',
      httpStatus: 409,
      retryable: true,
    })
    expect(
      db.query.mock.calls.some(([statement]: [string]) =>
        statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
      )
    ).toBe(false)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('records Codex complete without a linked success as unknown without fabricated tokens', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: 'codex-primary',
        host_ref: inputBase.hostRef,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        credential_slot: '',
        status: 'in_progress',
      },
      [],
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow()
    )

    const result = await finalizePromptBridgeInTransaction(
      {
        ...inputBase,
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          credentialSlot: '',
        },
        status: 'complete',
        usage: {
          llmSecretName: '',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 4,
          outputTokens: 2,
        },
      },
      db as never
    )

    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'unknown',
      usageAccepted: false,
    })
    const insert = db.query.mock.calls.find(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect(insert?.[1]).toEqual([
      IDS.providerAttempt,
      IDS.invocation,
      inputBase.recipeNamespace,
      inputBase.recipeName,
      1,
      1,
      'codex-primary',
      inputBase.hostRef,
      'codex-subscription',
      'gpt-5.1',
      '',
      'unknown',
      'provider_completed',
      null,
      null,
      // N-17: Codex spend is ingested by the proxy finalize, not here, so no
      // usage_events row exists for this attempt and the FK-shaped column must
      // stay NULL rather than point at a row that was never written.
      null,
    ])
    expect(updateParams(db, 'plugin_workload_sdk_provider_attempts')?.[2]).toBe(false)
  })

  it('records Codex complete as unknown when linked success finalized without usage', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      {
        id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        method: 'promptBridge',
        status: 'in_progress',
        attempt_generation: 1,
      },
      {
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        method: 'promptBridge',
        status: 'in_progress',
      },
      {
        id: IDS.providerAttempt,
        invocation_id: IDS.invocation,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        attempt_generation: 1,
        attempt_index: 1,
        target_ref: 'codex-primary',
        host_ref: inputBase.hostRef,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        credential_slot: '',
        status: 'in_progress',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        caller_kind: 'recipe',
        host_ref: inputBase.hostRef,
        recipe_namespace: inputBase.recipeNamespace,
        recipe_name: inputBase.recipeName,
        invocation_id: IDS.invocation,
        attempt_generation: 1,
        provider_attempt_index: 1,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        request_hash: 'hash',
        policy_revision: 1,
        policy_hash: 'a'.repeat(64),
        budget_reservation_id: 'budget-1',
        connection_revision: 1,
        status: 'finalized',
        outcome: 'success',
        usage_input_tokens: null,
        usage_output_tokens: null,
        created_at: new Date(),
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow()
    )

    const result = await finalizePromptBridgeInTransaction(
      {
        ...inputBase,
        target: {
          targetRef: 'codex-primary',
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          credentialSlot: '',
        },
        status: 'complete',
        usage: {
          llmSecretName: '',
          callerRef: 'scanner',
          fallbackUsed: false,
          attemptCount: 1,
          inputTokens: 4,
          outputTokens: 2,
        },
      },
      db as never
    )

    expect(result).toMatchObject({
      status: 'complete',
      outcome: 'unknown',
      usageAccepted: false,
    })
    expect(
      db.query.mock.calls.some(([statement]: [string]) =>
        statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
      )
    ).toBe(true)
  })

  it('replays a Codex unknown complete finalization idempotently', async () => {
    const row = {
      provider_attempt_id: IDS.providerAttempt,
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      attempt_index: 1,
      target_ref: 'codex-primary',
      host_ref: inputBase.hostRef,
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      credential_slot: '',
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: null,
    }
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        dbWithRows([], row, []) as never
      )
    ).resolves.toMatchObject({
      idempotent: true,
      outcome: 'unknown',
      usageAccepted: false,
    })
  })

  it('derives exact from linked Codex usage on replay without writing', async () => {
    const db = dbWithRows([], codexSpendRow(), linkedCodexRow())
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: { ...CODEX_TARGET },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        db as never
      )
    ).resolves.toMatchObject({
      idempotent: true,
      outcome: 'exact',
      usageAccepted: false,
    })
    // N-BLK-1: the floor is immutable. The runtime role holds SELECT/INSERT
    // only, so any write here would be a 42501 in production.
    const statements = statementsOf(db)
    expect(statements.some(sql => /UPDATE plugin_workload_sdk_spend_outcomes/i.test(sql))).toBe(
      false
    )
    expect(
      statements.some(sql => /INSERT INTO plugin_workload_sdk_spend_outcomes/i.test(sql))
    ).toBe(false)
    // advisory lock → floor SELECT → linked Codex row. Nothing else.
    expect(statements).toHaveLength(3)
  })

  it('refuses to replay a sweeper unknown while the linked Codex attempt is still in flight', async () => {
    const row = {
      provider_attempt_id: IDS.providerAttempt,
      invocation_id: IDS.invocation,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_generation: 1,
      attempt_index: 1,
      target_ref: 'codex-primary',
      host_ref: inputBase.hostRef,
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      credential_slot: '',
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: null,
    }
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        dbWithRows([], row, {
          id: '33333333-3333-4333-8333-333333333333',
          caller_kind: 'recipe',
          host_ref: inputBase.hostRef,
          recipe_namespace: inputBase.recipeNamespace,
          recipe_name: inputBase.recipeName,
          invocation_id: IDS.invocation,
          attempt_generation: 1,
          provider_attempt_index: 1,
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          request_hash: 'hash',
          policy_revision: 1,
          policy_hash: 'a'.repeat(64),
          budget_reservation_id: 'budget-1',
          connection_revision: 1,
          status: 'authorized',
          outcome: null,
          usage_input_tokens: null,
          usage_output_tokens: null,
          created_at: new Date(),
        }) as never
      )
    ).rejects.toMatchObject({
      code: 'ledger_pending',
      httpStatus: 409,
      retryable: true,
    })
  })

  it('rejects empty static-key credential material from the persisted provider', async () => {
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: { ...inputBase.target, credentialSlot: '' },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        dbWithRows(
          [],
          [],
          {
            id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            method: 'promptBridge',
            status: 'in_progress',
            attempt_generation: 1,
          },
          {
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            method: 'promptBridge',
            status: 'in_progress',
          },
          {
            id: IDS.providerAttempt,
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            attempt_index: 1,
            target_ref: inputBase.target.targetRef,
            provider: inputBase.target.provider,
            model: inputBase.target.model,
            credential_slot: '',
            status: 'in_progress',
          }
        ) as never
      )
    ).rejects.toMatchObject({
      code: 'invalid_request',
      httpStatus: 400,
    })
  })

  it('does not let a request-claimed oauth provider skip a static-key binding', async () => {
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            ...inputBase.target,
            provider: 'codex-subscription',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        dbWithRows(
          [],
          [],
          {
            id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            method: 'promptBridge',
            status: 'in_progress',
            attempt_generation: 1,
          },
          {
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            method: 'promptBridge',
            status: 'in_progress',
          },
          {
            id: IDS.providerAttempt,
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            attempt_index: 1,
            target_ref: inputBase.target.targetRef,
            provider: inputBase.target.provider,
            model: inputBase.target.model,
            credential_slot: inputBase.target.credentialSlot,
            status: 'in_progress',
          }
        ) as never
      )
    ).rejects.toMatchObject({
      // N-19: the persisted `openai` attempt still governs, so the missing
      // credentialSlot is a malformed body (400), not a binding mismatch (403).
      // `replayExistingOutcome` already classified this exact body as 400; the
      // fresh path used to answer 403 only because the binding comparison ran
      // before the persisted-auth-mode assert.
      code: 'invalid_request',
      httpStatus: 400,
    })
  })

  it('classifies the same malformed body identically on the replay path (N-19)', async () => {
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            ...inputBase.target,
            provider: 'codex-subscription',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        dbWithRows([], spendRow({ outcome: 'exact', input_tokens: 1, output_tokens: 1 })) as never
      )
    ).rejects.toMatchObject({
      code: 'invalid_request',
      httpStatus: 400,
    })
  })

  it('rejects Codex complete while the physical attempt is still reserved', async () => {
    await expect(
      finalizePromptBridgeInTransaction(
        {
          ...inputBase,
          target: {
            targetRef: 'codex-primary',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credentialSlot: '',
          },
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        dbWithRows(
          [],
          [],
          {
            id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            method: 'promptBridge',
            status: 'in_progress',
            attempt_generation: 1,
          },
          {
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            method: 'promptBridge',
            status: 'in_progress',
          },
          {
            id: IDS.providerAttempt,
            invocation_id: IDS.invocation,
            recipe_namespace: inputBase.recipeNamespace,
            recipe_name: inputBase.recipeName,
            attempt_generation: 1,
            attempt_index: 1,
            target_ref: 'codex-primary',
            provider: 'codex-subscription',
            model: 'gpt-5.1',
            credential_slot: '',
            status: 'reserved',
          }
        ) as never
      )
    ).rejects.toMatchObject({
      code: 'conflict',
      httpStatus: 409,
    })
  })
})

// ─── Derive-on-read: the floor is immutable, the truth is derived ─────────

const codexInput = {
  ...inputBase,
  target: { ...CODEX_TARGET },
} as const

function codexFence(providerAttemptStatus: string) {
  return fenceRows({
    target_ref: CODEX_TARGET.targetRef,
    provider: CODEX_TARGET.provider,
    model: CODEX_TARGET.model,
    credential_slot: CODEX_TARGET.credentialSlot,
    status: providerAttemptStatus,
  })
}

describe('spend floor writers (Addendum A.4 "best-floor")', () => {
  it.each([
    ['failed', 'provider_unavailable'],
    ['provider_unavailable', 'provider_unavailable'],
  ] as const)(
    'freezes an exact floor for a %s oauth close whose linked Codex usage is ready',
    async (status, persistedStatus) => {
      ingest.mockReset()
      project.mockReset()
      const db = dbWithRows(
        [],
        [],
        ...codexFence('in_progress'),
        linkedCodexRow(),
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
        codexSpendRow({ outcome: 'exact', input_tokens: 12, output_tokens: 7 })
      )

      const result = await finalizePromptBridgeInTransaction(
        { ...codexInput, status, reason: 'provider_stream_failed' },
        db as never
      )

      // N-BLK-2(a): before the fix this persisted `unknown` WITH tokens and
      // died on token_pair_check (23514 -> 500).
      expect(insertParams(db)?.slice(11, 16)).toEqual([
        'exact',
        'provider_stream_failed',
        12,
        7,
        null,
      ])
      // The wire status still echoes what the host declared; controlApiClient
      // rejects the response otherwise.
      expect(result).toMatchObject({ status, outcome: 'exact', idempotent: false })
      // Guard 1.a: the persisted terminal state is provider_unavailable, which
      // reviveFailedInvocation (WHERE status = 'failed') cannot revive, so the
      // same idempotency key cannot launch a second billable Codex call.
      expect(updateParams(db, 'plugin_workload_sdk_provider_attempts')?.[1]).toBe(persistedStatus)
      expect(updateParams(db, 'plugin_workload_sdk_invocation_attempts')?.[1]).toBe(persistedStatus)
      expect(updateParams(db, 'plugin_workload_sdk_invocations')?.[1]).toBe(persistedStatus)
      expect(ingest).not.toHaveBeenCalled()
    }
  )

  it('keeps a provider_unavailable close revivable-free without renaming a failed close that Codex never billed', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      ...codexFence('in_progress'),
      [],
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ outcome: 'not_executed' })
    )

    const result = await finalizePromptBridgeInTransaction(
      { ...codexInput, status: 'failed', reason: 'no_grant' },
      db as never
    )

    // No linked Codex row at all: nothing was billed, so the close stays
    // `failed` and the invocation stays revivable on a fresh attempt.
    expect(result).toMatchObject({ status: 'failed', outcome: 'not_executed' })
    expect(updateParams(db, 'plugin_workload_sdk_invocations')?.[1]).toBe('failed')
  })

  // R4-H1. The ledger_pending gate was keyed on `input.status === 'complete'`,
  // so a host closing `failed` walked past a Codex call still inside its usage
  // grace. `failed` is what reviveFailedInvocation reopens, so the same
  // idempotency key could launch a second billable Codex call while the first
  // was still able to bill.
  const codexInFlight = {
    status: 'authorized',
    outcome: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
  } as const

  it('refuses a Codex failed close while the linked attempt is still in flight', async () => {
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      ...codexFence('in_progress'),
      linkedCodexRow({ ...codexInFlight, created_at: new Date() })
    )

    await expect(
      finalizePromptBridgeInTransaction(
        { ...codexInput, status: 'failed', reason: 'provider_error' },
        db as never
      )
    ).rejects.toMatchObject({ code: 'ledger_pending', httpStatus: 409, retryable: true })
    expect(updateParams(db, 'plugin_workload_sdk_invocations')).toBeUndefined()
  })

  it('closes a Codex failed attempt whose linked row aged out without usage as provider_unavailable', async () => {
    // Past the grace window there is no ledger_pending left to raise, but the
    // call may still have billed. Only a spend proved `not_executed` — no
    // linked Codex row at all — is safe to leave revivable.
    ingest.mockReset()
    project.mockReset()
    const db = dbWithRows(
      [],
      [],
      ...codexFence('in_progress'),
      linkedCodexRow({ ...codexInFlight, created_at: new Date(Date.now() - 20 * 60_000) }),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ outcome: 'unknown' })
    )

    const result = await finalizePromptBridgeInTransaction(
      { ...codexInput, status: 'failed', reason: 'provider_error' },
      db as never
    )

    // The RESULT still echoes the caller's status — mcp-host asserts
    // result.status === body.status — while the persisted invocation state is
    // the non-revivable one.
    expect(result).toMatchObject({ status: 'failed', outcome: 'unknown' })
    expect(updateParams(db, 'plugin_workload_sdk_invocations')?.[1]).toBe('provider_unavailable')
  })

  it('refuses to promote a Codex row that errored with usage or reported a partial token pair', async () => {
    for (const linked of [
      linkedCodexRow({ outcome: 'error' }),
      linkedCodexRow({ usage_output_tokens: null }),
    ]) {
      ingest.mockReset()
      project.mockReset()
      const db = dbWithRows(
        [],
        [],
        ...codexFence('in_progress'),
        linked,
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 1 },
        codexSpendRow()
      )

      const result = await finalizePromptBridgeInTransaction(
        {
          ...codexInput,
          status: 'complete',
          usage: {
            llmSecretName: '',
            callerRef: 'scanner',
            fallbackUsed: false,
            attemptCount: 1,
            inputTokens: 4,
            outputTokens: 2,
          },
        },
        db as never
      )

      // N-BLK-2(b)/(c): `unknown` never carries tokens, and the host's own
      // usage claim is discarded for an oauth-broker attempt.
      expect(insertParams(db)?.slice(11, 16)).toEqual([
        'unknown',
        'provider_completed',
        null,
        null,
        null,
      ])
      expect(result).toMatchObject({ outcome: 'unknown', usageAccepted: false })
    }
  })
})

describe('spend replay is read-only and judged against the floor', () => {
  it('reports exact for every replay status once the linked Codex usage landed', async () => {
    for (const status of ['complete', 'failed', 'provider_unavailable'] as const) {
      const db = dbWithRows([], codexSpendRow(), linkedCodexRow())
      const usage =
        status === 'complete'
          ? {
              usage: {
                llmSecretName: '',
                callerRef: 'scanner',
                fallbackUsed: false,
                attemptCount: 1,
                inputTokens: 4,
                outputTokens: 2,
              },
            }
          : {}
      // N-05: the third identical `failed` call used to 409 because the second
      // had rewritten the row to `exact`. The floor never moves, so the verdict
      // is stable and the reported outcome still catches up.
      await expect(
        finalizePromptBridgeInTransaction({ ...codexInput, status, ...usage }, db as never)
      ).resolves.toMatchObject({ status, outcome: 'exact', idempotent: true, usageAccepted: false })
      expect(statementsOf(db).some(sql => /plugin_workload_sdk_spend_outcomes/i.test(sql))).toBe(
        true
      )
      expect(
        statementsOf(db).some(sql =>
          /(UPDATE|INSERT INTO) plugin_workload_sdk_spend_outcomes/i.test(sql)
        )
      ).toBe(false)
    }
  })

  it.each(['failed', 'provider_unavailable'] as const)(
    'still answers ledger_pending for a %s replay while the linked Codex attempt is in flight',
    async status => {
      // Regression cover for e13b4de8: ledger_pending is decided by the floor
      // plus the Codex row, never by the caller-chosen status. Reverting that
      // fix must turn this red.
      await expect(
        finalizePromptBridgeInTransaction(
          { ...codexInput, status },
          dbWithRows(
            [],
            codexSpendRow(),
            linkedCodexRow({
              status: 'authorized',
              outcome: null,
              usage_input_tokens: null,
              usage_output_tokens: null,
            })
          ) as never
        )
      ).rejects.toMatchObject({ code: 'ledger_pending', httpStatus: 409, retryable: true })
    }
  )

  it.each([
    [
      'in flight',
      { status: 'authorized', outcome: null, usage_input_tokens: null, usage_output_tokens: null },
    ],
    ['usage-ready', {}],
  ] as const)(
    'answers conflict, not the %s ledger state, when the JWT binding does not match the floor',
    async (_label, linkedOverrides) => {
      // N-07: the binding check runs before any state oracle, so a foreign
      // recipe cannot distinguish ledger_pending from exact from unknown.
      await expect(
        finalizePromptBridgeInTransaction(
          { ...codexInput, status: 'provider_unavailable' },
          dbWithRows(
            [],
            codexSpendRow({ recipe_namespace: 'someone-elses-namespace' }),
            linkedCodexRow(linkedOverrides)
          ) as never
        )
      ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 })
    }
  )

  it('never derives a not_executed floor, whatever the linked Codex row says', async () => {
    await expect(
      finalizePromptBridgeInTransaction(
        { ...codexInput, status: 'failed' },
        dbWithRows([], codexSpendRow({ outcome: 'not_executed' }), linkedCodexRow()) as never
      )
    ).resolves.toMatchObject({ outcome: 'not_executed', idempotent: true })
  })

  it.each(['complete', 'provider_unavailable'] as const)(
    'conflicts when a %s replay contradicts a not_executed floor',
    async status => {
      const usage =
        status === 'complete'
          ? {
              usage: {
                llmSecretName: '',
                callerRef: 'scanner',
                fallbackUsed: false,
                attemptCount: 1,
                inputTokens: 4,
                outputTokens: 2,
              },
            }
          : {}
      await expect(
        finalizePromptBridgeInTransaction(
          { ...codexInput, status, ...usage },
          dbWithRows([], codexSpendRow({ outcome: 'not_executed' }), linkedCodexRow()) as never
        )
      ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 })
    }
  )
})

describe('deriveEffectiveSpend', () => {
  const codexFloor = (outcome: string, tokens: [number, number] | null = null) => ({
    provider: 'codex-subscription',
    outcome: outcome as 'exact' | 'unknown' | 'not_executed',
    input_tokens: tokens?.[0] ?? null,
    output_tokens: tokens?.[1] ?? null,
  })
  const ready = { outcome: 'success' as const, usageInputTokens: 12, usageOutputTokens: 7 }

  it.each([
    [
      'unknown floor + ready Codex derives exact',
      codexFloor('unknown'),
      ready,
      { outcome: 'exact', inputTokens: 12, outputTokens: 7 },
    ],
    [
      'unknown floor + no link stays unknown',
      codexFloor('unknown'),
      null,
      { outcome: 'unknown', inputTokens: null, outputTokens: null },
    ],
    [
      'unknown floor + errored Codex stays unknown',
      codexFloor('unknown'),
      { outcome: 'error' as const, usageInputTokens: 12, usageOutputTokens: 7 },
      { outcome: 'unknown', inputTokens: null, outputTokens: null },
    ],
    [
      'unknown floor + partial usage stays unknown',
      codexFloor('unknown'),
      { outcome: 'success' as const, usageInputTokens: 12, usageOutputTokens: null },
      { outcome: 'unknown', inputTokens: null, outputTokens: null },
    ],
    [
      'not_executed is terminal',
      codexFloor('not_executed'),
      ready,
      { outcome: 'not_executed', inputTokens: null, outputTokens: null },
    ],
    [
      'exact keeps its own tokens',
      codexFloor('exact', [3, 1]),
      ready,
      { outcome: 'exact', inputTokens: 3, outputTokens: 1 },
    ],
    [
      'a non-oauth unknown floor is never derived',
      { provider: 'openai', outcome: 'unknown' as const, input_tokens: null, output_tokens: null },
      ready,
      { outcome: 'unknown', inputTokens: null, outputTokens: null },
    ],
  ])('%s', (_label, persisted, linked, expected) => {
    expect(deriveEffectiveSpend(persisted, linked)).toEqual(expected)
  })

  it('fails loudly on an exact floor without a token pair', () => {
    expect(() => deriveEffectiveSpend(codexFloor('exact'), null)).toThrow(
      /exact spend outcome persisted without a token pair/
    )
  })
})

describe('prior provider attempt settlement (RP-539-003)', () => {
  const PRIOR_ATTEMPT_ID = '44444444-4444-4444-8444-444444444444'

  function priorAttemptRow(status: string) {
    return {
      id: PRIOR_ATTEMPT_ID,
      recipe_namespace: inputBase.recipeNamespace,
      recipe_name: inputBase.recipeName,
      attempt_index: 1,
      target_ref: 'primary-openai',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      credential_slot: 'openai-api-key',
      status,
    }
  }

  function failoverDb(priorStatus: string) {
    return dbWithRows(
      [],
      [],
      ...fenceRows({
        attempt_index: 2,
        target_ref: CODEX_TARGET.targetRef,
        provider: CODEX_TARGET.provider,
        model: CODEX_TARGET.model,
        credential_slot: CODEX_TARGET.credentialSlot,
      }),
      linkedCodexRow(),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ attempt_index: 2, outcome: 'exact', input_tokens: 12, output_tokens: 7 }),
      [priorAttemptRow(priorStatus)],
      [],
      spendRow({ provider_attempt_id: PRIOR_ATTEMPT_ID, outcome: 'not_executed' })
    )
  }

  const winner = {
    ...codexInput,
    providerAttemptIndex: 2,
    status: 'complete' as const,
    usage: {
      llmSecretName: '',
      callerRef: 'scanner',
      fallbackUsed: false,
      attemptCount: 2,
      inputTokens: 4,
      outputTokens: 2,
    },
  }

  it.each([
    ['failed', 'not_executed'],
    ['skipped', 'not_executed'],
    ['provider_unavailable', 'unknown'],
  ] as const)(
    'freezes a %s floor for the displaced attempt a successful failover never finalizes',
    async (priorStatus, expectedOutcome) => {
      const db = failoverDb(priorStatus)
      await expect(finalizePromptBridgeInTransaction(winner, db as never)).resolves.toMatchObject({
        outcome: 'exact',
        idempotent: false,
      })

      const inserts = db.query.mock.calls.filter(([statement]: [string]) =>
        statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
      )
      expect(inserts).toHaveLength(2)
      const prior = inserts[1]?.[1] as unknown[]
      expect(prior?.[0]).toBe(PRIOR_ATTEMPT_ID)
      expect(prior?.[5]).toBe(1)
      expect(prior?.[7]).toBe(inputBase.hostRef)
      expect(prior?.slice(11, 16)).toEqual([
        expectedOutcome,
        `prior_attempt_${priorStatus}`,
        null,
        null,
        null,
      ])
      // The displaced attempt gets a ledger row only. Its invocation and
      // receipt belong to the winner's transition.
      const discovery = db.query.mock.calls.find(([statement]: [string]) =>
        statement.includes('attempt_index < $3')
      )
      expect(discovery?.[0]).toMatch(/FOR UPDATE/i)
      expect(discovery?.[1]).toEqual([IDS.invocation, 1, 2])
    }
  )

  it('freezes an exact floor for a displaced oauth attempt whose Codex row is ready', async () => {
    const db = dbWithRows(
      [],
      [],
      ...fenceRows({
        attempt_index: 2,
        target_ref: CODEX_TARGET.targetRef,
        provider: CODEX_TARGET.provider,
        model: CODEX_TARGET.model,
        credential_slot: CODEX_TARGET.credentialSlot,
      }),
      linkedCodexRow(),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ attempt_index: 2, outcome: 'exact', input_tokens: 12, output_tokens: 7 }),
      [
        {
          ...priorAttemptRow('provider_unavailable'),
          target_ref: CODEX_TARGET.targetRef,
          provider: CODEX_TARGET.provider,
          model: CODEX_TARGET.model,
          credential_slot: CODEX_TARGET.credentialSlot,
        },
      ],
      linkedCodexRow({
        id: '55555555-5555-4555-8555-555555555555',
        plugin_workload_sdk_provider_attempt_id: PRIOR_ATTEMPT_ID,
        usage_input_tokens: 5,
        usage_output_tokens: 3,
      }),
      spendRow({ provider_attempt_id: PRIOR_ATTEMPT_ID, outcome: 'exact' })
    )

    await finalizePromptBridgeInTransaction(winner, db as never)

    const inserts = db.query.mock.calls.filter(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect((inserts[1]?.[1] as unknown[])?.slice(11, 16)).toEqual([
      'exact',
      'prior_attempt_provider_unavailable',
      5,
      3,
      null,
    ])
  })

  it('freezes unknown for a displaced Codex attempt whose linked row carries no usage yet', async () => {
    // R4-M1. `not_executed` is terminal — deriveEffectiveSpend only lifts
    // `unknown` to `exact` — so freezing it over a linked row that can still
    // bill loses that spend permanently. A linked row exists only if
    // authorize-link ran, which is already "asked the broker for a ticket".
    const db = dbWithRows(
      [],
      [],
      ...fenceRows({
        attempt_index: 2,
        target_ref: CODEX_TARGET.targetRef,
        provider: CODEX_TARGET.provider,
        model: CODEX_TARGET.model,
        credential_slot: CODEX_TARGET.credentialSlot,
      }),
      linkedCodexRow(),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ attempt_index: 2, outcome: 'exact', input_tokens: 12, output_tokens: 7 }),
      [
        {
          ...priorAttemptRow('failed'),
          target_ref: CODEX_TARGET.targetRef,
          provider: CODEX_TARGET.provider,
          model: CODEX_TARGET.model,
          credential_slot: CODEX_TARGET.credentialSlot,
        },
      ],
      linkedCodexRow({
        id: '55555555-5555-4555-8555-555555555555',
        plugin_workload_sdk_provider_attempt_id: PRIOR_ATTEMPT_ID,
        status: 'authorized',
        outcome: null,
        usage_input_tokens: null,
        usage_output_tokens: null,
      }),
      spendRow({ provider_attempt_id: PRIOR_ATTEMPT_ID, outcome: 'unknown' })
    )

    await finalizePromptBridgeInTransaction(winner, db as never)

    const inserts = db.query.mock.calls.filter(([statement]: [string]) =>
      statement.includes('INSERT INTO plugin_workload_sdk_spend_outcomes')
    )
    expect((inserts[1]?.[1] as unknown[])?.slice(11, 16)).toEqual([
      'unknown',
      'prior_attempt_failed',
      null,
      null,
      null,
    ])
  })

  it('fails loudly when a displaced attempt is not terminal', async () => {
    // reservePluginWorkloadSdkProviderAttempt cannot hand out index 2 over a
    // non-terminal index 1, so this is a broken fence, not a tolerable case.
    const db = failoverDb('in_progress')
    await expect(finalizePromptBridgeInTransaction(winner, db as never)).rejects.toThrow(
      /is not terminal \(status=in_progress\); the reservation fence is broken/
    )
  })

  it('does not query for predecessors of the first attempt', async () => {
    const db = dbWithRows(
      [],
      [],
      ...codexFence('in_progress'),
      linkedCodexRow(),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      codexSpendRow({ outcome: 'exact', input_tokens: 12, output_tokens: 7 })
    )
    await finalizePromptBridgeInTransaction(
      { ...codexInput, status: 'provider_unavailable' },
      db as never
    )
    expect(statementsOf(db).some(sql => sql.includes('attempt_index < $3'))).toBe(false)
  })
})
