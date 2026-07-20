import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import type { AdministrativeEventDetailV1, InfrastructureEventDetailV1 } from './contracts.js'
import { projectTraceSafeFields } from './traceSafeFieldProjection.js'

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}
function iso(value: unknown): string {
  return new Date(String(value)).toISOString()
}

export class GovernedEventDetailService {
  constructor(private readonly db: Pick<DbClient, 'query'>) {}

  async administrative(eventId: string): Promise<AdministrativeEventDetailV1 | null> {
    const result = await this.db.query(
      `WITH event AS (
         SELECT e.*,
                CASE
                  WHEN e.operator_user_id IS NOT NULL THEN e.operator_user_id
                  WHEN e.operator_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN e.operator_sub::uuid
                  ELSE NULL
                END AS operator_resolved_id
           FROM administrative_events e
          WHERE e.event_id=$1::uuid
       )
       SELECT e.*,
              CASE
                WHEN ou.id IS NOT NULL AND oa.id IS NULL THEN COALESCE(op.display_name, ou.name, ou.email)
                WHEN oa.id IS NOT NULL AND ou.id IS NULL THEN COALESCE(oa.username, oa.email)
                ELSE NULL
              END AS operator_display_name,
              CASE
                WHEN ou.id IS NOT NULL AND oa.id IS NULL THEN 'platform_user'
                WHEN oa.id IS NOT NULL AND ou.id IS NULL THEN 'control_admin'
                WHEN e.operator_sub IS NULL AND e.operator_resolved_id IS NULL THEN 'system'
                ELSE 'unresolved'
              END AS operator_principal_kind,
              CASE
                WHEN (ou.id IS NOT NULL) <> (oa.id IS NOT NULL) THEN e.operator_resolved_id::text
                ELSE NULL
              END AS operator_principal_id,
              COALESCE(tp.display_name, tu.name, tu.email) AS target_display_name,
              COALESCE(ta.username, ta.email) AS target_control_admin_display_name,
              target_team.name AS target_team_display_name
         FROM event e
    LEFT JOIN users ou ON ou.id=e.operator_resolved_id
    LEFT JOIN profiles op ON op.user_id=ou.id
    LEFT JOIN control_admin_users oa ON oa.id=e.operator_resolved_id
    LEFT JOIN users tu ON tu.id=e.target_user_id LEFT JOIN profiles tp ON tp.user_id=tu.id
    LEFT JOIN control_admin_users ta ON ta.id = CASE
      WHEN e.target_identity_issuer = $2
       AND e.target_human_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN e.target_human_sub::uuid
      ELSE NULL
    END
    LEFT JOIN teams target_team ON target_team.id = CASE
      WHEN e.team_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN e.team_id::uuid
      ELSE NULL
    END
        `,
      [eventId, config.adminJwtIssuer]
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    const operatorUserId = text(row.operator_user_id)
    const operatorSubject = text(row.operator_sub)
    const operatorPrincipalId = text(row.operator_principal_id)
    const operatorPrincipalKind = String(
      row.operator_principal_kind ?? 'unresolved'
    ) as AdministrativeEventDetailV1['operatorHuman']['principalKind']
    const targetUserId = text(row.target_user_id)
    const targetSubject = text(row.target_human_sub)
    const targetIdentityIssuer = text(row.target_identity_issuer)
    const targetIsControlAdmin = Boolean(
      targetSubject && targetIdentityIssuer === config.adminJwtIssuer
    )
    const safeFields = projectTraceSafeFields(row.payload_metadata, 'administrative')
    return {
      eventId: String(row.event_id),
      action: String(row.action),
      outcome: String(row.outcome),
      occurredAt: iso(row.occurred_at),
      ingestedAt: iso(row.ingested_at),
      operatorHuman: {
        status:
          operatorPrincipalKind === 'system'
            ? 'system'
            : operatorPrincipalKind === 'unresolved'
              ? operatorSubject
                ? 'legacy'
                : 'unavailable'
              : operatorUserId
                ? 'verified'
                : 'verified_late',
        principalKind: operatorPrincipalKind,
        principalId: operatorPrincipalId,
        subject: operatorSubject,
        userId: operatorPrincipalKind === 'platform_user' ? operatorPrincipalId : null,
        displayName: operatorPrincipalId ? text(row.operator_display_name) : null,
        identityIssuer: text(row.identity_issuer),
      },
      delegatedActor: { subject: text(row.delegated_actor_sub) },
      evidenceProducer: {
        sourceKind: String(row.source_kind),
        sourceService: String(row.source_service),
        serviceSub: String(row.service_sub),
      },
      authorization: {
        resourceAud: text(row.resource_aud),
        effectiveScopes: Array.isArray(row.effective_scopes)
          ? row.effective_scopes.map(String)
          : [],
        tokenExchangeId: text(row.token_exchange_id),
        decision: text(row.authorization_decision),
        decisionActorSub: text(row.decision_actor_sub),
        approvalRequestId: text(row.approval_request_id),
        operationId: text(row.operation_id),
        requestId: text(row.request_id),
        relatedRunId: text(row.related_run_id),
      },
      context: {
        environment: text(row.environment),
        namespace: text(row.namespace),
        deploymentRef: text(row.deployment_ref),
        teamId: text(row.team_id),
        teamDisplayName: text(row.target_team_display_name),
      },
      provenance: {
        sourceAuditRef: text(row.source_audit_ref),
        sourceAdapterKind: text(row.source_adapter_kind),
        sourceAdapterVersion: text(row.source_adapter_version),
        codeDigest: text(row.code_digest),
        configDigest: text(row.config_digest),
        policyDigest: text(row.policy_digest),
        authorizationRef: text(row.authorization_ref),
        effectRef: text(row.effect_ref),
        preStateDigest: text(row.pre_state_digest),
        postStateDigest: text(row.post_state_digest),
        payloadSha256: String(row.payload_sha256),
      },
      targetResource: { type: String(row.target_type), ref: String(row.target_ref) },
      targetHuman: {
        status:
          targetUserId || targetIsControlAdmin
            ? 'verified'
            : targetSubject
              ? 'legacy'
              : 'unavailable',
        principalKind: targetUserId
          ? 'platform_user'
          : targetIsControlAdmin
            ? 'control_admin'
            : targetSubject
              ? 'unresolved'
              : 'system',
        principalId: targetUserId ?? (targetIsControlAdmin ? targetSubject : null),
        subject: targetSubject,
        userId: targetUserId,
        displayName: targetUserId
          ? text(row.target_display_name)
          : targetIsControlAdmin
            ? (text(row.target_control_admin_display_name) ?? text(safeFields.target_label))
            : null,
        identityIssuer: targetIdentityIssuer,
      },
      safeFields,
    }
  }

  async infrastructure(eventId: string): Promise<InfrastructureEventDetailV1 | null> {
    const result = await this.db.query(
      'SELECT * FROM infrastructure_telemetry_events WHERE event_id=$1::uuid',
      [eventId]
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return {
      eventId: String(row.event_id),
      telemetryType: row.telemetry_type as InfrastructureEventDetailV1['telemetryType'],
      outcome: String(row.outcome),
      reasonCode: text(row.reason_code),
      triggerKind: String(row.trigger_kind),
      occurredAt: iso(row.occurred_at),
      ingestedAt: iso(row.ingested_at),
      source: {
        sourceKind: String(row.source_kind),
        sourceService: String(row.source_service),
        controller: String(row.source_service),
        sourceOccurrenceId: String(row.source_occurrence_id),
        sourceAdapterKind: text(row.source_adapter_kind),
        sourceAdapterVersion: text(row.source_adapter_version),
      },
      scope: {
        environment: String(row.environment),
        clusterName: String(row.cluster_name),
        namespace: String(row.namespace),
        workloadKind: String(row.workload_kind),
        workloadRef: String(row.workload_ref),
        kubernetesKind: String(row.kubernetes_kind),
        kubernetesName: String(row.kubernetes_name),
        kubernetesUid: text(row.kubernetes_uid),
        metadataGeneration: text(row.metadata_generation),
      },
      correlation: {
        operationId: text(row.related_operation_id),
        runId: text(row.related_run_id),
        authorizationRef: text(row.authorization_ref),
        effectRef: text(row.effect_ref),
      },
      interval: {
        start: row.interval_start ? iso(row.interval_start) : null,
        end: row.interval_end ? iso(row.interval_end) : null,
      },
      capacity: {
        desiredReplicas: row.desired_replicas === null ? null : Number(row.desired_replicas),
        observedReplicas: row.observed_replicas === null ? null : Number(row.observed_replicas),
        readyReplicas: row.ready_replicas === null ? null : Number(row.ready_replicas),
        cpuRequestCores: text(row.cpu_request_cores),
        cpuLimitCores: text(row.cpu_limit_cores),
        memoryRequestBytes: text(row.memory_request_bytes),
        memoryLimitBytes: text(row.memory_limit_bytes),
      },
      usage: {
        cpuUsageCoreSeconds: text(row.cpu_usage_core_seconds),
        memoryUsageByteSeconds: text(row.memory_usage_byte_seconds),
      },
      integrity: {
        codeDigest: text(row.code_digest),
        configDigest: text(row.config_digest),
        policyDigest: text(row.policy_digest),
        preStateDigest: text(row.pre_state_digest),
        postStateDigest: text(row.post_state_digest),
        payloadSha256: String(row.payload_sha256),
      },
      safeFields: projectTraceSafeFields(row.payload_metadata, 'infrastructure'),
    }
  }
}
