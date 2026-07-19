import { createHash, randomUUID } from 'node:crypto'
import { type LlmProviderId, isLlmProviderId } from '@clerum/llm-providers'
import {
  type AgentStepResult,
  ConfigLoader,
  McpHostClient,
  SignalPoller,
  StatusReporter,
  type StepContext,
  StepCoordinator,
  type StepExecutor,
  type StepMcpServerRef,
  type StepSpec,
  type WorkflowConfig,
  type WorkflowPhase,
  type WorkflowRecipeSpec,
  computeBackoff,
  renderPrompt,
  requestModelInjection,
  withRetry,
} from '@clerum/workflow-runtime-core'
import { workflowStepDurationSeconds, workflowStepTotal } from '../metrics'
import { publishWorkflowOutputsToGfs } from './gfsOutputPublisher'
import { workflowStepNeedsMcpHost, workflowStepUsesSnippetRunner } from './runtimePlan'
import { SNIPPET_RUN_KEYS } from './snippetRunSchema'
import { SnippetRunnerClient } from './snippetRunnerClient'
import type { SnippetExecuteResponse } from './snippetTypes'

// NOTE: this type accepts every LlmProviderId (incl. `bedrock`), but the
// WorkflowRecipe CRD admission excludes `bedrock` from spec.agent.provider —
// the WRC configure transport is mono-credential and cannot deliver Bedrock's
// key pair (mirror of the enum comment in charts/.../workflowrecipe.yaml).
type AgentProvider = LlmProviderId

const DEFAULT_STEP_TIMEOUT_SECONDS = 300
const PROVIDER_OUTPUT_LENGTH_EXCEEDED = 'provider_output_length_exceeded'
const MCP_HOST_NOT_READY = 'mcp_host not ready'

interface RuntimeAgentSpec {
  provider: AgentProvider
  model: string
  soul?: string
}

interface ApprovalSpec {
  target: { userId?: string; teamId?: string }
  message: string
  timeoutSeconds?: number
}

interface RuntimeStepSpec extends Omit<StepSpec, 'agent' | 'mcpServers'> {
  agent?: Partial<RuntimeAgentSpec>
  mcpServers?: StepMcpServerRef[]
  allowedTools?: { include?: string[] }
  toolChoice?: 'auto' | 'none' | 'required'
  maxRetries?: number
  maxIterations?: number
  requiresApproval?: ApprovalSpec
}

interface RuntimeWorkflowSpec extends Omit<WorkflowRecipeSpec, 'steps' | 'agent'> {
  steps: RuntimeStepSpec[]
  agent?: RuntimeAgentSpec
  gfs?: {
    publishTargets?: Array<{ drive: string; target: string }>
  }
}

type UnknownObject = Record<string, unknown>
type RuntimeRunSpec = NonNullable<RuntimeStepSpec['run']>
type SnippetRuntimeRunSpec = Extract<RuntimeRunSpec, { type: 'snippet' }>
type SnippetRuntimeStepSpec = RuntimeStepSpec & { run: SnippetRuntimeRunSpec }

interface RuntimeStatusSnapshot {
  workflowPhase: string
  steps: Array<{ id: string; phase: string; output?: unknown; modelUsed?: string }>
  startedAt?: string
}

export interface RuntimeDependencies {
  config: WorkflowConfig
  spec: RuntimeWorkflowSpec
  coordinator: StepCoordinator
  status: StatusReporter
  signals: SignalPoller
  mcpHost?: McpHostClient | null
  snippetRunner?: SnippetRunnerClient | null
  modelInjection?: typeof requestModelInjection
  waitForMcpHost?: boolean
  mcpHostReadyAttempts?: number
  mcpHostReadyDelayMs?: number
}

export interface RuntimeResult {
  exitCode: number
  workflowPhase: WorkflowPhase
  failureReason?: string
}

class StepRuntimeError extends Error {
  constructor(
    readonly stepId: string,
    message: string
  ) {
    super(message)
  }
}

class McpHostReadinessTimeoutError extends Error {
  constructor() {
    super(MCP_HOST_NOT_READY)
  }
}

export async function runWorkflowFromEnvironment(): Promise<RuntimeResult> {
  const loader = new ConfigLoader()
  const config = loader.getConfig()
  const spec = parseRuntimeWorkflowSpec(await loader.getSpec())
  const coordinator = new StepCoordinator()
  const signals = new SignalPoller({
    wrcUrl: config.wrcUrl,
    workflowName: config.workflowName,
    tokenProvider: config.tokenProvider,
    intervalMs: config.signalPollIntervalMs,
  })
  const status = new StatusReporter({
    wrcUrl: config.wrcUrl,
    workflowName: config.workflowName,
    tokenProvider: config.tokenProvider,
  })
  const mcpHost =
    config.mcpHostUrl && config.tokenProvider.getMcpHostToken
      ? new McpHostClient(config.mcpHostUrl, config.tokenProvider)
      : null
  const snippetRunner =
    config.snippetRunnerUrl && config.tokenProvider.getSnippetRunnerToken
      ? new SnippetRunnerClient(config.snippetRunnerUrl, config.tokenProvider)
      : null

  return runWorkflowRuntime({
    config,
    spec,
    coordinator,
    status,
    signals,
    mcpHost,
    snippetRunner,
    modelInjection: requestModelInjection,
  })
}

export async function runWorkflowRuntime(deps: RuntimeDependencies): Promise<RuntimeResult> {
  const {
    config,
    spec,
    coordinator,
    status,
    signals,
    mcpHost,
    snippetRunner,
    modelInjection = requestModelInjection,
  } = deps

  const stopPolling = signals.pollSignals(signal => coordinator.injectSignal(signal))
  const coordinatorSpec = toCoordinatorWorkflowSpec(spec)
  const runtimeStepsById = new Map(spec.steps.map(step => [step.id, step]))
  const orderedSteps = coordinator.resolveOrder(coordinatorSpec.steps)
  const customCoordinator =
    typeof spec.coordinatorImage === 'string' && spec.coordinatorImage.trim() !== ''
  const needsMcpHost = orderedSteps.some(step =>
    workflowStepNeedsMcpHost(runtimeStepsById.get(step.id) ?? step, {
      customCoordinator,
      hasWorkflowAgent: Boolean(spec.agent),
    })
  )
  const needsSnippetRunner = spec.steps.some(step => workflowStepUsesSnippetRunner(step))

  try {
    if (needsMcpHost) {
      if (!mcpHost) {
        throw new Error('mcp_host endpoint and token are required for agentic workflow steps')
      }
      if (deps.waitForMcpHost !== false) {
        await waitForMcpHostReady(
          mcpHost,
          deps.mcpHostReadyAttempts ?? 120,
          deps.mcpHostReadyDelayMs ?? 2000
        )
      }
    }
    if (needsSnippetRunner && !snippetRunner) {
      throw new Error('snippet runner endpoint and token are required for snippet workflow steps')
    }

    const currentStatus = await readCurrentStatus(status)
    const completedStepIds = new Set(
      (currentStatus.steps ?? []).filter(step => step.phase === 'completed').map(step => step.id)
    )
    const initialOutputs = Object.fromEntries(
      (currentStatus.steps ?? [])
        .filter(step => step.phase === 'completed' && step.output !== undefined)
        .map(step => [step.id, step.output])
    )

    if (orderedSteps.every(step => completedStepIds.has(step.id))) {
      await status.reportWorkflowStatus('completed', { completedAt: new Date().toISOString() })
      return { exitCode: 0, workflowPhase: 'completed' }
    }

    await status.reportWorkflowStatus('running')

    let currentAgent = resolveLastCompletedAgent(orderedSteps, currentStatus, spec.agent)
    let needsInitialModelInjection = true
    const workflowStartedAt = currentStatus.startedAt ?? new Date().toISOString()
    const workflowRunId = process.env.CLERUM_WORKFLOW_RUN_ID?.trim()
    if (needsMcpHost && !workflowRunId) {
      throw new Error('CLERUM_WORKFLOW_RUN_ID is required for agentic workflow usage attribution')
    }
    const workflowTeamId = process.env.CLERUM_WORKFLOW_TEAM_ID?.trim()
    const workflowUserId = process.env.CLERUM_WORKFLOW_USER_ID?.trim()
    const workflowExecutionId = workflowRunId
      ? `${workflowRunId}:${config.workflowName}:${workflowStartedAt}`
      : ''

    const executor: StepExecutor = async (step, context) => {
      const runtimeStep = runtimeStepsById.get(step.id)
      if (!runtimeStep) throw new StepRuntimeError(step.id, 'runtime-step-not-found')
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      const executorKind = resolveExecutorKind(runtimeStep)
      const approvalBindingProof = runtimeStep.requiresApproval ? randomUUID() : undefined
      await status.reportStepStatus(runtimeStep.id, 'running', {
        executor: executorKind,
        startedAt,
        ...(approvalBindingProof
          ? {
              approvalBindingSha256: createHash('sha256')
                .update(approvalBindingProof)
                .digest('hex'),
            }
          : {}),
      })

      try {
        if (isSnippetRuntimeStep(runtimeStep)) {
          const output = await executeSnippetStepWithRetry(
            runtimeStep,
            context,
            spec,
            config,
            snippetRunner!
          )
          await status.reportStepStatus(runtimeStep.id, 'completed', {
            output: stringifyOutput(output),
            executor: 'snippet',
            durationMs: Date.now() - startedMs,
            completedAt: new Date().toISOString(),
          })
          recordStepMetrics(runtimeStep, 'succeeded', Date.now() - startedMs)
          return output
        }

        const stepAgent = resolveStepAgent(runtimeStep, spec.agent, currentAgent)
        if (!stepAgent) {
          throw new Error('agent-config-missing')
        }

        if (
          needsInitialModelInjection ||
          !currentAgent ||
          stepAgent.provider !== currentAgent.provider ||
          stepAgent.model !== currentAgent.model
        ) {
          await modelInjection(config.wrcUrl, config.workflowName, config.tokenProvider, {
            stepId: runtimeStep.id,
            provider: stepAgent.provider,
            model: stepAgent.model,
          })
          currentAgent = { provider: stepAgent.provider, model: stepAgent.model }
          needsInitialModelInjection = false
        }

        const instruction = renderPrompt(runtimeStep.instruction ?? '', {
          step,
          previousOutputs: context.previousOutputs,
          workflowName: config.workflowName,
        })
        const result = await executeAgenticStepWithRetry(
          mcpHost!,
          runtimeStep,
          instruction,
          {
            workflowExecutionId,
            ...(workflowTeamId ? { workflowTeamId } : {}),
            ...(workflowUserId ? { workflowUserId } : {}),
          },
          approvalBindingProof
        )

        await status.reportStepStatus(runtimeStep.id, 'completed', {
          output: result.output,
          executor: 'agentic',
          toolsCalled: result.toolsCalled,
          modelUsed: `${stepAgent.provider}/${stepAgent.model}`,
          durationMs: result.durationMs,
          completedAt: result.completedAt ?? new Date().toISOString(),
        })
        recordStepMetrics(runtimeStep, 'succeeded', Date.now() - startedMs)
        return result.output ?? ''
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        recordStepMetrics(runtimeStep, 'failed', Date.now() - startedMs)
        throw new StepRuntimeError(runtimeStep.id, message)
      }
    }

    const finalOutputs = await coordinator.runWorkflow(coordinatorSpec, executor, {
      initialOutputs,
      completedStepIds,
    })

    if (signals.hasSignal('cancel')) {
      await status.reportWorkflowStatus('cancelled')
      return { exitCode: 1, workflowPhase: 'cancelled' }
    }

    await publishWorkflowOutputsToGfs(spec, config, finalOutputs)
    await status.reportWorkflowStatus('completed', { completedAt: new Date().toISOString() })
    return { exitCode: 0, workflowPhase: 'completed' }
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err)
    const failedStepId = err instanceof StepRuntimeError ? err.stepId : undefined
    if (failedStepId) {
      await status.reportStepStatus(failedStepId, 'failed', {
        failureReason,
        completedAt: new Date().toISOString(),
      })
      await reportRemainingAsSkipped(orderedSteps, failedStepId, status)
    }
    if (err instanceof McpHostReadinessTimeoutError) {
      await status.reportWorkflowStatus('recovering', { failureReason })
      return { exitCode: 1, workflowPhase: 'recovering', failureReason }
    }
    await status.reportWorkflowStatus('failed', { failureReason })
    return { exitCode: 1, workflowPhase: 'failed', failureReason }
  } finally {
    stopPolling()
  }
}

async function executeSnippetStepWithRetry(
  step: SnippetRuntimeStepSpec,
  context: StepContext,
  spec: RuntimeWorkflowSpec,
  config: WorkflowConfig,
  snippetRunner: SnippetRunnerClient
): Promise<unknown> {
  return withRetry(
    async () => {
      const response = await snippetRunner.execute({
        workflowName: config.workflowName,
        stepId: step.id,
        inputs: spec.inputs,
        previousOutputs: context.previousOutputs,
        ...(step.timeoutSeconds !== undefined && { timeoutSeconds: step.timeoutSeconds }),
      })
      if (response.status === 'failed') {
        throw new Error(response.error ?? 'snippet-step-failed')
      }
      return mergeSnippetArtifactsIntoOutput(response)
    },
    {
      maxAttempts: step.maxRetries ?? step.retries ?? 1,
      backoffSeconds: step.backoffSeconds ?? 30,
    }
  )
}

function recordStepMetrics(
  step: RuntimeStepSpec,
  status: 'succeeded' | 'failed',
  durationMs: number
): void {
  const executor = resolveExecutorKind(step)
  const stepKind = isSnippetRun(step.run) ? 'snippet.typescript' : 'agentic'
  const labels = {
    executor,
    stepKind,
    status,
  }
  workflowStepTotal.inc(labels)
  workflowStepDurationSeconds.observe(labels, Math.max(0, durationMs) / 1000)
}

function resolveExecutorKind(step: RuntimeStepSpec): 'agentic' | 'snippet' {
  if (isSnippetRun(step.run)) return 'snippet'
  return 'agentic'
}

function isSnippetRun(run: RuntimeStepSpec['run'] | undefined): run is SnippetRuntimeRunSpec {
  return run?.type === 'snippet'
}

function isSnippetRuntimeStep(step: RuntimeStepSpec): step is SnippetRuntimeStepSpec {
  return isSnippetRun(step.run)
}

function mergeSnippetArtifactsIntoOutput(response: SnippetExecuteResponse): unknown {
  const artifacts = response.artifacts ?? []
  if (artifacts.length === 0) return response.output
  if (response.output && typeof response.output === 'object' && !Array.isArray(response.output)) {
    const output = response.output as Record<string, unknown>
    const existing = Array.isArray(output.artifacts) ? output.artifacts : []
    return { ...output, artifacts: [...existing, ...artifacts] }
  }
  return { value: response.output, artifacts }
}

function resolveStepTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_STEP_TIMEOUT_SECONDS
  return Math.max(1, Math.floor(value))
}

function resolveStepAgent(
  step: RuntimeStepSpec,
  defaultAgent: RuntimeAgentSpec | undefined,
  currentAgent: Pick<RuntimeAgentSpec, 'provider' | 'model'> | undefined
): RuntimeAgentSpec | undefined {
  const provider = step.agent?.provider ?? defaultAgent?.provider ?? currentAgent?.provider
  const model = step.agent?.model ?? defaultAgent?.model ?? currentAgent?.model
  if (!provider || !model) return undefined
  return { provider, model, ...(step.agent?.soul ? { soul: step.agent.soul } : {}) }
}

function resolveLastCompletedAgent(
  orderedSteps: StepSpec[],
  status: RuntimeStatusSnapshot,
  defaultAgent: RuntimeAgentSpec | undefined
): Pick<RuntimeAgentSpec, 'provider' | 'model'> | undefined {
  let current = defaultAgent
    ? { provider: defaultAgent.provider, model: defaultAgent.model }
    : undefined
  const statusByStep = new Map((status.steps ?? []).map(step => [step.id, step]))
  for (const step of orderedSteps) {
    const modelUsed = statusByStep.get(step.id)?.modelUsed
    if (!modelUsed) continue
    const [provider, model] = modelUsed.split('/')
    if (isAgentProvider(provider) && model) current = { provider, model }
  }
  return current
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProviderOutputLengthExceeded(error: string | undefined): boolean {
  return Boolean(error?.includes(PROVIDER_OUTPUT_LENGTH_EXCEEDED))
}

async function executeAgenticStepWithRetry(
  mcpHost: McpHostClient,
  step: RuntimeStepSpec,
  instruction: string,
  contextVars: Record<string, string>,
  approvalBindingProof?: string
): Promise<AgentStepResult> {
  const maxAttempts = step.maxRetries ?? step.retries ?? 2
  const backoffSeconds = step.backoffSeconds ?? 30
  if (maxAttempts < 1) {
    throw new Error(`agentic step retry policy for "${step.id}" must allow at least 1 attempt`)
  }

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await mcpHost.executeAgentStep({
        stepId: step.id,
        instruction,
        mcpServers: step.mcpServers ?? [],
        allowedTools: step.allowedTools ?? step.tools ?? {},
        toolChoice: step.toolChoice,
        maxIterations: step.maxIterations,
        timeoutSeconds: step.timeoutSeconds,
        contextVars,
        ...(approvalBindingProof ? { approvalBindingProof } : {}),
        ...(step.requiresApproval && { requiresApproval: step.requiresApproval }),
      })
      if (result.status === 'failed') {
        throw new Error(result.error ?? 'agentic-step-failed')
      }
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (isProviderOutputLengthExceeded(lastError.message)) {
        throw lastError
      }
      if (attempt < maxAttempts) {
        const delayMs = computeBackoff(backoffSeconds, attempt) * 1000
        if (delayMs > 0) await sleep(delayMs)
      }
    }
  }

  throw lastError ?? new Error('agentic-step-failed')
}

async function waitForMcpHostReady(
  client: McpHostClient,
  maxAttempts: number,
  delayMs: number
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const health = await client.healthCheck()
    if (health.status === 'healthy') return
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new McpHostReadinessTimeoutError()
}

async function readCurrentStatus(status: StatusReporter): Promise<RuntimeStatusSnapshot> {
  try {
    return await status.getWorkflowStatus()
  } catch {
    return { workflowPhase: 'pending', steps: [] }
  }
}

async function reportRemainingAsSkipped(
  orderedSteps: StepSpec[],
  failedStepId: string,
  status: StatusReporter
): Promise<void> {
  const failedIndex = orderedSteps.findIndex(step => step.id === failedStepId)
  if (failedIndex === -1) return
  for (const step of orderedSteps.slice(failedIndex + 1)) {
    await status.reportStepStatus(step.id, 'skipped')
  }
}

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function isAgentProvider(value: string): value is AgentProvider {
  return isLlmProviderId(value)
}

function parseRuntimeWorkflowSpec(spec: WorkflowRecipeSpec): RuntimeWorkflowSpec {
  const rawSpec = asObject(spec, 'workflow spec')
  const runtimeSpec: RuntimeWorkflowSpec = {
    ...spec,
    steps: spec.steps.map((step, index) => parseRuntimeStepSpec(step, `steps[${index}]`)),
  }
  const agent = parseAgentSpec(rawSpec.agent, 'agent', false)
  if (agent) runtimeSpec.agent = agent
  return runtimeSpec
}

function parseRuntimeStepSpec(step: StepSpec, path: string): RuntimeStepSpec {
  const rawStep = asObject(step, path)
  const runtimeStep: RuntimeStepSpec = {
    id: step.id,
    ...(step.instruction !== undefined && { instruction: step.instruction }),
    ...(step.dependsOn !== undefined && { dependsOn: step.dependsOn }),
    ...(step.timeoutSeconds !== undefined && {
      timeoutSeconds: readPositiveIntegerField(step.timeoutSeconds, `${path}.timeoutSeconds`),
    }),
    ...(step.retries !== undefined && {
      retries: readPositiveIntegerField(step.retries, `${path}.retries`),
    }),
    ...(step.backoffSeconds !== undefined && {
      backoffSeconds: readNonNegativeIntegerField(step.backoffSeconds, `${path}.backoffSeconds`),
    }),
    ...(step.tools !== undefined && { tools: step.tools }),
  }

  const maxRetries = rawStep.maxRetries
  if (maxRetries !== undefined) {
    runtimeStep.maxRetries = readPositiveIntegerField(maxRetries, `${path}.maxRetries`)
  }
  const maxIterations = rawStep.maxIterations
  if (maxIterations !== undefined) {
    runtimeStep.maxIterations = readPositiveIntegerField(maxIterations, `${path}.maxIterations`)
  }
  const allowedTools = parseAllowedTools(rawStep.allowedTools, `${path}.allowedTools`)
  if (allowedTools) runtimeStep.allowedTools = allowedTools
  const toolChoice = parseToolChoice(rawStep.toolChoice, `${path}.toolChoice`)
  if (toolChoice) runtimeStep.toolChoice = toolChoice
  const run = parseSnippetRun(rawStep.run, `${path}.run`)
  if (run) runtimeStep.run = run
  const mcpServers = parseMcpServers(rawStep.mcpServers, `${path}.mcpServers`)
  if (mcpServers) runtimeStep.mcpServers = mcpServers
  const agent = parseAgentSpec(rawStep.agent, `${path}.agent`, true)
  if (agent) runtimeStep.agent = agent
  const requiresApproval = parseApprovalSpec(rawStep.requiresApproval, `${path}.requiresApproval`)
  if (requiresApproval) runtimeStep.requiresApproval = requiresApproval

  return runtimeStep
}

function toCoordinatorWorkflowSpec(spec: RuntimeWorkflowSpec): WorkflowRecipeSpec {
  return {
    ...spec,
    ...(spec.agent && {
      agent: { provider: spec.agent.provider, model: spec.agent.model },
    }),
    steps: spec.steps.map(step => ({
      id: step.id,
      ...(step.instruction !== undefined && { instruction: step.instruction }),
      ...(step.dependsOn !== undefined && { dependsOn: step.dependsOn }),
      ...(step.timeoutSeconds !== undefined && { timeoutSeconds: step.timeoutSeconds }),
      ...(step.retries !== undefined && { retries: step.retries }),
      ...(step.backoffSeconds !== undefined && { backoffSeconds: step.backoffSeconds }),
      ...(step.tools !== undefined && { tools: step.tools }),
      ...(step.toolChoice !== undefined && { toolChoice: step.toolChoice }),
      ...(step.run !== undefined && { run: step.run }),
    })),
  }
}

function parseToolChoice(value: unknown, path: string): 'auto' | 'none' | 'required' | undefined {
  if (value === undefined) return undefined
  if (value === 'auto' || value === 'none' || value === 'required') return value
  throw new Error(`${path} must be one of: auto, none, required`)
}

function parseAllowedTools(value: unknown, path: string): { include?: string[] } | undefined {
  if (value === undefined) return undefined
  const raw = asObject(value, path)
  const include = raw.include
  if (include === undefined) return {}
  if (!Array.isArray(include) || include.some(item => typeof item !== 'string')) {
    throw new Error(`${path}.include must be an array of strings`)
  }
  return { include: [...include] }
}

function parseSnippetRun(value: unknown, path: string): SnippetRuntimeRunSpec | undefined {
  if (value === undefined) return undefined
  const raw = asObject(value, path)
  assertAllowedKeys(raw, SNIPPET_RUN_KEYS, path)
  if (raw.type !== 'snippet') {
    throw new Error(`${path}.type must be snippet`)
  }
  if (raw.language !== 'typescript') {
    throw new Error(`${path}.language must be typescript`)
  }
  if (typeof raw.code !== 'string' || raw.code.trim() === '') {
    throw new Error(`${path}.code must be a non-empty string`)
  }
  if (raw.capabilities !== undefined) {
    asObject(raw.capabilities, `${path}.capabilities`)
  }
  return {
    type: 'snippet',
    language: 'typescript',
    code: raw.code,
    ...(raw.capabilities !== undefined && {
      capabilities: raw.capabilities as SnippetRuntimeRunSpec['capabilities'],
    }),
  }
}

function parseMcpServers(value: unknown, path: string): StepMcpServerRef[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value.map((item, index) => parseMcpServerRef(item, `${path}[${index}]`))
}

function parseMcpServerRef(value: unknown, path: string): StepMcpServerRef {
  const raw = asObject(value, path)
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`${path}.name must be a non-empty string`)
  }
  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    throw new Error(`${path}.url must be a non-empty string`)
  }
  return { name: raw.name, url: raw.url }
}

function parseAgentSpec(
  value: unknown,
  path: string,
  allowPartial: true
): Partial<RuntimeAgentSpec> | undefined
function parseAgentSpec(
  value: unknown,
  path: string,
  allowPartial: false
): RuntimeAgentSpec | undefined
function parseAgentSpec(
  value: unknown,
  path: string,
  allowPartial: boolean
): Partial<RuntimeAgentSpec> | RuntimeAgentSpec | undefined {
  if (value === undefined) return undefined
  const raw = asObject(value, path)
  const provider = raw.provider
  const model = raw.model
  const soul = raw.soul
  if (provider !== undefined && (typeof provider !== 'string' || !isAgentProvider(provider))) {
    throw new Error(`${path}.provider must be a supported provider`)
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error(`${path}.model must be a non-empty string`)
  }
  if (soul !== undefined && (typeof soul !== 'string' || soul.trim() === '')) {
    throw new Error(`${path}.soul must be a non-empty string`)
  }
  if (!allowPartial && (!provider || !model)) {
    throw new Error(`${path} must include provider and model`)
  }
  return {
    ...(provider !== undefined && { provider: provider as AgentProvider }),
    ...(model !== undefined && { model }),
    ...(soul !== undefined && { soul }),
  }
}

function parseApprovalSpec(value: unknown, path: string): ApprovalSpec | undefined {
  if (value === undefined) return undefined
  const raw = asObject(value, path)
  const target = asObject(raw.target, `${path}.target`)
  if (target.userId !== undefined && typeof target.userId !== 'string') {
    throw new Error(`${path}.target.userId must be a string`)
  }
  if (target.teamId !== undefined && typeof target.teamId !== 'string') {
    throw new Error(`${path}.target.teamId must be a string`)
  }
  if (typeof raw.message !== 'string' || raw.message.trim() === '') {
    throw new Error(`${path}.message must be a non-empty string`)
  }
  const timeoutSeconds =
    raw.timeoutSeconds === undefined
      ? undefined
      : readPositiveIntegerField(raw.timeoutSeconds, `${path}.timeoutSeconds`)
  return {
    target: {
      ...(target.userId !== undefined && { userId: target.userId }),
      ...(target.teamId !== undefined && { teamId: target.teamId }),
    },
    message: raw.message,
    ...(timeoutSeconds !== undefined && { timeoutSeconds }),
  }
}

function asObject(value: unknown, path: string): UnknownObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as UnknownObject
}

function assertAllowedKeys(value: UnknownObject, allowedKeys: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${path} contains unsupported field "${key}"`)
    }
  }
}

function readPositiveIntegerField(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value
}

function readNonNegativeIntegerField(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`)
  }
  return value
}
