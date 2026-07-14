import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  McpHostClient,
  SignalPoller,
  StatusReporter,
  StepCoordinator,
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
