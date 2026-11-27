import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { runWorkflowFromEnvironment, runWorkflowRuntime } from './sdkRuntime'
import { drainSignals } from './signalStore'
import type { AuthenticatedRequest } from './workflowAuth'

// Cancel reaches a running coordinator the way production delivers it: the
// processor's option queues the signal in the workflow-recipes signal store
// (deliverRunCancelSignal → enqueueSignal), the REST signal endpoint drains it
// (getSignals → drainSignals), and its JSON body is what the real SignalPoller
// fetches. The coordinator is the real StepCoordinator. In the `workflow runtime
// cancel` cases the status reporter and the snippet runner are fakes; the
// `runWorkflowFromEnvironment cancel` cases run the real clients over a stubbed
// fetch.

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

// The composition root builds its own poller, and only it hands the poller the
// run id from CLERUM_WORKFLOW_RUN_ID. These cases run runWorkflowFromEnvironment
// with the pod's environment and answer every request at the network boundary:
// the signal GET from the real REST endpoint, the WRC status GET and POSTs, and
// the snippet runner's health check and execute calls.

const OTHER_RUN_ID = '9f8e7d6c-5555-4666-8777-888899990000'
const ENV_WRC_URL = 'http://wrc.test'
const ENV_SNIPPET_RUNNER_URL = 'http://snippet-runner.test'
/** ConfigLoader's lowest accepted poll interval. */
const ENV_SIGNAL_POLL_MS = 500

interface StatusPostBody {
  workflowPhase?: string
  stepId?: string
  phase?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Writes the pod's mounted files and sets the environment the WRC pod receives. */
async function stubRuntimeEnvironment(dir: string, runId: string): Promise<void> {
  const wrcTokenFile = join(dir, 'wrc-token')
  const snippetRunnerTokenFile = join(dir, 'snippet-runner-token')
  const specFile = join(dir, 'config.json')
  await writeFile(wrcTokenFile, 'fixture-wrc-token')
  await writeFile(snippetRunnerTokenFile, 'fixture-snippet-runner-token')
  await writeFile(specFile, JSON.stringify(TWO_STEP_SPEC))
  vi.stubEnv('CLERUM_WORKFLOW_NAME', CHILD_RECIPE_NAME)
  vi.stubEnv('CLERUM_NAMESPACE', SANDBOX_NAMESPACE)
  vi.stubEnv('CLERUM_WRC_URL', ENV_WRC_URL)
  vi.stubEnv('WRC_TOKEN_FILE', wrcTokenFile)
  vi.stubEnv('CLERUM_SNIPPET_RUNNER_URL', ENV_SNIPPET_RUNNER_URL)
  vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', snippetRunnerTokenFile)
  vi.stubEnv('CLERUM_WORKFLOW_CONFIG_PATH', specFile)
  vi.stubEnv('CLERUM_SIGNAL_POLL_INTERVAL_MS', String(ENV_SIGNAL_POLL_MS))
  // ConfigLoader requires the correlation id to equal the run id.
  vi.stubEnv('CLERUM_WORKFLOW_RUN_ID', runId)
  vi.stubEnv('CLERUM_CORRELATION_ID', runId)
  // Snippet steps only: no mcp-host endpoint may leak in from the host.
  vi.stubEnv('CLERUM_MCPHOST_URL', undefined)
  vi.stubEnv('MCP_HOST_TOKEN_FILE', undefined)
}

/**
 * Answers the runtime's requests at the network boundary. `onExecute` runs
 * while the snippet runner holds the execute call of a step. Requests no route
 * matches are recorded in `unexpected` and answered 500: the health check,
 * the status read and the poller swallow errors, so a throw would go unseen.
 */
function serveRuntimeEnvironment(
  onExecute: (stepId: string, served: ServedPoll[]) => Promise<void> | void
) {
  const handlers = createWorkflowEndpointHandlers({} as k8s.CustomObjectsApi, SANDBOX_NAMESPACE)
  const wrcOrigin = new URL(ENV_WRC_URL).origin
  const snippetRunnerOrigin = new URL(ENV_SNIPPET_RUNNER_URL).origin
  const statusPath = `/api/v1/workflow/${CHILD_RECIPE_NAME}/status`
  const served: ServedPoll[] = []
  const statusPosts: string[] = []
  const executed: string[] = []
  const unexpected: string[] = []
  let executing = 'none'

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.origin === wrcOrigin) {
      const signalMatch = /^\/api\/v1\/workflow\/([^/]+)\/signals$/.exec(url.pathname)
      if (signalMatch && method === 'GET') {
        const recipeName = decodeURIComponent(signalMatch[1])
        const answer = await handlers.getSignals(recipeName, claimsFor(recipeName))
        const signals = (answer.body.signals ?? []) as Signal[]
        served.push({ requestIds: signals.map(signal => signal.requestId), context: executing })
        return jsonResponse(answer.body, answer.status)
      }
      if (url.pathname === statusPath && method === 'GET') {
        return jsonResponse({ workflowPhase: 'pending', steps: [] })
      }
      if (url.pathname === statusPath && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as StatusPostBody
        statusPosts.push(
          body.stepId ? `step:${body.stepId}:${body.phase}` : `workflow:${body.workflowPhase}`
        )
        return jsonResponse({})
      }
    }

    if (url.origin === snippetRunnerOrigin) {
      if (url.pathname === '/health' && method === 'GET') {
        return jsonResponse({ status: 'ok' })
      }
      if (url.pathname === '/api/v1/snippet/execute' && method === 'POST') {
        const { stepId } = JSON.parse(String(init?.body)) as { stepId: string }
        executed.push(stepId)
        executing = stepId
        await onExecute(stepId, served)
        executing = 'none'
        return jsonResponse({ stepId, status: 'completed', output: { step: stepId } })
      }
    }

    unexpected.push(`${method} ${url.href}`)
    return jsonResponse({ error: 'unexpected request' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { served, statusPosts, executed, unexpected }
}

/**
 * Resolves once a signal GET served `cancel:<RUN_ID>` and a later signal GET
 * was answered. The poller starts no GET while one is in progress
 * (`SignalPoller.polling`), so the later GET proves the poller finished
 * handling the response that carried the cancel, whether it queued or
 * dropped it.
 */
async function untilCancelServedAndHandled(served: ServedPoll[]): Promise<void> {
  await vi.waitFor(
    () => {
      const cancelPoll = served.findIndex(poll => poll.requestIds.includes(`cancel:${RUN_ID}`))
      expect(cancelPoll).toBeGreaterThanOrEqual(0)
      expect(served.length).toBeGreaterThan(cancelPoll + 1)
    },
    { timeout: 5_000, interval: 50 }
  )
}

describe('runWorkflowFromEnvironment cancel', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sdk-runtime-env-'))
    vi.mocked(publishWorkflowOutputsToGfs).mockClear()
    drainSignals(CHILD_RECIPE_NAME)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    drainSignals(CHILD_RECIPE_NAME)
    await rm(dir, { recursive: true, force: true })
  })

  it('runWorkflowFromEnvironment stops on the cancel of CLERUM_WORKFLOW_RUN_ID', async () => {
    await stubRuntimeEnvironment(dir, RUN_ID)
    const env = serveRuntimeEnvironment(async (stepId, served) => {
      if (stepId !== 'first') return
      deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
      await untilCancelServedAndHandled(served)
    })

    const result = await runWorkflowFromEnvironment()

    expect(
      env.served.some(
        poll => poll.context === 'first' && poll.requestIds.includes(`cancel:${RUN_ID}`)
      )
    ).toBe(true)
    expect(env.statusPosts).toContain('step:first:running')
    expect(env.statusPosts).toContain('step:first:completed')
    expect(env.statusPosts).not.toContain('step:second:running')
    expect(env.executed).toEqual(['first'])
    expect(env.statusPosts.at(-1)).toBe('workflow:cancelled')
    expect(publishWorkflowOutputsToGfs).not.toHaveBeenCalled()
    expect(env.unexpected).toEqual([])
    expect(result.workflowPhase).toBe('cancelled')
  })

  it('runWorkflowFromEnvironment runs past the cancel of another run', async () => {
    await stubRuntimeEnvironment(dir, OTHER_RUN_ID)
    const env = serveRuntimeEnvironment(async (stepId, served) => {
      if (stepId !== 'first') return
      deliverRunCancelSignal(CHILD_RECIPE_NAME, RUN_ID)
      await untilCancelServedAndHandled(served)
    })

    const result = await runWorkflowFromEnvironment()

    expect(
      env.served.some(
        poll => poll.context === 'first' && poll.requestIds.includes(`cancel:${RUN_ID}`)
      )
    ).toBe(true)
    expect(env.executed).toEqual(['first', 'second'])
    expect(env.statusPosts).toContain('step:second:completed')
    expect(env.statusPosts).not.toContain('workflow:cancelled')
    expect(env.statusPosts.at(-1)).toBe('workflow:completed')
    expect(publishWorkflowOutputsToGfs).toHaveBeenCalledOnce()
    expect(env.unexpected).toEqual([])
    expect(result.workflowPhase).toBe('completed')
  })
})
