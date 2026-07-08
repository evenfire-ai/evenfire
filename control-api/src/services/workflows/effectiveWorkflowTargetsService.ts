import { type DbClient, pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { WorkflowRouteCaller } from './types.js'
import {
  type WorkflowApprovalTarget,
  getAuthorizedRecipeResources,
  getResourceName,
  getResourceNamespace,
  isRecipeNamespaceAllowed,
  mapRuntimeWorkflow,
} from './workflowRecipeAccessService.js'

const PERSONAL_TARGET_LABEL = 'Personal'

export type EffectiveWorkflowTargetKind = 'user' | 'team'

export type EffectiveWorkflowTarget =
  | { kind: 'user'; label: typeof PERSONAL_TARGET_LABEL; userId: string }
  | { kind: 'team'; label: string; teamId: string }

export type PublicEffectiveWorkflowTarget = {
  kind: EffectiveWorkflowTargetKind
  label: string
}

export type EffectiveWorkflowListItem = {
  namespace: string
  name: string
  inputContract: unknown
  targets: PublicEffectiveWorkflowTarget[]
  duplicateLabels?: true
}

export type EffectiveWorkflowTriggerResolution =
  | { status: 'none' }
  | {
      status: 'unique'
      target: PublicEffectiveWorkflowTarget & { userId?: string; teamId?: string }
    }
  | {
      status: 'ambiguous'
      targets: PublicEffectiveWorkflowTarget[]
      duplicateLabels?: true
    }

export type ResolveEffectiveWorkflowTargetsParams = {
  caller: WorkflowRouteCaller
  gateway: K8sGateway
  userId: string
  recipeNamespace?: string
  recipeName?: string
  targetLabel?: string
  db?: DbClient
}

type RecipeTargetBucket = {
  namespace: string
  name: string
  inputContract: unknown
  targets: EffectiveWorkflowTarget[]
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function publicTarget(target: EffectiveWorkflowTarget): PublicEffectiveWorkflowTarget {
  return { kind: target.kind, label: target.label }
}

function internalTarget(target: EffectiveWorkflowTarget) {
  return target.kind === 'user'
    ? { ...publicTarget(target), userId: target.userId }
    : { ...publicTarget(target), teamId: target.teamId }
}

function toApprovalTarget(target: EffectiveWorkflowTarget): WorkflowApprovalTarget {
  return target.kind === 'user' ? { targetUserId: target.userId } : { targetTeamId: target.teamId }
}

function targetKey(target: EffectiveWorkflowTarget): string {
  return target.kind === 'user' ? `user:${target.userId}` : `team:${target.teamId}`
}

function hasDuplicateLabels(targets: EffectiveWorkflowTarget[]): boolean {
  const seen = new Set<string>()
  for (const target of targets) {
    const label = normalizeLabel(target.label)
    if (seen.has(label)) return true
    seen.add(label)
  }
  return false
}

async function listCandidateTargets(
  userId: string,
  db: DbClient
): Promise<EffectiveWorkflowTarget[]> {
  const teams = await db.query(
    `SELECT t.id, t.name
       FROM teams t
       JOIN team_members tm
         ON tm.team_id = t.id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
      ORDER BY LOWER(t.name), t.name, t.id`,
    [userId]
  )

  const targets: EffectiveWorkflowTarget[] = [
    { kind: 'user', label: PERSONAL_TARGET_LABEL, userId },
  ]
  for (const row of teams.rows as Array<{ id?: unknown; name?: unknown }>) {
    const teamId = typeof row.id === 'string' ? row.id.trim() : ''
    const label = typeof row.name === 'string' ? row.name.trim() : ''
    if (teamId && label) targets.push({ kind: 'team', label, teamId })
  }
  return targets
}

async function collectEffectiveWorkflowTargets(
  params: ResolveEffectiveWorkflowTargetsParams
): Promise<RecipeTargetBucket[]> {
  const db = params.db ?? pool
  const buckets = new Map<string, RecipeTargetBucket>()
  const candidates = await listCandidateTargets(params.userId, db)

  for (const target of candidates) {
    const resources = await getAuthorizedRecipeResources(
      params.caller,
      params.gateway,
      toApprovalTarget(target)
    )
    const seenForTarget = new Set<string>()
    for (const resource of resources) {
      const namespace = getResourceNamespace(resource)
      const name = getResourceName(resource)
      if (!namespace || !name || !isRecipeNamespaceAllowed(namespace)) continue
      if (params.recipeNamespace && namespace !== params.recipeNamespace) continue
      if (params.recipeName && name !== params.recipeName) continue

      const key = `${namespace}/${name}`
      if (seenForTarget.has(key)) continue
      seenForTarget.add(key)

      const workflow = mapRuntimeWorkflow(resource)
      const bucket = buckets.get(key) ?? {
        namespace,
        name,
        inputContract: workflow.inputContract,
        targets: [],
      }
      if (!bucket.targets.some(existing => targetKey(existing) === targetKey(target))) {
        bucket.targets.push(target)
      }
      buckets.set(key, bucket)
    }
  }

  return [...buckets.values()].sort((a, b) =>
    a.namespace === b.namespace
      ? a.name.localeCompare(b.name)
      : a.namespace.localeCompare(b.namespace)
  )
}

export async function listEffectiveWorkflowTargets(
  params: ResolveEffectiveWorkflowTargetsParams
): Promise<{ items: EffectiveWorkflowListItem[] }> {
  const buckets = await collectEffectiveWorkflowTargets(params)
  return {
    items: buckets.map(bucket => ({
      namespace: bucket.namespace,
      name: bucket.name,
      inputContract: bucket.inputContract,
      targets: bucket.targets.map(publicTarget),
      ...(hasDuplicateLabels(bucket.targets) ? { duplicateLabels: true as const } : {}),
    })),
  }
}

export async function resolveEffectiveWorkflowTriggerTarget(
  params: ResolveEffectiveWorkflowTargetsParams
): Promise<EffectiveWorkflowTriggerResolution> {
  if (
    !params.recipeNamespace ||
    !params.recipeName ||
    !isRecipeNamespaceAllowed(params.recipeNamespace)
  ) {
    return { status: 'none' }
  }

  const bucket = (await collectEffectiveWorkflowTargets(params))[0]
  if (!bucket || bucket.targets.length === 0) return { status: 'none' }

  const requestedLabel = params.targetLabel?.trim()
  const targets = requestedLabel
    ? bucket.targets.filter(
        target => normalizeLabel(target.label) === normalizeLabel(requestedLabel)
      )
    : bucket.targets

  if (targets.length === 0) return { status: 'none' }

  if (targets.length === 1) {
    return { status: 'unique', target: internalTarget(targets[0]) }
  }

  return {
    status: 'ambiguous',
    targets: targets.map(publicTarget),
    ...(hasDuplicateLabels(targets) ? { duplicateLabels: true as const } : {}),
  }
}
