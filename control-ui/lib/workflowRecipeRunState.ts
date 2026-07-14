import type { WorkflowRecipeResource, WorkflowRecipeStatus, WorkflowRunSummary } from './api'

export const RECIPE_STATUS_LOADING_REASON = 'Recipe status is still loading.'
const WORKFLOW_EXECUTION_LIVE_PHASES = new Set(['pending', 'initializing', 'running', 'recovering'])
const INITIAL_DEPLOY_EXECUTION_WINDOW_MS = 60 * 1000
const RUN_MATCH_TOLERANCE_MS = 5000

export type WorkflowRunListItem = WorkflowRunSummary & {
  isCurrentExecution?: boolean
  isClickable?: boolean
}

function hasWorkflowSteps(recipe: WorkflowRecipeResource | null): boolean {
  const spec = recipe?.spec
  if (!spec || typeof spec !== 'object') return false

  const steps = (spec as { steps?: unknown }).steps
  return Array.isArray(steps) && steps.length > 0
}

function getTransportWorkloadIds(recipe: WorkflowRecipeResource | null): string[] {
  const spec = recipe?.spec
  if (!spec || typeof spec !== 'object') return []
  const workloads = (spec as { workloads?: unknown }).workloads
  if (!Array.isArray(workloads)) return []

  return workloads
    .map(workload => {
      if (!workload || typeof workload !== 'object' || Array.isArray(workload)) return null
      const record = workload as { id?: unknown; transport?: unknown }
      if (
        !record.transport ||
        typeof record.transport !== 'object' ||
        Array.isArray(record.transport)
      ) {
        return null
      }
      return typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null
    })
    .filter((id): id is string => Boolean(id))
}

function getWorkloadInstances(status: WorkflowRecipeStatus | null): Record<string, string> {
  const raw = status?.workloadInstances
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const instances: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) instances[key] = value.trim()
  }
  return instances
}

function workflowRuntimeDisabledReason(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null
): string {
  const transportWorkloadIds = getTransportWorkloadIds(recipe)
  if (transportWorkloadIds.length === 0) return ''

  const instances = getWorkloadInstances(status ?? recipe?.status ?? null)
  const missing = transportWorkloadIds.filter(id => !instances[id])
  if (missing.length > 0) {
    return `Workflow runtime is preparing transport workload${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`
  }

  return ''
}

function getOnDemandTrigger(recipe: WorkflowRecipeResource | null): Record<string, unknown> | null {
  const spec = recipe?.spec
  if (!spec || typeof spec !== 'object') return null

  const triggers = (spec as { triggers?: unknown }).triggers
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) return null

  const onDemand = (triggers as { onDemand?: unknown }).onDemand
  return onDemand && typeof onDemand === 'object' && !Array.isArray(onDemand)
    ? (onDemand as Record<string, unknown>)
    : null
}

export function workflowOnDemandRequiresApproval(recipe: WorkflowRecipeResource | null): boolean {
  return getOnDemandTrigger(recipe)?.requiresApproval === true
}

function getOnDemandUserActorDisabledReason(recipe: WorkflowRecipeResource | null): string {
  const onDemand = getOnDemandTrigger(recipe)
  if (!onDemand) {
    return 'Workflow is installed but does not declare spec.triggers.onDemand, so Control UI and Desktop cannot trigger it manually. Add an on-demand trigger before running it.'
  }

  const allowedActors = onDemand.allowedActors
  if (Array.isArray(allowedActors) && allowedActors.length > 0) {
    const allowsUser = allowedActors.includes('user')
    if (!allowsUser) {
      return 'Workflow on-demand trigger does not allow user actors. Add "user" to spec.triggers.onDemand.allowedActors for Control UI and Desktop App runs.'
    }
  }

  return ''
}

function normalizePhase(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function workflowExecutionPhase(status: WorkflowRecipeStatus | null): string {
  const execution = status?.workflowExecution
  if (!execution || typeof execution !== 'object') return ''
  return normalizePhase(execution.phase)
}

function workflowExecutionTimestamp(
  status: WorkflowRecipeStatus | null,
  field: 'startedAt' | 'completedAt'
): string | null {
  const execution = status?.workflowExecution
  if (!execution || typeof execution !== 'object') return null
  const value = execution[field]
  return typeof value === 'string' && value ? value : null
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

export function isWorkflowExecutionLive(status: WorkflowRecipeStatus | null): boolean {
  return WORKFLOW_EXECUTION_LIVE_PHASES.has(workflowExecutionPhase(status))
}

function isInitialDeployExecutionCandidate(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null
): boolean {
  // This compares the parent CRD creation time with the first workflowExecution
  // status initialization, not the full workflow duration. Keep it tight so a
  // quick manual run after install is not mislabeled as the install deploy.
  const createdMs = timestampMs(recipe?.metadata?.creationTimestamp)
  const startedMs = timestampMs(workflowExecutionTimestamp(status, 'startedAt'))
  if (createdMs === null || startedMs === null) return false
  return startedMs >= createdMs && startedMs - createdMs < INITIAL_DEPLOY_EXECUTION_WINDOW_MS
}

export function isInitialDeployExecution(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[] = []
): boolean {
  if (!isInitialDeployExecutionCandidate(recipe, status)) return false
  return !runs
    .filter(run => isRunFromCurrentRecipeInstance(recipe, run))
    .some(run => matchesWorkflowExecution(status, run))
}

export function getRecipeDisplayPhase(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[] = []
): string {
  const phase = normalizePhase(status?.phase ?? recipe?.status?.phase)
  const executionPhase = workflowExecutionPhase(status)

  if (phase === 'active') {
    if (WORKFLOW_EXECUTION_LIVE_PHASES.has(executionPhase)) {
      return isInitialDeployExecution(recipe, status, runs) ? 'deploying' : 'running'
    }
    if (executionPhase === 'failed') return 'failed'
    if (executionPhase === 'cancelled') return 'cancelled'
  }

  return phase || 'Unknown'
}

export function getRecipeResourceDisplayStatus(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null
): { phase: string; message: string } {
  const phase = normalizePhase(recipe?.status?.phase ?? status?.phase)
  const recipeMessage = recipe?.status?.message
  const statusMessage = status?.message

  return {
    phase: phase || 'Unknown',
    message:
      typeof recipeMessage === 'string'
        ? recipeMessage
        : typeof statusMessage === 'string'
          ? statusMessage
          : '',
  }
}

export function getRecipeRunDisabledReason(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[] = []
): string {
  if (!recipe) return 'Recipe is still loading.'
  if (!hasWorkflowSteps(recipe)) return 'Recipe has no steps to run.'

  const triggerDisabledReason = getOnDemandUserActorDisabledReason(recipe)
  if (triggerDisabledReason) return triggerDisabledReason

  const phase = normalizePhase(status?.phase ?? recipe.status?.phase)
  if (!phase) return RECIPE_STATUS_LOADING_REASON
  if (phase !== 'active' && phase !== 'failed') {
    const executionIsLive = isWorkflowExecutionLive(status)
    if (executionIsLive && !isInitialDeployExecution(recipe, status, runs)) {
      return ''
    }
    return `Recipe is ${phase}; wait until it is active.`
  }

  const runtimeDisabledReason = workflowRuntimeDisabledReason(recipe, status)
  if (runtimeDisabledReason) return runtimeDisabledReason

  return ''
}

export function isRecipeReadyToRun(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[] = []
): boolean {
  return getRecipeRunDisabledReason(recipe, status, runs) === ''
}

function runTime(run: WorkflowRunSummary): number | null {
  return timestampMs(run.triggeredAt ?? run.startedAt ?? run.completedAt)
}

function isRunFromCurrentRecipeInstance(
  recipe: WorkflowRecipeResource | null,
  run: WorkflowRunSummary
): boolean {
  const createdMs = timestampMs(recipe?.metadata?.creationTimestamp)
  const candidateMs = runTime(run)
  if (createdMs === null || candidateMs === null) return true
  return candidateMs >= createdMs
}

function executionRunPhase(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus,
  isInitialDeploy: boolean
): string {
  const phase = workflowExecutionPhase(status)
  if (WORKFLOW_EXECUTION_LIVE_PHASES.has(phase)) {
    return isInitialDeploy ? 'Deploying' : 'Running'
  }
  if (phase === 'completed') return 'Succeeded'
  if (phase === 'failed') return 'Failed'
  if (phase === 'cancelled') return 'Canceled'
  return phase || 'Unknown'
}

function currentExecutionRun(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[] = []
): WorkflowRunListItem | null {
  const execution = status?.workflowExecution
  if (!execution || typeof execution !== 'object') return null
  const phase = workflowExecutionPhase(status)
  if (!phase) return null

  const startedAt = workflowExecutionTimestamp(status, 'startedAt')
  const completedAt = workflowExecutionTimestamp(status, 'completedAt')
  const isInitialDeploy = isInitialDeployExecution(recipe, status, runs)
  const id = isInitialDeploy ? 'initial-deploy' : 'current-execution'
  const matchingPendingRun = runs
    .filter(run => isRunFromCurrentRecipeInstance(recipe, run))
    .find(
      run =>
        !run.startedAt &&
        !run.completedAt &&
        run.phase === workflowRunPhaseForExecutionPhase(status)
    )

  return {
    id,
    source: 'status',
    recipeNamespace: recipe?.metadata?.namespace ?? '',
    recipeName: recipe?.metadata?.name ?? '',
    phase: executionRunPhase(recipe, status, isInitialDeploy),
    triggerSource: isInitialDeploy ? 'deploy' : 'status',
    triggeredAt: isInitialDeploy
      ? (recipe?.metadata?.creationTimestamp ?? startedAt)
      : (startedAt ?? matchingPendingRun?.triggeredAt ?? null),
    startedAt,
    completedAt,
    finalPhase:
      phase === 'completed'
        ? 'Succeeded'
        : phase === 'failed'
          ? 'Failed'
          : phase === 'cancelled'
            ? 'Canceled'
            : null,
    message:
      typeof execution.message === 'string'
        ? execution.message
        : typeof status?.message === 'string'
          ? status.message
          : null,
    errorMessage: typeof execution.error === 'string' ? execution.error : null,
    actor: { type: isInitialDeploy ? 'deploy' : 'workflow' },
    executionRef: null,
    triggerer: { kind: isInitialDeploy ? 'deploy' : 'workflow' },
    isCurrentExecution: true,
    isClickable: WORKFLOW_EXECUTION_LIVE_PHASES.has(phase),
  }
}

function workflowRunPhaseForExecutionPhase(status: WorkflowRecipeStatus | null): string {
  switch (workflowExecutionPhase(status)) {
    case 'pending':
    case 'initializing':
      return 'Pending'
    case 'running':
    case 'recovering':
      return 'Running'
    case 'completed':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Canceled'
    default:
      return 'Unknown'
  }
}

function sameTimeWithinTolerance(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= RUN_MATCH_TOLERANCE_MS
}

function matchesWorkflowExecution(
  status: WorkflowRecipeStatus | null,
  run: WorkflowRunSummary
): boolean {
  const runStartedMs = timestampMs(run.startedAt)
  const currentStartedMs = timestampMs(workflowExecutionTimestamp(status, 'startedAt'))
  if (sameTimeWithinTolerance(runStartedMs, currentStartedMs)) return true

  const runCompletedMs = timestampMs(run.completedAt)
  const currentCompletedMs = timestampMs(workflowExecutionTimestamp(status, 'completedAt'))
  if (sameTimeWithinTolerance(runCompletedMs, currentCompletedMs)) return true

  const runTriggeredMs = timestampMs(run.triggeredAt)
  if (
    runStartedMs === null &&
    currentStartedMs === null &&
    runCompletedMs === null &&
    currentCompletedMs === null &&
    runTriggeredMs !== null &&
    run.phase === workflowRunPhaseForExecutionPhase(status)
  ) {
    return true
  }

  return false
}

function matchesCurrentExecution(
  status: WorkflowRecipeStatus | null,
  run: WorkflowRunSummary,
  current: WorkflowRunListItem
): boolean {
  const runStartedMs = timestampMs(run.startedAt)
  const currentStartedMs = timestampMs(current.startedAt)
  if (sameTimeWithinTolerance(runStartedMs, currentStartedMs)) return true

  const runCompletedMs = timestampMs(run.completedAt)
  const currentCompletedMs = timestampMs(current.completedAt)
  if (sameTimeWithinTolerance(runCompletedMs, currentCompletedMs)) return true

  const runTriggeredMs = timestampMs(run.triggeredAt)
  const currentTriggeredMs = timestampMs(current.triggeredAt)
  if (
    runStartedMs === null &&
    currentStartedMs === null &&
    runCompletedMs === null &&
    currentCompletedMs === null &&
    sameTimeWithinTolerance(runTriggeredMs, currentTriggeredMs) &&
    run.phase === workflowRunPhaseForExecutionPhase(status)
  ) {
    return true
  }

  return false
}

export function getVisibleWorkflowRuns(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[]
): WorkflowRunListItem[] {
  const current = currentExecutionRun(recipe, status, runs)
  const currentInstanceRuns = runs.filter(run => isRunFromCurrentRecipeInstance(recipe, run))
  if (!current || currentInstanceRuns.some(run => matchesCurrentExecution(status, run, current))) {
    return currentInstanceRuns.map(run => ({ ...run, isClickable: true }))
  }
  return [current, ...currentInstanceRuns.map(run => ({ ...run, isClickable: true }))]
}

export function shouldPollWorkflowRecipe(
  recipe: WorkflowRecipeResource | null,
  status: WorkflowRecipeStatus | null,
  runs: WorkflowRunSummary[]
): boolean {
  if (isWorkflowExecutionLive(status)) return true
  if (runs.some(r => r.phase === 'Pending' || r.phase === 'Running')) return true

  const phase = normalizePhase(status?.phase ?? recipe?.status?.phase)
  return !['active', 'failed', 'deprecated', 'rollback-failed'].includes(phase)
}
