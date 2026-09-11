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
import type { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
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
  gateway: Pick<K8sGateway, 'getResourceExact'>
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
    JSON.stringify(claims.resource) !== JSON.stringify(resource) ||
    claims.targetHashes[input.operationId] !== targetHash ||
    JSON.stringify(claims.targets[input.operationId]) !== JSON.stringify(input.target)
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
  const checkpoint = await checkpointActionAuthority({
    request,
    gateway: input.gateway,
    budget: input.req.accessExecutionBudget!,
    correlationId: input.req.correlationId,
  })
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

/**
 * Reuses the canonical action authorizer on the caller's repeatable-read write
 * transaction, then fences every database-owned revision component it read.
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
    JSON.stringify(result.context.resource) !== JSON.stringify(binding.resource) ||
    JSON.stringify(result.context.target) !== JSON.stringify(binding.target)
  ) {
    throw new WorkflowAuthorityError(409, 'access_path_stale')
  }
  try {
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
    const userRevision = await input.db.query(
      `SELECT user_id
         FROM authorization_user_revisions
        WHERE user_id = $1
        FOR UPDATE`,
      [binding.userId]
    )
    if ((userRevision.rowCount ?? 0) !== 1) {
      throw new WorkflowAuthorityError(409, 'access_path_stale')
    }
    const memberships = await input.db.query(
      `SELECT team_id
         FROM team_members
        WHERE user_id = $1 AND status = 'active'
        ORDER BY team_id`,
      [binding.userId]
    )
    const teamIds = memberships.rows.map(row => String((row as { team_id: unknown }).team_id))
    if (teamIds.length > 0) {
      const teamRevisions = await input.db.query(
        `SELECT team_id
           FROM authorization_team_revisions
          WHERE team_id = ANY($1::uuid[])
          ORDER BY team_id
          FOR UPDATE`,
        [teamIds]
      )
      if ((teamRevisions.rowCount ?? 0) !== teamIds.length) {
        throw new WorkflowAuthorityError(409, 'access_path_stale')
      }
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
