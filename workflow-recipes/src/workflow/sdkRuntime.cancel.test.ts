import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type Signal,
  SignalPoller,
  StatusReporter,
  StepCoordinator,
  WorkflowAuthorizationPausedError,
  createStaticRuntimeTokenProvider,
} from '@clerum/workflow-runtime-core'
import { deliverRunCancelSignal } from '../k8sClient'
import { publishWorkflowOutputsToGfs } from './gfsOutputPublisher'
import { createWorkflowEndpointHandlers } from './restEndpoints'
import { runWorkflowRuntime } from './sdkRuntime'
import { drainSignals } from './signalStore'
import type { AuthenticatedRequest } from './workflowAuth'

// Cancel reaches a running coordinator the way production delivers it: the
// processor's option queues the signal in the workflow-recipes signal store
// (deliverRunCancelSignal → enqueueSignal), the REST signal endpoint drains it
// (getSignals → drainSignals), and its JSON body is what the real SignalPoller
// fetches. The coordinator is the real StepCoordinator; the status reporter and
// the snippet runner are fakes.

vi.mock('./gfsOutputPublisher', () => ({
  publishWorkflowOutputsToGfs: vi.fn().mockResolvedValue(undefined),
}))

const RUN_ID = '0a1b2c3d-1111-4222-8333-444455556666'
const CHILD_RECIPE_NAME = 'echo-0a1b2c3d'
const SANDBOX_NAMESPACE = 'sandbox-recipes'
const SIGNAL_POLL_MS = 10

function runtimeConfig() {
  return {
    workflowName: CHILD_RECIPE_NAME,
    namespace: SANDBOX_NAMESPACE,
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
    correlationId: 'corr-cancel',
    traceContext: {
      origin: 'workflow_runtime' as const,
      runId: null,
      correlationId: 'corr-cancel',
    },
    signalPollIntervalMs: SIGNAL_POLL_MS,
    restPort: 8090,
  }
}

function snippetRun() {
  return { type: 'snippet' as const, language: 'typescript' as const, code: 'return {}' }
}

const TWO_STEP_SPEC = {
  name: CHILD_RECIPE_NAME,
  namespace: SANDBOX_NAMESPACE,
  steps: [
    { id: 'first', run: snippetRun() },
    { id: 'second', dependsOn: ['first'], run: snippetRun() },
  ],
}

function claimsFor(recipeName: string): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    recipeName,
    recipeNamespace: SANDBOX_NAMESPACE,
    scopes: ['signal_read'],
  }
}

/** Each signal GET answered by the REST endpoint, with what it returned. */
interface ServedPoll {
  requestIds: string[]
  context: string
}

/**
 * Serves the runtime's signal GET from the real REST endpoint. `context`
 * names what the runtime was doing when the poll was answered.
 */
function serveSignalsFromRest(context: () => string) {
  const handlers = createWorkflowEndpointHandlers({} as k8s.CustomObjectsApi, SANDBOX_NAMESPACE)
  const served: ServedPoll[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const match = /^\/api\/v1\/workflow\/([^/]+)\/signals$/.exec(url.pathname)
    if (!match) throw new Error(`unexpected fetch ${url.pathname}`)
    const recipeName = decodeURIComponent(match[1])
    const answer = await handlers.getSignals(recipeName, claimsFor(recipeName))
    const signals = (answer.body.signals ?? []) as Signal[]
    served.push({ requestIds: signals.map(signal => signal.requestId), context: context() })
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { served }
}

function runtimePoller(): SignalPoller {
  return new SignalPoller({
    wrcUrl: 'http://wrc.test',
    workflowName: CHILD_RECIPE_NAME,
    tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'wrc-token' }),
    intervalMs: SIGNAL_POLL_MS,
    runId: RUN_ID,
  })
}

type StatusHook = (phase: string) => Promise<void> | void

function fakeStatus(
  hooks: {
    onWorkflowReport?: StatusHook
    readStatus?: (call: number) => Promise<Record<string, unknown>> | Record<string, unknown>
  } = {}
) {
  const reports: string[] = []
  let reads = 0
  const status = {
    getWorkflowStatus: vi.fn(async () => {
      reads += 1
      return hooks.readStatus
        ? await hooks.readStatus(reads)
        : { workflowPhase: 'pending', steps: [] }
    }),
    reportWorkflowStatus: vi.fn(async (phase: string) => {
      reports.push(`workflow:${phase}`)
      await hooks.onWorkflowReport?.(phase)
    }),
    reportStepStatus: vi.fn(async (stepId: string, phase: string) => {
      reports.push(`step:${stepId}:${phase}`)
    }),
  }
  return { status: status as unknown as StatusReporter, reports }
}

function fakeSnippetRunner(onStep: (stepId: string) => Promise<void> | void = () => undefined) {
  return {
    execute: vi.fn(async (request: Record<string, unknown>) => {
      await onStep(String(request.stepId))
      return { status: 'completed', output: { step: request.stepId } }
    }),
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
  }
}

async function untilCancelAccepted(poller: SignalPoller): Promise<void> {
  await vi.waitFor(() => expect(poller.hasSignal('cancel')).toBe(true), {
    timeout: 5_000,
    interval: SIGNAL_POLL_MS,
  })
}

describe('workflow runtime cancel', () => {
  beforeEach(() => {
    vi.stubEnv('CLERUM_WORKFLOW_RUN_ID', RUN_ID)
    vi.mocked(publishWorkflowOutputsToGfs).mockClear()
    drainSignals(CHILD_RECIPE_NAME)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    drainSignals(CHILD_RECIPE_NAME)
  })

  it('a cancel signal lets the running step finish and starts no further step', async () => {
    let executing = 'none'
    const { served } = serveSignalsFromRest(() => executing)
    const poller = runtimePoller()
    const { status, reports } = fakeStatus()
    const snippetRunner = fakeSnippetRunner(async stepId => {
      executing = stepId
      if (stepId === 'first') {
        deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
        await untilCancelAccepted(poller)
      }
      executing = 'none'
    })

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: TWO_STEP_SPEC,
      coordinator: new StepCoordinator(),
      status,
      signals: poller,
      snippetRunner: snippetRunner as never,
      waitForSnippetRunner: false,
    })

    expect(
      served.some(poll => poll.context === 'first' && poll.requestIds.includes(`cancel:${RUN_ID}`))
    ).toBe(true)
    expect(reports).toContain('step:first:completed')
    expect(reports).not.toContain('step:second:running')
    expect(snippetRunner.execute).toHaveBeenCalledOnce()
    expect(reports.at(-1)).toBe('workflow:cancelled')
    expect(result.workflowPhase).toBe('cancelled')
  })

  it('a paused coordinator reports cancelled when the signal arrives', async () => {
    let paused = false
    const { served } = serveSignalsFromRest(() => (paused ? 'paused' : 'not paused'))
    const poller = runtimePoller()
    const { status, reports } = fakeStatus({
      onWorkflowReport: phase => {
        if (phase === 'running') throw new WorkflowAuthorizationPausedError()
      },
      readStatus: call => {
        // Call 1 is the runtime's initial status read; later calls are the
        // pause wait. The cancel is queued once the coordinator is waiting.
        if (call === 1) return { workflowPhase: 'pending', steps: [] }
        if (call === 2) {
          paused = true
          deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
        }
        return { workflowPhase: 'authorization_paused', steps: [] }
      },
    })
    const snippetRunner = fakeSnippetRunner()

    const result = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: TWO_STEP_SPEC,
      coordinator: new StepCoordinator(),
      status,
      signals: poller,
      snippetRunner: snippetRunner as never,
      waitForSnippetRunner: false,
    })

    expect(status.getWorkflowStatus).toHaveBeenCalledTimes(2)
    expect(
      served.some(poll => poll.context === 'paused' && poll.requestIds.includes(`cancel:${RUN_ID}`))
    ).toBe(true)
    expect(reports).toEqual(['workflow:running', 'workflow:cancelled'])
    expect(snippetRunner.execute).not.toHaveBeenCalled()
    expect(result.workflowPhase).toBe('cancelled')
  })

  it('cancel during the last step ends cancelled; cancel after the completed report ends completed', async () => {
    // Cancel while the last step runs: no output is published.
    let executing = 'none'
    const duringLastStep = serveSignalsFromRest(() => executing)
    const lastStepPoller = runtimePoller()
    const lastStepStatus = fakeStatus()
    const lastStepRunner = fakeSnippetRunner(async stepId => {
      executing = stepId
      if (stepId === 'second') {
        deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
        await untilCancelAccepted(lastStepPoller)
      }
      executing = 'none'
    })

    const cancelled = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: TWO_STEP_SPEC,
      coordinator: new StepCoordinator(),
      status: lastStepStatus.status,
      signals: lastStepPoller,
      snippetRunner: lastStepRunner as never,
      waitForSnippetRunner: false,
    })

    expect(
      duringLastStep.served.some(
        poll => poll.context === 'second' && poll.requestIds.includes(`cancel:${RUN_ID}`)
      )
    ).toBe(true)
    expect(lastStepStatus.reports).toContain('step:second:completed')
    expect(publishWorkflowOutputsToGfs).not.toHaveBeenCalled()
    expect(lastStepStatus.reports.at(-1)).toBe('workflow:cancelled')
    expect(cancelled.workflowPhase).toBe('cancelled')

    // Cancel after the completed report was sent: the run stays completed.
    vi.unstubAllGlobals()
    drainSignals(CHILD_RECIPE_NAME)
    let reported = 'none'
    const afterCompleted = serveSignalsFromRest(() => reported)
    const completedPoller = runtimePoller()
    const completedStatus = fakeStatus({
      onWorkflowReport: async phase => {
        if (phase !== 'completed') return
        reported = 'completed'
        deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
        await untilCancelAccepted(completedPoller)
      },
    })

    const completed = await runWorkflowRuntime({
      config: runtimeConfig(),
      spec: TWO_STEP_SPEC,
      coordinator: new StepCoordinator(),
      status: completedStatus.status,
      signals: completedPoller,
      snippetRunner: fakeSnippetRunner() as never,
      waitForSnippetRunner: false,
    })

    expect(
      afterCompleted.served.some(
        poll => poll.context === 'completed' && poll.requestIds.includes(`cancel:${RUN_ID}`)
      )
    ).toBe(true)
    expect(completedPoller.hasSignal('cancel')).toBe(true)
    expect(publishWorkflowOutputsToGfs).toHaveBeenCalledOnce()
    expect(completedStatus.reports).not.toContain('workflow:cancelled')
    expect(completedStatus.reports.at(-1)).toBe('workflow:completed')
    expect(completed.workflowPhase).toBe('completed')
  })
})
