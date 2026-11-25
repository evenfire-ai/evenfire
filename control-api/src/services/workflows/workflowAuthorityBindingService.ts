import type { Request } from 'express'
import { createHash } from 'node:crypto'
import {
  ACTION_CONTEXT_VERSION,
  type ActionAuthorityCheckpointRequestV2,
  type ActionOperationId,
  type AuthorityBindingV2,
  type CanonicalActionTarget,
  hashActionTarget,
} from '@clerum/action-context-contracts'
import type { DbClient } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { ExternalAuthedRequest } from '../../middleware/externalSessionAuth.js'
import {
  type UserDelegationV2Claims,
  verifyUserDelegationV2,
} from '../../utils/auth/userDelegationV2Token.js'
import { stableStringify } from '../../utils/stableStringify.js'
import { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
import { checkpointActionAuthority } from '../access/actionAuthorityCheckpoint.js'
import { authorizeActionV2 } from '../access/actionAuthorizer.js'
import { requestedActionContextV2 } from '../access/actionContextV2.js'
import { canonicalEnvironmentId } from '../access/operationalAccessProjection.js'
import {
  type CanonicalResourceIdentity,
  canonicalResourceIdentity,
  resourceIdentityKey,
} from '../access/resourceIdentity.js'
import type { WorkflowCaller } from './types.js'

export const WORKFLOW_ACTION_DELEGATION_HEADER = 'x-evenfire-action-delegation'
export const WORKFLOW_ACTION_DELEGATION_MAX_LENGTH = 4096

export type WorkflowAuthorityBinding = Readonly<{
  binding: AuthorityBindingV2
  sourceIssuedAt: number
  sourceExpiresAt: number
  bindingHash: string
}>

export class WorkflowAuthorityError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code:
      | 'invalid_action_delegation'
      | 'invalid_session'
      | 'forbidden'
      | 'not_found'
      | 'access_path_stale'
      | 'authority_unavailable'
  ) {
    super(code)
    this.name = 'WorkflowAuthorityError'
  }
}

function rawHeaderValues(req: Request): string[] {
  const values: string[] = []
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === WORKFLOW_ACTION_DELEGATION_HEADER) {
      values.push(req.rawHeaders[index + 1] ?? '')
    }
  }
  return values
}

function exactDelegation(req: Request): string {
  const values = rawHeaderValues(req)
  if (values.length !== 1) throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  const value = values[0]
  if (
    !value ||
    value !== value.trim() ||
    value.length > WORKFLOW_ACTION_DELEGATION_MAX_LENGTH ||
    value.includes(',') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }
  return value
}

export function workflowAuthorityBindingFromClaims(
  claims: UserDelegationV2Claims
): WorkflowAuthorityBinding {
  const operationId = claims.operationIds[0]
  const binding: AuthorityBindingV2 = Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    userId: claims.sub,
    sid: claims.sid,
    sessionVersion: claims.sv,
    delegationJti: claims.jti,
    operationId,
    resource: claims.resource,
    target: claims.targets[operationId],
    targetHash: claims.targetHashes[operationId],
    accessPathId: claims.accessPathId,
    authorizationRevision: claims.authorizationRevision,
    pathKind: claims.pathKind,
    effectiveTeamId: claims.effectiveTeamId,
    behaviorBindingHash: claims.behaviorBindingHash,
  })
  return Object.freeze({
    binding,
    sourceIssuedAt: claims.iat,
    sourceExpiresAt: claims.exp,
    bindingHash: createHash('sha256').update(stableStringify(binding)).digest('hex'),
  })
}

function mapCheckpointFailure(
  status: 'denied' | 'not_found' | 'access_path_stale' | 'authority_unavailable' | 'invalid_binding'
): WorkflowAuthorityError {
  if (status === 'authority_unavailable') return new WorkflowAuthorityError(503, status)
  if (status === 'not_found') return new WorkflowAuthorityError(404, status)
  if (status === 'access_path_stale') return new WorkflowAuthorityError(409, status)
  if (status === 'denied') return new WorkflowAuthorityError(403, 'forbidden')
  return new WorkflowAuthorityError(400, 'invalid_action_delegation')
}

export async function requireWorkflowActionAuthority(input: {
  req: ExternalAuthedRequest
  caller: Extract<WorkflowCaller, { kind: 'user-session' }>
  operationId: ActionOperationId
  resourceType: CanonicalResourceIdentity['type']
  resourceLogicalId: string
  target: CanonicalActionTarget
  gateway: Pick<K8sGateway, 'getResourceExact' | 'listResourcePage'>
}): Promise<WorkflowAuthorityBinding | null> {
  const values = rawHeaderValues(input.req)
  if (input.caller.session.contract !== 'v2') {
    if (values.length > 0) throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
    return null
  }

  const token = exactDelegation(input.req)
  const claims = verifyUserDelegationV2(token)
  if (!claims || claims.operationIds.length !== 1 || claims.operationIds[0] !== input.operationId) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }
  if (
    claims.sub !== input.caller.session.userId ||
    claims.sid !== input.caller.session.sid ||
    claims.sv !== input.caller.session.sessionVersion
  ) {
    throw new WorkflowAuthorityError(401, 'invalid_session')
  }

  const resource = canonicalResourceIdentity({
    environmentId: canonicalEnvironmentId(),
    type: input.resourceType,
    logicalId: input.resourceLogicalId,
  })
  const targetHash = hashActionTarget(input.target)
  if (
    resourceIdentityKey(claims.resource as CanonicalResourceIdentity) !==
      resourceIdentityKey(resource) ||
    stableStringify(claims.resource) !== stableStringify(resource) ||
    claims.targetHashes[input.operationId] !== targetHash ||
    stableStringify(claims.targets[input.operationId]) !== stableStringify(input.target)
  ) {
    throw new WorkflowAuthorityError(403, 'forbidden')
  }

  const request: ActionAuthorityCheckpointRequestV2 = Object.freeze({
    version: ACTION_CONTEXT_VERSION,
    principal: Object.freeze({
      sub: claims.sub,
      sid: claims.sid,
      sessionVersion: claims.sv,
    }),
    delegationJti: claims.jti,
    resource,
    operationId: input.operationId,
    target: input.target,
    targetHash,
    accessPathId: claims.accessPathId,
    authorizationRevision: claims.authorizationRevision,
    behaviorBindingHash: claims.behaviorBindingHash,
    domain: Object.freeze({ service: 'external-rest-api', resource, targetHash }),
  })
  // The checkpoint owns one action budget for this V2 call; V1 requests
  // returned above and never allocate one.
  const budget = AccessExecutionBudget.create('action')
  let checkpoint: Awaited<ReturnType<typeof checkpointActionAuthority>>
  try {
    checkpoint = await checkpointActionAuthority({
      request,
      gateway: input.gateway,
      budget,
      correlationId: input.req.correlationId,
    })
  } finally {
    budget.close()
  }
  if (checkpoint.status !== 'allowed') throw mapCheckpointFailure(checkpoint.status)
  const attribution = checkpoint.attribution
  if (
    checkpoint.authorizationRevision !== claims.authorizationRevision ||
    checkpoint.behaviorBindingHash !== claims.behaviorBindingHash ||
    attribution.userId !== claims.sub ||
    attribution.sid !== claims.sid ||
    attribution.sessionVersion !== claims.sv ||
    attribution.accessPathId !== claims.accessPathId ||
    attribution.pathKind !== claims.pathKind ||
    attribution.effectiveTeamId !== claims.effectiveTeamId ||
    (checkpoint.validUntil !== null && Date.parse(checkpoint.validUntil) <= Date.now())
  ) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }

  return workflowAuthorityBindingFromClaims(claims)
}

type BoundAccessPath = Readonly<{ kind: 'direct' }> | Readonly<{ kind: 'team'; teamId: string }>

/**
 * The path shape a signed binding names: direct with no effective team, or
 * team with one. Any other shape is a malformed delegation.
 */
function boundAccessPath(binding: AuthorityBindingV2): BoundAccessPath {
  if (binding.pathKind === 'direct' && binding.effectiveTeamId === null) {
    return { kind: 'direct' }
  }
  if (binding.pathKind === 'team' && binding.effectiveTeamId) {
    return { kind: 'team', teamId: binding.effectiveTeamId }
  }
  throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
}

/** A bound row that is missing, or no longer current, makes the path stale. */
function requireOneBoundRow(result: { rowCount: number | null }): void {
  if ((result.rowCount ?? 0) !== 1) {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
}

/**
 * Locks, `FOR SHARE`, the rows the approval decision's selected path depends
 * on: the direct trigger grant, or the active team membership and then the
 * team's approval allowance. The recipe and target come from the approval row
 * the caller already holds `FOR UPDATE`. Membership is locked in its own
 * statement before any grant row of the same team, so the order holds whatever
 * order a team-delete cascade reaches `team_members`,
 * `workflow_recipe_allowed_teams` and `team_workflow_triggers` in.
 */
async function lockApprovalDecisionPath(db: DbClient, binding: AuthorityBindingV2): Promise<void> {
  const path = boundAccessPath(binding)
  const approvalId = binding.resource.logicalId
  if (path.kind === 'direct') {
    requireOneBoundRow(
      await db.query(
        `SELECT uwt.user_id
           FROM workflow_approval_requests war
           JOIN user_workflow_triggers uwt
             ON uwt.user_id = $1
            AND uwt.recipe_namespace = war.recipe_namespace
            AND uwt.recipe_name = war.recipe_name
          WHERE war.id = $2::uuid AND war.target_user_id = $1
            FOR SHARE OF uwt`,
        [binding.userId, approvalId]
      )
    )
    return
  }
  requireOneBoundRow(
    await db.query(
      `SELECT tm.role
         FROM workflow_approval_requests war
         JOIN team_members tm
           ON tm.team_id = war.target_team_id AND tm.user_id = $1 AND tm.status = 'active'
        WHERE war.id = $2::uuid AND war.target_team_id = $3
          FOR SHARE OF tm`,
      [binding.userId, approvalId, path.teamId]
    )
  )
  requireOneBoundRow(
    await db.query(
      `SELECT wat.team_id
         FROM workflow_approval_requests war
         JOIN workflow_recipe_allowed_teams wat
           ON wat.team_id = war.target_team_id
          AND wat.recipe_namespace = war.recipe_namespace
          AND wat.recipe_name = war.recipe_name
        WHERE war.id = $1::uuid AND war.target_team_id = $2
          FOR SHARE OF wat`,
      [approvalId, path.teamId]
    )
  )
}

/**
 * Reuses the canonical action authorizer on the caller's repeatable-read write
 * transaction, then locks in the global order: the user row `FOR SHARE`, the
 * session `FOR UPDATE`, then the rows the selected path is bound to `FOR SHARE`
 * (the direct trigger grant, or the active team membership before the team's
 * approval allowance). `users` comes before the session so a decision
 * serialises behind `revokeAllUserSessions`, which locks the same two tables in
 * that order. The bound-row lock replaces the removed revision counters: a
 * grant or membership changed after this transaction's snapshot raises 40001
 * at that lock, which `recordDecision` maps to a stale-authority rejection, and
 * once the lock is held a revocation waits for this decision to commit. A
 * missing bound row answers 409 `access_path_stale`.
 * It performs no connection acquisition or external destination lookup while
 * the caller holds the approval row lock.
 */
export async function requireCurrentWorkflowApprovalAuthority(input: {
  db: DbClient
  authority: WorkflowAuthorityBinding
  budget: AccessExecutionBudget
  correlationId?: string
}): Promise<WorkflowAuthorityBinding> {
  const binding = input.authority.binding
  if (
    binding.operationId !== 'workflow.approval.decide' ||
    binding.resource.type !== 'workflow_approval'
  ) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }

  const result = await authorizeActionV2(
    {
      session: Object.freeze({
        contract: 'v2',
        authorityMode: 'logical_session_checkpoint',
        userId: binding.userId,
        sid: binding.sid,
        sessionVersion: binding.sessionVersion,
      }),
      requested: requestedActionContextV2({
        accessPathId: binding.accessPathId,
        authorizationRevision: binding.authorizationRevision,
      }),
      operationId: binding.operationId,
      resource: binding.resource as CanonicalResourceIdentity,
      operationTarget: binding.target,
      allocateChatMessageId: false,
      budget: input.budget,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    },
    {
      authorizationOptions: {
        transaction: work => work(input.db),
        configureTransaction: false,
      },
    }
  )
  if (result.status === 'authority_unavailable') {
    throw new WorkflowAuthorityError(503, 'authority_unavailable')
  }
  if (result.status === 'not_found') throw new WorkflowAuthorityError(404, 'not_found')
  if (result.status === 'access_path_stale') {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
  if (result.status === 'denied') throw new WorkflowAuthorityError(403, 'forbidden')
  if (result.status !== 'allowed') {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }
  if (
    result.context.authorizationRevision !== binding.authorizationRevision ||
    result.context.behaviorBindingHash !== binding.behaviorBindingHash ||
    result.context.accessPathId !== binding.accessPathId ||
    result.context.principal.userId !== binding.userId ||
    result.context.principal.sid !== binding.sid ||
    result.context.principal.sessionVersion !== binding.sessionVersion ||
    result.context.targetHash !== binding.targetHash ||
    stableStringify(result.context.resource) !== stableStringify(binding.resource) ||
    stableStringify(result.context.target) !== stableStringify(binding.target)
  ) {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
  try {
    // The runtime's `legacy_dml` grant on `users` covers this row lock, and it
    // is the same order `revokeAllUserSessions` uses, so a revocation that
    // already owns the user row runs to completion before this decision takes
    // its first lock.
    const user = await input.db.query(
      `SELECT id
         FROM users
        WHERE id = $1
        FOR SHARE`,
      [binding.userId]
    )
    if ((user.rowCount ?? 0) !== 1) {
      throw new WorkflowAuthorityError(401, 'invalid_session')
    }
    const session = await input.db.query(
      `SELECT sid
         FROM external_user_sessions
        WHERE sid = $1 AND user_id = $2 AND session_version = $3
        FOR UPDATE`,
      [binding.sid, binding.userId, binding.sessionVersion]
    )
    if ((session.rowCount ?? 0) !== 1) {
      throw new WorkflowAuthorityError(401, 'invalid_session')
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '40001'
    ) {
      throw new WorkflowAuthorityError(409, 'access_path_stale')
    }
    throw error
  }
  // Outside the conversion above on purpose: a 40001 here reaches
  // `recordDecision` raw and becomes `WorkflowApprovalAuthorityStaleError`.
  await lockApprovalDecisionPath(input.db, binding)
  const currentTime = await input.db.query(
    `SELECT clock_timestamp() < to_timestamp($1) AS "delegationCurrent",
            ($2::timestamptz IS NULL OR clock_timestamp() < $2::timestamptz) AS "pathCurrent"`,
    [input.authority.sourceExpiresAt, result.context.validUntil]
  )
  const current = currentTime.rows[0] as
    | { delegationCurrent?: unknown; pathCurrent?: unknown }
    | undefined
  if (current?.delegationCurrent !== true || current.pathCurrent !== true) {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
  return input.authority
}

function workflowTriggerIdentity(authority: WorkflowAuthorityBinding): {
  recipeNamespace: string
  recipeName: string
} {
  const { binding } = authority
  const target = binding.target as Readonly<Record<string, unknown>>
  const recipeNamespace = String(target.recipeNamespace ?? '')
  const recipeName = String(target.recipeName ?? '')
  if (
    binding.operationId !== 'workflow.trigger' ||
    binding.resource.type !== 'workflow_recipe' ||
    binding.resource.logicalId !== `${recipeNamespace}/${recipeName}` ||
    !recipeNamespace ||
    !recipeName
  ) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }
  return { recipeNamespace, recipeName }
}

/**
 * The trigger row check, run inside the run or approval insert transaction.
 * The route's single `requireWorkflowActionAuthority` checkpoint already
 * selected the path and compared its authorization revision, so this check
 * captures nothing beforehand and compares no fingerprint: it locks and
 * re-reads only the rows the selected path is bound to. A session or user
 * failure answers 401 `invalid_session`; a missing grant or active membership
 * answers 409 `access_path_stale`; delegation, idle or absolute session expiry
 * observed after those reads answers 409 `access_path_stale`.
 */
export async function requireCurrentWorkflowTriggerAuthority(input: {
  db: DbClient
  authority: WorkflowAuthorityBinding
}): Promise<WorkflowAuthorityBinding> {
  const { binding } = input.authority
  const { recipeNamespace, recipeName } = workflowTriggerIdentity(input.authority)
  const session = await input.db.query(
    `SELECT u.lifecycle_state, s.session_version, s.current_jti, s.revoked_at,
            s.idle_expires_at, s.absolute_expires_at
       FROM users u
       JOIN external_user_sessions s ON s.user_id = u.id AND s.sid = $2
      WHERE u.id = $1 AND s.session_version = $3 FOR SHARE`,
    [binding.userId, binding.sid, binding.sessionVersion]
  )
  const sessionRow = session.rows[0] as
    | {
        lifecycle_state?: unknown
        revoked_at?: unknown
        idle_expires_at?: unknown
        absolute_expires_at?: unknown
      }
    | undefined
  if (!sessionRow || sessionRow.lifecycle_state !== 'active' || sessionRow.revoked_at !== null) {
    throw new WorkflowAuthorityError(401, 'invalid_session')
  }
  const idleExpiresAt = new Date(String(sessionRow.idle_expires_at))
  const absoluteExpiresAt = new Date(String(sessionRow.absolute_expires_at))
  if (!Number.isFinite(idleExpiresAt.getTime()) || !Number.isFinite(absoluteExpiresAt.getTime())) {
    throw new WorkflowAuthorityError(401, 'invalid_session')
  }

  const path = boundAccessPath(binding)
  if (path.kind === 'direct') {
    requireOneBoundRow(
      await input.db.query(
        `SELECT user_id, recipe_namespace, recipe_name
           FROM user_workflow_triggers
          WHERE user_id = $1 AND recipe_namespace = $2 AND recipe_name = $3 FOR SHARE`,
        [binding.userId, recipeNamespace, recipeName]
      )
    )
  } else {
    // Membership first, in its own statement, then the team grant: the same
    // order the approval decision and resume use (see
    // `lockApprovalDecisionPath`).
    requireOneBoundRow(
      await input.db.query(
        `SELECT role
           FROM team_members
          WHERE team_id = $2 AND user_id = $1 AND status = 'active' FOR SHARE`,
        [binding.userId, path.teamId]
      )
    )
    requireOneBoundRow(
      await input.db.query(
        `SELECT team_id
           FROM team_workflow_triggers
          WHERE team_id = $1 AND recipe_namespace = $2 AND recipe_name = $3 FOR SHARE`,
        [path.teamId, recipeNamespace, recipeName]
      )
    )
  }

  const currentTime = await input.db.query(
    `WITH fence_time AS MATERIALIZED (
       SELECT clock_timestamp() AS observed_at
     )
     SELECT observed_at < to_timestamp($1) AS "delegationCurrent",
            observed_at < $2::timestamptz AS "idleSessionCurrent",
            observed_at < $3::timestamptz AS "absoluteSessionCurrent"
       FROM fence_time`,
    [input.authority.sourceExpiresAt, idleExpiresAt, absoluteExpiresAt]
  )
  const currentTimeRow = currentTime.rows[0] as
    | {
        delegationCurrent?: unknown
        idleSessionCurrent?: unknown
        absoluteSessionCurrent?: unknown
      }
    | undefined
  if (
    currentTimeRow?.delegationCurrent !== true ||
    currentTimeRow.idleSessionCurrent !== true ||
    currentTimeRow.absoluteSessionCurrent !== true
  ) {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
  return input.authority
}

export async function persistWorkflowAuthorityBinding(
  db: DbClient,
  input: {
    authority: WorkflowAuthorityBinding
    kind: string
    entityType: string
    entityId: string
    parentBindingId?: string | null
    transitionId?: string | null
  }
): Promise<string> {
  if (
    !Number.isSafeInteger(input.authority.sourceIssuedAt) ||
    !Number.isSafeInteger(input.authority.sourceExpiresAt) ||
    input.authority.sourceExpiresAt <= input.authority.sourceIssuedAt
  ) {
    throw new WorkflowAuthorityError(400, 'invalid_action_delegation')
  }
  const binding = input.authority.binding
  const inserted = await db.query(
    `INSERT INTO workflow_authority_bindings (
       binding_kind, entity_type, entity_id, binding_version, binding_hash,
       parent_binding_id, transition_id,
       user_id, session_id, session_version, delegation_jti, operation_id,
       resource, target, target_hash, access_path_id, authorization_revision,
       path_kind, effective_team_id, behavior_binding_hash, source_issued_at, source_expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15, $16, $17,
       $18, $19, $20, to_timestamp($21), to_timestamp($22)
     )
     ON CONFLICT (binding_kind, entity_type, entity_id, binding_hash)
     DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.entityType,
      input.entityId,
      binding.version,
      input.authority.bindingHash,
      input.parentBindingId ?? null,
      input.transitionId ?? null,
      binding.userId,
      binding.sid,
      binding.sessionVersion,
      binding.delegationJti,
      binding.operationId,
      JSON.stringify(binding.resource),
      JSON.stringify(binding.target),
      binding.targetHash,
      binding.accessPathId,
      binding.authorizationRevision,
      binding.pathKind,
      binding.effectiveTeamId,
      binding.behaviorBindingHash,
      input.authority.sourceIssuedAt,
      input.authority.sourceExpiresAt,
    ]
  )
  let id = (inserted.rows[0] as { id?: unknown } | undefined)?.id
  if (id === undefined) {
    const existing = await db.query(
      `SELECT id FROM workflow_authority_bindings
        WHERE binding_kind = $1 AND entity_type = $2 AND entity_id = $3 AND binding_hash = $4`,
      [input.kind, input.entityType, input.entityId, input.authority.bindingHash]
    )
    id = (existing.rows[0] as { id?: unknown } | undefined)?.id
  }
  if (typeof id !== 'string' || !id) {
    throw new Error('workflow_authority_binding_persistence_failed')
  }
  return id
}
