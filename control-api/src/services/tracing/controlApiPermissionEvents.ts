import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import type { AdministrativeEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import { currentAdministrativeRequestContext } from './adminOperationContext.js'
import { AdministrativeEventService } from './administrativeEvents.js'
import type {
  AdministrativeEventInputV1,
  AdministrativeServerBindingV1,
  TracingServiceDependencies,
} from './contracts.js'
import { CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1 } from './controlApiLocalAdministrativeBindingResolver.js'
import { canonicalTracingEnvironment } from './environment.js'

export type ControlApiPermissionSubject =
  | { kind: 'user'; id: string }
  | { kind: 'team'; id: string }
  | {
      kind: 'service'
      id: string | null
      principalKind?: 'operator' | 'host' | 'context' | 'service'
    }

export type ControlApiPermissionChange = {
  action: 'grant' | 'revoke'
  resourceClass: string
  resourceRef: string
  subject: ControlApiPermissionSubject
  namespace?: string | null
  teamId?: string | null
  sourceAuditRef?: string | null
  status?: string
  detailRef?: string
  count?: number
  outcome?: 'committed' | 'rejected'
  authorizationDecision?: 'allow' | 'deny'
}

type PermissionEventDependencies = Pick<TracingServiceDependencies, 'now' | 'newEventId'>
const PERMISSION_EVENT_BATCH_SIZE = 100

const CONTROL_API_PERMISSION_ADMINISTRATIVE_PRINCIPAL_V1 = {
  ...CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
  serviceSub: 'access-administration',
}

/** Appends one governed event per affected principal inside the mutation transaction. */
export async function appendControlApiPermissionEventsInTransaction(
  db: DbClient,
  params: {
    operatorSub: string
    changes: readonly ControlApiPermissionChange[]
    operationId?: string
    operatorKind?: 'control_admin' | 'platform_user'
    /**
     * Authenticated technical principal for an internal control-plane
     * mutation. Its service subject is auditable but is never coerced into the
     * UUID-only operator_user_id column.
     */
    internalPrincipal?: AdministrativeEventSubmitterPrincipalV1
    requestId?: string | null
    dependencies?: PermissionEventDependencies
  }
): Promise<string | null> {
  if (params.changes.length === 0) return null

  const operationId = params.operationId ?? randomUUID()
  const now = params.dependencies?.now ?? (() => new Date())
  const requestContext = currentAdministrativeRequestContext()
  const internalPrincipal = params.internalPrincipal
  if (internalPrincipal && internalPrincipal.serviceSub !== params.operatorSub) {
    throw new Error('internal permission-event principal does not match operatorSub')
  }
  const localAdminRequest =
    !internalPrincipal &&
    (params.operatorKind === 'control_admin' ||
      (params.operatorKind === undefined &&
        Boolean(requestContext && requestContext.operatorSub === params.operatorSub)))
  const events = new AdministrativeEventService({
    transaction: async () => {
      throw new Error('permission event append requires the caller transaction')
    },
    ...params.dependencies,
  })

  const entries: Array<{
    binding: AdministrativeServerBindingV1
    input: AdministrativeEventInputV1
  }> = params.changes.map((change, index) => {
    const targetsUser = change.subject.kind === 'user'
    const targetsTeam = change.subject.kind === 'team'
    const targetServiceSubject = change.subject.kind === 'service' ? change.subject : null
    const targetPrincipalKind = targetServiceSubject?.principalKind ?? 'service'
    const targetPrincipalRef = targetServiceSubject?.id
      ? targetPrincipalKind === 'service' && !targetServiceSubject.id.startsWith('service:')
        ? `service:${targetServiceSubject.id}`
        : targetServiceSubject.id
      : null
    const outcome = change.outcome ?? 'committed'
    const authorizationDecision =
      change.authorizationDecision ?? (outcome === 'rejected' ? 'deny' : 'allow')
    return {
      binding: {
        action: change.action === 'grant' ? 'permission_grant' : 'permission_revoke',
        outcome,
        operatorSub: params.operatorSub,
        operatorUserId: internalPrincipal ? null : params.operatorSub,
        operationId,
        relatedRunId: null,
        requestId:
          params.requestId !== undefined
            ? params.requestId
            : localAdminRequest
              ? (requestContext?.requestId ?? null)
              : null,
        targetType: 'permission',
        targetRef: change.resourceRef,
        environment: canonicalTracingEnvironment(),
        tenantId: null,
        teamId: change.teamId ?? (targetsTeam ? change.subject.id : null),
        namespace: change.namespace ?? null,
        sourceAuditRef: change.sourceAuditRef ?? null,
        targetIdentityIssuer: targetsUser ? config.jwtIssuer : null,
        targetHumanSub: targetsUser ? change.subject.id : null,
        targetUserId: targetsUser ? change.subject.id : null,
        identityIssuer: internalPrincipal
          ? internalPrincipal.kind === 'wrc_internal_control'
            ? 'wrc'
            : 'hcc'
          : localAdminRequest
            ? config.adminJwtIssuer
            : config.jwtIssuer,
        resourceAud: internalPrincipal
          ? 'control-api'
          : localAdminRequest
            ? config.adminJwtAudience
            : config.jwtAudience,
        effectiveScopes: [],
        authorizationDecision,
        decisionActorSub: params.operatorSub,
      },
      input: {
        kind: 'service_action' as const,
        sourceEventId: `control-api:permission:${operationId}:${index}`,
        occurredAt: now().toISOString(),
        reasonCode:
          outcome === 'rejected'
            ? `permission_${change.action}_rejected`
            : `permission_${change.action}ed`,
        payload: {
          resource_class: change.resourceClass,
          status:
            change.status ??
            (outcome === 'rejected'
              ? `${change.action}_rejected`
              : change.action === 'grant'
                ? 'granted'
                : 'revoked'),
          ...(change.detailRef ? { detail_ref: change.detailRef } : {}),
          ...(change.count === undefined ? {} : { count: change.count }),
          ...(targetPrincipalRef
            ? {
                target_principal_kind: targetPrincipalKind,
                target_principal_ref: targetPrincipalRef,
              }
            : {}),
        },
      },
    }
  })

  for (let start = 0; start < entries.length; start += PERMISSION_EVENT_BATCH_SIZE) {
    await events.appendManyInTransaction(
      db,
      internalPrincipal ?? CONTROL_API_PERMISSION_ADMINISTRATIVE_PRINCIPAL_V1,
      entries.slice(start, start + PERMISSION_EVENT_BATCH_SIZE)
    )
  }

  return operationId
}
