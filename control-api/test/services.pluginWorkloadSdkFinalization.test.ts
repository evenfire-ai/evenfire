import { describe, expect, it, vi } from 'vitest'
import {
  PromptBridgeFinalizationError,
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
      { rows: [], rowCount: 1 }
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
      { rows: [], rowCount: 1 }
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
      { rows: [], rowCount: 1 }
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
      { rows: [], rowCount: 1 }
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
      {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'finalized',
        outcome: 'success',
        usage_input_tokens: 12,
        usage_output_tokens: 7,
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }
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
      { rows: [], rowCount: 1 }
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
      IDS.providerAttempt,
    ])
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
        dbWithRows([], row) as never
      )
    ).resolves.toMatchObject({
      idempotent: true,
      outcome: 'unknown',
      usageAccepted: false,
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
      code: 'binding_mismatch',
      httpStatus: 403,
    })
  })
})
