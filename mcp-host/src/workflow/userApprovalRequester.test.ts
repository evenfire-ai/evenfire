import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// No need to mock node:crypto — SHA256 is deterministic by nature

import { type ApprovalGateParams, type McpHostRuntimeAuth, gateStep } from './userApprovalRequester'

// Mock global fetch before importing the module
const mockFetch = vi.fn() as Mock
vi.stubGlobal('fetch', mockFetch)

function makeRuntimeJwt(binding: {
  hostRefs: string[]
  recipeNamespace: string
  recipeName: string
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(binding)).toString('base64url')
  return `${header}.${payload}.sig`
}

const STANDALONE_ACCESS_TOKEN = makeRuntimeJwt({
  hostRefs: ['mcp-host/standalone'],
  recipeNamespace: 'mcp-host',
  recipeName: 'standalone',
})

describe('userApprovalRequester — gateStep', () => {
  let auth: McpHostRuntimeAuth

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.useFakeTimers()

    auth = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      baseUrl: 'http://gateway:8092',
      hostRef: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Happy path: approved ────────────────────────────────────────────

  it('posts approval request and polls until approved', async () => {
    // 1st call: POST /request → 200
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-001',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    // 2nd call: GET /status → pending
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending' }),
    })
    // 3rd call: GET /status → approved
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'approved',
        decisionMaker: { userId: 'user-1' },
        note: 'looks good',
      }),
    })

    const params: ApprovalGateParams = {
      stepId: 'step-1',
      target: { userId: 'user-1' },
      message: 'Approve this step?',
      runBindingProof: '00000000-0000-4000-8000-000000000123',
    }

    const promise = gateStep(params, auth)

    // Advance past first poll sleep (5s)
    await vi.advanceTimersByTimeAsync(8_000)

    const result = await promise
    expect(result.status).toBe('approved')
    expect(result.decidedBy).toEqual({ userId: 'user-1' })
    expect(result.note).toBe('looks good')

    // Verify POST /request was called correctly
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://gateway:8092/api/v1/workflow-approvals/request',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-abc',
          'Idempotency-Key': expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      })
    )
    const [, postInit] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(postInit.body))).toMatchObject({
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      target: { userId: 'user-1' },
      payload: { message: 'Approve this step?' },
      workflowRunBindingProof: '00000000-0000-4000-8000-000000000123',
    })
  })

  it('can bind a trigger-bound approval request to the target workflow recipe', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-target-recipe',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const promise = gateStep(
      {
        stepId: 'workflow_trigger:sandbox-recipes/target-recipe',
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'target-recipe',
        },
        target: { userId: 'user-1' },
        message: 'Approve target trigger?',
        payloadMetadata: {
          workflowTrigger: {
            namespace: 'sandbox-recipes',
            name: 'target-recipe',
            caller: 'mcp-host/standalone',
          },
        },
      },
      auth
    )

    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise
    expect(result.status).toBe('approved')
    const [, postInit] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(postInit.body))).toMatchObject({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'target-recipe',
      target: { userId: 'user-1' },
      payload: {
        message: 'Approve target trigger?',
        metadata: {
          workflowTrigger: {
            namespace: 'sandbox-recipes',
            name: 'target-recipe',
            caller: 'mcp-host/standalone',
          },
        },
      },
    })
  })

  it('includes the runtime mcp-host route hint without changing the approval caller binding', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-runtime-route',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const promise = gateStep(
      {
        stepId: 'approval-gated-step',
        target: { userId: 'user-1' },
        message: 'Approve runtime child step?',
        runtimeMcpHostRef: 'sandbox-recipes/caller-recipe-run-12345678',
      },
      auth
    )

    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise
    expect(result.status).toBe('approved')
    const [, postInit] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(postInit.body))).toMatchObject({
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      payload: {
        message: 'Approve runtime child step?',
        metadata: {
          runtimeMcpHostRef: 'sandbox-recipes/caller-recipe-run-12345678',
        },
      },
    })
  })

  // ── Denied ──────────────────────────────────────────────────────────

  it('throws when approval is denied', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-002',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'denied', note: 'not safe' }),
    })

    const params: ApprovalGateParams = {
      stepId: 'step-denied',
      target: { userId: 'user-1' },
      message: 'Approve?',
    }

    const promise = gateStep(params, auth)
    const assertion = expect(promise).rejects.toThrow('Approval denied')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  // ── Expired ─────────────────────────────────────────────────────────

  it('throws when approval expires', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-003',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'expired' }),
    })

    const params: ApprovalGateParams = {
      stepId: 'step-expired',
      target: { userId: 'user-1' },
      message: 'Approve?',
    }

    const promise = gateStep(params, auth)
    const assertion = expect(promise).rejects.toThrow('Approval expired')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  // ── Cancelled ───────────────────────────────────────────────────────

  it('throws when approval is cancelled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-004',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'cancelled' }),
    })

    const promise = gateStep(
      { stepId: 'step-cancelled', target: { teamId: 'team-1' }, message: 'OK?' },
      auth
    )
    const assertion = expect(promise).rejects.toThrow('Approval cancelled')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  // ── Request failure (non-200) ───────────────────────────────────────

  it('throws when approval request returns non-200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'target not in allowlist',
    })

    const promise = gateStep(
      { stepId: 'step-fail', target: { userId: 'unknown' }, message: 'test' },
      auth
    )
    const assertion = expect(promise).rejects.toThrow('Approval request failed (403)')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('does not include approval error bodies in thrown messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'target not in allowlist bearer-token-like-value',
    })

    const promise = gateStep(
      { stepId: 'step-redact', target: { userId: 'unknown' }, message: 'test' },
      auth
    )
    const assertion = promise.then(
      () => {
        throw new Error('expected gateStep to fail')
      },
      err => {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toBe('Approval request failed (403)')
        expect(message).not.toContain('target not in allowlist')
        expect(message).not.toContain('bearer-token-like-value')
      }
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('refreshes access token when the initial approval request returns 401, then retries once', async () => {
    const persistRotatedTokens = vi.fn().mockResolvedValue(undefined)
    auth.persistRotatedTokens = persistRotatedTokens

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'expired access token',
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessToken: STANDALONE_ACCESS_TOKEN,
        refreshToken: 'rotated-refresh',
        expiresInSeconds: 600,
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-initial-refresh',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const result = await gateStep(
      {
        stepId: 'step-initial-refresh',
        executionId: 'exec-1',
        target: { userId: 'user-1' },
        message: 'approve this',
      },
      auth
    )

    expect(result.status).toBe('approved')
    expect(auth.accessToken).toBe(STANDALONE_ACCESS_TOKEN)
    expect(auth.refreshToken).toBe('rotated-refresh')
    expect(persistRotatedTokens).toHaveBeenCalledWith({
      accessToken: STANDALONE_ACCESS_TOKEN,
      refreshToken: 'rotated-refresh',
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'http://gateway:8092/api/v1/workflow-auth/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer refresh-xyz',
        }),
      })
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'http://gateway:8092/api/v1/workflow-approvals/request',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${STANDALONE_ACCESS_TOKEN}`,
        }),
      })
    )
  })

  // ── Token refresh mid-poll (401 → refresh → retry) ─────────────────

  it('refreshes access token when poll returns 401, then retries', async () => {
    // POST /request → 200
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-005',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    // GET /status → 401 (token expired) — pollStatus returns __unauthorized__
    mockFetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
    })
    // POST /auth/refresh → 200 (rotated tokens)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessToken: STANDALONE_ACCESS_TOKEN,
        refreshToken: 'new-refresh',
        expiresInSeconds: 600,
      }),
    })
    // GET /status with new token → approved
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const promise = gateStep(
      { stepId: 'step-refresh', target: { userId: 'user-1' }, message: 'test' },
      auth
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(6_000)

    const result = await promise
    expect(result.status).toBe('approved')

    // Verify tokens were rotated on the auth object
    expect(auth.accessToken).toBe(STANDALONE_ACCESS_TOKEN)
    expect(auth.refreshToken).toBe('new-refresh')

    // Verify refresh was called with the old refresh token
    expect(mockFetch).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflow-auth/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer refresh-xyz',
        }),
      })
    )
  })

  it('does not treat a literal status value as an unauthorized sentinel', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-literal-status',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: '__unauthorized__' }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const promise = gateStep(
      { stepId: 'step-literal-status', target: { userId: 'user-1' }, message: 'test' },
      auth
    )
    await vi.advanceTimersByTimeAsync(8_000)

    const result = await promise
    expect(result.status).toBe('approved')
    expect(mockFetch).not.toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflow-auth/refresh',
      expect.anything()
    )
  })

  it('retries transient 5xx poll failures before succeeding', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        approvalRequestId: 'approval-poll-retry',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable',
    })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const promise = gateStep(
      {
        stepId: 'step-poll-retry',
        executionId: 'exec-1',
        target: { userId: 'user-1' },
        message: 'approve this',
      },
      auth
    )

    await vi.advanceTimersByTimeAsync(5_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  // ── Client-side timeout ─────────────────────────────────────────────

  it('throws when client-side timeoutSeconds is exceeded', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approvalRequestId: 'approval-timeout',
          status: 'pending',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'pending' }),
      })

    const params: ApprovalGateParams = {
      stepId: 'step-timeout',
      target: { userId: 'user-1' },
      message: 'Approve?',
      timeoutSeconds: 2,
    }

    const promise = gateStep(params, auth)
    const assertion = expect(promise).rejects.toThrow('polling timed out')

    // Advance past deadline (2s) + poll interval
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(6_000)
    await assertion
  })

  // ── Response missing approvalRequestId ──────────────────────────────

  it('throws when request response is missing approvalRequestId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'pending' }),
    })

    const promise = gateStep(
      { stepId: 'step-missing', target: { userId: 'user-1' }, message: 'test' },
      auth
    )
    const assertion = expect(promise).rejects.toThrow('missing approvalRequestId')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('reuses an existing approval request when the server returns 409 for the same idempotency key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        approvalRequestId: 'approval-existing',
        status: 'pending',
      }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    })

    const result = await gateStep(
      {
        stepId: 'step-existing-approval',
        executionId: 'exec-existing-approval',
        target: { userId: 'user-1' },
        message: 'approve this once',
      },
      auth
    )

    expect(result.status).toBe('approved')
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'http://gateway:8092/api/v1/workflow-approvals/approval-existing/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-abc',
        }),
      })
    )
  })

  it('retries a run binding conflict while WRC persists the exact step hash', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'workflow_approval_run_binding_invalid' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ approvalRequestId: 'approval-bound', status: 'pending' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'approved' }),
      })

    const pending = gateStep(
      {
        stepId: 'approval-gated-step',
        executionId: '22222222-2222-4222-8222-222222222222:risk-review:started',
        runBindingProof: '33333333-3333-4333-8333-333333333333',
        target: { userId: 'user-1' },
        message: 'approve the bound step',
      },
      auth
    )

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toMatchObject({ status: 'approved' })
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(mockFetch.mock.calls[0]?.[0]).toContain('/workflow-approvals/request')
    expect(mockFetch.mock.calls[1]?.[0]).toContain('/workflow-approvals/request')
    expect(mockFetch.mock.calls[2]?.[0]).toContain('/workflow-approvals/approval-bound/status')
  })

  it('uses a stable idempotency key within one execution and a different key across executions', async () => {
    async function captureIdempotencyKey(executionId: string): Promise<string> {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approvalRequestId: `approval-${executionId}`,
          status: 'pending',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'approved' }),
      })

      await gateStep(
        {
          stepId: 'step-idempotency',
          executionId,
          target: { userId: 'user-1' },
          message: 'approve this',
        },
        auth
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      return String((init.headers as Record<string, string>)['Idempotency-Key'])
    }

    const sameExecutionKey1 = await captureIdempotencyKey('exec-stable')
    vi.clearAllMocks()
    const sameExecutionKey2 = await captureIdempotencyKey('exec-stable')
    vi.clearAllMocks()
    const differentExecutionKey = await captureIdempotencyKey('exec-other')

    expect(sameExecutionKey1).toBe(sameExecutionKey2)
    expect(differentExecutionKey).not.toBe(sameExecutionKey1)
  })
})
