import { createHash } from 'node:crypto'
import { getMcpHostRuntimeCallerKey } from '../../workflow/mcpHostRuntimeJwt'
import { gateStep } from '../../workflow/userApprovalRequester'
import { WorkflowTool } from './workflowBaseTool'
import { shouldResolveEffectiveWorkflowTargets } from './workflowEffectiveTargets'
import { approvalAuth, getObject, getString, requireWorkflowRef } from './workflowShared'
import { workflowTriggerApprovalExecutionId } from './workflowTriggerApprovalIdentity'
import {
  AUTHENTICATED_CHAT_APPROVAL_TIMEOUT_SECONDS,
  type EffectiveWorkflowTriggerParams,
  isApprovalTargetFallbackError,
  resolveAuthenticatedChatWorkflowTriggerParams,
  validateAuthenticatedChatWorkflowTriggerParams,
} from './workflowTriggerTargetResolution'

export class WorkflowTriggerTool extends WorkflowTool {
  private workflowArtifactScope: Record<string, unknown> | undefined

  name(): string {
    return 'workflow_trigger'
  }

  description(): string {
    return 'Request approval and trigger a workflow recipe after approval is granted.'
  }

  requiresApproval(): boolean {
    if (
      this.workflowCallerContext?.originChannelType === 'telegram' ||
      this.workflowCallerContext?.originChannelType === 'slack'
    ) {
      return false
    }
    return true
  }

  parametersSchema(): Record<string, unknown> {
    if (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId) {
      const properties: Record<string, unknown> = {
        name: { type: 'string', description: 'WorkflowRecipe name.' },
        inputs: { type: 'object', description: 'Workflow business inputs.' },
      }
      if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
        properties.targetLabel = {
          type: 'string',
          description:
            'Human target label returned by workflow_list, such as Personal or a team name.',
        }
      }
      return {
        type: 'object',
        properties,
        required: ['name'],
      }
    }
    return {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'WorkflowRecipe namespace.' },
        name: { type: 'string', description: 'WorkflowRecipe name.' },
        targetUserId: { type: 'string', description: 'User UUID to request approval from.' },
        targetTeamId: { type: 'string', description: 'Team UUID to request approval from.' },
        approvalMessage: { type: 'string', description: 'Message shown to the approver.' },
        timeoutSeconds: { type: 'number', description: 'Approval polling timeout in seconds.' },
        inputs: { type: 'object', description: 'Workflow inputs.' },
        intermediateParameters: {
          type: 'object',
          description: 'Workflow intermediate parameters.',
        },
        outputOverrides: { type: 'object', description: 'Workflow output overrides.' },
      },
      required: ['namespace', 'name'],
    }
  }

  private async effectiveParamsForResolvedAuthenticatedChat(
    params: Record<string, unknown>
  ): Promise<EffectiveWorkflowTriggerParams | Record<string, unknown>> {
    return resolveAuthenticatedChatWorkflowTriggerParams({
      client: this.client,
      workflowCallerContext: this.workflowCallerContext,
      triggerParams: params,
    })
  }

  private effectiveParamSet(params: Record<string, unknown>): EffectiveWorkflowTriggerParams[] {
    if (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId) {
      const { namespace, name, inputs } = validateAuthenticatedChatWorkflowTriggerParams(
        params,
        this.workflowCallerContext
      )
      const authenticatedTargetUserId = this.workflowCallerContext.targetUserId
      const authenticatedTargetTeamId = this.workflowCallerContext.targetTeamId
      const base = {
        namespace,
        name,
        timeoutSeconds: AUTHENTICATED_CHAT_APPROVAL_TIMEOUT_SECONDS,
        inputs,
      }
      if (authenticatedTargetUserId && authenticatedTargetTeamId) {
        return [
          { ...base, targetUserId: authenticatedTargetUserId },
          { ...base, targetTeamId: authenticatedTargetTeamId },
        ]
      }
      if (!authenticatedTargetUserId && !authenticatedTargetTeamId) {
        throw new Error('authenticated conversation is missing workflow approval target')
      }
      return [
        authenticatedTargetUserId
          ? { ...base, targetUserId: authenticatedTargetUserId }
          : { ...base, targetTeamId: authenticatedTargetTeamId },
      ]
    }

    const { namespace, name } = requireWorkflowRef(params)
    return [
      {
        namespace,
        name,
        targetUserId: getString(params, 'targetUserId') || undefined,
        targetTeamId: getString(params, 'targetTeamId') || undefined,
        approvalMessage: getString(params, 'approvalMessage') || undefined,
        timeoutSeconds:
          typeof params.timeoutSeconds === 'number' && Number.isFinite(params.timeoutSeconds)
            ? Math.max(1, Math.floor(params.timeoutSeconds))
            : undefined,
        inputs: getObject(params, 'inputs') || undefined,
        intermediateParameters: getObject(params, 'intermediateParameters') || undefined,
        outputOverrides: getObject(params, 'outputOverrides') || undefined,
      },
    ]
  }

  async run(params: Record<string, unknown>): Promise<unknown> {
    if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
      const resolved = await this.effectiveParamsForResolvedAuthenticatedChat(params)
      if (!('namespace' in resolved) || !('name' in resolved)) return resolved
      return this.runWithEffectiveParams(resolved as EffectiveWorkflowTriggerParams)
    }

    const candidates = this.effectiveParamSet(params)
    let lastError: unknown
    for (const effective of candidates) {
      try {
        return await this.runWithEffectiveParams(effective)
      } catch (error) {
        lastError = error
        if (candidates.length === 1 || !isApprovalTargetFallbackError(error)) throw error
      }
    }
    throw lastError
  }

  private async runWithEffectiveParams(
    effective: EffectiveWorkflowTriggerParams
  ): Promise<unknown> {
    const { namespace, name } = effective
    const targetUserId = effective.targetUserId
    const targetTeamId = effective.targetTeamId
    if (Boolean(targetUserId) === Boolean(targetTeamId)) {
      throw new Error('workflow_trigger requires exactly one of targetUserId or targetTeamId')
    }

    const workflowToken = await this.workflowControlTokenProvider.getWorkflowControlToken()
    const workflowControlCaller = getMcpHostRuntimeCallerKey(workflowToken)
    if (!workflowControlCaller) {
      throw new Error('workflow-control token must include hostRefs[0] for workflow_trigger')
    }

    const auth = approvalAuth(this.getEnv)
    if (auth.hostRef !== workflowControlCaller) {
      throw new Error(
        'workflow runtime token and workflow-control token caller bindings must match'
      )
    }
    const caller = workflowControlCaller
    const timeout = effective.timeoutSeconds
    const message =
      effective.approvalMessage ||
      (this.workflowCallerContext
        ? `Approve workflow trigger for ${name}`
        : `Approve workflow trigger for ${namespace}/${name}`)
    const providerBinding =
      this.workflowCallerContext?.providerChannelId &&
      (this.workflowCallerContext.originChannelType === 'telegram' ||
        this.workflowCallerContext.originChannelType === 'slack')
        ? {
            medium: this.workflowCallerContext.originChannelType,
            providerChannelId: this.workflowCallerContext.providerChannelId,
            ...(this.workflowCallerContext.providerWorkspaceId
              ? { providerWorkspaceId: this.workflowCallerContext.providerWorkspaceId }
              : {}),
            ...(this.workflowCallerContext.sourceThreadId
              ? { providerThreadId: this.workflowCallerContext.sourceThreadId }
              : {}),
          }
        : undefined
    const approvalExecutionId = workflowTriggerApprovalExecutionId({
      caller,
      namespace,
      name,
      targetUserId,
      targetTeamId,
      inputs: effective.inputs,
      workflowCallerContext: this.workflowCallerContext,
    })
    if (this.workflowCallerContext && !approvalExecutionId) {
      throw new Error('workflow_trigger requires a stable approval execution id')
    }
    const runIdempotencyKey = approvalExecutionId
      ? `workflow-trigger-${createHash('sha256').update(approvalExecutionId).digest('hex')}`
      : undefined

    const runtimeMcpHostRef = this.runtimeMcpHostRef()
    const approval = await gateStep(
      {
        stepId: `workflow_trigger:${namespace}/${name}`,
        executionId: approvalExecutionId,
        ...(runIdempotencyKey ? { idempotencyKeyOverride: runIdempotencyKey } : {}),
        ...(runtimeMcpHostRef ? { runtimeMcpHostRef } : {}),
        target: targetUserId ? { userId: targetUserId } : { teamId: targetTeamId },
        message,
        timeoutSeconds: timeout,
        approvalRecipe: {
          recipeNamespace: namespace,
          recipeName: name,
        },
        payloadMetadata: {
          workflowTrigger: {
            namespace,
            name,
            caller,
            ...(this.workflowCallerContext?.targetUserId
              ? { requesterUserId: this.workflowCallerContext.targetUserId }
              : {}),
            ...(this.workflowCallerContext?.conversationId
              ? { conversationId: this.workflowCallerContext.conversationId }
              : {}),
            ...(providerBinding ? { providerBinding } : {}),
          },
        },
        ...(runIdempotencyKey
          ? {
              workflowTriggerRunIntent: {
                inputs: effective.inputs ?? {},
                intermediateParameters: effective.intermediateParameters ?? null,
                outputOverrides: effective.outputOverrides ?? null,
              },
            }
          : {}),
        allowConsumedTerminal: true,
      },
      auth
    )
    if (!approval.approvalRequestId) {
      throw new Error('workflow_trigger approval completed without approvalRequestId')
    }

    const idempotencyKey =
      runIdempotencyKey ||
      `workflow-trigger-${createHash('sha256')
        .update(`${approval.approvalRequestId}:${namespace}:${name}:${caller}`)
        .digest('hex')}`
    const body: Record<string, unknown> = {
      approvalRequestId: approval.approvalRequestId,
    }
    if (effective.inputs) body.inputs = effective.inputs
    if (effective.intermediateParameters) {
      body.intermediateParameters = effective.intermediateParameters
    }
    if (effective.outputOverrides) body.outputOverrides = effective.outputOverrides

    const run = await this.client.request(
      `/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/trigger`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      }
    )
    const runRecord = run && typeof run === 'object' ? (run as Record<string, unknown>) : {}
    const runId = typeof runRecord.id === 'string' ? runRecord.id : ''
    const triggeredAt =
      typeof runRecord.triggeredAt === 'string' ? runRecord.triggeredAt : undefined
    const requestedAt = triggeredAt ? Date.parse(triggeredAt) : undefined
    this.workflowArtifactScope = runId
      ? {
          workflowArtifactScope: {
            namespace,
            name,
            label: name,
            runId,
            ...(requestedAt !== undefined && Number.isFinite(requestedAt) ? { requestedAt } : {}),
          },
        }
      : undefined
    return {
      workflowName: name,
      ...(this.workflowCallerContext && effective.targetLabel
        ? { target: { label: effective.targetLabel } }
        : {}),
      phase: typeof runRecord.phase === 'string' ? runRecord.phase : undefined,
      triggeredAt,
      startedAt: typeof runRecord.startedAt === 'string' ? runRecord.startedAt : null,
      completedAt: typeof runRecord.completedAt === 'string' ? runRecord.completedAt : null,
      message: typeof runRecord.message === 'string' ? runRecord.message : null,
      ...(this.workflowCallerContext
        ? {}
        : {
            runId: runId || undefined,
            workflowNamespace: namespace,
          }),
    }
  }

  private runtimeMcpHostRef(): string | undefined {
    const namespace = this.getEnv('CLERUM_WORKFLOW_NAMESPACE')?.trim()
    const recipeName = this.getEnv('CLERUM_WORKFLOW_RECIPE')?.trim()
    if (!namespace || !recipeName) return undefined
    if (namespace !== 'sandbox-recipes') return undefined
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(recipeName)) return undefined
    return `${namespace}/${recipeName}`
  }

  protected metadataForResult(_data: unknown): Record<string, unknown> | undefined {
    return this.workflowArtifactScope
  }
}
