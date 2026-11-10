import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  McpHostClient,
  SignalPoller,
  StatusReporter,
  StepCoordinator,
  WorkflowAuthorizationPausedError,
  WorkflowRunStateUnavailableError,
  createStaticRuntimeTokenProvider,
} from '@clerum/workflow-runtime-core'
import { registry, workflowStepDurationSeconds, workflowStepTotal } from '../../../src/metrics'
import { runWorkflowRuntime } from '../../../src/workflow/sdkRuntime'

function runtimeConfig() {
  return {
    workflowName: 'runtime-test',
    namespace: 'sandbox-recipes',
    wrcUrl: 'http://wrc.test',
    tokenProvider: createStaticRuntimeTokenProvider({
      wrcToken: 'wrc-token',
      mcpHostToken: 'mcp-token',
      snippetRunnerToken: 'snippet-token',
    }),
    wrcTokenFile: '/var/run/clerum/workflow-tokens/wrc-token',
    mcpHostUrl: 'http://mcp-host.test',
    mcpHostTokenFile: '/var/run/clerum/workflow-tokens/mcp-host-token',
    snippetRunnerUrl: 'http://snippet-runner.test',
    snippetRunnerTokenFile: '/var/run/clerum/workflow-tokens/snippet-runner-token',
    correlationId: 'corr-1',
    signalPollIntervalMs: 5000,
    restPort: 8090,
  }
}

function snippetRun(code = 'return { ok: true }') {
  return { type: 'snippet' as const, language: 'typescript' as const, code }
}

function makeStatus(
  snapshot = { workflowPhase: 'pending', steps: [] as Array<Record<string, unknown>> }
) {
  const calls: Array<{ kind: 'workflow' | 'step'; args: unknown[] }> = []
  const status = {
    getWorkflowStatus: vi.fn().mockResolvedValue(snapshot),
    reportWorkflowStatus: vi.fn().mockImplementation(async (...args: unknown[]) => {
      calls.push({ kind: 'workflow', args })
    }),
    reportStepStatus: vi.fn().mockImplementation(async (...args: unknown[]) => {
      calls.push({ kind: 'step', args })
    }),
  }
  return { status: status as unknown as StatusReporter, calls }
}

function makeSignals(cancelled = false) {
  const signals = {
    pollSignals: vi.fn().mockReturnValue(vi.fn()),
    hasSignal: vi.fn().mockReturnValue(cancelled),
  }
  return signals as unknown as SignalPoller
}

function makeMcpHost(result = 'agent-output') {
  const mcpHost = {
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
    executeAgentStep: vi.fn().mockResolvedValue({
      stepId: 'agent',
      status: 'completed',
      output: result,
      durationMs: 10,
      toolsCalled: [{ serverName: 'mock', toolName: 'echo', args: {}, result, durationMs: 1 }],
    }),
  }
  return mcpHost as unknown as McpHostClient
}

function makeSnippetRunner(
  impl: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
) {
  return {
    execute: vi.fn().mockImplementation(impl),
  }
}

function expectMetricLine(
  metrics: string,
  name: string,
  labels: Record<string, string>,
  value: number
): void {
  const lookaheads = Object.entries(labels)
    .map(
      ([key, labelValue]) =>
        `(?=[^\\n]*${key}="${labelValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`
    )
    .join('')
  expect(metrics).toMatch(new RegExp(`^${name}\\{${lookaheads}[^\\n]*\\} ${value}$`, 'm'))
}

describe('sdk workflow runtime', () => {
  beforeEach(() => {
    vi.stubEnv('CLERUM_WORKFLOW_RUN_ID', '00000000-0000-4000-8000-000000000abc')
    vi.stubEnv('CLERUM_WORKFLOW_TEAM_ID', '11111111-1111-4111-8111-111111111111')
    workflowStepTotal.reset()
    workflowStepDurationSeconds.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    workflowStepTotal.reset()
    workflowStepDurationSeconds.reset()
  })

  it('runs pure snippet workflows without mcp-host or model injection', async () => {
    const { status, calls } = makeStatus()
    const modelInjection = vi.fn()
    const mcpHost = makeMcpHost()
    const snippetRunner = makeSnippetRunner(async request => ({
      status: 'completed',
      output:
        request.stepId === 'seed'
          ? { value: 'abc' }
          : { rendered: `value=${JSON.stringify(request.previousOutputs)}` },
    }))

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [
          { id: 'seed', run: snippetRun() },
          { id: 'render', dependsOn: ['seed'], run: snippetRun() },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      snippetRunner: snippetRunner as never,
      modelInjection,
    })

    expect(result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    expect(mcpHost.healthCheck).not.toHaveBeenCalled()
    expect(modelInjection).not.toHaveBeenCalled()
    expect(snippetRunner.execute).toHaveBeenCalledTimes(2)
    expect(snippetRunner.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workflowName: 'runtime-test',
        stepId: 'render',
        previousOutputs: { seed: { value: 'abc' } },
      })
    )
    expect(calls.some(call => call.kind === 'step' && call.args[2]?.executor === 'snippet')).toBe(
      true
    )

    const metrics = await registry.metrics()
    expectMetricLine(
      metrics,
      'workflow_step_total',
      { executor: 'snippet', stepKind: 'snippet.typescript', status: 'succeeded' },
      2
    )
  })

  it('fails the workflow when a completed step status cannot be persisted', async () => {
    const { status } = makeStatus()
    const statusMock = status as unknown as {
      reportStepStatus: ReturnType<typeof vi.fn>
      reportWorkflowStatus: ReturnType<typeof vi.fn>
    }
    statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      if (stepId === 'emit' && phase === 'completed') {
        throw new Error('WRC rejected step status with HTTP 500')
      }
    })
    const snippetRunner = makeSnippetRunner(async () => ({
      status: 'completed',
      output: { ok: true },
    }))

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [{ id: 'emit', run: snippetRun() }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost: null,
      snippetRunner: snippetRunner as never,
      modelInjection: vi.fn(),
    })

    expect(result.workflowPhase).toBe('failed')
    expect(result.failureReason).toContain('WRC rejected step status')
    expect(statusMock.reportWorkflowStatus).toHaveBeenLastCalledWith('failed', {
      failureReason: expect.stringContaining('WRC rejected step status'),
    })
    expect(statusMock.reportWorkflowStatus).not.toHaveBeenCalledWith('completed', expect.anything())
  })

  it('runs hybrid snippet and agentic workflows through the right executors', async () => {
    const { status, calls } = makeStatus()
    const modelInjection = vi.fn()
    const mcpHost = makeMcpHost('agent-output')
    const snippetRunner = makeSnippetRunner(async request => ({
      status: 'completed',
      output: { stepId: request.stepId },
    }))
    const config = runtimeConfig()

    const result = await runWorkflowRuntime({
      config,
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'openai', model: 'gpt-4o' },
        steps: [
          { id: 'prep', run: snippetRun() },
          { id: 'agent', instruction: 'Summarize prep output', dependsOn: ['prep'] },
          { id: 'finalize', run: snippetRun(), dependsOn: ['agent'] },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      snippetRunner: snippetRunner as never,
      modelInjection,
    })

    expect(result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    expect(mcpHost.healthCheck).toHaveBeenCalled()
    expect(modelInjection).toHaveBeenCalledWith(
      'http://wrc.test',
      'runtime-test',
      config.tokenProvider,
      expect.objectContaining({ stepId: 'agent', provider: 'openai', model: 'gpt-4o' })
    )
    expect(snippetRunner.execute).toHaveBeenCalledTimes(2)
    expect(
      calls.some(
        call =>
          call.kind === 'step' && call.args[0] === 'agent' && call.args[2]?.executor === 'agentic'
      )
    ).toBe(true)
    expect(
      calls.some(
        call =>
          call.kind === 'step' &&
          call.args[0] === 'finalize' &&
          call.args[2]?.executor === 'snippet'
      )
    ).toBe(true)
  })

  it('binds approval-gated agentic steps with an ephemeral proof and persisted hash', async () => {
    const { status } = makeStatus()
    const statusMock = status as unknown as {
      reportStepStatus: ReturnType<typeof vi.fn>
    }
    const executeAgentStep = vi.fn().mockResolvedValue({
      stepId: 'approve',
      status: 'completed',
      output: 'approved output',
      durationMs: 10,
      toolsCalled: [],
    })
    const mcpHost = {
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
      executeAgentStep,
    } as unknown as McpHostClient

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'openai', model: 'gpt-4o' },
        steps: [
          {
            id: 'approve',
            instruction: 'Perform the approved action',
            requiresApproval: {
              target: { userId: '11111111-1111-4111-8111-111111111111' },
              message: 'Approve this step?',
            },
          },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      snippetRunner: null,
      modelInjection: vi.fn(),
    })

    expect(result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    const request = executeAgentStep.mock.calls[0]?.[0] as { approvalBindingProof?: string }
    expect(request.approvalBindingProof).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    const runningCall = statusMock.reportStepStatus.mock.calls.find(
      ([stepId, phase]) => stepId === 'approve' && phase === 'running'
    )
    expect(runningCall?.[2]?.approvalBindingSha256).toBe(
      createHash('sha256').update(request.approvalBindingProof!).digest('hex')
    )
  })

  it('forwards agentic approval gates to mcp-host', async () => {
    const { status } = makeStatus()
    const mcpHost = makeMcpHost()
    const requiresApproval = {
      target: { userId: 'operator' },
      message: 'Approve?',
      timeoutSeconds: 60,
    }

    await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'agent', instruction: 'run', requiresApproval }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(mcpHost.executeAgentStep).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval })
    )
  })

  it('forwards explicit agentic tool choice to mcp-host', async () => {
    const { status } = makeStatus()
    const mcpHost = makeMcpHost()

    await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [
          {
            id: 'agent',
            instruction: 'run',
            allowedTools: { include: ['clerum__trigger_workflow'] },
            toolChoice: 'required',
          },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(mcpHost.executeAgentStep).toHaveBeenCalledWith(
      expect.objectContaining({ toolChoice: 'required' })
    )
  })

  it('does not retry provider output length failures as a new agentic step attempt', async () => {
    const { status } = makeStatus()
    const executeAgentStep = vi.fn().mockResolvedValue({
      stepId: 'agent',
      status: 'failed',
      error: 'provider_output_length_exceeded: provider stopped because output reached max tokens',
    })
    const mcpHost = {
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
      executeAgentStep,
    } as unknown as McpHostClient

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'agent', instruction: 'run', maxRetries: 3, backoffSeconds: 0 }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(result.workflowPhase).toBe('failed')
    expect(result.failureReason).toContain('provider_output_length_exceeded')
    expect(executeAgentStep).toHaveBeenCalledTimes(1)
  })

  it('still retries ordinary agentic failures with the configured retry policy', async () => {
    const { status } = makeStatus()
    const executeAgentStep = vi
      .fn()
      .mockResolvedValueOnce({ stepId: 'agent', status: 'failed', error: 'temporary provider 502' })
      .mockResolvedValueOnce({
        stepId: 'agent',
        status: 'completed',
        output: 'retry-ok',
        durationMs: 10,
      })
    const mcpHost = {
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
      executeAgentStep,
    } as unknown as McpHostClient

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'agent', instruction: 'run', maxRetries: 2, backoffSeconds: 0 }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(result.workflowPhase).toBe('completed')
    expect(executeAgentStep).toHaveBeenCalledTimes(2)
  })

  it('stamps workflow run id into agentic usage execution context', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_RUN_ID', '00000000-0000-4000-8000-000000000001')
    vi.stubEnv('CLERUM_WORKFLOW_TEAM_ID', '22222222-2222-4222-8222-222222222222')
    vi.stubEnv('CLERUM_WORKFLOW_USER_ID', '33333333-3333-4333-8333-333333333333')
    const { status } = makeStatus({
      workflowPhase: 'pending',
      startedAt: '2026-05-09T00:00:00.000Z',
      steps: [],
    })
    const mcpHost = makeMcpHost()

    await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'agent', instruction: 'run' }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost,
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(mcpHost.executeAgentStep).toHaveBeenCalledWith(
      expect.objectContaining({
        contextVars: expect.objectContaining({
          workflowExecutionId:
            '00000000-0000-4000-8000-000000000001:runtime-test:2026-05-09T00:00:00.000Z',
          workflowTeamId: '22222222-2222-4222-8222-222222222222',
          workflowUserId: '33333333-3333-4333-8333-333333333333',
        }),
      })
    )
  })

  it('fails closed for agentic workflow usage when the parent run id is absent', async () => {
    vi.unstubAllEnvs()
    const { status } = makeStatus()
    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'agent', instruction: 'run' }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      mcpHost: makeMcpHost(),
      modelInjection: vi.fn().mockResolvedValue(undefined),
      waitForMcpHost: false,
    })

    expect(result.workflowPhase).toBe('failed')
    expect(result.failureReason).toContain('CLERUM_WORKFLOW_RUN_ID')
  })

  it('requires a snippet runner for snippet steps', async () => {
    const { status } = makeStatus()

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [{ id: 'emit', run: snippetRun() }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      snippetRunner: null,
      mcpHost: null,
    })

    expect(result.workflowPhase).toBe('failed')
    expect(result.failureReason).toContain('snippet runner endpoint and token are required')
  })

  it('merges snippet artifacts into step output', async () => {
    const { status, calls } = makeStatus()
    const snippetRunner = makeSnippetRunner(async () => ({
      status: 'completed',
      output: { ok: true },
      artifacts: [
        {
          name: 'result.json',
          format: 'json',
          sizeBytes: 17,
          path: '/output/result.json',
          createdAt: '2026-05-08T00:00:00.000Z',
        },
      ],
    }))

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [{ id: 'emit', run: snippetRun() }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      snippetRunner: snippetRunner as never,
      mcpHost: null,
    })

    expect(result.workflowPhase).toBe('completed')
    const completed = calls.find(
      call => call.kind === 'step' && call.args[0] === 'emit' && call.args[1] === 'completed'
    )
    expect(JSON.parse(completed?.args[2]?.output as string)).toEqual({
      ok: true,
      artifacts: [
        {
          name: 'result.json',
          format: 'json',
          sizeBytes: 17,
          path: '/output/result.json',
          createdAt: '2026-05-08T00:00:00.000Z',
        },
      ],
    })
  })

  it('retries snippet steps with the configured retry policy', async () => {
    const { status } = makeStatus()
    const snippetRunner = makeSnippetRunner(
      vi
        .fn()
        .mockResolvedValueOnce({ status: 'failed', error: 'temporary failure' })
        .mockResolvedValueOnce({ status: 'completed', output: 'retry-ok' })
    )

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [{ id: 'retry', run: snippetRun(), maxRetries: 2, backoffSeconds: 0 }],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      snippetRunner: snippetRunner as never,
      mcpHost: null,
    })

    expect(result.workflowPhase).toBe('completed')
    expect(snippetRunner.execute).toHaveBeenCalledTimes(2)
  })

  it('fails and skips downstream steps when a snippet fails', async () => {
    const { status } = makeStatus()
    const snippetRunner = makeSnippetRunner(async request =>
      request.stepId === 'bad'
        ? { status: 'failed', error: 'bad snippet' }
        : { status: 'completed', output: 'ok' }
    )

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [
          { id: 'bad', run: snippetRun() },
          { id: 'after', dependsOn: ['bad'], run: snippetRun() },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      snippetRunner: snippetRunner as never,
      mcpHost: null,
    })

    expect(result.workflowPhase).toBe('failed')
    expect(result.failureReason).toContain('bad snippet')
    expect(status.reportStepStatus).toHaveBeenCalledWith('after', 'skipped')
  })

  it('does not rerun completed steps during resume', async () => {
    const { status } = makeStatus({
      workflowPhase: 'running',
      steps: [{ id: 'seed', phase: 'completed', output: '{"value":"cached"}' }],
    })
    const snippetRunner = makeSnippetRunner(async request => ({
      status: 'completed',
      output: { previous: request.previousOutputs },
    }))

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [
          { id: 'seed', run: snippetRun() },
          { id: 'after', dependsOn: ['seed'], run: snippetRun() },
        ],
      },
      coordinator: new StepCoordinator(),
      status,
      signals: makeSignals(),
      snippetRunner: snippetRunner as never,
      mcpHost: null,
    })

    expect(result.workflowPhase).toBe('completed')
    expect(snippetRunner.execute).toHaveBeenCalledTimes(1)
    expect(snippetRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'after',
        previousOutputs: { seed: '{"value":"cached"}' },
      })
    )
  })
})

// ─── Run-store wait at running boundaries (C13 spec §4.3) ───────────────────

describe('sdk workflow runtime: run store unavailable at a running boundary', () => {
  const STORE_MESSAGE = 'Failed to report step status after 3 attempts: HTTP 503'
  const WAIT_LINE = 'Workflow run state unavailable at a running boundary; waiting before retry'
  const BOUND_LINE = 'Workflow run state unavailable beyond the wait bound'

  type Harness = {
    status: StatusReporter
    statusMock: {
      getWorkflowStatus: ReturnType<typeof vi.fn>
      reportWorkflowStatus: ReturnType<typeof vi.fn>
      reportStepStatus: ReturnType<typeof vi.fn>
    }
    signals: SignalPoller
    order: string[]
    snippetRunner: ReturnType<typeof makeSnippetRunner>
    state: { cancel: boolean }
  }

  function harness(snapshot = { workflowPhase: 'pending', steps: [] as unknown[] }): Harness {
    const order: string[] = []
    const state = { cancel: false }
    const statusMock = {
      getWorkflowStatus: vi.fn().mockResolvedValue(snapshot),
      reportWorkflowStatus: vi.fn().mockImplementation(async (phase: string) => {
        order.push(`workflow:${phase}`)
      }),
      reportStepStatus: vi.fn().mockImplementation(async (stepId: string, phase: string) => {
        order.push(`step:${stepId}:${phase}`)
      }),
    }
    const signals = {
      pollSignals: vi.fn().mockReturnValue(vi.fn()),
      hasSignal: vi.fn((signal: string) => signal === 'cancel' && state.cancel),
    }
    const snippetRunner = makeSnippetRunner(async () => {
      order.push('snippet')
      return { status: 'completed', output: { ok: true } }
    })
    return {
      status: statusMock as unknown as StatusReporter,
      statusMock,
      signals: signals as unknown as SignalPoller,
      order,
      snippetRunner,
      state,
    }
  }

  function run(h: Harness, overrides: { signalPollIntervalMs?: number; runStateWaitMs?: number }) {
    return runWorkflowRuntime({
      config: { ...runtimeConfig(), signalPollIntervalMs: overrides.signalPollIntervalMs ?? 1 },
      spec: {
        name: 'runtime-test',
        namespace: 'sandbox-recipes',
        steps: [{ id: 'emit', run: snippetRun() }],
      },
      coordinator: new StepCoordinator(),
      status: h.status,
      signals: h.signals,
      mcpHost: null,
      snippetRunner: h.snippetRunner as never,
      modelInjection: vi.fn(),
      ...(overrides.runStateWaitMs === undefined
        ? {}
        : { runStateWaitMs: overrides.runStateWaitMs }),
    })
  }

  async function withDeadline<T>(promise: Promise<T>, ms = 5_000): Promise<T | 'deadline'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<'deadline'>(resolve => {
          timer = setTimeout(() => resolve('deadline'), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  function runtimeLogLines(write: ReturnType<typeof vi.spyOn>, message: string): unknown[] {
    return write.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes(`"message":"${message}"`))
      .map(line => JSON.parse(line))
  }

  function storeUnavailable(): WorkflowRunStateUnavailableError {
    return new WorkflowRunStateUnavailableError(STORE_MESSAGE)
  }

  it('T-4f: waits and retries the step running report, then runs the step once', async () => {
    const h = harness()
    let runningCalls = 0
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase === 'running') {
        runningCalls += 1
        if (runningCalls <= 2) throw storeUnavailable()
      }
    })

    const result = await run(h, {})

    expect(result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    expect(h.order).toEqual([
      'workflow:running',
      'step:emit:running',
      'step:emit:running',
      'step:emit:running',
      'snippet',
      'step:emit:completed',
      'workflow:completed',
    ])
    expect(h.snippetRunner.execute).toHaveBeenCalledOnce()
    expect(h.statusMock.reportWorkflowStatus).not.toHaveBeenCalledWith('failed', expect.anything())
    // Only readCurrentStatus read the status: the store wait never consults it.
    expect(h.statusMock.getWorkflowStatus).toHaveBeenCalledOnce()
  })

  it('T-4g: waits at the workflow-level boundary of a run still initializing', async () => {
    const h = harness({ workflowPhase: 'initializing', steps: [] })
    let workflowRunningCalls = 0
    h.statusMock.reportWorkflowStatus.mockImplementation(async (phase: string) => {
      h.order.push(`workflow:${phase}`)
      if (phase === 'running') {
        workflowRunningCalls += 1
        if (workflowRunningCalls === 1) throw storeUnavailable()
      }
    })

    const runtime = run(h, {})
    try {
      const outcome = await withDeadline(runtime)
      expect(outcome).toEqual({ exitCode: 0, workflowPhase: 'completed' })
      expect(workflowRunningCalls).toBe(2)
    } finally {
      h.state.cancel = true
      await withDeadline(runtime)
    }
  })

  it('T-4h: honours cancel while waiting for the run store', async () => {
    const h = harness()
    let runningCalls = 0
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase !== 'running') return
      runningCalls += 1
      if (h.state.cancel && runningCalls > 50) throw new Error('stop the mutated wait loop')
      // The cancel arrives after the first wait.
      if (runningCalls === 2) h.state.cancel = true
      throw storeUnavailable()
    })

    const runtime = run(h, {})
    try {
      const outcome = await withDeadline(runtime)
      expect(outcome).toEqual({ exitCode: 1, workflowPhase: 'cancelled' })
      expect(runningCalls).toBeGreaterThanOrEqual(1)
      expect(
        h.statusMock.reportWorkflowStatus.mock.calls.filter(c => c[0] === 'cancelled')
      ).toHaveLength(1)
      expect(h.snippetRunner.execute).not.toHaveBeenCalled()
    } finally {
      runningCalls = 1_000
      await withDeadline(runtime)
    }
  })

  it('T-4i: fails the run on a plain Error from the step running report, as before', async () => {
    const h = harness()
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase === 'running')
        throw new Error('Failed to report step status after 3 attempts: HTTP 500')
    })

    const runtime = run(h, {})
    try {
      const outcome = await withDeadline(runtime)
      expect(outcome).toMatchObject({ exitCode: 1, workflowPhase: 'failed' })
      expect(h.statusMock.reportStepStatus.mock.calls.filter(c => c[1] === 'running')).toHaveLength(
        1
      )
      expect(h.statusMock.reportWorkflowStatus).toHaveBeenCalledWith('failed', {
        failureReason: 'Failed to report step status after 3 attempts: HTTP 500',
      })
      expect(h.snippetRunner.execute).not.toHaveBeenCalled()
    } finally {
      h.state.cancel = true
      await withDeadline(runtime)
    }
  })

  it('T-4k: fails the run once the consecutive wait passes runStateWaitMs', async () => {
    const write = vi.spyOn(process.stdout, 'write')
    const h = harness()
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase === 'running') throw storeUnavailable()
    })

    const runtime = run(h, { runStateWaitMs: 600 })
    try {
      const outcome = await withDeadline(runtime)
      expect(outcome).toEqual({
        exitCode: 1,
        workflowPhase: 'failed',
        failureReason: STORE_MESSAGE,
      })
      expect(
        h.statusMock.reportStepStatus.mock.calls.filter(c => c[1] === 'running').length
      ).toBeGreaterThanOrEqual(2)
      expect(runtimeLogLines(write, BOUND_LINE)).toEqual([
        expect.objectContaining({
          level: 'error',
          context: { boundary: 'emit', waitedMs: expect.any(Number) },
        }),
      ])
      expect(runtimeLogLines(write, WAIT_LINE).length).toBeGreaterThanOrEqual(1)
      expect(h.snippetRunner.execute).not.toHaveBeenCalled()
    } finally {
      h.state.cancel = true
      await withDeadline(runtime)
      write.mockRestore()
    }
  })

  it('T-4l: a 423 between two store outages starts a new wait window', async () => {
    const h = harness()
    const startedAt = Date.now()
    h.statusMock.getWorkflowStatus.mockImplementation(async () =>
      h.statusMock.getWorkflowStatus.mock.calls.length === 1
        ? { workflowPhase: 'pending', steps: [] }
        : {
            workflowPhase: Date.now() - startedAt < 800 ? 'authorization_paused' : 'running',
            steps: [],
          }
    )
    const answers: Array<() => void> = [
      () => {
        throw storeUnavailable()
      },
      () => {
        throw new WorkflowAuthorizationPausedError()
      },
      () => {
        throw storeUnavailable()
      },
      () => undefined,
    ]
    let runningCalls = 0
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase !== 'running') return
      runningCalls += 1
      const answer = answers[runningCalls - 1]
      if (!answer) throw new Error(`unexpected running report ${runningCalls}`)
      answer()
    })

    const runtime = run(h, { runStateWaitMs: 600 })
    try {
      const outcome = await withDeadline(runtime)
      expect(outcome).toEqual({ exitCode: 0, workflowPhase: 'completed' })
      expect(runningCalls).toBe(4)
      expect(h.order.slice(h.order.lastIndexOf('step:emit:running'))).toEqual([
        'step:emit:running',
        'snippet',
        'step:emit:completed',
        'workflow:completed',
      ])
      expect(h.snippetRunner.execute).toHaveBeenCalledOnce()
    } finally {
      h.state.cancel = true
      await withDeadline(runtime)
    }
  })

  it('T-4m: the production bound is 150 000 ms of consecutive unavailability', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const h = harness()
    h.statusMock.reportStepStatus.mockImplementation(async (stepId: string, phase: string) => {
      h.order.push(`step:${stepId}:${phase}`)
      if (phase === 'running') throw storeUnavailable()
    })
    let settled: unknown = 'pending'
    const runtime = run(h, { signalPollIntervalMs: 5_000 }).then(result => {
      settled = result
      return result
    })
    try {
      await vi.advanceTimersByTimeAsync(149_000)
      expect(settled).toBe('pending')
      expect(
        h.statusMock.reportStepStatus.mock.calls.filter(c => c[1] === 'running').length
      ).toBeGreaterThan(1)

      await vi.advanceTimersByTimeAsync(1_500)
      expect(settled).toEqual({
        exitCode: 1,
        workflowPhase: 'failed',
        failureReason: STORE_MESSAGE,
      })
    } finally {
      h.state.cancel = true
      await vi.advanceTimersByTimeAsync(10_000)
      await runtime
      write.mockRestore()
      vi.useRealTimers()
    }
  })
})
