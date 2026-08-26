/**
 * Tests for the refresh-rotation recovery path in userApprovalRequester:
 * persistent refresh 401 → caller-supplied `reIssueTokens` callback →
 * retry the original operation once.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { persistRuntimeAuthTokens } from '../mcpHostJwtState'
import { resetRuntimeAuthHealthForTests, runtimeAuthHealthSnapshot } from '../runtimeAuthHealth'
import {
  type ApprovalGateParams,
  type McpHostRuntimeAuth,
  type ReIssuedTokenPair,
  gateStep,
  reIssueCounter,
  refreshFailureCounter,
  refreshWithRecovery,
  workflowTokenRefreshCounter,
} from '../userApprovalRequester'

const mockFetch = vi.fn() as Mock
vi.stubGlobal('fetch', mockFetch)
const tempDirs: string[] = []

function makeAuth(
  overrides: Partial<McpHostRuntimeAuth> = {}
): McpHostRuntimeAuth & { reIssueTokens: Mock<() => Promise<ReIssuedTokenPair>> } {
  const reIssueTokens = vi.fn<() => Promise<ReIssuedTokenPair>>()
  return {
    accessToken: RECIPE_TEST_ACCESS_TOKEN,
    refreshToken: 'initial-refresh',
    baseUrl: 'http://gateway:8092',
    hostRef: 'sandbox-recipes/recipe-test',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'recipe-test',
    reIssueTokens,
    ...overrides,
  } as McpHostRuntimeAuth & { reIssueTokens: Mock<() => Promise<ReIssuedTokenPair>> }
}

function makeRuntimeJwt(
  binding: {
    hostRefs: string[]
    recipeNamespace: string
    recipeName: string
  } & Record<string, unknown>
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(binding)).toString('base64url')
  return `${header}.${payload}.sig`
}

const RECIPE_TEST_ACCESS_TOKEN = makeRuntimeJwt({
  hostRefs: ['sandbox-recipes/recipe-test'],
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'recipe-test',
})

const REISSUED_ACCESS_TOKEN = makeRuntimeJwt({
  hostRefs: ['sandbox-recipes/reissued-recipe'],
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'reissued-recipe',
})

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): unknown {
  const status = init?.status ?? 200
  return {
    ok: init?.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function textResponse(status: number, body: string): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json')
    },
    text: async () => body,
  }
}

const PARAMS: ApprovalGateParams = {
  stepId: 'step-recovery',
  executionId: 'exec-recovery',
  target: { userId: 'user-1' },
  message: 'approve this',
}

describe('userApprovalRequester — refresh rotation crash recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    // Reset prom-client counters between tests so assertions are isolated.
    refreshFailureCounter.reset()
    reIssueCounter.reset()
    workflowTokenRefreshCounter.reset()
    resetRuntimeAuthHealthForTests()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('serialises concurrent runtime refreshes on the same auth object', async () => {
    vi.useRealTimers()
    const auth = makeAuth()
    let releaseRefresh!: () => void
    let signalRefreshStarted!: () => void
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })
    const refreshStarted = new Promise<void>(resolve => {
      signalRefreshStarted = resolve
    })
    let refreshCount = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (!url.endsWith('/workflow-auth/refresh')) {
        throw new Error(`Unexpected fetch: ${url}`)
      }
      refreshCount += 1
      if (refreshCount === 1) signalRefreshStarted()
      await refreshGate
      return jsonResponse({
        [['access', 'Token'].join('')]: REISSUED_ACCESS_TOKEN,
        [['refresh', 'Token'].join('')]: ['rotated', 'refresh'].join('-'),
      })
    })

    const first = refreshWithRecovery(auth)
    await refreshStarted
    const second = refreshWithRecovery(auth)
    await new Promise(resolve => setTimeout(resolve, 10))
    releaseRefresh()

    await Promise.all([first, second])
    expect(refreshCount).toBe(1)
    expect(auth.accessToken).toBe(REISSUED_ACCESS_TOKEN)
    expect(auth.refreshToken).toBe(['rotated', 'refresh'].join('-'))
  })

  it('does not invoke re-issue when refresh is not needed', async () => {
    const auth = makeAuth()

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-ok',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'approved' }, { status: 200 }))

    const promise = gateStep(PARAMS, auth)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(auth.reIssueTokens).not.toHaveBeenCalled()
    expect(
      mockFetch.mock.calls.some(
        ([url]) => typeof url === 'string' && url.includes('/workflow-auth/refresh')
      )
    ).toBe(false)
  })

  it('rejects consumed approvals by default because they are already spent', async () => {
    const auth = makeAuth()

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-consumed',
        status: 'consumed',
      })
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'consumed' }, { status: 200 }))

    const assertion = expect(gateStep(PARAMS, auth)).rejects.toThrow('Approval consumed')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('treats consumed as terminal only when workflow trigger retries opt in', async () => {
    const auth = makeAuth()

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-consumed',
        status: 'consumed',
      })
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'consumed' }, { status: 200 }))

    const promise = gateStep({ ...PARAMS, allowConsumedTerminal: true }, auth)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise

    expect(result).toMatchObject({
      approvalRequestId: 'approval-consumed',
      status: 'consumed',
    })
  })

  // ── Test 2: single refresh 401 then 200 — no re-issue ────────────────

  it('recovers from a single refresh 401 followed by 200 without re-issuing', async () => {
    const auth = makeAuth()

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-single-401',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    mockFetch.mockResolvedValueOnce(textResponse(401, 'refresh token expired'))
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        accessToken: RECIPE_TEST_ACCESS_TOKEN,
        refreshToken: 'rotated-refresh',
        expiresInSeconds: 600,
      })
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'approved' }, { status: 200 }))

    const promise = gateStep(PARAMS, auth)
    // 1s backoff between refresh attempts → 2s window covers it.
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(auth.accessToken).toBe(RECIPE_TEST_ACCESS_TOKEN)
    expect(auth.refreshToken).toBe('rotated-refresh')
    expect(auth.reIssueTokens).not.toHaveBeenCalled()
    expect(runtimeAuthHealthSnapshot()).toMatchObject({
      state: 'ok',
      consecutiveFailures: 0,
      lastFailureReason: null,
    })
    const metric = await workflowTokenRefreshCounter.get()
    expect(metric.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          labels: { recipe: 'recipe-test', outcome: 'failed' },
        }),
        expect.objectContaining({
          value: 1,
          labels: { recipe: 'recipe-test', outcome: 'succeeded' },
        }),
      ])
    )
  })

  it('labels persisted auth reloads separately from network refresh success', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-auth-state-'))
    tempDirs.push(stateDir)
    vi.stubEnv('MCP_HOST_RUNTIME_AUTH_STATE_DIR', stateDir)
    const nowSecs = Math.floor(Date.now() / 1000)
    const persistedAccessToken = makeRuntimeJwt({
      hostRefs: ['sandbox-recipes/recipe-test'],
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-test',
      exp: nowSecs + 600,
    })
    const persistedRefreshToken = makeRuntimeJwt({
      hostRefs: ['sandbox-recipes/recipe-test'],
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-test',
      exp: nowSecs + 1200,
    })
    await persistRuntimeAuthTokens(
      {
        accessToken: persistedAccessToken,
        refreshToken: persistedRefreshToken,
      },
      stateDir
    )
    const auth = makeAuth({ refreshToken: 'stale-refresh' })

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-state-reload',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'approved' }, { status: 200 }))

    const promise = gateStep(PARAMS, auth)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(auth.accessToken).toBe(persistedAccessToken)
    expect(auth.refreshToken).toBe(persistedRefreshToken)
    expect(
      mockFetch.mock.calls.some(
        ([url]) => typeof url === 'string' && url.includes('/workflow-auth/refresh')
      )
    ).toBe(false)
    const metric = await workflowTokenRefreshCounter.get()
    expect(metric.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          labels: { recipe: 'recipe-test', outcome: 'loaded_from_state' },
        }),
      ])
    )
    expect(metric.values).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: { recipe: 'recipe-test', outcome: 'succeeded' },
        }),
      ])
    )
  })

  it('reloads persisted auth after a refresh 401 race before re-issuing', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-auth-state-'))
    tempDirs.push(stateDir)
    vi.stubEnv('MCP_HOST_RUNTIME_AUTH_STATE_DIR', stateDir)
    const nowSecs = Math.floor(Date.now() / 1000)
    const racedAccessToken = makeRuntimeJwt({
      hostRefs: ['sandbox-recipes/recipe-test'],
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-test',
      iat: nowSecs + 1,
      exp: nowSecs + 600,
    })
    const racedRefreshToken = makeRuntimeJwt({
      hostRefs: ['sandbox-recipes/recipe-test'],
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-test',
      iat: nowSecs + 1,
      exp: nowSecs + 1200,
    })
    const auth = makeAuth({ refreshToken: 'stale-refresh' })

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-refresh-race',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    mockFetch.mockImplementationOnce(async () => {
      await persistRuntimeAuthTokens(
        {
          accessToken: racedAccessToken,
          refreshToken: racedRefreshToken,
        },
        stateDir
      )
      return textResponse(401, 'refresh token already rotated')
    })
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'approved' }, { status: 200 }))

    const promise = gateStep(PARAMS, auth)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(auth.accessToken).toBe(racedAccessToken)
    expect(auth.refreshToken).toBe(racedRefreshToken)
    expect(auth.reIssueTokens).not.toHaveBeenCalled()
    const refreshCalls = mockFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/workflow-auth/refresh')
    )
    expect(refreshCalls).toHaveLength(1)
    const metric = await workflowTokenRefreshCounter.get()
    expect(metric.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          labels: { recipe: 'recipe-test', outcome: 'loaded_from_state' },
        }),
      ])
    )
  })

  it('invokes re-issue after 2 consecutive refresh 401s, then retries the original op', async () => {
    const auth = makeAuth()
    auth.reIssueTokens.mockResolvedValueOnce({
      accessToken: REISSUED_ACCESS_TOKEN,
      refreshToken: 'reissued-refresh',
    })

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-reissue',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
    // Second 401 reaches the threshold → recovery via reIssueTokens.
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'approved' }, { status: 200 }))

    const promise = gateStep(PARAMS, auth)
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await promise

    expect(result.status).toBe('approved')
    expect(auth.reIssueTokens).toHaveBeenCalledTimes(1)
    expect(auth.accessToken).toContain('.')
    expect(auth.refreshToken).toBe('reissued-refresh')
    expect(auth.hostRef).toBe('sandbox-recipes/reissued-recipe')
    expect(auth.recipeNamespace).toBe('sandbox-recipes')
    expect(auth.recipeName).toBe('reissued-recipe')
  })

  it('propagates the error when re-issue itself fails', async () => {
    vi.stubEnv('MCP_HOST_RUNTIME_AUTH_DEGRADED_AFTER_FAILURES', '1')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const auth = makeAuth()
      auth.reIssueTokens.mockRejectedValueOnce(
        new Error('WRC /auth/mcp-host/:ns/:name/tokens returned HTTP 500')
      )

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          approvalRequestId: 'approval-fail',
          status: 'pending',
          expiresAt: '2099-01-01T00:00:00Z',
        })
      )
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
      mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
      mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))

      const promise = gateStep(PARAMS, auth)
      const assertion = expect(promise).rejects.toThrow(
        /WRC \/auth\/mcp-host\/:ns\/:name\/tokens returned HTTP 500/
      )
      await vi.advanceTimersByTimeAsync(3_000)
      await assertion

      expect(auth.reIssueTokens).toHaveBeenCalledTimes(1)
      expect(runtimeAuthHealthSnapshot()).toMatchObject({
        state: 'degraded',
        consecutiveFailures: 1,
        lastFailureReason: 'refresh_recovery_failed',
      })
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Workflow auth re-issue failed')
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does NOT re-issue again if the original operation fails with 401 after recovery', async () => {
    const auth = makeAuth()
    auth.reIssueTokens.mockResolvedValueOnce({
      accessToken: REISSUED_ACCESS_TOKEN,
      refreshToken: 'reissued-refresh',
    })

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-loop-guard',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    // First poll → 401
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    // Refresh attempts both 401 → triggers re-issue
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
    // Re-issued tokens are also rejected (e.g. admin revocation persists).
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    const promise = gateStep(PARAMS, auth)
    const assertion = expect(promise).rejects.toThrow(/upstream auth appears broken/)
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion

    expect(auth.reIssueTokens).toHaveBeenCalledTimes(1)
  })

  it('serialises concurrent re-issue attempts on the same auth object', async () => {
    // Real timers: the mutex contract is wall-clock driven — both gateStep
    // invocations must reach `recoverTokenPair` on the same auth object
    // before the first one finishes.
    vi.useRealTimers()

    const auth = makeAuth()
    // Barrier: first reIssue blocks until released so the second caller
    // observes the in-flight promise in the mutex map.
    let releaseReIssue: (v: ReIssuedTokenPair) => void
    const reIssueGate = new Promise<ReIssuedTokenPair>(resolve => {
      releaseReIssue = resolve
    })
    auth.reIssueTokens.mockImplementation(() => reIssueGate)

    let requestCount = 0
    let refreshCount = 0
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/workflow-approvals/request') && init?.method === 'POST') {
        requestCount += 1
        return jsonResponse({
          approvalRequestId: `approval-concurrent-${requestCount}`,
          status: 'pending',
          expiresAt: '2099-01-01T00:00:00Z',
        })
      }
      if (url.includes('/workflow-approvals/') && url.endsWith('/status')) {
        const isApproved = auth.accessToken === REISSUED_ACCESS_TOKEN
        if (isApproved) {
          return jsonResponse({ status: 'approved' }, { status: 200 })
        }
        return { ok: false, status: 401 } as unknown
      }
      if (url.endsWith('/workflow-auth/refresh')) {
        refreshCount += 1
        return textResponse(401, 'revoked')
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
    })

    const p1 = gateStep(PARAMS, auth)
    const p2 = gateStep(
      { ...PARAMS, stepId: 'step-recovery-b', executionId: 'exec-recovery-b' },
      auth
    )

    // Wait for the first reIssueTokens invocation; refresh backoff is 1s
    // between attempts so ≥1.5s gives both gates time to reach recovery.
    const started = Date.now()
    while (auth.reIssueTokens.mock.calls.length === 0 && Date.now() - started < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 1_500))

    releaseReIssue!({ accessToken: REISSUED_ACCESS_TOKEN, refreshToken: 'reissued-refresh' })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('approved')
    expect(r2.status).toBe('approved')
    expect(auth.reIssueTokens).toHaveBeenCalledTimes(1)
    expect(refreshCount).toBeGreaterThanOrEqual(2)
  }, 15_000)

  it('throws a descriptive error when persistent 401 has no reIssueTokens callback', async () => {
    const auth = makeAuth()
    delete (auth as { reIssueTokens?: unknown }).reIssueTokens

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        approvalRequestId: 'approval-no-recovery',
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))
    mockFetch.mockResolvedValueOnce(textResponse(401, 'revoked'))

    const promise = gateStep(PARAMS, auth)
    const assertion = expect(promise).rejects.toThrow(
      /no reIssueTokens recovery callback is configured/
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
  })
})
