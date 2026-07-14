import type { K8sGateway } from '../../k8s.js'
import { getMcpHostCallerKey } from '../../utils/auth/mcpHostJwtToken.js'
import {
  ApprovalConsumeError,
  type WorkflowTriggerGrantResult,
  allowlistCheck,
  assertApprovalTriggerBinding,
} from '../userApprovalRequestService.js'
import {
  type WorkflowRunActorType,
  WorkflowRunIdempotencyConflictError,
  type WorkflowRunRow,
  computeWorkflowRunPayloadHash,
  createApprovedRun,
  createRun,
} from '../workflowRunService.js'
import type { TriggerAllowedActor, TriggerBody, WorkflowRouteCaller } from './types.js'
import {
  getMcpHostWorkflowPrincipalId,
  getTriggerActorForCaller,
  getWorkflowPrincipalId,
} from './workflowCallerService.js'
import {
  ensureRecipeAuthorized,
  findRecipeNamespace,
  getMaxRunDurationSeconds,
  getOnDemandAllowedActors,
  getOnDemandRequiresApproval,
  getTtlSecondsAfterFinished,
  getWorkflowRuntimeReadiness,
  hasOnDemandTrigger,
  isRecipeNamespaceAllowed,
} from './workflowRecipeAccessService.js'
import {
  type WorkflowTriggerApprovalRunIntent,
  createWorkflowTriggerApprovalRequest,
} from './workflowTriggerApprovalService.js'
import { resolveWorkflowTriggerGrant } from './workflowTriggerGrantResolver.js'

const CONTROL_PLANE_ADMIN_USAGE_TEAM_ID = 'control-plane-admin-ui'

export class WorkflowTriggerHttpError extends Error {
  status: number
  body: Record<string, unknown>

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error || 'workflow_trigger_failed'))
    this.name = 'WorkflowTriggerHttpError'
    this.status = status
    this.body = body
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function approvalConsumeHttpStatus(err: ApprovalConsumeError): number {
  switch (err.code) {
    case 'approval_request_not_found':
      return 404
    case 'approval_recipe_mismatch':
    case 'approval_trigger_binding_mismatch':
    case 'approval_target_user_mismatch':
    case 'approval_requester_mismatch':
    case 'approval_target_missing':
    case 'approval_trigger_grant_missing':
    case 'approval_target_not_allowed':
    case 'approval_team_decider_not_active':
      return 403
    case 'approval_expired':
    case 'approval_status_not_consumable':
      return 409
  }
}

function approvalConsumeResponse(err: ApprovalConsumeError): Record<string, unknown> {
  return {
    error: err.code,
    ...(err.approvalStatus ? { approvalStatus: err.approvalStatus } : {}),
  }
}

function getWorkflowTeamIdForCaller(caller: WorkflowRouteCaller): string | null {
  if (caller.kind === 'user-session') return caller.claims.teamId
  return null
}

function getWorkflowUsageTeamIdForCaller(caller: WorkflowRouteCaller): string | null {
  if (caller.kind === 'user-session') return caller.claims.teamId
  if (caller.kind === 'admin-ui') return CONTROL_PLANE_ADMIN_USAGE_TEAM_ID
  return null
}

function getExternalWorkflowTriggerCallerKey(
  caller: Extract<WorkflowRouteCaller, { kind: 'user-session' }>
): string {
  return `external-rest-api:user:${caller.claims.userId}:team:${caller.claims.teamId}`
}

type WorkflowTriggerResult =
  | { kind: 'run'; row: WorkflowRunRow; created: boolean }
  | {
      kind: 'approval'
      approvalRequestId: string
      status: string
      expiresAt?: string
      existing?: true
    }

type McpHostApprovalTriggerContext = {
  approvalRequestId: string
  callerKey: string
}

type WorkflowTriggerRecipeValidation = {
  requiresApproval: boolean
  maxRunDurationSeconds: number | null
  ttlSecondsAfterFinished: number | null
}

async function validateWorkflowTriggerRecipeForActor(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  requestedActor: TriggerAllowedActor
}): Promise<WorkflowTriggerRecipeValidation> {
  const { gateway, recipeNamespace: ns, recipeName: name, requestedActor } = params
  if (!isRecipeNamespaceAllowed(ns)) {
    throw new WorkflowTriggerHttpError(404, { error: `Recipe ${ns}/${name} not found` })
  }

  const found = await findRecipeNamespace(gateway, name, ns)
  if (!found || found.ns !== ns) {
    throw new WorkflowTriggerHttpError(404, { error: `Recipe ${ns}/${name} not found` })
  }

  if (!hasOnDemandTrigger(found.resource)) {
    throw new WorkflowTriggerHttpError(400, {
      error: 'Workflow does not declare an onDemand trigger',
    })
  }
  const runtimeReadiness = await getWorkflowRuntimeReadiness(gateway, found.resource)
  if (!runtimeReadiness.ready) {
    throw new WorkflowTriggerHttpError(409, {
      error: runtimeReadiness.error,
      reason: runtimeReadiness.reason,
      message: runtimeReadiness.message,
    })
  }
  const allowedActors = getOnDemandAllowedActors(found.resource)
  if (allowedActors && !allowedActors.includes(requestedActor)) {
    throw new WorkflowTriggerHttpError(403, {
      error: `Actor "${requestedActor}" is not allowed to trigger this workflow`,
    })
  }

  return {
    requiresApproval: getOnDemandRequiresApproval(found.resource),
    maxRunDurationSeconds: getMaxRunDurationSeconds(found.resource),
    ttlSecondsAfterFinished: getTtlSecondsAfterFinished(found.resource),
  }
}

export async function validateMcpHostWorkflowTriggerApprovalRunIntent(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  callerKey: string
  body: TriggerBody
  requesterUserId?: string
  targetUserId?: string
  targetTeamId?: string
}): Promise<WorkflowTriggerApprovalRunIntent> {
  const requesterUserId = params.requesterUserId?.trim() || ''
  if (requesterUserId && !isUuid(requesterUserId)) {
    throw new WorkflowTriggerHttpError(400, { error: 'Invalid requesterUserId format' })
  }
  if (params.targetUserId && requesterUserId && params.targetUserId !== requesterUserId) {
    throw new WorkflowTriggerHttpError(400, { error: 'requester_user_target_mismatch' })
  }
  const requestedActor: TriggerAllowedActor = requesterUserId ? 'user' : 'autonomous'
  const triggerRecipe = await validateWorkflowTriggerRecipeForActor({
    gateway: params.gateway,
    recipeNamespace: params.recipeNamespace,
    recipeName: params.recipeName,
    requestedActor,
  })

  return {
    actorType: requesterUserId ? 'user' : 'autonomous',
    actorId: requesterUserId || getMcpHostWorkflowPrincipalId(params.callerKey),
    teamId: params.targetTeamId ?? null,
    usageTeamId: params.targetTeamId ?? null,
    triggerSource: requesterUserId ? 'onDemand' : 'autonomous',
    inputs: params.body.inputs ?? {},
    intermediateParameters: params.body.intermediateParameters ?? null,
    outputOverrides: params.body.outputOverrides ?? null,
    maxDurationSeconds: triggerRecipe.maxRunDurationSeconds,
    ttlSecondsAfterFinished: triggerRecipe.ttlSecondsAfterFinished,
  }
}

export async function triggerWorkflow(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  body: TriggerBody
  idempotencyKey: string
  correlationId?: string
}): Promise<WorkflowTriggerResult> {
  const { gateway, caller, recipeNamespace: ns, recipeName: name, body } = params
  const idempotencyKey = params.idempotencyKey.trim()

  if (!isRecipeNamespaceAllowed(ns)) {
    throw new WorkflowTriggerHttpError(404, { error: `Recipe ${ns}/${name} not found` })
  }
  if (!idempotencyKey) {
    throw new WorkflowTriggerHttpError(400, { error: 'Idempotency-Key header is required' })
  }
  if (idempotencyKey.length > 256) {
    throw new WorkflowTriggerHttpError(400, {
      error: 'Idempotency-Key must not exceed 256 characters',
    })
  }

  let mcpHostApprovalContext: McpHostApprovalTriggerContext | null = null
  if (caller.kind === 'mcp-host-control') {
    const callerKey = getMcpHostCallerKey(caller.claims)
    const approvalRequestId =
      typeof body.approvalRequestId === 'string' ? body.approvalRequestId.trim() : ''
    if (!isUuid(approvalRequestId)) {
      throw new WorkflowTriggerHttpError(400, {
        error: 'approvalRequestId is required for mcp-host-control triggers',
      })
    }
    try {
      await assertApprovalTriggerBinding({
        approvalRequestId,
        recipeNamespace: ns,
        recipeName: name,
        callerKey,
      })
    } catch (err) {
      if (err instanceof ApprovalConsumeError) {
        throw new WorkflowTriggerHttpError(
          approvalConsumeHttpStatus(err),
          approvalConsumeResponse(err)
        )
      }
      throw err
    }
    mcpHostApprovalContext = { approvalRequestId, callerKey }
  }

  let userSessionGrant: WorkflowTriggerGrantResult | null = null
  let recipeAuthorized = false
  if (caller.kind === 'admin-ui') {
    recipeAuthorized = true
  } else if (caller.kind === 'user-session') {
    userSessionGrant = await resolveWorkflowTriggerGrant({
      userId: caller.claims.userId,
      recipeNamespace: ns,
      recipeName: name,
      mode: 'direct-user-session',
      currentTeamId: caller.claims.teamId,
    })
    recipeAuthorized = userSessionGrant.granted
  } else {
    recipeAuthorized = await ensureRecipeAuthorized(caller, ns, name)
  }
  // MCP-host trigger authorization is approval-bound: createApprovedRun consumes
  // the typed approval intent and resolves the user/team trigger grant. The host
  // ref is the caller binding, not a requirement that the host equal the target workflow.
  const mcpHostApprovalBoundAttempt = caller.kind === 'mcp-host-control'
  if (!recipeAuthorized && !mcpHostApprovalBoundAttempt) {
    throw new WorkflowTriggerHttpError(403, { error: 'Not authorized to trigger this recipe' })
  }

  const principalId = getWorkflowPrincipalId(caller)
  const teamId = getWorkflowTeamIdForCaller(caller)
  const usageTeamId = getWorkflowUsageTeamIdForCaller(caller)
  const dbActorType: WorkflowRunActorType =
    caller.kind === 'mcp-host-control'
      ? 'autonomous'
      : caller.kind === 'admin-ui'
        ? 'admin'
        : 'user'
  const triggerSource = caller.kind === 'mcp-host-control' ? 'autonomous' : 'onDemand'
  const requestedActor = getTriggerActorForCaller(caller)
  const triggerRecipe = await validateWorkflowTriggerRecipeForActor({
    gateway,
    recipeNamespace: ns,
    recipeName: name,
    requestedActor,
  })
  const maxRunDurationSeconds = triggerRecipe.maxRunDurationSeconds
  const ttlSecondsAfterFinished = triggerRecipe.ttlSecondsAfterFinished

  // Trigger-level approval is the Desktop user-session consent path. Admin UI
  // callers are already authenticated control-plane operators and continue to
  // create admin-attributed runs without impersonating or consuming user approvals.
  if (caller.kind === 'user-session' && triggerRecipe.requiresApproval) {
    if (!userSessionGrant?.granted) {
      throw new WorkflowTriggerHttpError(403, { error: 'Not authorized to trigger this recipe' })
    }

    const targetUserId = userSessionGrant.source === 'user' ? userSessionGrant.userId : undefined
    const targetTeamId = userSessionGrant.source === 'team' ? userSessionGrant.teamId : undefined
    const targetAllowed = await allowlistCheck(ns, name, targetUserId, targetTeamId)
    if (!targetAllowed) {
      throw new WorkflowTriggerHttpError(403, {
        error: 'approval_target_not_allowed',
        message:
          userSessionGrant.source === 'team'
            ? 'The current team has trigger access but is not configured as an approval target for this workflow.'
            : 'The current user is not configured as an approval target for this workflow.',
      })
    }

    const callerKey = getExternalWorkflowTriggerCallerKey(caller)
    const approval = await createWorkflowTriggerApprovalRequest({
      recipeNamespace: ns,
      recipeName: name,
      callerKey,
      targetUserId,
      targetTeamId,
      payload: {
        message: `Approve ${ns}/${name} workflow trigger.`,
        metadata: {
          workflowTrigger: {
            namespace: ns,
            name,
            caller: callerKey,
          },
          workflowTriggerRequest: {
            source: 'external-rest-api',
            actorType: dbActorType,
          },
        },
      },
      idempotencyKey,
      correlation: { taskId: idempotencyKey },
      runIntent: {
        actorType: dbActorType,
        actorId: principalId,
        teamId,
        usageTeamId,
        triggerSource,
        inputs: body.inputs ?? {},
        intermediateParameters: body.intermediateParameters ?? null,
        outputOverrides: body.outputOverrides ?? null,
        maxDurationSeconds: maxRunDurationSeconds,
        ttlSecondsAfterFinished,
      },
    })

    if (approval.kind === 'mismatch') {
      throw new WorkflowTriggerHttpError(409, {
        error: 'idempotency_key_payload_mismatch',
        approvalRequestId: approval.approvalRequestId,
        status: approval.status,
        ...(approval.reason === 'missing_run_intent'
          ? {
              message:
                'The Idempotency-Key matches an approval that is missing typed workflow run intent. Retry with a new Idempotency-Key.',
            }
          : {}),
      })
    }
    if (approval.kind === 'run') {
      return { kind: 'run', row: approval.row, created: approval.created }
    }

    return {
      kind: 'approval',
      approvalRequestId: approval.approvalRequestId,
      status: approval.status,
      expiresAt: approval.expiresAt,
      ...(approval.existing ? { existing: true } : {}),
    }
  }

  if (caller.kind === 'mcp-host-control') {
    const { approvalRequestId, callerKey } = mcpHostApprovalContext!

    const legacyPayloadHash = computeWorkflowRunPayloadHash({
      recipeNamespace: ns,
      recipeName: name,
      actorType: dbActorType,
      actorId: principalId,
      idempotencyKey,
      triggerSource,
      approvalRequestId,
      callerKey,
      inputs: body.inputs ?? {},
      intermediateParameters: body.intermediateParameters ?? null,
      outputOverrides: body.outputOverrides ?? null,
    })

    try {
      // Current approvals use the persisted run intent inside createApprovedRun;
      // this fallback only preserves legacy approvals without typed intent rows.
      const legacyFallbackRunInput = {
        recipe_namespace: ns,
        recipe_name: name,
        actor_type: dbActorType,
        team_id: teamId,
        usage_team_id: usageTeamId,
        actor_id: principalId,
        idempotency_key: idempotencyKey,
        trigger_source: triggerSource,
        inputs: body.inputs ?? {},
        intermediate_parameters: body.intermediateParameters ?? null,
        output_overrides: body.outputOverrides ?? null,
        max_duration_seconds: maxRunDurationSeconds,
        ttl_seconds_after_finished: ttlSecondsAfterFinished,
        approval_request_id: approvalRequestId,
        idempotency_payload_hash: legacyPayloadHash,
        approval_caller_key: callerKey,
        correlation_id: params.correlationId ?? idempotencyKey,
      }
      const result = await createApprovedRun(legacyFallbackRunInput)
      return { kind: 'run', ...result }
    } catch (err) {
      if (err instanceof WorkflowRunIdempotencyConflictError) {
        throw new WorkflowTriggerHttpError(409, { error: 'idempotency_key_payload_mismatch' })
      }
      if (err instanceof ApprovalConsumeError) {
        throw new WorkflowTriggerHttpError(
          approvalConsumeHttpStatus(err),
          approvalConsumeResponse(err)
        )
      }
      throw err
    }
  }

  try {
    const result = await createRun({
      recipe_namespace: ns,
      recipe_name: name,
      actor_type: dbActorType,
      team_id: teamId,
      usage_team_id: usageTeamId,
      actor_id: principalId,
      idempotency_key: idempotencyKey,
      trigger_source: triggerSource,
      inputs: body.inputs ?? {},
      intermediate_parameters: body.intermediateParameters ?? null,
      output_overrides: body.outputOverrides ?? null,
      max_duration_seconds: maxRunDurationSeconds,
      ttl_seconds_after_finished: ttlSecondsAfterFinished,
    })
    return { kind: 'run', ...result }
  } catch (err) {
    if (err instanceof WorkflowRunIdempotencyConflictError) {
      throw new WorkflowTriggerHttpError(409, { error: 'idempotency_key_payload_mismatch' })
    }
    throw err
  }
}
