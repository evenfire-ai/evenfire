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
      hostLookupReference: {
        name: 'chatllm',
        namespace: 'mcp-host',
        generation: 7,
        uid: 'host-uid',
      },
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
          hostLookupReference: {
            name: 'chatllm',
            namespace: 'mcp-host',
            generation: 7,
            uid: 'host-uid',
          },
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
        hostLookupReference: {
          name: 'chatllm',
          namespace: 'mcp-host',
          generation: 7,
          uid: 'host-uid',
        },
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
          metadata: { name: 'chatllm', namespace: 'mcp-host', uid: 'host-uid', generation: 7 },
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
          hostLookupReference: {
            name: 'chatllm',
            namespace: 'mcp-host',
            generation: 7,
            uid: 'host-uid',
          },
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
        metadata: { name: 'chatllm', namespace: 'mcp-host', uid: 'host-uid', generation: 8 },
      }),
    })
    const reference = {
      name: 'chatllm',
      namespace: 'mcp-host',
      generation: 7,
      uid: 'host-uid',
    }

    await expect(
      unavailable.resolve(principal, {
        sourceEventId: 'health-1',
        occurredAt: NOW,
        telemetryType: 'health_transition',
        hostLookupReference: reference,
      })
    ).resolves.toBeNull()
    await expect(
      stale.resolve(principal, {
        sourceEventId: 'health-1',
        occurredAt: NOW,
        telemetryType: 'health_transition',
        hostLookupReference: reference,
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

  it('binds a reconcile outcome only to the Host object whose uid it observed (#691)', async () => {
    // Same name, namespace and generation 1: a recreated Host differs only by uid.
    const hostLookup = {
      getResource: vi.fn().mockResolvedValue({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: { name: 'chatllm', namespace: 'mcp-host', uid: 'new-uid', generation: 1 },
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
    const resolver = new HccHealthTransitionBindingResolver(hostLookup)
    const event = (uid?: string) => ({
      sourceEventId: `reconcile-${uid ?? 'no-uid'}`,
      occurredAt: NOW,
      telemetryType: 'reconcile_outcome' as const,
      hostLookupReference: {
        name: 'chatllm',
        namespace: 'mcp-host',
        generation: 1,
        ...(uid === undefined ? {} : { uid }),
      },
      payload: { status: 'succeeded', reason_code: 'ready' },
    })

    await expect(resolver.resolve(principal, event('new-uid'))).resolves.toMatchObject({
      kubernetesUid: 'new-uid',
      metadataGeneration: 1,
    })
    await expect(resolver.resolve(principal, event('old-uid'))).resolves.toBeNull()
    // A reference without uid was accepted while HCC was still rolling out
    // (#691). It is now refused as invalid input, not silently bound to
    // whichever Host answers to the name (#693).
    await expect(resolver.resolve(principal, event())).rejects.toMatchObject({
      code: 'invalid_tracing_input',
      status: 400,
    })
    // Liveness: the authoritative Host read ran for both uid-bearing
    // references, and not for the one refused before the lookup.
    expect(hostLookup.getResource).toHaveBeenCalledTimes(2)
  })

  it('refuses an unresolvable Host reference before reading the API server (#693)', async () => {
    const hostLookup = { getResource: vi.fn() }
    const principal = {
      kind: 'hcc_internal_control',
      sourceService: 'host-context-controller',
      serviceSub: 'hcc-provisioner',
      credentialId: 'hcc-1',
      resourceAuthority: 'hcc_managed',
      allowedTelemetryTypes: ['health_transition'],
    } as const

    await expect(
      new HccHealthTransitionBindingResolver(hostLookup).resolve(principal, {
        sourceEventId: 'health-no-uid',
        occurredAt: NOW,
        telemetryType: 'health_transition',
        hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      })
    ).rejects.toMatchObject({ code: 'invalid_tracing_input', status: 400 })
    // A 400 is terminal for HCC, so the rejection has to be decidable from the
    // request alone: no authoritative read, no dependence on cluster state.
    expect(hostLookup.getResource).not.toHaveBeenCalled()
  })

  it('leaves a non-HCC event to the next resolver instead of rejecting it (#693)', async () => {
    // The uid requirement sits behind the principal guard on purpose. The
    // chain does not catch exceptions, so a throw here would abort a WRC batch
    // before wrcInfrastructureBindingResolver ever saw it.
    const hostLookup = { getResource: vi.fn() }
    const resolver = new HccHealthTransitionBindingResolver(hostLookup)
    const principal = {
      kind: 'wrc_internal_control',
      sourceService: 'workflow-recipes',
      serviceSub: 'wrc-provisioner',
      credentialId: 'wrc-1',
      resourceAuthority: 'wrc_managed',
      allowedTelemetryTypes: ['health_transition'],
    } as const
    const hccPrincipal = {
      kind: 'hcc_internal_control',
      sourceService: 'host-context-controller',
      serviceSub: 'hcc-provisioner',
      credentialId: 'hcc-1',
      resourceAuthority: 'hcc_managed',
      allowedTelemetryTypes: ['health_transition'],
    } as const
    const event = {
      sourceEventId: 'health-wrc',
      occurredAt: NOW,
      telemetryType: 'health_transition' as const,
      hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
    }

    await expect(resolver.resolve(principal, event)).resolves.toBeNull()
    // Liveness: the same instance and the same uid-less reference, submitted
    // under the HCC principal, do throw. The null above is the principal guard
    // deciding, not a resolver that returns null for anything handed to it.
    await expect(resolver.resolve(hccPrincipal, event)).rejects.toMatchObject({
      code: 'invalid_tracing_input',
      status: 400,
    })
    expect(hostLookup.getResource).not.toHaveBeenCalled()
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
