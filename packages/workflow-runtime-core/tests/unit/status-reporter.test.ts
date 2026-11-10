import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunStateUnavailableError } from '../../src/errors'
import { createStaticRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'
import { AUTH_RETRY_DELAY_MS } from '../../src/status-reporter/authRetry'
import { StatusReporter } from '../../src/status-reporter/client'
import * as logger from '../../src/status-reporter/logger'

const tokenProvider = (token = 'tok') => createStaticRuntimeTokenProvider({ wrcToken: token })

describe('StatusReporter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('fetches workflow status with WRC auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        workflowPhase: 'running',
        steps: [{ id: 's1', phase: 'completed', output: 'done' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
    const status = await reporter.getWorkflowStatus()

    expect(status.steps[0].output).toBe('done')
    expect(fetchMock).toHaveBeenCalledWith('http://wrc:8082/api/v1/workflow/wf/status', {
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    })
  })

  it('reports step executor metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
    await reporter.reportStepStatus('s1', 'completed', {
      executor: 'snippet',
      output: 'ok',
      approvalBindingSha256: 'a'.repeat(64),
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual(
      expect.objectContaining({
        stepId: 's1',
        phase: 'completed',
        executor: 'snippet',
        approvalBindingSha256: 'a'.repeat(64),
      })
    )
  })

  it('retries 5xx status reports and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, ok: false })
      .mockResolvedValueOnce({ status: 502, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await reporter.reportStepStatus('s1', 'running')

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails closed on non-retryable 4xx status reports', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 403, ok: false })
    const logSpy = vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(
      reporter.reportStepStatus('s1', 'running', { output: 'sensitive output' })
    ).rejects.toThrow('WRC rejected step status with HTTP 403')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'Non-retryable error reporting step status: HTTP 403',
      { label: 'step status', httpStatus: 403 }
    )
  })

  it('throws when status report retries are exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 500, ok: false })
    const logSpy = vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(reporter.reportWorkflowStatus('running')).rejects.toThrow(
      'Failed to report workflow status after 3 attempts: HTTP 500'
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'Failed to report workflow status after 3 attempts: HTTP 500',
      { label: 'workflow status' }
    )
  })

  it('treats duplicate terminal step conflicts as idempotent success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      ok: false,
      text: async () => JSON.stringify({ error: "Step 's1' is already in terminal phase" }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(reporter.reportStepStatus('s1', 'completed')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rereads token provider after a 401 response', async () => {
    vi.useFakeTimers()
    const tokens = ['jwt-a', 'jwt-b']
    const provider = {
      getWrcToken: vi.fn(async () => tokens.shift() ?? 'jwt-b'),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: provider,
    })

    const pending = reporter.reportWorkflowStatus('running')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
  })

  it('keeps rereading tokens across a bounded kubelet Secret projection delay', async () => {
    vi.useFakeTimers()
    let tokenIndex = 0
    const provider = {
      getWrcToken: vi.fn(async () => `jwt-${(tokenIndex += 1)}`),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: provider,
    })

    const pending = reporter.reportWorkflowStatus('running')
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
      await vi.advanceTimersByTimeAsync(0)
    }
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-1')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-2')
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer jwt-3')
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer jwt-4')
  })
})

describe('StatusReporter run-store unavailable answers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const runStateUnavailable = () => ({
    status: 503,
    ok: false,
    json: async () => ({ code: 'workflow_run_state_unavailable' }),
  })
  const plain503 = () => ({
    status: 503,
    ok: false,
    json: async () => ({ error: 'Service Unavailable' }),
  })

  function reporter(): StatusReporter {
    return new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
  }

  async function settle(promise: Promise<void>): Promise<unknown> {
    return promise.then(
      () => 'resolved',
      (error: unknown) => error
    )
  }

  it('throws WorkflowRunStateUnavailableError after three 503 run-store answers', async () => {
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    const fetchMock = vi.fn().mockImplementation(async () => runStateUnavailable())
    vi.stubGlobal('fetch', fetchMock)

    const failure = await settle(reporter().reportStepStatus('s1', 'running'))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(failure).toBeInstanceOf(WorkflowRunStateUnavailableError)
    expect((failure as Error).message).toBe(
      'Failed to report step status after 3 attempts: HTTP 503'
    )
  })

  it('throws a plain Error after three 503 answers without the run-store code', async () => {
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    const fetchMock = vi.fn().mockImplementation(async () => plain503())
    vi.stubGlobal('fetch', fetchMock)

    const failure = await settle(reporter().reportStepStatus('s1', 'running'))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(WorkflowRunStateUnavailableError)
    expect((failure as Error).message).toBe(
      'Failed to report step status after 3 attempts: HTTP 503'
    )
  })

  it('resolves when a 503 run-store answer is followed by 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(runStateUnavailable())
      .mockResolvedValueOnce({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await expect(reporter().reportStepStatus('s1', 'running')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('lets the last attempt decide: code, code, then a plain 503 is a plain Error', async () => {
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(runStateUnavailable())
      .mockResolvedValueOnce(runStateUnavailable())
      .mockResolvedValueOnce(plain503())
    vi.stubGlobal('fetch', fetchMock)

    const failure = await settle(reporter().reportStepStatus('s1', 'running'))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(WorkflowRunStateUnavailableError)
  })

  it('lets the last attempt decide: plain, plain, then the code is the typed error', async () => {
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(plain503())
      .mockResolvedValueOnce(plain503())
      .mockResolvedValueOnce(runStateUnavailable())
    vi.stubGlobal('fetch', fetchMock)

    const failure = await settle(reporter().reportStepStatus('s1', 'running'))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(failure).toBeInstanceOf(WorkflowRunStateUnavailableError)
  })
})
