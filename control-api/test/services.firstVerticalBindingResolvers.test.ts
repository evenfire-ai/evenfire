import { describe, expect, it, vi } from 'vitest'
import { AdministrativeEventService } from '../src/services/tracing/administrativeEvents.js'
import {
  CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
  ControlApiLocalAdministrativeBindingResolver,
} from '../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js'
import {
  HCC_HEALTH_TRANSITION_BINDING_BLOCKER,
  HccHealthTransitionBindingResolver,
} from '../src/services/tracing/hccHealthTransitionBindingResolver.js'
import { WrcInfrastructureBindingResolver } from '../src/services/tracing/wrcInfrastructureBindingResolver.js'
import { acceptedDb, harness } from './services.tracingFixtures.js'

const NOW = '2026-07-11T10:00:00.000Z'

describe('first vertical trusted binding resolvers', () => {
  it('derives the deterministic control-api-local administrative binding from in-process context', async () => {
    const context = {
      sourceEventId: 'governed-tracing-config-v1',
      requestId: 'request-1',
      environment: 'test',
    } as const
    const input = {
      sourceEventId: context.sourceEventId,
      occurredAt: NOW,
      kind: 'service_action' as const,
      payload: { config_hash: 'a'.repeat(64) },
    }
    const binding = new ControlApiLocalAdministrativeBindingResolver().resolve(context, input)

    expect(CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1).toMatchObject({
      kind: 'control_api_local',
      sourceService: 'control-api',
      allowedKinds: ['service_action'],
    })
    expect(binding).toEqual({
      action: 'configuration_mutation',
      outcome: 'committed',
      operatorSub: null,
      operationId: null,
      relatedRunId: null,
      requestId: 'request-1',
      targetType: 'configuration',
      targetRef: 'control-api/governed-tracing',
      environment: 'test',
      tenantId: null,
      teamId: null,
      namespace: null,
      sourceAuditRef: null,
    })

    const h = harness()
    acceptedDb(h.query)
    await new AdministrativeEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => '11111111-1111-4111-8111-111111111111',
    }).appendControlApiLocalInTransaction(h.db, context, input)

    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(
      h.query.mock.calls.filter(([sql]) => String(sql).includes('inserted_family'))
    ).toHaveLength(1)
  })

  it('does not allow local context to bind a different source occurrence or event kind', () => {
    const resolver = new ControlApiLocalAdministrativeBindingResolver()
    const context = {
      sourceEventId: 'governed-tracing-config-v1',
      requestId: null,
      environment: 'test',
    }

    expect(
      resolver.resolve(context, {
        sourceEventId: 'other-event',
        occurredAt: NOW,
        kind: 'service_action',
      })
    ).toBeNull()
    expect(
      resolver.resolve(context, {
        sourceEventId: context.sourceEventId,
        occurredAt: NOW,
        kind: 'intent',
      })
    ).toBeNull()
  })

  it('derives HCC health bindings only from an authoritative Host lookup', async () => {
    const hostLookup = {
      getResource: vi.fn().mockResolvedValue({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: { name: 'chatllm', namespace: 'mcp-host', uid: 'host-uid', generation: 7 },
      }),
    }
    const resolver = new HccHealthTransitionBindingResolver(hostLookup)
    const principal = {
      kind: 'hcc_internal_control',
      sourceService: 'host-context-controller',
      serviceSub: 'hcc-provisioner',
      credentialId: 'hcc-1',
      resourceAuthority: 'hcc_managed',
      allowedTelemetryTypes: ['health_transition'],
    } as const

    const binding = await resolver.resolve(principal, {
      sourceEventId: 'health-1',
      occurredAt: NOW,
      telemetryType: 'health_transition',
      hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
    })

    expect(hostLookup.getResource).toHaveBeenCalledWith('hosts', 'chatllm', 'mcp-host')
    expect(binding).toMatchObject({
      workloadRef: 'mcp-host/chatllm',
      kubernetesUid: 'host-uid',
      metadataGeneration: 7,
    })
  })

  it.each(['lifecycle_transition', 'reconcile_outcome', 'controller_error'] as const)(
    'derives HCC %s bindings from the same authoritative Host generation',
    async telemetryType => {
      const hostLookup = {
        getResource: vi.fn().mockResolvedValue({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'Host',
          metadata: {
            name: 'chatllm',
            namespace: 'mcp-host',
            uid: 'host-uid',
            generation: 7,
          },
        }),
      }
      const principal = {
        kind: 'hcc_internal_control',
        sourceService: 'host-context-controller',
        serviceSub: 'hcc-provisioner',
        credentialId: 'hcc-1',
        resourceAuthority: 'hcc_managed',
        allowedTelemetryTypes: [telemetryType],
      } as const

      await expect(
        new HccHealthTransitionBindingResolver(hostLookup).resolve(principal, {
          sourceEventId: `${telemetryType}-1`,
          occurredAt: NOW,
          telemetryType,
          hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
          ...(telemetryType === 'reconcile_outcome'
            ? { payload: { status: 'succeeded', reason_code: 'ready' } }
            : telemetryType === 'controller_error'
              ? { payload: { status: 'failed', reason_code: 'reconcile_error' } }
              : {}),
        })
      ).resolves.toMatchObject({
        workloadRef: 'mcp-host/chatllm',
        outcome:
          telemetryType === 'controller_error'
            ? 'failed'
            : telemetryType === 'reconcile_outcome'
              ? 'succeeded'
              : 'unknown',
        reasonCode:
          telemetryType === 'reconcile_outcome'
            ? 'ready'
            : telemetryType === 'controller_error'
              ? 'reconcile_error'
              : null,
      })
    }
  )

  it.each([
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ] as const)('maps HCC reconcile evidence status %s to outcome %s', async (status, outcome) => {
    const hostLookup = {
      getResource: vi.fn().mockResolvedValue({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: {
          name: 'chatllm',
          namespace: 'mcp-host',
          uid: 'host-uid',
          generation: 7,
        },
      }),
    }
    const principal = {
      kind: 'hcc_internal_control',
      sourceService: 'host-context-controller',
      serviceSub: 'hcc-provisioner',
      credentialId: 'hcc-1',
      resourceAuthority: 'hcc_managed',
      allowedTelemetryTypes: ['reconcile_outcome'],
    } as const

    await expect(
      new HccHealthTransitionBindingResolver(hostLookup).resolve(principal, {
        sourceEventId: `reconcile-${status}`,
        occurredAt: NOW,
        telemetryType: 'reconcile_outcome',
        hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
        payload: { status, reason_code: status === 'succeeded' ? 'ready' : 'not_ready' },
      })
    ).resolves.toMatchObject({ outcome })
  })

  it.each([undefined, 'unknown', 'started'])(
    'rejects HCC reconcile evidence with unsupported status %s',
    async status => {
      const hostLookup = {
        getResource: vi.fn().mockResolvedValue({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'Host',
          metadata: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
        }),
      }
      const principal = {
        kind: 'hcc_internal_control',
        sourceService: 'host-context-controller',
        serviceSub: 'hcc-provisioner',
        credentialId: 'hcc-1',
        resourceAuthority: 'hcc_managed',
        allowedTelemetryTypes: ['reconcile_outcome'],
      } as const

      await expect(
        new HccHealthTransitionBindingResolver(hostLookup).resolve(principal, {
          sourceEventId: `reconcile-${status ?? 'missing'}`,
          occurredAt: NOW,
          telemetryType: 'reconcile_outcome',
          hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
          ...(status === undefined ? {} : { payload: { status } }),
        })
      ).resolves.toBeNull()
    }
  )

  it.each(['capacity_sample', 'usage_sample'] as const)(
    'keeps HCC %s fail-closed without an inventory or metrics binding',
    async telemetryType => {
      const hostLookup = { getResource: vi.fn() }
      const principal = {
        kind: 'hcc_internal_control',
        sourceService: 'host-context-controller',
        serviceSub: 'hcc-provisioner',
        credentialId: 'hcc-1',
        resourceAuthority: 'hcc_managed',
        allowedTelemetryTypes: [telemetryType],
      } as const
      await expect(
        new HccHealthTransitionBindingResolver(hostLookup).resolve(principal, {
          sourceEventId: `${telemetryType}-1`,
          occurredAt: NOW,
          telemetryType,
          hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
        })
      ).resolves.toBeNull()
      expect(hostLookup.getResource).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the Host reference is absent, stale, or unavailable', async () => {
    const principal = {
      kind: 'hcc_internal_control',
      sourceService: 'host-context-controller',
      serviceSub: 'hcc-provisioner',
      credentialId: 'hcc-1',
      resourceAuthority: 'hcc_managed',
      allowedTelemetryTypes: ['health_transition'],
    } as const
    const unavailable = new HccHealthTransitionBindingResolver({
      getResource: vi.fn().mockRejectedValue(new Error('not found')),
    })
    const stale = new HccHealthTransitionBindingResolver({
      getResource: vi.fn().mockResolvedValue({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: { name: 'chatllm', namespace: 'mcp-host', generation: 8 },
      }),
    })

    await expect(
      unavailable.resolve(principal, {
        sourceEventId: 'health-1',
        occurredAt: NOW,
        telemetryType: 'health_transition',
        hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      })
    ).resolves.toBeNull()
    await expect(
      stale.resolve(principal, {
        sourceEventId: 'health-1',
        occurredAt: NOW,
        telemetryType: 'health_transition',
        hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      })
    ).resolves.toBeNull()
    await expect(
      unavailable.resolve(principal, {
        sourceEventId: 'health-1',
        occurredAt: NOW,
        telemetryType: 'health_transition',
      })
    ).rejects.toMatchObject({ code: HCC_HEALTH_TRANSITION_BINDING_BLOCKER, status: 403 })
  })

  it('resolves WRC infrastructure batches from authoritative workflow rows in one query', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          run_id: '00000000-0000-4000-8000-000000000001',
          recipe_namespace: 'sandbox-recipes',
          recipe_name: 'demo',
          phase: 'Running',
          actor_type: 'autonomous',
          actor_id: null,
          team_id: null,
          usage_team_id: null,
          started_at: NOW,
          completed_at: null,
          approval_request_id: null,
          duration_ms: null,
          source: 'live',
        },
      ],
    })
    const principal = {
      kind: 'wrc_internal_control',
      sourceService: 'workflow-recipes',
      serviceSub: 'wrc-provisioner',
      credentialId: 'wrc-1',
      resourceAuthority: 'wrc_managed',
      allowedTelemetryTypes: ['lifecycle_transition'],
    } as const
    const event = {
      sourceEventId: 'lifecycle-1',
      occurredAt: NOW,
      telemetryType: 'lifecycle_transition' as const,
      workflowRunLookupReference: { runId: '00000000-0000-4000-8000-000000000001' },
    }
    const resolved = await new WrcInfrastructureBindingResolver(
      { query },
      'test',
      'cluster-1'
    ).resolveMany(principal, [event, { ...event, sourceEventId: 'lifecycle-2' }])

    expect(query).toHaveBeenCalledOnce()
    expect(resolved).toEqual([
      expect.objectContaining({
        workloadRef: 'sandbox-recipes/demo',
        relatedRunId: event.workflowRunLookupReference.runId,
      }),
      expect.objectContaining({
        workloadRef: 'sandbox-recipes/demo',
        relatedRunId: event.workflowRunLookupReference.runId,
      }),
    ])
  })
})
