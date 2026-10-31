import { createHmac } from 'node:crypto'
import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import { resolveCanonicalBudgetTeamsForContexts } from '../budgets/contextTeams.js'
import { type TokenBudget, rowToBudget } from '../budgets/definitions.js'
import {
  type BudgetScopeDimension,
  isAllowedDimension,
  scopeMatches,
} from '../budgets/dimensions.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import type { AccessPathBehavior, BehaviorDimension } from './accessPath.js'
import { knownBehavior, unknownBehavior } from './accessPath.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import type { OperationalResourceGraphResult } from './operationalAccessReader.js'

type BehaviorDimensions = Omit<AccessPathBehavior, 'capabilities' | 'audit'>

type ModelPair = Readonly<{ provider: string; model: string }>

export type RuntimeBehaviorPolicySnapshot = Readonly<{
  budgets: readonly TokenBudget[]
  allowedModels: readonly ModelPair[]
  canonicalTeamByContext: Readonly<Record<string, string>>
}>

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalUtf8Text(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalUtf8Text)
}

function boundedIdentity(resource: { resourceType: string; logicalId: string }): string {
  return `${resource.resourceType}:${resource.logicalId}`
}

function behaviorFingerprint(value: unknown): string {
  return createHmac('sha256', config.sessionJwtPrivateKey)
    .update(canonical(value), 'utf8')
    .digest('base64url')
}

export async function loadRuntimeBehaviorPolicySnapshot(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  contextRefs?: readonly string[]
}): Promise<RuntimeBehaviorPolicySnapshot> {
  const contextRefs = uniqueSorted(input.contextRefs ?? [])
  const [budgetRows, modelRows, canonicalTeamByContext] = await Promise.all([
    runAccessDatabaseQuery(
      input.db,
      input.budget,
      `SELECT id, name, enabled, scope, unit, currency, limit_amount, period,
              timezone, min_start_amount, max_task_amount, enforcement,
              created_at, updated_at
         FROM token_budgets
        WHERE enabled = TRUE
        ORDER BY id`,
      []
    ),
    runAccessDatabaseQuery(
      input.db,
      input.budget,
      `SELECT provider, model
         FROM llm_allowed_models
        WHERE enabled = TRUE
        ORDER BY provider, model`,
      []
    ),
    resolveCanonicalBudgetTeamsForContexts(contextRefs, {
      query: (text, values) => runAccessDatabaseQuery(input.db, input.budget, text, values),
    }),
  ])
  const budgets = Object.freeze((budgetRows.rows as Record<string, unknown>[]).map(rowToBudget))
  const allowedModels = Object.freeze(
    (modelRows.rows as Record<string, unknown>[]).map(row =>
      Object.freeze({ provider: String(row.provider), model: String(row.model) })
    )
  )
  input.budget.charge({
    kind: 'decodedBytes',
    amount: Math.max(1, Buffer.byteLength(JSON.stringify({ budgets, allowedModels }), 'utf8')),
  })
  return Object.freeze({
    budgets,
    allowedModels,
    canonicalTeamByContext: Object.freeze(Object.fromEntries(canonicalTeamByContext)),
  })
}

export function budgetContextRefsForGraph(
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
): string[] {
  // Budget checks for Host execution include a context_ref. Workflow Recipes
  // use a separate producer whose canonical request has context_ref: null.
  // Context and MCP action authority do not require a budget behavior dimension.
  if (graph.resource.resourceType !== 'host') return []
  return uniqueSorted(
    graph.resources
      .filter(resource => resource.resourceType === 'context')
      .map(resource => resource.logicalId.slice(resource.logicalId.lastIndexOf('/') + 1))
      .filter(Boolean)
  )
}

function potentialBudgetDimensions(input: {
  userId: string
  teamId?: string
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
  canonicalTeamByContext: Readonly<Record<string, string>>
}): Partial<Record<BudgetScopeDimension, readonly string[]>> {
  const hosts = input.graph.resources.filter(resource => resource.resourceType === 'host')
  const contexts = input.graph.resources.filter(resource => resource.resourceType === 'context')
  const workflowRecipe = input.graph.resource.resourceType === 'workflow_recipe'
  const recipes = input.graph.resources.filter(
    resource => resource.resourceType === 'workflow_recipe'
  )
  const credentialRefs = input.graph.resources.flatMap(
    resource => resource.behaviorSources.credentialReferenceNames
  )
  const hostRefs = hosts.flatMap(resource => {
    const name = resource.logicalId.slice(resource.logicalId.indexOf('/') + 1)
    return [name, resource.logicalId]
  })
  if (workflowRecipe) {
    // WRC-issued recipe tokens bind host_ref to the canonical recipe identity,
    // not to an associated Host CRD.
    hostRefs.push(...recipes.map(resource => resource.logicalId))
  }
  const contextRefs = (workflowRecipe ? [] : contexts).flatMap(resource => {
    const name = resource.logicalId.slice(resource.logicalId.indexOf('/') + 1)
    return [name, resource.logicalId]
  })
  const budgetTeamIds =
    !workflowRecipe && contexts.length
      ? contexts.flatMap(resource => {
          const name = resource.logicalId.slice(resource.logicalId.lastIndexOf('/') + 1)
          return [input.canonicalTeamByContext[name] ?? input.teamId].filter(
            (teamId): teamId is string => typeof teamId === 'string' && teamId.length > 0
          )
        })
      : input.teamId
        ? [input.teamId]
        : []
  const recipeNames = recipes.flatMap(resource => {
    const name = resource.logicalId.slice(resource.logicalId.indexOf('/') + 1)
    return [name, resource.logicalId]
  })
  return Object.freeze({
    host_ref: uniqueSorted(hostRefs),
    context_ref: uniqueSorted(contextRefs),
    team_id: uniqueSorted(budgetTeamIds),
    user_id: [input.userId],
    llm_secret_name: uniqueSorted(credentialRefs),
    source_kind: workflowRecipe
      ? ['workflow']
      : ['channel', 'desktop', 'cron', 'unknown', 'plugin_workload_sdk'],
    recipe_name: uniqueSorted(recipeNames),
  })
}

function budgetMayApply(
  budget: TokenBudget,
  dimensions: Partial<Record<BudgetScopeDimension, readonly string[]>>,
  modelPairs: readonly Readonly<{ provider: string; model: string }>[]
): boolean {
  const scope = budget.scope
  const request: Partial<Record<BudgetScopeDimension, string | null>> = {}
  for (const candidate of Object.keys(scope)) {
    if (!isAllowedDimension(candidate)) continue
    const key = candidate
    const allowed = scope[key]
    if (!Array.isArray(allowed) || allowed.length === 0) continue
    if (key === 'provider' || key === 'model') continue
    const available = dimensions[key]
    const matching = available?.find(value => allowed.includes(value))
    if (!matching) return false
    request[key] = matching
  }
  const providers =
    Array.isArray(scope.provider) && scope.provider.length > 0 ? scope.provider : undefined
  const models = Array.isArray(scope.model) && scope.model.length > 0 ? scope.model : undefined
  if (!providers && !models) return scopeMatches(scope, request)
  return modelPairs.some(pair => {
    if (providers && !providers.includes(pair.provider)) return false
    if (models && !models.includes(pair.model)) return false
    return scopeMatches(scope, { ...request, provider: pair.provider, model: pair.model })
  })
}

function policyValue(source: { state: 'known' | 'unknown'; fingerprint: string | null }) {
  return source.state === 'known' && typeof source.fingerprint === 'string'
    ? source.fingerprint
    : null
}

export function assembleOperationalBehaviorDimensions(input: {
  userId: string
  teamId?: string
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
  policySnapshot: RuntimeBehaviorPolicySnapshot
  runtimeRef: string | null
}): BehaviorDimensions {
  const resources = [...input.graph.resources].sort((left, right) =>
    compareCanonicalUtf8Text(boundedIdentity(left), boundedIdentity(right))
  )
  const relationships = [...input.graph.relationships].sort((left, right) =>
    compareCanonicalUtf8Text(left.relationshipInstanceId, right.relationshipInstanceId)
  )
  const unknownDimension = (): BehaviorDimension => unknownBehavior()
  const runtimeSources = resources.map(resource => ({
    identity: boundedIdentity(resource),
    providerUid: resource.providerUid,
    resourceVersion: resource.providerResourceVersion,
    enabled: resource.enabled,
    deletedAt: resource.deletedAt,
    observedGeneration: resource.observedGeneration,
    policy: policyValue(resource.behaviorSources.runtimePolicy),
  }))
  const runtimeKnown = runtimeSources.every(source => source.policy !== null)
  const runtimeRelationships = relationships.map(relationship => ({
    source: `${relationship.sourceType}:${relationship.sourceId}`,
    type: relationship.relationshipType,
    target: `${relationship.targetType}:${relationship.targetId}`,
    instance: relationship.relationshipInstanceId,
    behavior: relationship.behaviorAttributes,
    sourceUid: relationship.sourceProviderUid,
    sourceVersion: relationship.sourceResourceVersion,
    observedGeneration: relationship.observedGeneration,
  }))

  const credentialSources = resources.map(resource => ({
    identity: boundedIdentity(resource),
    providerUid: resource.providerUid,
    resourceVersion: resource.providerResourceVersion,
    enabled: resource.enabled,
    deletedAt: resource.deletedAt,
    mode: resource.behaviorSources.credentialMode,
    configured: resource.behaviorSources.credentialPolicyConfigured,
    policy: policyValue(resource.behaviorSources.credentialPolicy),
    references: resource.behaviorSources.credentialReferenceFingerprints,
  }))
  const credentialsKnown = credentialSources.every(
    source => source.policy !== null && typeof source.configured === 'boolean'
  )

  const approvalSources = resources.map(resource => ({
    identity: boundedIdentity(resource),
    providerUid: resource.providerUid,
    resourceVersion: resource.providerResourceVersion,
    policy: policyValue(resource.behaviorSources.approvalPolicy),
    configured: resource.behaviorSources.approvalPolicyConfigured,
  }))
  const approvalsKnown = approvalSources.every(
    source => source.policy !== null && typeof source.configured === 'boolean'
  )

  const mounts = relationships
    .filter(relationship => relationship.relationshipType === 'mounts_shared_filesystem')
    .map(relationship => ({
      context: relationship.sourceId,
      relationship: relationship.relationshipInstanceId,
      filesystem: relationship.targetId,
      mountPath: relationship.behaviorAttributes.mountPath,
      readOnly: relationship.behaviorAttributes.readOnly,
      sourceUid: relationship.sourceProviderUid,
      sourceVersion: relationship.sourceResourceVersion,
      target: resources.find(
        resource =>
          resource.resourceType === 'shared_filesystem' &&
          resource.logicalId === relationship.targetId
      )
        ? {
            uid: resources.find(
              resource =>
                resource.resourceType === 'shared_filesystem' &&
                resource.logicalId === relationship.targetId
            )!.providerUid,
            resourceVersion: resources.find(
              resource =>
                resource.resourceType === 'shared_filesystem' &&
                resource.logicalId === relationship.targetId
            )!.providerResourceVersion,
            enabled: resources.find(
              resource =>
                resource.resourceType === 'shared_filesystem' &&
                resource.logicalId === relationship.targetId
            )!.enabled,
            deletedAt: resources.find(
              resource =>
                resource.resourceType === 'shared_filesystem' &&
                resource.logicalId === relationship.targetId
            )!.deletedAt,
          }
        : null,
    }))
  const filesystemKnown = mounts.every(mount => mount.target !== null)

  const configuredTargetPairs = resources.flatMap(resource =>
    resource.behaviorSources.providerModelTargets.map(target => ({
      provider: target.provider,
      model: target.model,
    }))
  )
  const allowedPairs = input.policySnapshot.allowedModels.map(({ provider, model }) => ({
    provider,
    model,
  }))
  const allowedPairKeys = new Set(allowedPairs.map(pair => JSON.stringify(pair)))
  const targetPairs = configuredTargetPairs.filter(pair =>
    allowedPairKeys.has(JSON.stringify(pair))
  )
  const selectedPairs = [
    ...new Map(targetPairs.map(pair => [JSON.stringify(pair), pair] as const)).values(),
  ]
  const modelPairs = selectedPairs.length > 0 ? selectedPairs : allowedPairs
  const providerSources = resources.map(resource => ({
    identity: boundedIdentity(resource),
    providerUid: resource.providerUid,
    resourceVersion: resource.providerResourceVersion,
    enabled: resource.enabled,
    deletedAt: resource.deletedAt,
    policy: policyValue(resource.behaviorSources.providerModelPolicy),
    targets: resource.behaviorSources.providerModelTargets,
  }))
  const providerKnown = providerSources.every(source => source.policy !== null)
  const modelPolicyApplies = ['host', 'workflow_recipe'].includes(input.graph.resource.resourceType)

  const dimensions = potentialBudgetDimensions({
    userId: input.userId,
    teamId: input.teamId,
    graph: input.graph,
    canonicalTeamByContext: input.policySnapshot.canonicalTeamByContext,
  })
  const budgetDimensionApplies = !['context', 'mcp_server'].includes(
    input.graph.resource.resourceType
  )
  const applicableBudgets = input.policySnapshot.budgets
    .filter(budget => budgetDimensionApplies && budgetMayApply(budget, dimensions, modelPairs))
    .map(budget => ({
      id: budget.id,
      scope: budget.scope,
      unit: budget.unit,
      currency: budget.currency,
      limit: budget.limit_amount,
      period: budget.period,
      timezone: budget.timezone,
      minimum: budget.min_start_amount,
      maximumTask: budget.max_task_amount,
      enforcement: budget.enforcement,
    }))
    .sort((left, right) => compareCanonicalUtf8Text(left.id, right.id))
  const modelPolicyDescriptor = {
    resources: providerSources,
    configuredTargets: [...configuredTargetPairs].sort((left, right) =>
      compareCanonicalUtf8Text(JSON.stringify(left), JSON.stringify(right))
    ),
    effectiveTargets: [...targetPairs].sort((left, right) =>
      compareCanonicalUtf8Text(JSON.stringify(left), JSON.stringify(right))
    ),
    globallyAllowed: [...input.policySnapshot.allowedModels]
      .map(({ provider, model }) => ({ provider, model }))
      .sort((left, right) =>
        compareCanonicalUtf8Text(
          `${left.provider}\0${left.model}`,
          `${right.provider}\0${right.model}`
        )
      ),
  }

  return Object.freeze({
    budget:
      applicableBudgets.length === 0
        ? knownBehavior(null)
        : knownBehavior(
            behaviorFingerprint({
              source: 'token_budgets',
              state: 'complete',
              policies: applicableBudgets,
            })
          ),
    credentialPolicy: credentialsKnown
      ? credentialSources.every(source => source.configured === false)
        ? knownBehavior(null)
        : knownBehavior(
            behaviorFingerprint({
              source: 'operational-resource-config',
              resources: credentialSources,
            })
          )
      : unknownDimension(),
    approvalPolicy: approvalsKnown
      ? approvalSources.every(source => source.configured === false)
        ? knownBehavior(null)
        : knownBehavior(
            behaviorFingerprint({
              source: 'operational-approval-config',
              resources: approvalSources,
            })
          )
      : unknownDimension(),
    filesystemScope: filesystemKnown
      ? mounts.length === 0
        ? knownBehavior(null)
        : knownBehavior(behaviorFingerprint({ mounts, path: input.runtimeRef }))
      : unknownDimension(),
    runtime: runtimeKnown
      ? knownBehavior(
          behaviorFingerprint({
            sources: runtimeSources,
            relationships: runtimeRelationships,
            path: input.runtimeRef,
          })
        )
      : unknownDimension(),
    providerModelPolicy: providerKnown
      ? !modelPolicyApplies
        ? knownBehavior(null)
        : knownBehavior(behaviorFingerprint(modelPolicyDescriptor))
      : unknownDimension(),
  })
}
