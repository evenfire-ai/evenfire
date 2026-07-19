import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { GovernedEventDetailService } from '../src/services/tracing/governedEventDetailService.js'

const EVENT_ID = '00000000-0000-4000-8000-000000000123'

describe('GovernedEventDetailService', () => {
  it('projects administrative identity, RFC axes, correlation, and closed safe fields', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          event_id: EVENT_ID,
          action: 'permission_grant',
          outcome: 'succeeded',
          occurred_at: '2026-07-14T10:00:00.000Z',
          ingested_at: '2026-07-14T10:00:01.000Z',
          operator_sub: 'operator-sub',
          operator_user_id: '00000000-0000-4000-8000-000000000001',
          operator_principal_id: '00000000-0000-4000-8000-000000000001',
          operator_principal_kind: 'platform_user',
          operator_display_name: 'Operator One',
          identity_issuer: 'https://issuer.example.test',
          delegated_actor_sub: 'service-agent',
          source_kind: 'control_api_local',
          source_service: 'control-api',
          service_sub: 'workflow-approvals',
          resource_aud: 'resource-aud',
          effective_scopes: ['approval:write'],
          token_exchange_id: '00000000-0000-4000-8000-000000000002',
          authorization_decision: 'allow',
          decision_actor_sub: 'policy-engine',
          approval_request_id: '00000000-0000-4000-8000-000000000003',
          operation_id: '00000000-0000-4000-8000-000000000004',
          request_id: 'request-1',
          related_run_id: '00000000-0000-4000-8000-000000000005',
          environment: 'test',
          namespace: 'control-plane',
          deployment_ref: 'deployment/control-api',
          team_id: 'team-1',
          target_team_display_name: 'Operations',
          source_audit_ref: 'audit-1',
          source_adapter_kind: 'http',
          source_adapter_version: 'v1',
          code_digest: 'a'.repeat(64),
          config_digest: 'b'.repeat(64),
          policy_digest: 'c'.repeat(64),
          authorization_ref: 'authorization-1',
          effect_ref: 'effect-1',
          pre_state_digest: 'd'.repeat(64),
          post_state_digest: 'e'.repeat(64),
          payload_sha256: 'f'.repeat(64),
          target_type: 'permission',
          target_ref: 'permission/1',
          target_human_sub: 'target-sub',
          target_user_id: '00000000-0000-4000-8000-000000000006',
          target_display_name: 'Target User',
          target_identity_issuer: 'https://issuer.example.test',
          payload_metadata: {
            reason_code: 'approved_policy',
            status: 'succeeded',
            resource_class: 'platform_user',
            count: 1,
            config_hash: 'a'.repeat(64),
            summary: 'FORBIDDEN_ADMIN_SUMMARY',
            detail_ref: 'password=hunter2',
            arbitrary: 'forbidden',
          },
        },
      ],
      rowCount: 1,
    })

    const detail = await new GovernedEventDetailService({ query } as never).administrative(EVENT_ID)

    expect(detail).toMatchObject({
      operatorHuman: {
        status: 'verified',
        principalKind: 'platform_user',
        principalId: '00000000-0000-4000-8000-000000000001',
        subject: 'operator-sub',
        displayName: 'Operator One',
      },
      delegatedActor: { subject: 'service-agent' },
      authorization: { decision: 'allow', decisionActorSub: 'policy-engine' },
      context: { teamId: 'team-1', teamDisplayName: 'Operations' },
      targetHuman: { status: 'verified', subject: 'target-sub', displayName: 'Target User' },
      safeFields: {
        reason_code: 'approved_policy',
        status: 'succeeded',
        resource_class: 'platform_user',
        count: 1,
        config_hash: 'a'.repeat(64),
      },
    })
    expect(JSON.stringify(detail)).not.toContain('arbitrary')
    expect(JSON.stringify(detail)).not.toContain('forbidden')
    expect(JSON.stringify(detail)).not.toMatch(/FORBIDDEN_ADMIN_SUMMARY|hunter2/)
    expect(String(query.mock.calls[0]?.[0])).toContain('control_admin_users')
  })

  it('resolves a legacy Control UI administrator UUID without rewriting the event', async () => {
    const adminId = '00000000-0000-4000-8000-000000000009'
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          event_id: EVENT_ID,
          action: 'host_mutation',
          outcome: 'attempted',
          occurred_at: '2026-07-14T10:00:00.000Z',
          ingested_at: '2026-07-14T10:00:01.000Z',
          operator_sub: adminId,
          operator_user_id: null,
          operator_principal_id: adminId,
          operator_principal_kind: 'control_admin',
          operator_display_name: 'Control Admin',
          identity_issuer: null,
          delegated_actor_sub: null,
          source_kind: 'control_api_local',
          source_service: 'control-api',
          service_sub: 'control-api',
          resource_aud: null,
          effective_scopes: [],
          token_exchange_id: null,
          authorization_decision: null,
          decision_actor_sub: null,
          approval_request_id: null,
          operation_id: null,
          request_id: null,
          related_run_id: null,
          environment: 'test',
          namespace: 'control-plane',
          deployment_ref: null,
          team_id: null,
          source_audit_ref: null,
          source_adapter_kind: null,
          source_adapter_version: null,
          code_digest: null,
          config_digest: null,
          policy_digest: null,
          authorization_ref: null,
          effect_ref: null,
          pre_state_digest: null,
          post_state_digest: null,
          payload_sha256: 'f'.repeat(64),
          target_type: 'control_admin',
          target_ref: 'control_admin:00000000-0000-4000-8000-000000000010',
          target_human_sub: '00000000-0000-4000-8000-000000000010',
          target_user_id: null,
          target_display_name: null,
          target_control_admin_display_name: null,
          target_identity_issuer: config.adminJwtIssuer,
          payload_metadata: { target_label: 'deleted_admin' },
        },
      ],
      rowCount: 1,
    })

    const detail = await new GovernedEventDetailService({ query } as never).administrative(EVENT_ID)

    expect(detail?.operatorHuman).toEqual({
      status: 'verified_late',
      principalKind: 'control_admin',
      principalId: adminId,
      subject: adminId,
      userId: null,
      displayName: 'Control Admin',
      identityIssuer: null,
    })
    expect(detail?.targetHuman).toMatchObject({
      status: 'verified',
      principalKind: 'control_admin',
      principalId: '00000000-0000-4000-8000-000000000010',
      displayName: 'deleted_admin',
    })
  })

  it('projects infrastructure source, workload, correlation, usage, and integrity without metadata blobs', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          event_id: EVENT_ID,
          telemetry_type: 'capacity_sample',
          trigger_kind: 'periodic_sample',
          outcome: 'healthy',
          reason_code: null,
          occurred_at: '2026-07-14T10:00:00.000Z',
          ingested_at: '2026-07-14T10:00:01.000Z',
          source_kind: 'trace_maintenance',
          source_service: 'control-api',
          source_occurrence_id: 'sample-1',
          source_adapter_kind: 'k8s',
          source_adapter_version: 'v1',
          environment: 'test',
          cluster_name: 'cluster-1',
          namespace: 'control-plane',
          workload_kind: 'Deployment',
          workload_ref: 'control-api',
          kubernetes_kind: 'Deployment',
          kubernetes_name: 'control-api',
          kubernetes_uid: 'uid-1',
          metadata_generation: '12',
          related_operation_id: null,
          related_run_id: '00000000-0000-4000-8000-000000000456',
          authorization_ref: 'authorization-1',
          effect_ref: 'effect-1',
          interval_start: '2026-07-14T09:00:00.000Z',
          interval_end: '2026-07-14T10:00:00.000Z',
          desired_replicas: 2,
          observed_replicas: 2,
          ready_replicas: 2,
          cpu_request_cores: '1.000000',
          cpu_limit_cores: '2.000000',
          memory_request_bytes: '1024',
          memory_limit_bytes: '2048',
          cpu_usage_core_seconds: '42.000000000',
          memory_usage_byte_seconds: '99.000000000',
          code_digest: 'a'.repeat(64),
          config_digest: 'b'.repeat(64),
          policy_digest: 'c'.repeat(64),
          pre_state_digest: 'd'.repeat(64),
          post_state_digest: 'e'.repeat(64),
          payload_sha256: 'f'.repeat(64),
          payload_metadata: {
            status: 'ready',
            error_class: 'ControllerTimeout',
            count: 2,
            summary: 'FORBIDDEN_INFRA_SUMMARY',
            provider_ref: 'secret=provider-key',
            detail_ref: 'FORBIDDEN_INFRA_DETAIL',
            arbitrary: 'forbidden',
          },
        },
      ],
      rowCount: 1,
    })

    const detail = await new GovernedEventDetailService({ query } as never).infrastructure(EVENT_ID)

    expect(detail).toMatchObject({
      triggerKind: 'periodic_sample',
      source: { controller: 'control-api', sourceOccurrenceId: 'sample-1' },
      scope: { clusterName: 'cluster-1', workloadRef: 'control-api', metadataGeneration: '12' },
      correlation: { runId: '00000000-0000-4000-8000-000000000456' },
      capacity: { desiredReplicas: 2, memoryLimitBytes: '2048' },
      usage: { cpuUsageCoreSeconds: '42.000000000' },
      safeFields: { status: 'ready', error_class: 'ControllerTimeout', count: 2 },
    })
    expect(JSON.stringify(detail)).not.toContain('arbitrary')
    expect(JSON.stringify(detail)).not.toContain('forbidden')
    expect(JSON.stringify(detail)).not.toMatch(/FORBIDDEN_INFRA|provider-key/)
  })
})
