import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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

  it('bounds toolsCalled in step reports while keeping the full output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const toolsCalled = Array.from({ length: 22 }, (_, i) => ({
      serverName: 'git',
      toolName: 'read_file',
      args: { path: `src/file-${i}.ts` },
      result: [{ type: 'text', text: 'x'.repeat(27_000) }],
      durationMs: 3,
    }))
    const output = 'r'.repeat(150_000)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
    await reporter.reportStepStatus('review', 'completed', { output, toolsCalled })

    const rawBody: string = fetchMock.mock.calls[0][1].body
    const body = JSON.parse(rawBody)
    expect(body.output).toBe(output)
    expect(body.toolsCalled).toHaveLength(22)
    expect(body.toolsCalled[0].result).toEqual({ truncated: true, preview: expect.any(String) })
    expect(rawBody.length - output.length).toBeLessThan(64 * 1024)
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
      { label: 'step status', httpStatus: 403, bodyBytes: expect.any(Number) }
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
      { label: 'workflow status', bodyBytes: expect.any(Number) }
    )
  })

  it('names WRC’s reason and the body size when a report is rejected as too large', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 413,
      ok: false,
      text: async () => JSON.stringify({ error: 'Request body too large' }),
    })
    const logSpy = vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(
      reporter.reportStepStatus('s1', 'completed', { output: 'sensitive output' })
    ).rejects.toThrow('WRC rejected step status with HTTP 413: Request body too large')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sentBytes = Buffer.byteLength(fetchMock.mock.calls[0][1].body)
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'Non-retryable error reporting step status: HTTP 413',
      { label: 'step status', httpStatus: 413, bodyBytes: sentBytes }
    )
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('sensitive output')
  })

  it('names WRC’s reason for a conflict that is not an already-terminal step', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Workflow is not running' }), { status: 409 })
      )
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(reporter.reportStepStatus('s1', 'completed')).rejects.toThrow(
      'WRC rejected step status with HTTP 409: Workflow is not running'
    )
  })

  it('caps WRC’s reason text in the error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 422,
      ok: false,
      text: async () => JSON.stringify({ error: 'r'.repeat(500) }),
    })
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(reporter.reportStepStatus('s1', 'completed')).rejects.toThrow(
      new Error(`WRC rejected step status with HTTP 422: ${'r'.repeat(200)}`)
    )
  })

  it('includes the network error cause code when retries are exhausted', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause }))
    const logSpy = vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })

    await expect(reporter.reportStepStatus('s1', 'completed', { output: 'x' })).rejects.toThrow(
      'Failed to report step status after 3 attempts: fetch failed (ECONNRESET)'
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'Failed to report step status after 3 attempts: fetch failed (ECONNRESET)',
      { label: 'step status', cause: 'ECONNRESET', bodyBytes: expect.any(Number) }
    )
  })

  it('reports the real socket error when WRC drops the connection', async () => {
    const server = http.createServer(req => req.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    vi.spyOn(logger, 'emitLog').mockImplementation(() => undefined)
    try {
      const observed = await fetch(url, { method: 'POST', body: '{}' }).catch(
        (err: Error & { cause?: { code?: string } }) => err.cause?.code
      )
      expect(observed).toEqual(expect.any(String))

      const reporter = new StatusReporter({
        wrcUrl: url,
        workflowName: 'wf',
        tokenProvider: tokenProvider(),
      })
      await expect(reporter.reportStepStatus('s1', 'completed')).rejects.toThrow(
        `fetch failed (${observed})`
      )
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
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

// --- The request body carries a byte-bounded toolsCalled -------------------

describe('StatusReporter with byte-heavy tool calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bounds multi-byte and control-character toolsCalled in the real request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const cjk = '日本語テキスト'.repeat(800)
    const control = '\u0001\u001b'.repeat(2_500)
    const toolsCalled = Array.from({ length: 100 }, (_, i) => ({
      serverName: 'srv',
      toolName: 'tool',
      durationMs: 1,
      args: i % 2 ? { query: cjk } : control,
      result:
        i >= 50
          ? {
              success: true,
              artifact: { name: 'a/b', format: 'pdf', path: '/output/x' },
              content: cjk,
            }
          : i % 2
            ? control
            : [{ type: 'text', text: cjk }],
    }))
    const output = 'r'.repeat(150_000)

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
    await reporter.reportStepStatus('review', 'completed', { output, toolsCalled })

    const rawBody: string = fetchMock.mock.calls[0][1].body
    const body = JSON.parse(rawBody)
    // Liveness: the report went out with the full output and every call.
    expect(body.output).toBe(output)
    expect(body.toolsCalled).toHaveLength(100)
    expect(body.toolsCalled[0].result.preview.length).toBeGreaterThan(300)
    const toolsCalledBytes = Buffer.byteLength(JSON.stringify(body.toolsCalled))
    expect(toolsCalledBytes).toBeGreaterThan(200 * 1024)
    // 150 values of at most 2 x 1,024 + 31 bytes, plus at most 80 bytes per call.
    expect(toolsCalledBytes).toBeLessThanOrEqual(150 * (2 * 1024 + 31) + 100 * 80)
    // With a 150 KB output the whole body fits WRC's 512 KiB request limit.
    expect(Buffer.byteLength(rawBody)).toBeLessThan(512 * 1024)
  })

  it('sends byte-bounded artifact results, previews and non-record args in the real request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const artifact = {
      name: 'report.docx',
      format: 'docx',
      path: '/output/report.docx',
      sizeBytes: 2048,
      createdAt: '2026-10-16T00:00:00.000Z',
    }
    // Fits the 1,024-character limit, over 2,048 bytes, artifact accepted by WRC.
    const artifactResult = { success: true, artifact, content: '日'.repeat(800) }
    const craftedPreview = { truncated: true, preview: '\u0001'.repeat(1_024) }
    const stringArgs = '日'.repeat(680)
    const toolsCalled = [
      { serverName: 'clerum', toolName: 'generate_docx', args: {}, result: artifactResult },
      { serverName: 'srv', toolName: 'tool', args: stringArgs, result: craftedPreview },
    ]

    const reporter = new StatusReporter({
      wrcUrl: 'http://wrc:8082',
      workflowName: 'wf',
      tokenProvider: tokenProvider(),
    })
    await reporter.reportStepStatus('build', 'completed', { output: 'done', toolsCalled })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.toolsCalled).toHaveLength(2)
    // The artifact result is reduced to what WRC extracts, not previewed.
    expect(body.toolsCalled[0].result).toEqual({ success: true, artifact })
    // A string arg whose {value} record is over the byte limit is previewed whole.
    expect(body.toolsCalled[1].args).toEqual({ truncated: true, preview: stringArgs })
    // A preview over the byte limit is bounded again instead of passed through.
    const result = body.toolsCalled[1].result as { truncated: boolean; preview: string }
    expect(result).not.toEqual(craftedPreview)
    expect(result.truncated).toBe(true)
    expect(result.preview.length).toBeGreaterThan(300)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2 * 1024 + 31)
  })
})
