import { Router } from 'express'
import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import { getInvocationById } from '../../services/pluginWorkloadSdkDb.js'
import { withTraceIngestTransaction } from '../../services/tracing/pools.js'
import { projectAcceptedUsageEvents } from '../../services/tracing/usageProjection.js'
import { ingestUsageEventsInTransaction } from '../../services/usageEvents.js'
import {
  type WorkflowRunBinding,
  WorkflowRunBindingRepository,
} from '../../services/workflowRunBindingRepository.js'
import type { McpHostAccessClaims } from '../../utils/auth/mcpHostJwtToken.js'

const MAX_EVENTS_PER_REQUEST = 1000
const CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX = 'admin-ui/'

type BindingViolation = {
  index: number
  reason:
    | 'sentinel_token_with_recipe_name'
    | 'sentinel_token_with_workflow_source'
    | 'sentinel_token_host_ref_mismatch'
    | 'recipe_token_recipe_name_mismatch'
    | 'recipe_token_non_workflow_source'
    | 'recipe_token_host_ref_mismatch'
    | 'recipe_token_missing_canonical_task_id'
    | 'recipe_token_missing_llm_secret_name'
    | 'recipe_token_invalid_sdk_usage_binding'
    | 'unrecognized_token_binding'
}

type WorkflowRunBindingViolation = {
  index: number
  reason:
    | 'workflow_run_not_found'
    | 'workflow_run_recipe_mismatch'
    | 'workflow_run_team_mismatch'
    | 'workflow_run_user_mismatch'
}

type WorkflowUsageCandidate = {
  index: number
  runId: string
  recipeName: string
  teamId: string | null
  userId: string | null
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_PREFIX_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::|$)/i

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableString(value: unknown): string | null {
  const trimmed = nonEmptyString(value)
  return trimmed || null
}

function workflowRunIdFromTaskId(taskId: string): string | null {
  const runId = taskId.split(':', 1)[0]?.trim() ?? ''
  return UUID_REGEX.test(runId) ? runId : null
}

/**
 * Bind each event in the batch to the JWT's recipe/namespace and host
 * claims so a pod cannot forge events for another tenant or another
 * host. Modeled on the approval route's `canCreateApprovalForRecipe` /
 * `canAccessApprovalBinding` (user-approval-requests.routes.ts:45-105).
 *
 * Rules:
 * - 1st-party sentinel tokens (claims.recipeNamespace === hostsNamespace):
 *   `recipe_name` MUST be null, `source_kind` MUST NOT be "workflow", and
 *   `host_ref` MUST equal `claims.hostRefs[0]` — HCC mints these tokens
 *   with the actual Host CRD name in `hostRefs[0]`.
 * - WRC recipe tokens (claims.recipeNamespace === sandboxNamespace):
 *   `recipe_name` MUST equal `claims.recipeName`, `source_kind` MUST be
 *   "workflow", and `host_ref` MUST equal `claims.hostRefs[0]` (which
 *   WRC mints as `${recipeNamespace}/${recipeName}`). Without the
 *   host_ref check a recipe pod could submit events tagged with a
 *   1st-party host's name and poison its rollups.
 * - Any other namespace is rejected.
 *
 * Returns the first violation found; one forged event fails the whole
 * batch so a misconfigured/compromised reporter surfaces the bug rather
 * than slipping forgeries alongside legit events.
 */
function checkClaimBinding(
  events: unknown[],
  claims: McpHostAccessClaims
): BindingViolation | null {
  const isSentinel = claims.recipeNamespace === config.hostsNamespace
  const isRecipe = claims.recipeNamespace === config.sandboxNamespace
  if (!isSentinel && !isRecipe) {
    return { index: -1, reason: 'unrecognized_token_binding' }
  }

  // Both branches anchor host_ref to the JWT's hostRefs[0]:
  //   sentinel — the Host CRD's metadata.name (e.g. "chatllm")
  //   recipe   — "${recipeNamespace}/${recipeName}" (e.g. "sandbox-recipes/r1")
  // Without this check on the recipe branch, a valid WRC token could submit
  // events with host_ref="chatllm" and poison a 1st-party host's rollup.
  const expectedHostRef = claims.hostRefs[0]

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!e || typeof e !== 'object') {
      // Shape-validated downstream by ingestUsageEvents; skip here.
      continue
    }
    const recipeName = (e as { recipe_name?: unknown }).recipe_name
    const sourceKind = (e as { source_kind?: unknown }).source_kind
    const hostRef = (e as { host_ref?: unknown }).host_ref
    const taskId = nonEmptyString((e as { task_id?: unknown }).task_id)
    const llmSecretName = nonEmptyString((e as { llm_secret_name?: unknown }).llm_secret_name)

    if (isSentinel) {
      if (recipeName != null) {
        return { index: i, reason: 'sentinel_token_with_recipe_name' }
      }
      if (sourceKind === 'workflow') {
        return { index: i, reason: 'sentinel_token_with_workflow_source' }
      }
    } else {
      if (recipeName !== claims.recipeName) {
        return { index: i, reason: 'recipe_token_recipe_name_mismatch' }
      }
      if (sourceKind === 'workflow') {
        if (!UUID_PREFIX_REGEX.test(taskId)) {
          return { index: i, reason: 'recipe_token_missing_canonical_task_id' }
        }
        if (!llmSecretName) {
          return { index: i, reason: 'recipe_token_missing_llm_secret_name' }
        }
      } else if (
        sourceKind !== 'unknown' ||
        (e as { channel_type?: unknown }).channel_type !== 'plugin_workload_sdk' ||
        taskId ||
        !llmSecretName ||
        typeof (e as { prompt_bridge_metadata?: unknown }).prompt_bridge_metadata !== 'object' ||
        (e as { prompt_bridge_metadata?: { invocation_id?: unknown } }).prompt_bridge_metadata
          ?.invocation_id === undefined
      ) {
        return { index: i, reason: 'recipe_token_non_workflow_source' }
      }
    }

    // host_ref binding only fires for events that could pass validation.
    // Missing / non-string host_ref is a shape error the validator rejects;
    // failing here would just confuse "forged" with "malformed".
    if (typeof hostRef === 'string') {
      const trimmed = hostRef.trim()
      if (trimmed && trimmed !== expectedHostRef) {
        return {
          index: i,
          reason: isSentinel
            ? 'sentinel_token_host_ref_mismatch'
            : 'recipe_token_host_ref_mismatch',
        }
      }
    }
  }
  return null
}

async function checkSdkOnlyUsageBinding(
  events: unknown[],
  claims: McpHostAccessClaims,
  db: DbClient
): Promise<BindingViolation | null> {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    if (record.source_kind !== 'unknown') continue
    const metadata = record.prompt_bridge_metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    const invocationId = (metadata as { invocation_id?: unknown }).invocation_id
    if (typeof invocationId !== 'string') continue
    const invocation = await getInvocationById(invocationId, db)
    if (
      !invocation ||
      invocation.recipeNamespace !== claims.recipeNamespace ||
      invocation.recipeName !== claims.recipeName ||
      invocation.method !== 'promptBridge' ||
      // UsageReporter enqueues before the handler's terminal status POST; an
      // in-flight invocation is therefore a valid server-bound usage source.
      !['in_progress', 'complete'].includes(invocation.status) ||
      invocation.authorizationDecision !== 'authorized' ||
      !invocation.promptAuthorization ||
      !invocation.promptAuthorization.authorizedTargetRefs.includes(
        String((metadata as { target_ref?: unknown }).target_ref ?? '')
      )
    ) {
      return { index, reason: 'recipe_token_invalid_sdk_usage_binding' }
    }
  }
  return null
}

function collectWorkflowUsageCandidates(events: unknown[]): WorkflowUsageCandidate[] {
  const candidates: WorkflowUsageCandidate[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!e || typeof e !== 'object') continue

    const sourceKind = (e as { source_kind?: unknown }).source_kind
    if (sourceKind !== 'workflow') continue

    const runId = nonEmptyString((e as { run_id?: unknown }).run_id).toLowerCase()
    const recipeName = nonEmptyString((e as { recipe_name?: unknown }).recipe_name)
    if (!UUID_REGEX.test(runId) || !recipeName) {
      // Shape and JWT-binding validation handle malformed workflow events.
      continue
    }

    candidates.push({
      index: i,
      runId,
      recipeName,
      teamId: nullableString((e as { team_id?: unknown }).team_id),
      userId: nullableString((e as { user_id?: unknown }).user_id),
    })
  }
  return candidates
}

function expectedUsageUserId(binding: {
  actorType: string
  actorId: string | null
}): string | null {
  if (binding.actorType === 'user') return binding.actorId
  if (binding.actorType === 'admin' && binding.actorId) {
    return `${CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX}${binding.actorId}`
  }
  return null
}

async function checkWorkflowRunBinding(
  events: unknown[],
  claims: McpHostAccessClaims,
  db: DbClient
): Promise<{
  violation: WorkflowRunBindingViolation | null
  bindings: Map<string, WorkflowRunBinding>
}> {
  const candidates = collectWorkflowUsageCandidates(events)
  if (candidates.length === 0) return { violation: null, bindings: new Map() }

  const runIds = Array.from(new Set(candidates.map(candidate => candidate.runId)))
  const workflowRunBindings = new WorkflowRunBindingRepository(db)
  const bindings = await workflowRunBindings.resolveMany(runIds)

  for (const candidate of candidates) {
    const binding = bindings.get(candidate.runId)
    if (!binding) {
      return { violation: { index: candidate.index, reason: 'workflow_run_not_found' }, bindings }
    }
    if (
      binding.recipeNamespace !== claims.recipeNamespace ||
      binding.recipeName !== candidate.recipeName
    ) {
      return {
        violation: { index: candidate.index, reason: 'workflow_run_recipe_mismatch' },
        bindings,
      }
    }
    if (candidate.teamId !== binding.usageTeamId) {
      return {
        violation: { index: candidate.index, reason: 'workflow_run_team_mismatch' },
        bindings,
      }
    }
    if (candidate.userId !== expectedUsageUserId(binding)) {
      return {
        violation: { index: candidate.index, reason: 'workflow_run_user_mismatch' },
        bindings,
      }
    }
  }
  return { violation: null, bindings }
}

export function createInternalUsageEventsRouter(): Router {
  const router = Router()

  router.post('/internal/usage/llm/events', requireMcpHostJwt, async (req, res, next) => {
    try {
      const body = req.body
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'invalid_body' })
      }
      const events = (body as { events?: unknown }).events
      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'events_required' })
      }
      if (events.length > MAX_EVENTS_PER_REQUEST) {
        return res.status(400).json({
          error: 'batch_too_large',
          max: MAX_EVENTS_PER_REQUEST,
          got: events.length,
        })
      }
      const violation = checkClaimBinding(events, req.mcpHostJwt!)
      if (violation) {
        return res.status(403).json({ error: 'claim_binding_mismatch', ...violation })
      }
      const transactionResult = await withTraceIngestTransaction(async db => {
        const sdkBinding = await checkSdkOnlyUsageBinding(events, req.mcpHostJwt!, db)
        if (sdkBinding) return { violation: sdkBinding }
        const workflowBinding = await checkWorkflowRunBinding(events, req.mcpHostJwt!, db)
        if (workflowBinding.violation) return { violation: workflowBinding.violation }

        const ingest = await ingestUsageEventsInTransaction(events, db)
        await projectAcceptedUsageEvents(db, ingest.acceptedEvents, workflowBinding.bindings, {
          recipeNamespace: req.mcpHostJwt!.recipeNamespace,
          recipeName: req.mcpHostJwt!.recipeName,
          hostRef: req.mcpHostJwt!.hostRefs[0],
        })
        return { result: ingest.result }
      })
      if ('violation' in transactionResult) {
        return res.status(403).json({
          error: 'workflow_usage_binding_mismatch',
          ...transactionResult.violation,
        })
      }
      return res.status(200).json(transactionResult.result)
    } catch (error) {
      return next(error)
    }
  })

  return router
}
