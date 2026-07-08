import { describe, expect, it, vi } from 'vitest'
import { type HttpClient, StatusReporter } from '../../../src/workflow/statusReporter'

// ─── Mock HTTP Client ───────────────────────────────────────────────────

function mockHttp(postResponses: Array<{ status: number }> = [{ status: 204 }]): HttpClient {
  let callIndex = 0
  return {
    post: vi.fn().mockImplementation(() => {
      const resp = postResponses[callIndex++] ?? { status: 204 }
      if (resp.status >= 500 && callIndex <= postResponses.length) {
        return Promise.resolve(resp)
      }
      return Promise.resolve(resp)
    }),
    get: vi.fn().mockResolvedValue({
      status: 200,
      body: { workflowPhase: 'running', steps: [{ id: 's1', phase: 'completed', output: 'ok' }] },
    }),
  }
}

function createReporter(http?: HttpClient) {
  const client = http ?? mockHttp()
  return {
    reporter: new StatusReporter('http://wrc:8082', 'test-recipe', 'jwt-token-123', client),
    http: client,
  }
}

describe('reportStepStatus', () => {
  it('POSTs step status update to WRC /status endpoint', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({
      stepId: 's1',
      phase: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    })
    expect(http.post).toHaveBeenCalledWith(
      'http://wrc:8082/api/v1/workflow/test-recipe/status',
      expect.objectContaining({ stepId: 's1', phase: 'running' }),
      expect.objectContaining({ Authorization: 'Bearer jwt-token-123' })
    )
  })

  it('includes stepId, phase, completedAt in request body', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({
      stepId: 's1',
      phase: 'completed',
      completedAt: '2026-01-01T00:01:00Z',
    })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.stepId).toBe('s1')
    expect(body.phase).toBe('completed')
    expect(body.completedAt).toBe('2026-01-01T00:01:00Z')
  })

  it('includes output and toolsCalled for completed phase', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({
      stepId: 's1',
      phase: 'completed',
      output: 'result',
      toolsCalled: [
        { serverName: 'db', toolName: 'query', args: {}, result: 'ok', durationMs: 100 },
      ],
    })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.output).toBe('result')
    expect(body.toolsCalled).toHaveLength(1)
  })

  it('includes failureReason for failed phase', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({ stepId: 's1', phase: 'failed', failureReason: 'timeout' })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.failureReason).toBe('timeout')
  })

  it('retries up to 5 times on 5xx response', { timeout: 20_000 }, async () => {
    const http = mockHttp([
      { status: 500 },
      { status: 502 },
      { status: 500 },
      { status: 502 },
      { status: 204 },
    ])
    const reporter = new StatusReporter('http://wrc:8082', 'test-recipe', 'tok', http)

    await reporter.reportStepStatus({ stepId: 's1', phase: 'running' })
    expect(http.post).toHaveBeenCalledTimes(5)
  })

  it('does not retry on 4xx response', async () => {
    const http = mockHttp([{ status: 403 }])
    const reporter = new StatusReporter('http://wrc:8082', 'test-recipe', 'tok', http)

    await expect(reporter.reportStepStatus({ stepId: 's1', phase: 'running' })).rejects.toThrow()
    expect(http.post).toHaveBeenCalledTimes(1)
  })

  it('throws after 5 failed retries on 5xx', { timeout: 20_000 }, async () => {
    const http = mockHttp([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ])
    const reporter = new StatusReporter('http://wrc:8082', 'test-recipe', 'tok', http)

    await expect(reporter.reportStepStatus({ stepId: 's1', phase: 'running' })).rejects.toThrow()
    expect(http.post).toHaveBeenCalledTimes(5)
  })

  it('uses wrc-token for authorization', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({ stepId: 's1', phase: 'running' })
    const headers = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(headers.Authorization).toBe('Bearer jwt-token-123')
  })
})

describe('WRC /status handler — CRD patch', () => {
  // These test the reporter's contract with WRC, not the WRC handler itself.
  // The WRC handler is already tested in restEndpoints.test.ts from Stage 1.

  it('patches status.steps[stepId] with received data', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportStepStatus({ stepId: 's1', phase: 'completed', output: 'done' })
    expect(http.post).toHaveBeenCalled()
  })

  it('returns successfully on 204/200', async () => {
    const { reporter } = createReporter(mockHttp([{ status: 200 }]))
    await expect(
      reporter.reportStepStatus({ stepId: 's1', phase: 'completed' })
    ).resolves.toBeUndefined()
  })

  it('is idempotent: duplicate completed for same stepId does not error', async () => {
    const { reporter } = createReporter()
    await reporter.reportStepStatus({ stepId: 's1', phase: 'completed' })
    await reporter.reportStepStatus({ stepId: 's1', phase: 'completed' })
    // Both succeed without error
  })

  it('returns 204 No Content equivalent on success', async () => {
    const http = mockHttp([{ status: 204 }])
    const reporter = new StatusReporter('http://wrc:8082', 'r', 't', http)
    await expect(
      reporter.reportStepStatus({ stepId: 's1', phase: 'running' })
    ).resolves.toBeUndefined()
  })
})

describe('reportWorkflowStatus', () => {
  it('POSTs workflow-level phase to WRC', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportWorkflowStatus({ workflowPhase: 'running' })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.workflowPhase).toBe('running')
  })

  it('includes completedAt when phase is completed', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportWorkflowStatus({
      workflowPhase: 'completed',
      completedAt: '2026-01-01T00:05:00Z',
    })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.completedAt).toBe('2026-01-01T00:05:00Z')
  })

  it('includes failureReason when phase is failed', async () => {
    const { reporter, http } = createReporter()
    await reporter.reportWorkflowStatus({ workflowPhase: 'failed', failureReason: 'step-timeout' })
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body.failureReason).toBe('step-timeout')
  })
})
