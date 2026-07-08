import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { isHostRefAuthorized } from '../../utils/auth/mcpHostJwtToken.js'
import { K8sNotFoundError } from '../resourceService.js'
import type { RuntimeWorkflowDto, TriggerAllowedActor, WorkflowRouteCaller } from './types.js'
import {
  listApprovalTargetWorkflowTriggerKeys,
  resolveWorkflowTriggerGrant,
} from './workflowTriggerGrantResolver.js'

export const WORKFLOW_RECIPE_PLURAL = 'workflowrecipes' as const
export const RECIPE_NAMESPACES: readonly string[] = [config.sandboxNamespace] as const
export const MAX_TTL_SECONDS_AFTER_FINISHED = 30 * 24 * 60 * 60
const SHARED_MCP_HOST_RECIPE_NAME = 'standalone'
const WORKFLOW_CONTEXT_NAME_MAX_LENGTH = 63
const WORKFLOW_CONTEXT_NAME_HASH_LENGTH = 8

export type WorkflowRuntimeReadiness =
  | { ready: true }
  | { ready: false; error: 'workflow_runtime_not_ready'; message: string; reason: string }

export type WorkflowApprovalTarget = {
  targetUserId?: string
  targetTeamId?: string
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function isRecipeNamespaceAllowed(ns: string): boolean {
  return RECIPE_NAMESPACES.includes(ns)
}

export function isSharedMcpHostControlCaller(caller: WorkflowRouteCaller): boolean {
  return (
    caller.kind === 'mcp-host-control' &&
    caller.claims.recipeNamespace === config.hostsNamespace &&
    caller.claims.recipeName === SHARED_MCP_HOST_RECIPE_NAME
  )
}

export function isMcpHostDirectlyAuthorizedForRecipe(
  caller: WorkflowRouteCaller,
  recipeNamespace: string,
  recipeName: string
): boolean {
  if (caller.kind !== 'mcp-host-control') return false
  return isHostRefAuthorized(caller.claims, recipeNamespace, recipeName)
}

export async function findRecipeNamespace(
  gateway: K8sGateway,
  name: string,
  preferredNs?: string
): Promise<{ ns: string; resource: Record<string, unknown> } | null> {
  if (preferredNs) {
    try {
      const resource = await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, preferredNs)
      return { ns: preferredNs, resource: resource as Record<string, unknown> }
    } catch (err) {
      if (!(err instanceof K8sNotFoundError)) throw err
    }
  }

  const namespacesToSearch = preferredNs
    ? RECIPE_NAMESPACES.filter(ns => ns !== preferredNs)
    : [...RECIPE_NAMESPACES]

  const results = await Promise.allSettled(
    namespacesToSearch.map(ns => gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns))
  )
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      return { ns: namespacesToSearch[i], resource: result.value as Record<string, unknown> }
    }
    if (result.status === 'rejected' && !(result.reason instanceof K8sNotFoundError)) {
      throw result.reason
    }
  }
  return null
}

async function listWorkflowRecipeResources(
  gateway: K8sGateway
): Promise<Record<string, unknown>[]> {
  const byNamespace = await Promise.all(
    RECIPE_NAMESPACES.map(ns =>
      gateway.listResource(WORKFLOW_RECIPE_PLURAL, ns).catch(err => {
        if (err instanceof K8sNotFoundError) return []
        throw err
      })
    )
  )
  return byNamespace.flat() as Record<string, unknown>[]
}

function filterAllowedRecipeKeys(keys: Set<string>): Set<string> {
  return new Set([...keys].filter(key => isRecipeNamespaceAllowed(key.split('/', 1)[0] ?? '')))
}

export async function getApprovalTargetAuthorizedRecipeKeys(
  approvalTarget: WorkflowApprovalTarget
): Promise<Set<string>> {
  if (approvalTarget.targetUserId) {
    const keys = await listApprovalTargetWorkflowTriggerKeys({
      mode: 'approval-target-user',
      userId: approvalTarget.targetUserId,
    })
    return filterAllowedRecipeKeys(keys)
  }

  if (approvalTarget.targetTeamId) {
    const keys = await listApprovalTargetWorkflowTriggerKeys({
      mode: 'approval-target-team',
      targetTeamId: approvalTarget.targetTeamId,
    })
    return filterAllowedRecipeKeys(keys)
  }

  return new Set()
}

export async function getAuthorizedRecipeResources(
  caller: WorkflowRouteCaller,
  gateway: K8sGateway,
  approvalTarget: WorkflowApprovalTarget = {}
): Promise<Record<string, unknown>[]> {
  if (caller.kind === 'admin-ui') {
    return listWorkflowRecipeResources(gateway)
  }

  if (caller.kind === 'mcp-host-control') {
    if (isSharedMcpHostControlCaller(caller)) {
      if (!approvalTarget.targetUserId && !approvalTarget.targetTeamId) {
        return []
      }
      const targetAuthorizedKeys = await getApprovalTargetAuthorizedRecipeKeys(approvalTarget)
      return (await listWorkflowRecipeResources(gateway)).filter(resource => {
        const key = `${getResourceNamespace(resource)}/${getResourceName(resource)}`
        return targetAuthorizedKeys.has(key)
      })
    }

    const recipes = await Promise.all(
      caller.claims.hostRefs.map(async hostRef => {
        const [ns, name] = hostRef.split('/', 2)
        if (!ns || !name || !isRecipeNamespaceAllowed(ns)) return null
        try {
          return (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
            string,
            unknown
          >
        } catch (err) {
          if (err instanceof K8sNotFoundError) return null
          throw err
        }
      })
    )
    const hostRefRecipes = recipes.filter(Boolean) as Record<string, unknown>[]
    if (!approvalTarget.targetUserId && !approvalTarget.targetTeamId) {
      return hostRefRecipes
    }

    const hostRefKeys = new Set(
      hostRefRecipes.map(
        resource => `${getResourceNamespace(resource)}/${getResourceName(resource)}`
      )
    )
    const targetAuthorizedKeys = await getApprovalTargetAuthorizedRecipeKeys(approvalTarget)
    const targetVisible = (await listWorkflowRecipeResources(gateway)).filter(resource => {
      const key = `${getResourceNamespace(resource)}/${getResourceName(resource)}`
      return !hostRefKeys.has(key) && targetAuthorizedKeys.has(key)
    })
    return [...hostRefRecipes, ...targetVisible]
  }

  const grants = await pool.query(
    `SELECT recipe_namespace, recipe_name
       FROM user_workflow_triggers
      WHERE user_id = $1
     UNION
     SELECT twt.recipe_namespace, twt.recipe_name
       FROM team_workflow_triggers twt
      JOIN team_members tm
         ON tm.team_id = twt.team_id
        AND tm.user_id = $1
        AND tm.status = 'active'
      WHERE $2::uuid IS NOT NULL
        AND twt.team_id = $2::uuid`,
    [caller.claims.userId, caller.claims.teamId]
  )

  const recipes = await Promise.all(
    grants.rows.map(async row => {
      const recipeNamespace = String(row.recipe_namespace || '')
      if (!isRecipeNamespaceAllowed(recipeNamespace)) return null
      try {
        return (await gateway.getResource(
          WORKFLOW_RECIPE_PLURAL,
          row.recipe_name,
          recipeNamespace
        )) as Record<string, unknown>
      } catch (err) {
        if (err instanceof K8sNotFoundError) return null
        throw err
      }
    })
  )

  return recipes.filter(Boolean) as Record<string, unknown>[]
}

export async function ensureRecipeAuthorized(
  caller: WorkflowRouteCaller,
  recipeNamespace: string,
  recipeName: string,
  approvalTarget: WorkflowApprovalTarget = {}
): Promise<boolean> {
  if (!isRecipeNamespaceAllowed(recipeNamespace)) return false
  if (caller.kind === 'admin-ui') return true
  if (caller.kind === 'mcp-host-control') {
    if (isMcpHostDirectlyAuthorizedForRecipe(caller, recipeNamespace, recipeName)) return true
    return isApprovalTargetAuthorizedForRecipe(recipeNamespace, recipeName, approvalTarget)
  }

  const grant = await resolveWorkflowTriggerGrant({
    userId: caller.claims.userId,
    recipeNamespace,
    recipeName,
    mode: 'direct-user-session',
    currentTeamId: caller.claims.teamId,
  })
  return grant.granted
}

async function isApprovalTargetAuthorizedForRecipe(
  recipeNamespace: string,
  recipeName: string,
  approvalTarget: WorkflowApprovalTarget
): Promise<boolean> {
  if (!isRecipeNamespaceAllowed(recipeNamespace)) return false

  if (approvalTarget.targetUserId) {
    const result = await pool.query(
      `SELECT 1
         FROM user_workflow_triggers
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND user_id = $3
        LIMIT 1`,
      [recipeNamespace, recipeName, approvalTarget.targetUserId]
    )
    return (result.rowCount ?? 0) > 0
  }

  if (approvalTarget.targetTeamId) {
    const result = await pool.query(
      `SELECT 1
         FROM workflow_recipe_allowed_teams wat
         JOIN team_workflow_triggers twt
           ON twt.team_id = wat.team_id
          AND twt.recipe_namespace = wat.recipe_namespace
          AND twt.recipe_name = wat.recipe_name
        WHERE wat.recipe_namespace = $1
          AND wat.recipe_name = $2
          AND wat.team_id = $3
        LIMIT 1`,
      [recipeNamespace, recipeName, approvalTarget.targetTeamId]
    )
    return (result.rowCount ?? 0) > 0
  }

  return false
}

export function getResourceName(resource: Record<string, unknown>): string {
  const metadata = asRecord(resource.metadata)
  return typeof metadata?.name === 'string' ? metadata.name : ''
}

export function getResourceNamespace(resource: Record<string, unknown>): string {
  const metadata = asRecord(resource.metadata)
  return typeof metadata?.namespace === 'string' ? metadata.namespace : ''
}

export function mapRuntimeWorkflow(resource: Record<string, unknown>): RuntimeWorkflowDto {
  const namespace = getResourceNamespace(resource)
  const name = getResourceName(resource)
  const spec = asRecord(resource.spec) ?? {}
  const status = asRecord(resource.status) ?? {}
  return {
    namespace,
    name,
    hostRef: `${namespace}/${name}`,
    phase: status.phase ?? 'Unknown',
    workflowPhase: asRecord(status.workflowExecution)?.phase ?? null,
    triggers: asRecord(spec.triggers) ?? {},
    inputContract: asRecord(spec.inputContract) ?? null,
  }
}

function normalizePhase(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function conditionIsTrue(
  resource: Record<string, unknown>,
  type: string,
  generation?: number
): boolean {
  const status = asRecord(resource.status)
  const conditions = status?.conditions
  if (!Array.isArray(conditions)) return false
  return conditions.some(condition => {
    const record = asRecord(condition)
    if (!record || record.type !== type || record.status !== 'True') return false
    if (generation === undefined) return true
    const observedGeneration = record.observedGeneration
    return typeof observedGeneration !== 'number' || observedGeneration >= generation
  })
}

function privateWorkflowContextName(recipeName: string): string {
  const base = `wf-${recipeName}`
  if (base.length <= WORKFLOW_CONTEXT_NAME_MAX_LENGTH) return base

  const hash = createHash('sha256')
    .update(base)
    .digest('hex')
    .slice(0, WORKFLOW_CONTEXT_NAME_HASH_LENGTH)
  const maxStemLength = WORKFLOW_CONTEXT_NAME_MAX_LENGTH - hash.length - 1
  const stem = base.slice(0, maxStemLength).replace(/-+$/g, '') || 'wf'
  return `${stem}-${hash}`
}

function effectiveWorkflowContextRef(recipeName: string, spec: Record<string, unknown>): string {
  const explicit = typeof spec.contextRef === 'string' ? spec.contextRef.trim() : ''
  return explicit || privateWorkflowContextName(recipeName)
}

function getTransportWorkloadIds(resource: Record<string, unknown>): string[] {
  const spec = asRecord(resource.spec)
  const workloads = spec?.workloads
  if (!Array.isArray(workloads)) return []

  const ids: string[] = []
  for (const workload of workloads) {
    const record = asRecord(workload)
    if (!record || !asRecord(record.transport)) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id) ids.push(id)
  }
  return ids
}

function workloadHasExternalEgress(resource: Record<string, unknown>, workloadId: string): boolean {
  const spec = asRecord(resource.spec)
  const workloads = spec?.workloads
  if (!Array.isArray(workloads)) return false
  const workload = workloads.map(asRecord).find(item => item?.id === workloadId)
  return Array.isArray(workload?.egressBindings) && workload.egressBindings.length > 0
}

function getWorkflowWorkloadInstances(resource: Record<string, unknown>): Record<string, string> {
  const status = asRecord(resource.status)
  const rawInstances = asRecord(status?.workloadInstances)
  const instances: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawInstances ?? {})) {
    if (typeof value === 'string' && value.trim()) instances[key] = value.trim()
  }
  return instances
}

function contextAllowsMcpServer(context: Record<string, unknown>, mcpServerName: string): boolean {
  const servers = asRecord(context.spec)?.mcpServers
  return Array.isArray(servers) && servers.includes(mcpServerName)
}

async function getMcpServerRuntimeReadiness(
  gateway: K8sGateway,
  recipeName: string,
  recipeSpec: Record<string, unknown>,
  resource: Record<string, unknown>,
  workloadId: string,
  mcpServerName: string
): Promise<WorkflowRuntimeReadiness> {
  let mcpServer: Record<string, unknown>
  try {
    mcpServer = (await gateway.getResource(
      'mcpservers',
      mcpServerName,
      config.mcpServersNamespace
    )) as Record<string, unknown>
  } catch (err) {
    if (err instanceof K8sNotFoundError) {
      return {
        ready: false,
        error: 'workflow_runtime_not_ready',
        reason: 'mcpserver_missing',
        message: `Workflow runtime is still preparing MCP server "${mcpServerName}" for workload "${workloadId}". Retry when the workflow infrastructure is ready.`,
      }
    }
    throw err
  }

  const mcpGeneration = asRecord(mcpServer.metadata)?.generation
  const generation = typeof mcpGeneration === 'number' ? mcpGeneration : undefined
  if (!conditionIsTrue(mcpServer, 'Ready', generation)) {
    return {
      ready: false,
      error: 'workflow_runtime_not_ready',
      reason: 'mcpserver_not_ready',
      message: `Workflow runtime MCP server "${mcpServerName}" is not ready yet. Retry when the workflow infrastructure is ready.`,
    }
  }

  if (workloadHasExternalEgress(resource, workloadId)) {
    if (!conditionIsTrue(mcpServer, 'ExternalEgressReady', generation)) {
      return {
        ready: false,
        error: 'workflow_runtime_not_ready',
        reason: 'mcpserver_egress_not_ready',
        message: `Workflow runtime egress policy for MCP server "${mcpServerName}" is not ready yet. Retry when the workflow infrastructure is ready.`,
      }
    }
  }

  const mcpSpec = asRecord(mcpServer.spec)
  const contextRef =
    typeof mcpSpec?.contextRef === 'string' && mcpSpec.contextRef.trim()
      ? mcpSpec.contextRef.trim()
      : effectiveWorkflowContextRef(recipeName, recipeSpec)
  try {
    const context = (await gateway.getResource(
      'contexts',
      contextRef,
      config.mcpServersNamespace
    )) as Record<string, unknown>
    if (!contextAllowsMcpServer(context, mcpServerName)) {
      return {
        ready: false,
        error: 'workflow_runtime_not_ready',
        reason: 'context_allowlist_missing',
        message: `Workflow runtime Context "${contextRef}" does not allow MCP server "${mcpServerName}" yet. Retry when the workflow infrastructure is ready.`,
      }
    }
  } catch (err) {
    if (err instanceof K8sNotFoundError) {
      return {
        ready: false,
        error: 'workflow_runtime_not_ready',
        reason: 'context_missing',
        message: `Workflow runtime Context "${contextRef}" is not ready yet. Retry when the workflow infrastructure is ready.`,
      }
    }
    throw err
  }

  const readyAddressCount = await gateway.getServiceReadyAddressCount(
    mcpServerName,
    config.mcpServersNamespace
  )
  if (readyAddressCount === null) {
    return {
      ready: false,
      error: 'workflow_runtime_not_ready',
      reason: 'service_endpoints_missing',
      message: `Workflow runtime Service/Endpoints for MCP server "${mcpServerName}" are not ready yet. Retry when the workflow infrastructure is ready.`,
    }
  }
  if (readyAddressCount < 1) {
    return {
      ready: false,
      error: 'workflow_runtime_not_ready',
      reason: 'service_endpoints_not_ready',
      message: `Workflow runtime MCP server "${mcpServerName}" has no ready endpoint yet. Retry when the workflow infrastructure is ready.`,
    }
  }

  return { ready: true }
}

export async function getWorkflowRuntimeReadiness(
  gateway: K8sGateway,
  resource: Record<string, unknown>
): Promise<WorkflowRuntimeReadiness> {
  const transportWorkloadIds = getTransportWorkloadIds(resource)
  if (transportWorkloadIds.length === 0) return { ready: true }

  const phase = normalizePhase(asRecord(resource.status)?.phase)
  if (phase !== 'active' && phase !== 'failed') {
    return {
      ready: false,
      error: 'workflow_runtime_not_ready',
      reason: 'recipe_phase_not_ready',
      message: phase
        ? `Workflow recipe is ${phase}; wait until transport runtime infrastructure is ready.`
        : 'Workflow recipe status is still loading; wait until transport runtime infrastructure is ready.',
    }
  }

  const name = getResourceName(resource)
  const recipeSpec = asRecord(resource.spec) ?? {}
  const workloadInstances = getWorkflowWorkloadInstances(resource)

  for (const workloadId of transportWorkloadIds) {
    const mcpServerName = workloadInstances[workloadId]
    if (!mcpServerName) {
      return {
        ready: false,
        error: 'workflow_runtime_not_ready',
        reason: 'workload_instance_missing',
        message: `Workflow runtime has not registered an MCP server for workload "${workloadId}" yet. Retry when the workflow infrastructure is ready.`,
      }
    }

    const readiness = await getMcpServerRuntimeReadiness(
      gateway,
      name,
      recipeSpec,
      resource,
      workloadId,
      mcpServerName
    )
    if (!readiness.ready) return readiness
  }

  return { ready: true }
}

export function getOnDemandAllowedActors(
  resource: Record<string, unknown>
): TriggerAllowedActor[] | null {
  const onDemand = getOnDemandTrigger(resource)
  if (!onDemand) return null
  const allowedActors = onDemand.allowedActors
  if (!Array.isArray(allowedActors)) return null
  if (allowedActors.length === 0) return null
  const filtered = allowedActors.filter(
    (value): value is TriggerAllowedActor =>
      value === 'user' || value === 'autonomous' || value === 'scheduled'
  )
  return filtered
}

export function getOnDemandRequiresApproval(resource: Record<string, unknown>): boolean {
  return getOnDemandTrigger(resource)?.requiresApproval === true
}

export function hasWorkflowStepApproval(resource: Record<string, unknown>): boolean {
  const spec = asRecord(resource.spec)
  const steps = spec?.steps
  if (!Array.isArray(steps)) return false
  return steps.some(step => {
    const record = asRecord(step)
    return record?.requiresApproval !== undefined && record.requiresApproval !== null
  })
}

export function hasOnDemandTrigger(resource: Record<string, unknown>): boolean {
  return getOnDemandTrigger(resource) !== null
}

function getOnDemandTrigger(resource: Record<string, unknown>): Record<string, unknown> | null {
  const spec = asRecord(resource.spec)
  const triggers = asRecord(spec?.triggers)
  const onDemand = asRecord(triggers?.onDemand)
  return onDemand ?? null
}

export function getMaxRunDurationSeconds(resource: Record<string, unknown>): number | null {
  const spec = asRecord(resource.spec)
  const runRetention = asRecord(spec?.runRetention)
  const value = runRetention?.maxRunDurationSeconds
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export function getTtlSecondsAfterFinished(resource: Record<string, unknown>): number {
  const spec = asRecord(resource.spec)
  const runRetention = asRecord(spec?.runRetention)
  const value = runRetention?.ttlSecondsAfterFinished
  if (value === undefined || value === null) return MAX_TTL_SECONDS_AFTER_FINISHED
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TTL_SECONDS_AFTER_FINISHED
    ? value
    : MAX_TTL_SECONDS_AFTER_FINISHED
}
