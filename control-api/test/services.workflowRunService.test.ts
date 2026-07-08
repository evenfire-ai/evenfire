import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeApprovalForTrigger } from '../src/services/userApprovalRequestService.js'
import {
  WorkflowRunIdempotencyConflictError,
  computeWorkflowRunPayloadHash,
  createApprovedRun,
  listRunsByRecipe,
} from '../src/services/workflowRunService.js'

const mockPoolQuery = vi.fn()
const mockPoolConnect = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: (...args: unknown[]) => mockPoolConnect(...args),
  },
}))

vi.mock('../src/services/userApprovalRequestService.js', () => ({
  consumeApprovalForTrigger: vi.fn((_params, _db) =>
    Promise.resolve({ teamId: '11111111-1111-4111-8111-111111111111' })
  ),
}))

const mockedConsumeApprovalForTrigger = vi.mocked(consumeApprovalForTrigger)

describe('services/workflowRunService.listRunsByRecipe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('orders live runs by created_at first so newly queued Pending runs remain visible', async () => {
    await listRunsByRecipe('mcp-server', 'test-recipe', 10)

    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]

    expect(sql).toContain('ORDER BY created_at DESC')
    expect(sql).toContain('started_at DESC NULLS LAST')
    expect(params).toEqual(['mcp-server', 'test-recipe', 10])
  })
})

describe('services/workflowRunService.createApprovedRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedConsumeApprovalForTrigger.mockResolvedValue({
      teamId: '11111111-1111-4111-8111-111111111111',
    })
  })

  function makeClient() {
    const query = vi.fn()
    const release = vi.fn()
    mockPoolConnect.mockResolvedValueOnce({ query, release })
    return { query, release }
  }

  const input = {
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'test-recipe',
    actor_type: 'autonomous' as const,
    actor_id: '00000000-0000-4000-8000-000000000001',
    idempotency_key: 'idem-1',
    trigger_source: 'autonomous',
    inputs: { topic: 'alpha' },
    intermediate_parameters: null,
    output_overrides: null,
    max_duration_seconds: null,
    ttl_seconds_after_finished: null,
    approval_request_id: '00000000-0000-4000-8000-000000000123',
    idempotency_payload_hash: 'hash-1',
    approval_caller_key: 'sandbox-recipes/test-recipe',
    correlation_id: 'corr-1',
  }

  it('serializes by idempotency key before consuming approval', async () => {
    const { query, release } = makeClient()
    const inserted = {
      run_id: 'run-1',
      recipe_namespace: input.recipe_namespace,
      recipe_name: input.recipe_name,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      approval_request_id: input.approval_request_id,
      idempotency_payload_hash: input.idempotency_payload_hash,
    }
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [inserted], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    const result = await createApprovedRun(input)

    expect(result.created).toBe(true)
    expect(query.mock.calls[2][0]).toContain('pg_advisory_xact_lock')
    expect(query.mock.calls[3][0]).toContain('FOR UPDATE')
    expect(query.mock.calls[4][0]).toContain('INSERT INTO workflow_runs')
    expect(query.mock.calls[4][1]).toContain('11111111-1111-4111-8111-111111111111')
    expect(mockedConsumeApprovalForTrigger).toHaveBeenCalledWith(
      {
        approvalRequestId: input.approval_request_id,
        recipeNamespace: input.recipe_namespace,
        recipeName: input.recipe_name,
        callerKey: input.approval_caller_key,
        correlationId: input.correlation_id,
      },
      expect.objectContaining({ query })
    )
    expect(mockedConsumeApprovalForTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[4]
    )
    expect(release).toHaveBeenCalled()
  })

  it('returns existing run only when payload hash and approval id match', async () => {
    const { query } = makeClient()
    const existing = {
      run_id: 'run-1',
      recipe_namespace: input.recipe_namespace,
      recipe_name: input.recipe_name,
      actor_id: input.actor_id,
      approval_request_id: input.approval_request_id,
      idempotency_payload_hash: input.idempotency_payload_hash,
    }
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    const result = await createApprovedRun(input)

    expect(result).toEqual({ row: existing, created: false })
    expect(mockedConsumeApprovalForTrigger).not.toHaveBeenCalled()
    expect(query.mock.calls.some(call => String(call[0]).includes("SET status = 'consumed'"))).toBe(
      false
    )
  })

  it('rejects idempotency reuse with a different payload hash', async () => {
    const { query } = makeClient()
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            actor_id: input.actor_id,
            approval_request_id: input.approval_request_id,
            idempotency_payload_hash: 'different',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    await expect(createApprovedRun(input)).rejects.toBeInstanceOf(
      WorkflowRunIdempotencyConflictError
    )
    expect(mockedConsumeApprovalForTrigger).not.toHaveBeenCalled()
  })

  it('rolls back and does not insert a run when approval consumption fails', async () => {
    const { query, release } = makeClient()
    const consumeError = new Error('approval target no longer allowed')
    mockedConsumeApprovalForTrigger.mockRejectedValueOnce(consumeError)
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    await expect(createApprovedRun(input)).rejects.toThrow('approval target no longer allowed')

    expect(
      query.mock.calls.some(call => String(call[0]).includes('INSERT INTO workflow_runs'))
    ).toBe(false)
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalled()
  })

  it('returns an approval-created user run using the persisted run intent', async () => {
    const { query } = makeClient()
    const userRunIntent = {
      triggerNamespace: input.recipe_namespace,
      triggerName: input.recipe_name,
      callerKey: input.approval_caller_key,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000321',
      teamId: null,
      usageTeamId: null,
      triggerSource: 'onDemand',
      idempotencyKey: input.idempotency_key,
      inputs: { topic: 'from persisted intent' },
      intermediateParameters: null,
      outputOverrides: null,
      maxDurationSeconds: 120,
      ttlSecondsAfterFinished: 600,
      idempotencyPayloadHash: 'typed-intent-hash',
    }
    const existing = {
      run_id: 'approval-created-run',
      recipe_namespace: input.recipe_namespace,
      recipe_name: input.recipe_name,
      actor_id: userRunIntent.actorId,
      actor_type: 'user',
      trigger_source: 'onDemand',
      approval_request_id: input.approval_request_id,
      idempotency_payload_hash: userRunIntent.idempotencyPayloadHash,
    }
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [userRunIntent], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    const result = await createApprovedRun(input)

    expect(result).toEqual({ row: existing, created: false })
    expect(mockedConsumeApprovalForTrigger).not.toHaveBeenCalled()
  })

  it('rejects a confirmation idempotency key that differs from the persisted run intent', async () => {
    const { query } = makeClient()
    query
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({
        rows: [
          {
            triggerNamespace: input.recipe_namespace,
            triggerName: input.recipe_name,
            callerKey: input.approval_caller_key,
            actorType: 'user',
            actorId: input.actor_id,
            teamId: null,
            usageTeamId: null,
            triggerSource: 'onDemand',
            idempotencyKey: 'different-idem-key',
            inputs: {},
            intermediateParameters: null,
            outputOverrides: null,
            maxDurationSeconds: null,
            ttlSecondsAfterFinished: null,
            idempotencyPayloadHash: 'typed-intent-hash',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: null })

    await expect(createApprovedRun(input)).rejects.toBeInstanceOf(
      WorkflowRunIdempotencyConflictError
    )
    expect(query.mock.calls.some(call => String(call[0]).includes('pg_advisory_xact_lock'))).toBe(
      false
    )
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
  })
})

describe('services/workflowRunService.computeWorkflowRunPayloadHash', () => {
  it('is stable across object key ordering and changes when approval id changes', () => {
    const a = computeWorkflowRunPayloadHash({
      recipeNamespace: 'ns',
      recipeName: 'recipe',
      actorType: 'autonomous',
      actorId: 'actor',
      idempotencyKey: 'key',
      triggerSource: 'autonomous',
      approvalRequestId: 'approval-a',
      callerKey: 'ns/recipe',
      inputs: { b: 2, a: 1 },
    })
    const b = computeWorkflowRunPayloadHash({
      recipeNamespace: 'ns',
      recipeName: 'recipe',
      actorType: 'autonomous',
      actorId: 'actor',
      idempotencyKey: 'key',
      triggerSource: 'autonomous',
      approvalRequestId: 'approval-a',
      callerKey: 'ns/recipe',
      inputs: { a: 1, b: 2 },
    })
    const c = computeWorkflowRunPayloadHash({
      recipeNamespace: 'ns',
      recipeName: 'recipe',
      actorType: 'autonomous',
      actorId: 'actor',
      idempotencyKey: 'key',
      triggerSource: 'autonomous',
      approvalRequestId: 'approval-b',
      callerKey: 'ns/recipe',
      inputs: { a: 1, b: 2 },
    })

    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
