/**
 * WRC REST endpoints for workflow status reporting and management.
 */
import * as k8s from '@kubernetes/client-node'
import { loadConfig } from '../config'
import type {
  GovernedTraceReporter,
  WorkflowInfrastructureTelemetryProjection,
} from '../governedTraceReporter'
import { createLogger } from '../observability/logger'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants'
import { getErrorCode } from '../reconciler/k8sErrors'
import { JwtTokenFactory } from './jwtTokenFactory'
import { ModelConfigHandler } from './modelConfigHandler'
import {
  buildArtifactReaderUrl as buildWorkflowArtifactReaderUrl,
  buildMcpHostUrl as buildWorkflowMcpHostUrl,
} from './resourceNames'
import { drainSignals } from './signalStore'
import { buildStatusOutputPreview } from './statusOutputPreview'
import { handleTrigger } from './triggerHandler'
import { StepPhase, WorkflowPhase, isTerminalStepPhase, isTerminalWorkflowPhase } from './types'
import { type AuthenticatedRequest, CONTROL_API_ISSUER } from './workflowAuth'
import { workflowStatusMessage } from './workflowStatusMessage'

const log = createLogger('wrc', 'restEndpoints')
const MAX_ARTIFACT_NAME_LENGTH = 128
const MAX_ARTIFACT_FORMAT_LENGTH = 64
const MAX_ARTIFACT_PATH_LENGTH = 512
const MAX_ARTIFACT_CREATED_AT_LENGTH = 64
const MAX_CUSTOM_ARTIFACTS_PER_STEP = 20
const ARTIFACT_READER_NOT_FOUND_RETRY_DELAYS_MS = [250, 750, 1500, 3000, 5000, 8000]
const MODEL_INJECTION_REQUEST_SCOPE = 'model_injection_request'
const MAX_STATUS_TOOL_CALLS = 50
const STATUS_TOOL_ARGS_PREVIEW_LIMIT = 1024
const STATUS_TOOL_RESULT_PREVIEW_LIMIT = 1024
const WORKFLOW_RUN_ID_LABEL = 'clerum.io/workflow-run-id'

type WorkflowEndpointHandlerOptions = {
  traceReporter?: GovernedTraceReporter | null
}

type JsonPatchOperation = {
  op: 'add' | 'replace' | 'test'
  path: string
  value: unknown
}

const STEP_STATUS_PATCH_MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readUpstreamText(
  response: Response,
  context: Record<string, unknown>
): Promise<string> {
  try {
    return await response.text()
  } catch (err) {
    log.warn('Failed to read upstream response body', {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    })
    return ''
  }
}

function parseUpstreamJsonBody(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isArtifactGoneBody(body: Record<string, unknown> | null): boolean {
  return body?.error === 'artifact_gone' || body?.code === 'artifact_gone'
}

/** Build the in-cluster URL for a recipe's mcp-host pod. */
export function buildMcpHostUrl(recipeName: string, sandboxNamespace: string): string {
  return buildWorkflowMcpHostUrl(recipeName, sandboxNamespace)
}

/** Build the in-cluster URL for a recipe's platform-managed artifact reader pod. */
export function buildArtifactReaderUrl(recipeName: string, sandboxNamespace: string): string {
  return buildWorkflowArtifactReaderUrl(recipeName, sandboxNamespace)
}

function recipePhaseForWorkflowPhase(
  phase: WorkflowPhase,
  currentPhase?: unknown
): 'active' | 'deploying' | 'failed' {
  if (phase === 'running' || phase === 'completed') return 'active'
  // WorkflowRecipe has no cancelled phase yet; expose cancelled runs as terminal.
  if (phase === 'failed' || phase === 'cancelled') return 'failed'
  // A new run may briefly report pending/initializing/recovering; keep already-active
  // recipe infrastructure active so watchers do not see active -> deploying -> active churn.
  if (currentPhase === 'active') return 'active'
  return 'deploying'
}

function lifecycleTransitionTelemetryProjection(
  recipeName: string,
  claims: AuthenticatedRequest['tokenClaims'],
  transition: string,
  phase: string,
  recipe?: unknown,
  occurredAt = new Date().toISOString()
): WorkflowInfrastructureTelemetryProjection | undefined {
  const runId = workflowRunIdFromRecipe(recipe) ?? claims.runId?.trim()
  if (!runId) return undefined
  return {
    sourceEventId: `workflow-status:${claims.recipeNamespace}:${recipeName}:run:${runId}:${transition}:${phase}`,
    occurredAt,
    telemetryType: 'lifecycle_transition',
    runId,
    payload: {
      phase,
      status: 'patched',
      transition,
    },
  }
}

function enqueueInfrastructureTelemetryBestEffort(
  traceReporter: GovernedTraceReporter | null | undefined,
  projection: WorkflowInfrastructureTelemetryProjection | undefined
): void {
  if (!traceReporter || !projection) return
  try {
    traceReporter.enqueueInfrastructureTelemetry(projection)
  } catch (error) {
    log.warn('Infrastructure telemetry enqueue failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export {
  initializeControlApiPublicKey,
  initializePublicKey,
  verifyIncomingToken,
  type AuthenticatedRequest,
} from './workflowAuth'

function extractArtifactsFromStepStatus(body: StepStatusUpdate): ArtifactStatus[] {
  const artifacts: ArtifactStatus[] = []
  for (const tc of body.toolsCalled ?? []) {
    const parsed = parseUnknownArtifactResult(tc.result)
    if (parsed) artifacts.push(parsed)
  }

  artifacts.push(...extractCustomArtifacts(body.output))
  return artifacts
}

function parseUnknownArtifactResult(result: unknown): ArtifactStatus | null {
  try {
    const parsed = typeof result === 'object' ? result : JSON.parse(String(result ?? '{}'))
    if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.artifact)) return null
    return normalizeArtifact(parsed.artifact)
  } catch {
    return null
  }
}

function extractCustomArtifacts(output: unknown): ArtifactStatus[] {
  const parsedOutput = parseOutputRecord(output)
  if (!parsedOutput) return []

  const artifacts: ArtifactStatus[] = []
  if (isRecord(parsedOutput.artifact)) {
    const artifact = normalizeArtifact(parsedOutput.artifact)
    if (artifact) artifacts.push(artifact)
  }

  if (Array.isArray(parsedOutput.artifacts)) {
    for (const item of parsedOutput.artifacts.slice(0, MAX_CUSTOM_ARTIFACTS_PER_STEP)) {
      if (!isRecord(item)) continue
      const artifact = normalizeArtifact(item)
      if (artifact) artifacts.push(artifact)
    }
  }

  return artifacts
}

function parseOutputRecord(output: unknown): Record<string, unknown> | null {
  if (isRecord(output)) return output
  if (typeof output !== 'string') return null
  try {
    const parsed = JSON.parse(output)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeArtifact(value: Record<string, unknown>): ArtifactStatus | null {
  if (typeof value.name !== 'string') return null
  const name = value.name.trim()
  if (!name || name.length > MAX_ARTIFACT_NAME_LENGTH) return null
  if (/[/\\\x00]/.test(name) || name.includes('..')) return null

  if (typeof value.path !== 'string') return null
  const path = value.path.trim()
  if (!path.startsWith('/output/') || path.length > MAX_ARTIFACT_PATH_LENGTH) return null
  if (path.includes('\x00') || path.split('/').includes('..')) return null

  const format = typeof value.format === 'string' ? value.format.trim() : ''
  if (format.length > MAX_ARTIFACT_FORMAT_LENGTH) return null

  const sizeBytes = typeof value.sizeBytes === 'number' ? value.sizeBytes : 0
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null

  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt.length <= MAX_ARTIFACT_CREATED_AT_LENGTH
      ? value.createdAt
      : new Date().toISOString()

  return {
    name,
    format,
    sizeBytes,
    path,
    createdAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function incompleteStepsForWorkflowCompletion(recipe: unknown): string[] {
  if (!isRecord(recipe) || !isRecord(recipe.spec)) return []
  const declaredSteps = Array.isArray(recipe.spec.steps) ? recipe.spec.steps : []
  const declaredStepIds = declaredSteps
    .map(step => (isRecord(step) && typeof step.id === 'string' ? step.id : undefined))
    .filter((id): id is string => Boolean(id))

  if (declaredStepIds.length === 0) return []

  const status = isRecord(recipe.status) ? recipe.status : undefined
  const statusSteps = Array.isArray(status?.steps) ? status.steps : []
  const statusEntries: Array<[string, unknown]> = []
  for (const step of statusSteps) {
    if (isRecord(step) && typeof step.id === 'string') {
      statusEntries.push([step.id, step.phase])
    }
  }
  const statusById = new Map(statusEntries)

  return declaredStepIds.filter(id => {
    const phase = statusById.get(id)
    return phase !== 'completed' && phase !== 'skipped'
  })
}

function workflowRecipeNeedsMcpHost(recipe: unknown): boolean {
  if (!isRecord(recipe) || !isRecord(recipe.spec)) return false
  const steps = recipe.spec.steps
  if (!Array.isArray(steps)) return false
  return steps.some(step => {
    if (!isRecord(step)) return false
    if (typeof step.instruction === 'string' && step.instruction.trim()) return true
    if (isRecord(step.agent)) return true
    if (Array.isArray(step.mcpServers) && step.mcpServers.length > 0) return true
    if (step.requiresApproval === true) return true
    return false
  })
}

function listDeclaredArtifacts(recipe: unknown): ArtifactStatus[] {
  if (!isRecord(recipe) || !isRecord(recipe.status) || !Array.isArray(recipe.status.artifacts)) {
    return []
  }

  const artifacts: ArtifactStatus[] = []
  for (const artifact of recipe.status.artifacts) {
    if (!isRecord(artifact)) continue
    const name = typeof artifact.name === 'string' ? artifact.name : ''
    const path = typeof artifact.path === 'string' ? artifact.path : ''
    if (!name || !path) continue
    artifacts.push({
      name,
      path,
      format: typeof artifact.format === 'string' ? artifact.format : '',
      sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : 0,
      createdAt:
        typeof artifact.createdAt === 'string' ? artifact.createdAt : new Date(0).toISOString(),
    })
  }
  return artifacts
}

function findDeclaredArtifact(recipe: unknown, filename: string): ArtifactStatus | undefined {
  return listDeclaredArtifacts(recipe).find(artifact => artifact.name === filename)
}

function artifactUsesWorkflowOutput(artifact: ArtifactStatus | undefined): boolean {
  return typeof artifact?.path === 'string' && artifact.path.startsWith('/output/')
}

function recipeHasWorkflowOutputArtifacts(recipe: unknown): boolean {
  if (!isRecord(recipe) || !isRecord(recipe.status) || !Array.isArray(recipe.status.artifacts)) {
    return false
  }
  return recipe.status.artifacts.some(
    artifact =>
      isRecord(artifact) &&
      typeof artifact.path === 'string' &&
      artifact.path.startsWith('/output/')
  )
}

function workflowRunIdFromRecipe(recipe: unknown): string | undefined {
  if (!isRecord(recipe) || !isRecord(recipe.metadata) || !isRecord(recipe.metadata.labels)) {
    return undefined
  }
  const runId = recipe.metadata.labels[WORKFLOW_RUN_ID_LABEL]
  return typeof runId === 'string' && runId.trim() ? runId : undefined
}

function validateRunIdClaim(
  recipe: unknown,
  claims: AuthenticatedRequest['tokenClaims']
): { status: number; body: Record<string, unknown> } | undefined {
  if (!claims.runId) return undefined
  const recipeRunId = workflowRunIdFromRecipe(recipe)
  if (recipeRunId !== claims.runId) {
    return { status: 403, body: { error: 'Token runId mismatch' } }
  }
  return undefined
}

function resolveArtifactBackend(
  recipe: unknown,
  recipeName: string,
  sandboxNamespace: string,
  artifact?: ArtifactStatus
): { component: 'artifact-reader' | 'mcp-host'; url: string } {
  if (artifactUsesWorkflowOutput(artifact)) {
    return {
      component: 'artifact-reader',
      url: buildArtifactReaderUrl(recipeName, sandboxNamespace),
    }
  }
  if (!artifact && recipeHasWorkflowOutputArtifacts(recipe)) {
    return {
      component: 'artifact-reader',
      url: buildArtifactReaderUrl(recipeName, sandboxNamespace),
    }
  }
  if (workflowRecipeNeedsMcpHost(recipe)) {
    return { component: 'mcp-host', url: buildMcpHostUrl(recipeName, sandboxNamespace) }
  }
  return {
    component: 'artifact-reader',
    url: buildArtifactReaderUrl(recipeName, sandboxNamespace),
  }
}

function resolveBulkArtifactBackends(
  recipe: unknown,
  recipeName: string,
  sandboxNamespace: string
): Array<{ component: 'artifact-reader' | 'mcp-host'; url: string }> {
  const backends = new Map<string, { component: 'artifact-reader' | 'mcp-host'; url: string }>()
  const addBackend = (backend: { component: 'artifact-reader' | 'mcp-host'; url: string }) => {
    backends.set(`${backend.component}:${backend.url}`, backend)
  }

  const artifacts = listDeclaredArtifacts(recipe)
  if (artifacts.length === 0) {
    addBackend(resolveArtifactBackend(recipe, recipeName, sandboxNamespace))
  } else {
    for (const artifact of artifacts) {
      addBackend(resolveArtifactBackend(recipe, recipeName, sandboxNamespace, artifact))
    }
  }

  return Array.from(backends.values())
}

function stringifyStatusPreview(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeToolArgsForStatus(args: unknown): Record<string, unknown> | undefined {
  if (args === undefined) return undefined
  const serialized = stringifyStatusPreview(args)
  if (serialized.length > STATUS_TOOL_ARGS_PREVIEW_LIMIT) {
    return {
      truncated: true,
      preview: serialized.slice(0, STATUS_TOOL_ARGS_PREVIEW_LIMIT),
    }
  }
  if (isRecord(args)) return args
  return { value: args }
}

function normalizeToolResultForStatus(result: unknown): unknown {
  if (result === undefined) return undefined
  const serialized = stringifyStatusPreview(result)
  if (serialized.length > STATUS_TOOL_RESULT_PREVIEW_LIMIT) {
    return {
      truncated: true,
      preview: serialized.slice(0, STATUS_TOOL_RESULT_PREVIEW_LIMIT),
    }
  }
  return result
}

type NormalizedToolCallStatus = {
  serverName: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  durationMs?: number
}

function normalizeToolsCalledForStatus(
  toolsCalled: StepStatusUpdate['toolsCalled']
): { ok: true; value?: NormalizedToolCallStatus[] } | { ok: false; error: string } {
  if (!toolsCalled) return { ok: true }

  const normalized: NormalizedToolCallStatus[] = []
  for (const [index, tc] of toolsCalled.slice(0, MAX_STATUS_TOOL_CALLS).entries()) {
    if (typeof tc.serverName !== 'string' || tc.serverName.length === 0) {
      return { ok: false, error: `toolsCalled[${index}].serverName is required` }
    }
    if (typeof tc.toolName !== 'string' || tc.toolName.length === 0) {
      return { ok: false, error: `toolsCalled[${index}].toolName is required` }
    }
    normalized.push({
      serverName: tc.serverName,
      toolName: tc.toolName,
      args: normalizeToolArgsForStatus(tc.args),
      result: normalizeToolResultForStatus(tc.result),
      durationMs: tc.durationMs,
    })
  }
  return { ok: true, value: normalized }
}

function isRetriableJsonPatchConflict(
  error: unknown,
  patchOps: readonly JsonPatchOperation[] = []
): boolean {
  const code = getErrorCode(error)
  if (code === 409) return true
  if (code !== 422) return false

  const e = error as { body?: { message?: unknown }; message?: unknown }
  const message = String(e.body?.message ?? e.message ?? '').toLowerCase()
  if (message.includes('test') || message.includes('conflict')) return true

  // Kubernetes reports a failed JSON Patch `test` op against CRD status as a
  // generic 422 ("the server rejected our request") with no field details.
  // When the patch contains a test guard, treat that generic 422 as a stale
  // read and retry after re-reading status. Schema failures with an actual
  // validation message must still fail immediately.
  const isGenericKubernetesPatchRejection =
    message.length === 0 || message.includes('the server rejected our request')
  return isGenericKubernetesPatchRejection && patchOps.some(op => op.op === 'test')
}

function statusPatchFailure(
  label: string,
  error: unknown,
  context: Record<string, unknown>
): { status: number; body: Record<string, unknown> } {
  const code = getErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  log.warn(`Failed to persist ${label}`, {
    ...context,
    statusCode: code,
    error: message,
  })
  return {
    status: typeof code === 'number' && code >= 400 && code < 500 ? code : 500,
    body: {
      error: `Could not persist ${label}`,
      ...(typeof code === 'number' ? { statusCode: code } : {}),
    },
  }
}

interface StepStatusUpdate {
  stepId: string
  phase: StepPhase
  output?: unknown
  error?: string
  failureReason?: string
  executor?: 'agentic' | 'snippet' | 'custom'
  startedAt?: string
  completedAt?: string
  toolsCalled?: Array<{
    serverName: string
    toolName: string
    args?: unknown
    result?: unknown
    durationMs?: number
  }>
  modelUsed?: string
  approvalBindingSha256?: string
}

interface DeclaredStep {
  id: string
  agent?: { provider?: string; model?: string }
}

interface ArtifactStatus {
  name: string
  format: string
  sizeBytes: number
  path: string
  createdAt: string
}

interface WorkflowStatusBody {
  workflowPhase: string
  failureReason?: string
  completedAt?: string
}

interface ModelInjectionBody {
  stepId: string
  provider: string
  model: string
}

function parseModelInjectionBody(body: {
  model?: unknown
  provider?: unknown
  stepId?: unknown
}): ModelInjectionBody | null {
  if (
    typeof body.stepId !== 'string' ||
    typeof body.provider !== 'string' ||
    typeof body.model !== 'string'
  ) {
    return null
  }
  const stepId = body.stepId.trim()
  const provider = body.provider.trim()
  const model = body.model.trim()
  if (!stepId || !provider || !model) return null
  return { stepId, provider, model }
}

function validateDeclaredModelInjection(
  recipe: unknown,
  request: ModelInjectionBody
): { status: number; body: Record<string, unknown> } | null {
  if (!isRecord(recipe) || !isRecord(recipe.spec)) {
    return { status: 422, body: { error: 'WorkflowRecipe spec is missing' } }
  }

  const steps = recipe.spec.steps
  if (!Array.isArray(steps)) {
    return { status: 422, body: { error: 'WorkflowRecipe spec.steps is missing' } }
  }

  const declaredStep = steps.find(
    step => isRecord(step) && typeof step.id === 'string' && step.id === request.stepId
  )
  if (!isRecord(declaredStep)) {
    return {
      status: 422,
      body: { error: `Step '${request.stepId}' is not declared in spec.steps` },
    }
  }

  const stepAgent = isRecord(declaredStep.agent) ? declaredStep.agent : undefined
  const workflowAgent = isRecord(recipe.spec.agent) ? recipe.spec.agent : undefined
  const declaredProvider =
    typeof stepAgent?.provider === 'string' && stepAgent.provider
      ? stepAgent.provider
      : typeof workflowAgent?.provider === 'string' && workflowAgent.provider
        ? workflowAgent.provider
        : undefined
  const declaredModel =
    typeof stepAgent?.model === 'string' && stepAgent.model
      ? stepAgent.model
      : typeof workflowAgent?.model === 'string' && workflowAgent.model
        ? workflowAgent.model
        : undefined
  if (!declaredProvider || !declaredModel) {
    return {
      status: 422,
      body: { error: `Step '${request.stepId}' does not declare an agent provider/model` },
    }
  }

  if (declaredProvider !== request.provider || declaredModel !== request.model) {
    return {
      status: 422,
      body: { error: 'Requested provider/model does not match the declared step agent' },
    }
  }

  return null
}

// ─── Signal Store (re-exported from signalStore.ts) ─────────────────────
// enqueueSignal + drainSignals live in signalStore.ts so that triggerHandler.ts
// can import them without creating a circular dependency.
export { enqueueSignal, drainSignals, type WorkflowSignal } from './signalStore'

// ─── Endpoint Handlers ──────────────────────────────────────────────────

export function createWorkflowEndpointHandlers(
  customApi: k8s.CustomObjectsApi,
  sandboxNamespace: string,
  tokenFactory?: JwtTokenFactory,
  options: WorkflowEndpointHandlerOptions = {}
) {
  const statusOutputPreviewMaxChars = loadConfig().workflowStepOutputPreviewMaxChars
  const traceReporter = options.traceReporter ?? null

  function validateWorkflowClaimBinding(
    recipeName: string,
    claims: AuthenticatedRequest['tokenClaims']
  ): { status: number; body: Record<string, unknown> } | undefined {
    if (claims.recipeName !== recipeName) {
      return { status: 403, body: { error: 'Token recipeName mismatch' } }
    }
    if (claims.recipeNamespace !== sandboxNamespace) {
      return { status: 403, body: { error: 'Token recipeNamespace mismatch' } }
    }
    return undefined
  }

  async function forwardModelInjectionToMcpHost(
    recipeName: string,
    recipeNamespaceClaim: string,
    body: ModelInjectionBody,
    modelConfigHandler?: ModelConfigHandler,
    // Enforced by the broker ONLY when the allowlist ConfigMap is absent
    // (degraded mode, R3.5). The configure-model path passes a validator that
    // requires the request to match the declared step model; the SDK injection
    // path already validated that upstream and passes nothing.
    validateDegraded?: () => Promise<{ status: number; body: Record<string, unknown> } | null>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!modelConfigHandler) {
      return { status: 501, body: { error: 'Model config handler not configured' } }
    }

    if (!tokenFactory) {
      return { status: 500, body: { error: 'Token factory not configured' } }
    }

    // WRC stays the exclusive broker: it signs the configure token and reads the
    // backing provider Secret itself. The coordinator only requests a declared
    // step/provider/model tuple and never receives provider secret material.
    const wrcConfigureToken = await tokenFactory.signWrcConfigureToken(
      recipeName,
      recipeNamespaceClaim
    )

    const mcpHostEndpoint = buildMcpHostUrl(recipeName, sandboxNamespace)
    // R5 F6 stop-point: `fallbacks`/`cooldownSeconds`/`triggerOn` are NOT
    // forwarded yet — the broker request carries only the declared step tuple, so
    // the mcp-host handler's fallback path is never reached from the coordinator.
    // End-to-end wiring lands here: needs a workflowrecipe CRD field + coordinator
    // plumbing to source and pass the policy.
    const result = await modelConfigHandler.handle(
      { stepId: body.stepId, provider: body.provider, model: body.model },
      mcpHostEndpoint,
      wrcConfigureToken,
      validateDegraded ? { validateDegraded } : undefined
    )
    return { status: result.status, body: result.body }
  }

  return {
    /** POST /api/v1/workflow/:name/status — step phase transition */
    async postStepStatus(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims'],
      body: StepStatusUpdate | WorkflowStatusBody
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('status_write')) {
        return { status: 403, body: { error: 'Missing scope: status_write' } }
      }

      // Workflow-level status update (no stepId) — update workflowExecution phase directly
      if (!('stepId' in body) || !body.stepId) {
        const wfBody = body as WorkflowStatusBody
        const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
        if (!recipe) return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }

        // Preserve existing execution metadata on partial status updates.
        const existingStatus = (recipe as Record<string, unknown>).status as
          | Record<string, unknown>
          | undefined
        const existingExecution = existingStatus?.workflowExecution as
          | Record<string, unknown>
          | undefined
        const existingPhase = existingExecution?.phase
        const requestedPhase = wfBody.workflowPhase as WorkflowPhase
        const startsFreshExecution =
          requestedPhase === 'pending' ||
          requestedPhase === 'initializing' ||
          requestedPhase === 'recovering'
        const initializesExecutionStorage = startsFreshExecution || requestedPhase === 'running'

        if (requestedPhase === 'completed') {
          const incompleteSteps = incompleteStepsForWorkflowCompletion(recipe)
          if (incompleteSteps.length > 0) {
            return {
              status: 409,
              body: {
                error: 'Cannot mark workflow completed before all declared steps complete',
                incompleteSteps,
              },
            }
          }
        }

        if (
          typeof existingPhase === 'string' &&
          isTerminalWorkflowPhase(existingPhase as WorkflowPhase) &&
          existingPhase !== requestedPhase &&
          !startsFreshExecution
        ) {
          return {
            status: 409,
            body: {
              error: `Workflow is already in terminal phase '${existingPhase}'`,
            },
          }
        }

        const statusPatch = {
          status: {
            phase: recipePhaseForWorkflowPhase(
              wfBody.workflowPhase as WorkflowPhase,
              existingStatus?.phase
            ),
            ...(initializesExecutionStorage && !Array.isArray(existingStatus?.artifacts)
              ? { artifacts: [] }
              : {}),
            workflowExecution: {
              ...(existingExecution ?? {}),
              phase: requestedPhase,
              message: workflowStatusMessage(requestedPhase, wfBody.failureReason),
              ...(isTerminalWorkflowPhase(requestedPhase)
                ? { completedAt: wfBody.completedAt ?? new Date().toISOString() }
                : {}),
            },
          },
        }

        // Force merge-patch because CRD status patches use object merge semantics.
        try {
          await customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace: claims.recipeNamespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: statusPatch,
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
        } catch (error) {
          return statusPatchFailure('workflow status', error, {
            recipeName,
            workflowPhase: requestedPhase,
          })
        }
        enqueueInfrastructureTelemetryBestEffort(
          traceReporter,
          lifecycleTransitionTelemetryProjection(
            recipeName,
            claims,
            `workflow:${existingPhase ?? 'unknown'}->${requestedPhase}`,
            requestedPhase,
            recipe
          )
        )

        return { status: 200, body: { accepted: true } }
      }

      for (let patchAttempt = 1; patchAttempt <= STEP_STATUS_PATCH_MAX_ATTEMPTS; patchAttempt++) {
        const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
        if (!recipe) return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }

        const status = (recipe as Record<string, unknown>).status as
          | Record<string, unknown>
          | undefined
        const existingSteps = (status?.steps ?? []) as Array<{ id: string; phase: string }>
        const existingIndex = existingSteps.findIndex(s => s.id === body.stepId)
        const existing = existingIndex >= 0 ? existingSteps[existingIndex] : undefined

        if (existing && isTerminalStepPhase(existing.phase as StepPhase)) {
          return {
            status: 409,
            body: {
              error: `Step '${body.stepId}' is already in terminal phase '${existing.phase}'`,
            },
          }
        }

        // Validate stepId is declared in spec.steps[] — prevents a misbehaving coordinator
        // from injecting phantom step IDs that pollute status.steps[] and etcd storage.
        const spec = (recipe as Record<string, unknown>).spec as Record<string, unknown>
        const declaredSteps = (spec?.steps ?? []) as DeclaredStep[]
        const declaredStep = declaredSteps.find(s => s.id === body.stepId)
        if (!declaredStep) {
          return {
            status: 422,
            body: { error: `Step '${body.stepId}' is not declared in spec.steps` },
          }
        }

        // Normalize failureReason → error (statusReporter.ts sends failureReason)
        const resolvedError = body.error ?? body.failureReason
        const normalizedToolsCalled = normalizeToolsCalledForStatus(body.toolsCalled)
        if (!normalizedToolsCalled.ok) {
          return { status: 422, body: { error: normalizedToolsCalled.error } }
        }
        const outputPreview =
          body.output != null
            ? buildStatusOutputPreview(body.output, statusOutputPreviewMaxChars)
            : undefined
        if (
          body.approvalBindingSha256 !== undefined &&
          !/^[0-9a-f]{64}$/.test(body.approvalBindingSha256)
        ) {
          return { status: 422, body: { error: 'approvalBindingSha256 must be sha256 hex' } }
        }

        const stepEntry = {
          phase: body.phase,
          ...(outputPreview && outputPreview),
          ...(resolvedError && { error: resolvedError }),
          ...(body.executor && { executor: body.executor }),
          ...(body.startedAt && { startedAt: body.startedAt }),
          ...(body.completedAt && { completedAt: body.completedAt }),
          // Cap at 50 tool calls + truncate args/result to prevent etcd storage exhaustion.
          ...(body.toolsCalled && {
            toolsCalled: normalizedToolsCalled.value,
          }),
          ...(body.modelUsed && { modelUsed: body.modelUsed }),
          ...(body.approvalBindingSha256 && {
            approvalBindingSha256: body.approvalBindingSha256,
          }),
        }

        // Build local status projection for completion checks, then patch only
        // the touched step. Replacing status.steps as a whole can let a stale
        // read from one step update clobber a terminal update from another step.
        const updatedSteps = existingSteps.map(s =>
          s.id === body.stepId ? { ...s, ...stepEntry } : s
        )

        // If step not found in existing, add it
        if (!existing) {
          updatedSteps.push({
            id: body.stepId,
            ...stepEntry,
          } as (typeof updatedSteps)[number])
        }

        // Check if all DECLARED steps completed → transition workflow phase.
        // We compare against spec.steps[] count, not just reported status.steps[],
        // to prevent premature completion when only a subset of steps have reported.
        // (spec and declaredSteps already resolved above for stepId validation)
        const totalDeclared = declaredSteps.length

        // ID-based completion check: verify every DECLARED step ID is present with a terminal
        // phase, not just that the count matches. A spurious extra step ID from a misbehaving
        // coordinator could satisfy a count check while real declared steps are still pending.
        const updatedStepMap = new Map(updatedSteps.map(s => [s.id, s]))
        const allCompleted =
          totalDeclared > 0 &&
          declaredSteps.every(s => {
            const status = updatedStepMap.get(s.id)
            return status && (status.phase === 'completed' || status.phase === 'skipped')
          })
        const anyFailed = declaredSteps.some(s => {
          const status = updatedStepMap.get(s.id)
          return status && status.phase === 'failed'
        })

        let workflowPhase: WorkflowPhase | undefined
        if (allCompleted) workflowPhase = 'completed'
        else if (anyFailed) workflowPhase = 'failed'

        // Preserve execution metadata when step status drives a workflow transition.
        const autoTransitionRecipeStatus = (recipe as Record<string, unknown>).status as
          | Record<string, unknown>
          | undefined
        const autoTransitionExecution = autoTransitionRecipeStatus?.workflowExecution as
          | Record<string, unknown>
          | undefined

        // Extract artifact metadata from toolsCalled and append to status.artifacts[].
        // This populates the CRD field that the UI reads as source of truth, so that
        // delete operations (which clear/filter status.artifacts) are reflected correctly.
        const existingArtifacts = (autoTransitionRecipeStatus?.artifacts ?? []) as ArtifactStatus[]
        const artifactNames = new Set(existingArtifacts.map(a => a.name as string))
        const artifactsToAdd: ArtifactStatus[] = []

        for (const artifact of extractArtifactsFromStepStatus(body)) {
          if (!artifactNames.has(artifact.name)) {
            artifactNames.add(artifact.name)
            artifactsToAdd.push(artifact)
          }
        }

        const patchOps: JsonPatchOperation[] = []
        const updatedStep = existing
          ? { ...existing, ...stepEntry }
          : {
              id: body.stepId,
              ...stepEntry,
            }
        const shouldCreateStepsArray = existingIndex < 0 && !Array.isArray(status?.steps)
        if (isRecord(status) && shouldCreateStepsArray) {
          patchOps.push({ op: 'test', path: '/status', value: status })
        }
        if (existingIndex >= 0) {
          patchOps.push({
            op: 'test',
            path: `/status/steps/${existingIndex}/id`,
            value: body.stepId,
          })
          patchOps.push({
            op: 'replace',
            path: `/status/steps/${existingIndex}`,
            value: updatedStep,
          })
        } else if (Array.isArray(status?.steps)) {
          patchOps.push({ op: 'add', path: '/status/steps/-', value: updatedStep })
        } else {
          patchOps.push({ op: 'add', path: '/status/steps', value: [updatedStep] })
        }
        if (artifactsToAdd.length > 0) {
          if (Array.isArray(status?.artifacts)) {
            for (const artifact of artifactsToAdd) {
              patchOps.push({ op: 'add', path: '/status/artifacts/-', value: artifact })
            }
          } else {
            patchOps.push({
              op: 'add',
              path: '/status/artifacts',
              value: artifactsToAdd,
            })
          }
        }
        if (workflowPhase) {
          patchOps.push({
            op:
              isRecord(status) && Object.prototype.hasOwnProperty.call(status, 'phase')
                ? 'replace'
                : 'add',
            path: '/status/phase',
            value: recipePhaseForWorkflowPhase(workflowPhase, status?.phase),
          })
          patchOps.push({
            op: autoTransitionExecution ? 'replace' : 'add',
            path: '/status/workflowExecution',
            value: {
              ...(autoTransitionExecution ?? {}),
              phase: workflowPhase,
              message: workflowStatusMessage(workflowPhase),
              ...(workflowPhase === 'completed' || workflowPhase === 'failed'
                ? { completedAt: new Date().toISOString() }
                : {}),
            },
          })
        }

        try {
          await customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace: claims.recipeNamespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: patchOps,
            },
            { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/json-patch+json')] }
          )
        } catch (error) {
          if (
            patchAttempt < STEP_STATUS_PATCH_MAX_ATTEMPTS &&
            isRetriableJsonPatchConflict(error, patchOps)
          ) {
            log.warn('Retrying workflow step status patch after concurrent status update', {
              recipeName,
              stepId: body.stepId,
              patchAttempt,
            })
            continue
          }
          return statusPatchFailure('workflow step status', error, {
            recipeName,
            stepId: body.stepId,
            phase: body.phase,
            patchAttempt,
          })
        }
        return { status: 200, body: { accepted: true } }
      }

      return {
        status: 409,
        body: { error: 'Could not persist step status after concurrent status updates' },
      }
    },

    /** GET /api/v1/workflow/:name/status — current execution state */
    async getWorkflowStatus(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('status_read') && !claims.scopes.includes('status_write')) {
        return { status: 403, body: { error: 'Missing scope: status_read' } }
      }

      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe)
        return { status: 404, body: { error: `WorkflowRecipe '${recipeName}' not found` } }

      const status = (recipe as Record<string, unknown>).status as
        | Record<string, unknown>
        | undefined
      const execution = status?.workflowExecution as Record<string, unknown> | undefined
      const steps = (status?.steps ?? []) as Array<Record<string, unknown>>

      return {
        status: 200,
        body: {
          workflowPhase: execution?.phase ?? 'pending',
          steps,
          attempt: execution?.attempt ?? 0,
          startedAt: execution?.startedAt,
        },
      }
    },

    /** GET /api/v1/workflow/:name/health — Pod health status */
    async getHealth(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      // Bind health checks to the caller's workflow token.
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('health_read') && !claims.scopes.includes('status_read')) {
        return { status: 403, body: { error: 'Missing scope: health_read' } }
      }
      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe) return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }

      const status = (recipe as Record<string, unknown>).status as
        | Record<string, unknown>
        | undefined
      const execution = status?.workflowExecution as Record<string, unknown> | undefined

      return {
        status: 200,
        body: {
          workflowPhase: execution?.phase ?? 'pending',
        },
      }
    },

    /** GET /api/v1/workflow/:name/signals — runtime signals (polling) */
    async getSignals(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('signal_read') && !claims.scopes.includes('signal')) {
        return { status: 403, body: { error: 'Missing scope: signal_read' } }
      }

      const signals = drainSignals(recipeName)
      return { status: 200, body: { signals } }
    },

    /** POST /api/v1/workflow/:name/configure-model — model hot-swap */
    async configureModel(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims'],
      body: { model: string; provider: string; stepId: string },
      modelConfigHandler?: ModelConfigHandler
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('configure_model')) {
        return { status: 403, body: { error: 'Missing scope: configure_model' } }
      }

      const parsed = parseModelInjectionBody(body)
      if (!parsed) {
        return { status: 400, body: { error: 'stepId, provider, and model are required' } }
      }

      // Degraded-mode guard (R3.5): when the allowlist ConfigMap is absent, the
      // broker permits ONLY the declared step model. Unlike the SDK injection
      // path, this endpoint does not otherwise load the recipe — so we resolve
      // the declared model lazily and hand the check to the broker, which runs
      // it only when the allowlist is missing (with the allowlist present, the
      // allowlist rules and the declared model is not required).
      const validateDegraded = async (): Promise<{
        status: number
        body: Record<string, unknown>
      } | null> => {
        const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
        if (!recipe) return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }
        return validateDeclaredModelInjection(recipe, parsed)
      }

      return forwardModelInjectionToMcpHost(
        recipeName,
        claims.recipeNamespace,
        parsed,
        modelConfigHandler,
        validateDegraded
      )
    },

    /** POST /api/v1/workflow/:name/injections/model — SDK brokered model injection */
    async requestModelInjection(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims'],
      body: { model?: unknown; provider?: unknown; stepId?: unknown },
      modelConfigHandler?: ModelConfigHandler
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes(MODEL_INJECTION_REQUEST_SCOPE)) {
        return { status: 403, body: { error: `Missing scope: ${MODEL_INJECTION_REQUEST_SCOPE}` } }
      }

      const parsed = parseModelInjectionBody(body)
      if (!parsed) {
        return { status: 400, body: { error: 'stepId, provider, and model are required' } }
      }

      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe) return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }

      const declarationError = validateDeclaredModelInjection(recipe, parsed)
      if (declarationError) return declarationError

      return forwardModelInjectionToMcpHost(
        recipeName,
        claims.recipeNamespace,
        parsed,
        modelConfigHandler
      )
    },

    /**
     * GET /api/v1/workflow/:name/artifacts/:filename — artifact download proxy.
     *
     * Called by control-api on behalf of an authenticated admin (delegation
     * token, iss=control-api). WRC proxies to the recipe's mcp-host with a
     * fresh 60-second `artifact_read` token signed just-in-time and never stored.
     *
     * Authz:
     *  - recipeName in claims must match the URL path param
     *  - scopes must include `artifact_read` OR `admin:artifact_read`
     *    (admin delegation uses the admin-prefixed scope; operational cleanup
     *    via `artifact_delete` is a DIFFERENT endpoint on mcp-host)
     */
    async getArtifact(
      recipeName: string,
      filename: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{
      status: number
      headers?: Record<string, string>
      body: Buffer | Record<string, unknown>
    }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      // admin:artifact_read is only valid from control-api (iss=control-api);
      // reject it from WRC-issued tokens to prevent scope escalation.
      const hasScope =
        claims.scopes.includes('artifact_read') ||
        (claims.scopes.includes('admin:artifact_read') && claims.iss === CONTROL_API_ISSUER)
      if (!hasScope) {
        return { status: 403, body: { error: 'Missing scope: artifact_read' } }
      }

      if (!tokenFactory) {
        return { status: 500, body: { error: 'Token factory not configured' } }
      }

      // Sanitize filename to prevent path-traversal via URL — mcp-host re-validates
      // but rejecting early gives a cleaner 400 and a shorter audit trail.
      if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes('..')) {
        return { status: 400, body: { error: 'Invalid filename' } }
      }
      if (!claims.artifactName) {
        return { status: 403, body: { error: 'Missing artifactName binding' } }
      }
      if (claims.artifactName !== filename) {
        return { status: 403, body: { error: 'Token artifactName mismatch' } }
      }

      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe) {
        return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }
      }
      const runIdError = validateRunIdClaim(recipe, claims)
      if (runIdError) return runIdError
      const declaredArtifact = findDeclaredArtifact(recipe, filename)
      if (!declaredArtifact) {
        return { status: 404, body: { error: `Artifact "${filename}" not found` } }
      }
      const backend = resolveArtifactBackend(recipe, recipeName, sandboxNamespace, declaredArtifact)

      // Fresh per-request token — 60s TTL. No store, no refresh, nothing to leak.
      const token = await tokenFactory.signWrcArtifactToken(recipeName, claims.recipeNamespace, {
        ...(claims.runId ? { runId: claims.runId } : {}),
        artifactName: filename,
      })

      const target = `${backend.url}/api/v1/workflow/artifacts/${encodeURIComponent(filename)}`

      let upstream: Response | undefined
      const notFoundRetryDelays =
        backend.component === 'mcp-host' ? [] : ARTIFACT_READER_NOT_FOUND_RETRY_DELAYS_MS
      for (let attempt = 0; ; attempt++) {
        try {
          upstream = await fetch(target, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          })
        } catch (err) {
          if (attempt < notFoundRetryDelays.length) {
            await sleep(notFoundRetryDelays[attempt])
            continue
          }
          log.error('Artifact fetch failed', {
            recipeName,
            filename,
            backend: backend.component,
            error: err instanceof Error ? err.message : String(err),
          })
          return { status: 502, body: { error: 'Upstream artifact reader unreachable' } }
        }

        if (upstream.status !== 404 || attempt >= notFoundRetryDelays.length) break
        await readUpstreamText(upstream, { recipeName, filename, status: upstream.status })
        await sleep(notFoundRetryDelays[attempt])
      }

      if (!upstream) {
        return { status: 502, body: { error: 'Upstream artifact reader unreachable' } }
      }

      if (!upstream.ok) {
        // Log upstream error details server-side, return generic message to caller.
        const text = await readUpstreamText(upstream, {
          recipeName,
          filename,
          status: upstream.status,
        })
        const upstreamBody = parseUpstreamJsonBody(text)
        log.warn('Artifact upstream error', { recipeName, status: upstream.status, body: text })
        if (isArtifactGoneBody(upstreamBody)) {
          return {
            status: 410,
            body: {
              error: 'artifact_gone',
              message:
                typeof upstreamBody?.message === 'string'
                  ? upstreamBody.message
                  : `Artifact "${filename}" is no longer available`,
            },
          }
        }
        return {
          status: upstream.status,
          body: { error: `Upstream returned ${upstream.status}` },
        }
      }

      const arrayBuf = await upstream.arrayBuffer()

      // Sanitize upstream Content-Disposition: mcp-host is untrusted (runs
      // arbitrary LLM workflows). Extract only the filename, strip everything
      // else to prevent header injection from a compromised pod.
      const upstreamDisposition = upstream.headers.get('content-disposition')
      const extractedName = upstreamDisposition?.match(/filename="?([^";\r\n]+)"?/)?.[1]
      const safeDispositionName = (extractedName ?? filename).replace(/[^a-zA-Z0-9._-]/g, '_')

      return {
        status: 200,
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'content-length': String(arrayBuf.byteLength),
          ...(upstreamDisposition
            ? { 'content-disposition': `attachment; filename="${safeDispositionName}"` }
            : {}),
        },
        body: Buffer.from(arrayBuf),
      }
    },

    /**
     * DELETE /api/v1/workflow/:name/artifacts — admin-initiated artifact cleanup.
     *
     * Proxies DELETE to mcp-host after verifying admin:artifact_delete scope
     * from control-api (iss=control-api). WRC re-signs with its own key
     * (sub=wrc, scope=artifact_delete) so mcp-host handler stays unchanged.
     * Admin identity is logged at WRC level for audit trail.
     *
     * After successful upstream delete, patches the CRD status.artifacts to []
     * so the UI stays consistent without requiring a manual refresh.
     */
    async deleteArtifact(
      recipeName: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      // admin:artifact_delete is only valid from control-api
      if (!claims.scopes.includes('admin:artifact_delete') || claims.iss !== CONTROL_API_ISSUER) {
        return { status: 403, body: { error: 'Missing scope: admin:artifact_delete' } }
      }

      if (!tokenFactory) {
        return { status: 500, body: { error: 'Token factory not configured' } }
      }

      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe) {
        return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }
      }
      const runIdError = validateRunIdClaim(recipe, claims)
      if (runIdError) return runIdError
      const backends = resolveBulkArtifactBackends(recipe, recipeName, sandboxNamespace)
      const token = await tokenFactory.signWrcArtifactDeleteToken(
        recipeName,
        claims.recipeNamespace,
        claims.runId ? { runId: claims.runId } : {}
      )

      log.info('Admin artifact delete proxied', {
        recipeName,
        admin: claims.sub,
        iss: claims.iss,
        backends: backends.map(backend => backend.component),
      })

      for (const backend of backends) {
        const target = `${backend.url}/api/v1/workflow/artifacts`
        let upstream: Response
        try {
          upstream = await fetch(target, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          })
        } catch (err) {
          log.error('Artifact delete fetch failed', {
            recipeName,
            backend: backend.component,
            error: err instanceof Error ? err.message : String(err),
          })
          return { status: 502, body: { error: 'Upstream artifact cleanup service unreachable' } }
        }

        if (!upstream.ok) {
          log.warn('Artifact delete upstream error', {
            recipeName,
            backend: backend.component,
            status: upstream.status,
          })
          return {
            status: upstream.status,
            body: { error: `Upstream returned ${upstream.status}` },
          }
        }
      }

      // Best-effort CRD status patch — clear artifacts array so UI stays consistent.
      // If this fails, the files are still deleted; the UI will just show stale entries
      // until the next reconcile cycle or manual refresh.
      try {
        await customApi.patchNamespacedCustomObjectStatus(
          {
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace: claims.recipeNamespace,
            plural: WORKFLOWRECIPE_PLURAL,
            name: recipeName,
            body: { status: { artifacts: [] } },
          },
          { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
        )
      } catch (err) {
        log.warn('Failed to clear CRD status.artifacts after bulk delete', {
          recipeName,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return { status: 204, body: {} }
    },

    /**
     * DELETE /api/v1/workflow/:name/artifacts/:filename — admin-initiated single file delete.
     *
     * Same auth model as deleteArtifact (bulk), but targets one file.
     * After successful upstream delete, patches the CRD status.artifacts to
     * remove the deleted file so the UI stays consistent.
     */
    async deleteArtifactFile(
      recipeName: string,
      filename: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(recipeName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('admin:artifact_delete') || claims.iss !== CONTROL_API_ISSUER) {
        return { status: 403, body: { error: 'Missing scope: admin:artifact_delete' } }
      }
      if (!tokenFactory) {
        return { status: 500, body: { error: 'Token factory not configured' } }
      }
      if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes('..')) {
        return { status: 400, body: { error: 'Invalid filename' } }
      }
      if (!claims.artifactName) {
        return { status: 403, body: { error: 'Missing artifactName binding' } }
      }
      if (claims.artifactName !== filename) {
        return { status: 403, body: { error: 'artifactName mismatch' } }
      }

      const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
      if (!recipe) {
        return { status: 404, body: { error: `Recipe '${recipeName}' not found` } }
      }
      const runIdError = validateRunIdClaim(recipe, claims)
      if (runIdError) return runIdError
      const declaredArtifact = findDeclaredArtifact(recipe, filename)
      if (!declaredArtifact) {
        return { status: 404, body: { error: `Artifact "${filename}" not found` } }
      }

      const token = await tokenFactory.signWrcArtifactDeleteToken(
        recipeName,
        claims.recipeNamespace,
        {
          ...(claims.runId ? { runId: claims.runId } : {}),
          artifactName: filename,
        }
      )
      const backend = resolveArtifactBackend(recipe, recipeName, sandboxNamespace, declaredArtifact)
      const target = `${backend.url}/api/v1/workflow/artifacts/${encodeURIComponent(filename)}`

      log.info('Admin artifact file delete proxied', {
        recipeName,
        filename,
        admin: claims.sub,
      })

      let upstream: Response
      try {
        upstream = await fetch(target, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        })
      } catch (err) {
        log.error('Artifact file delete fetch failed', {
          recipeName,
          filename,
          backend: backend.component,
          error: err instanceof Error ? err.message : String(err),
        })
        return { status: 502, body: { error: 'Upstream artifact cleanup service unreachable' } }
      }

      if (!upstream.ok) {
        log.warn('Artifact file delete upstream error', {
          recipeName,
          filename,
          status: upstream.status,
        })
        return { status: upstream.status, body: { error: `Upstream returned ${upstream.status}` } }
      }

      // Best-effort CRD status patch — remove the deleted file from status.artifacts[].
      // merge-patch cannot remove array items, so we read→filter→replace the whole array.
      try {
        const recipe = await this.getRecipe(recipeName, claims.recipeNamespace)
        if (recipe) {
          const status = (recipe as Record<string, unknown>).status as
            | Record<string, unknown>
            | undefined
          const artifacts = (status?.artifacts ?? []) as Array<Record<string, unknown>>
          const filtered = artifacts.filter(a => a.name !== filename)
          await customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace: claims.recipeNamespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: { status: { artifacts: filtered } },
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
        }
      } catch (err) {
        log.warn('Failed to update CRD status.artifacts after file delete', {
          recipeName,
          filename,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return { status: 204, body: {} }
    },

    /** POST /api/v1/workflow/:name/trigger — legacy scheduled execution */
    async postTrigger(
      parentName: string,
      namespace: string,
      claims: AuthenticatedRequest['tokenClaims']
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const bindingError = validateWorkflowClaimBinding(parentName, claims)
      if (bindingError) return bindingError
      if (!claims.scopes.includes('trigger_write')) {
        return { status: 403, body: { error: 'Missing scope: trigger_write' } }
      }
      if (process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER !== 'true') {
        return {
          status: 410,
          body: {
            error: 'Legacy direct trigger endpoint disabled; use control-api workflow broker',
          },
        }
      }
      // Coordinator tokens also carry trigger_write, so require CronJob subject.
      if (claims.sub !== 'cronjob') {
        return { status: 403, body: { error: 'Endpoint requires sub: cronjob' } }
      }
      return handleTrigger(customApi, parentName, namespace)
    },

    // ─── Helpers ──────────────────────────────────────────────────────

    /**
     * Fetch the recipe CRD from the namespace encoded in the caller's JWT
     * claim (`claims.recipeNamespace`). WRC knows the namespace when it signs
     * the token, so handlers never need to probe or hardcode it.
     *
     * Non-404 lookup errors rethrow.
     */
    async getRecipe(recipeName: string, namespace: string): Promise<unknown | null> {
      try {
        return await customApi.getNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name: recipeName,
        })
      } catch (err) {
        if (getErrorCode(err) === 404) return null
        throw err
      }
    },
  }
}
