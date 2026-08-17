import { describe, expect, it, vi } from 'vitest'
import {
  WorkflowRecipeWatcher,
  controllerErrorTelemetryProjection,
  externalEgressRefreshIntervalMs,
  recipeHasExternalExactHostEgress,
  recipeReferencesNamedSecrets,
  reconcileOutcomeTelemetryProjection,
  rotateBrokerTokensOnce,
  runtimeCredentialRefreshIntervalMs,
  shouldPatchRecipeStatus,
  workflowNeedsInfrastructureReconcile,
  workflowNeedsOwnershipBackstop,
  workflowNeedsRuntimeCredentialRefresh,
  workflowNeedsTerminalRunTeardown,
  workflowNeedsWorkloadStatusRefresh,
  workflowRecipeFromWatchObject,
} from './k8sClient'
import type { WorkflowRecipeCRD } from './types'

function makeWorkflowRecipe(overrides: Partial<WorkflowRecipeCRD> = {}): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'recipe',
      namespace: 'sandbox-recipes',
      ...(overrides.metadata ?? {}),
    },
    spec: {
      steps: [
        { id: 'step-1', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
      ],
      ...(overrides.spec ?? {}),
    },
    status: overrides.status,
  }
}

describe('workflowRecipeFromWatchObject', () => {
  it('preserves ownerReferences from Kubernetes watch objects', () => {
    const recipe = workflowRecipeFromWatchObject(
      {
        metadata: {
          name: 'child-run',
          uid: 'uid-child',
          labels: { 'clerum.io/parent-recipe': 'parent-recipe' },
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'WorkflowRecipe',
              name: 'parent-recipe',
              uid: 'uid-parent-recipe',
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        },
        spec: { steps: [{ id: 'step-1', instruction: 'run' }] },
      },
      'sandbox-recipes'
    )

    expect(recipe.metadata.namespace).toBe('sandbox-recipes')
    expect(recipe.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        name: 'parent-recipe',
        uid: 'uid-parent-recipe',
        controller: true,
        blockOwnerDeletion: true,
      },
    ])
  })
})

describe('rotateBrokerTokensOnce', () => {
  function makeRecipe(name: string, withBackgroundAccess: boolean): WorkflowRecipeCRD {
    return {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [{ id: 's1', instruction: 'noop' }],
        oauthClients: withBackgroundAccess
          ? [
              {
                id: 'gmail',
                provider: 'google',
                clientIdRef: { name: 'creds', key: 'client-id' },
                clientSecretRef: { name: 'creds', key: 'client-secret' },
                scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                backgroundAccess: true,
              },
            ]
          : [],
      } as WorkflowRecipeCRD['spec'],
    }
  }

  it('refreshes only recipes with a backgroundAccess client', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const recipes = [
      makeRecipe('with-bg', true),
      makeRecipe('without-bg', false),
      makeRecipe('also-with-bg', true),
    ]
    await rotateBrokerTokensOnce(recipes, refresh)
    expect(refresh).toHaveBeenCalledTimes(2)
    const names = refresh.mock.calls.map(c => c[0].metadata.name).sort()
    expect(names).toEqual(['also-with-bg', 'with-bg'])
  })

  it('continues iterating after a refresh throws and reports it via onError', async () => {
    const boom = new Error('apiserver 503')
    const refresh = vi
      .fn<(r: WorkflowRecipeCRD) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const recipes = [makeRecipe('first', true), makeRecipe('boom', true), makeRecipe('third', true)]
    await rotateBrokerTokensOnce(recipes, refresh, onError)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].metadata.name).toBe('boom')
    expect(onError.mock.calls[0][1]).toBe(boom)
  })
})

describe('shouldPatchRecipeStatus', () => {
  it('patches when a terminal workflow keeps the same phase but updates the message', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'e2e-scheduled-recipe', namespace: 'sandbox-recipes' },
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            message: 'Workflow running',
            lastTransitionTime: '2026-05-09T00:00:00Z',
          },
        },
        {
          phase: 'active',
          message: 'Workflow completed',
          workloadStatuses: [],
          skipStatusPatch: false,
        }
      )
    ).toBe(true)
  })

  it('patches active parent workflow recipes when stale workflowExecution must be cleared', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'e2e-scheduled-recipe', namespace: 'sandbox-recipes' },
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            workflowExecution: { phase: 'pending', message: 'stale parent run state' },
          },
        },
        {
          phase: 'active',
          message: 'Workflow trigger infrastructure registered (workflow-agentic)',
          workloadStatuses: [],
          clearWorkflowExecution: true,
        }
      )
    ).toBe(true)
  })

  it('patches when internal dependency readiness is missing on an otherwise steady active recipe', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'helpdesk', namespace: 'sandbox-recipes' },
          spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:test' }] },
          status: {
            phase: 'active',
            message: 'All workloads deployed',
            conditions: [
              { type: 'WebhookGatewayNotReady', status: 'False', lastTransitionTime: 'old' },
            ],
          },
        },
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          internalDependencyConditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'True',
              reason: 'Reconciled',
              message: 'Reconciled 6 WRC internal dependency rule(s)',
              lastTransitionTime: 'now',
            },
          ],
        }
      )
    ).toBe(true)
  })

  it('patches when stale internal dependency readiness must be cleared', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'policy-blocked', namespace: 'sandbox-recipes' },
          spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:test' }] },
          status: {
            phase: 'failed',
            message: 'Policy violation: blocked',
            conditions: [
              {
                type: 'InternalDependenciesReady',
                status: 'False',
                reason: 'InvalidInternalDependency',
                message: 'stale',
                lastTransitionTime: 'old',
              },
            ],
          },
        },
        {
          phase: 'failed',
          message: 'Policy violation: blocked',
          workloadStatuses: [],
        }
      )
    ).toBe(true)
  })

  it('does not patch steady state when phase and message already match', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'e2e-scheduled-recipe', namespace: 'sandbox-recipes' },
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            message: 'Workflow completed',
            lastTransitionTime: '2026-05-09T00:00:00Z',
          },
        },
        {
          phase: 'active',
          message: 'Workflow completed',
          workloadStatuses: [],
          skipStatusPatch: false,
        }
      )
    ).toBe(false)
  })

  it('patches a contradictory persisted SDK capability message', () => {
    expect(
      shouldPatchRecipeStatus(
        makeWorkflowRecipe({
          spec: { steps: [], pluginWorkloadSdk: { promptBridge: {} } },
          status: {
            phase: 'active',
            message: 'All workloads deployed',
            pluginWorkloadSdk: {
              state: 'validated',
              promptBridge: true,
              clientNotifications: false,
              message: 'promptBridge bootstrap policy proof is not ready',
            },
            conditions: [
              {
                type: 'PluginWorkloadSdkCapability',
                status: 'True',
                reason: 'Validated',
                message: 'Capability validated (promptBridge)',
                lastTransitionTime: 'now',
              },
            ],
          },
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
        }
      )
    ).toBe(true)
  })

  it('patches when only the persisted workload status projection changes', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'api-recipe', namespace: 'sandbox-recipes' },
          spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:test' }] },
          status: {
            phase: 'degraded',
            message: 'Some workloads not ready',
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                phase: 'degraded',
                ready: false,
                message: 'Deployment "api" updated/ready/available/desired 1/0/0/1',
              },
            ],
          },
        },
        {
          phase: 'degraded',
          message: 'Some workloads not ready',
          workloadStatuses: [
            {
              id: 'api',
              phase: 'degraded',
              ready: false,
              message: 'Deployment "api" updated/ready/available/desired 1/1/0/1',
            },
          ],
        }
      )
    ).toBe(true)
  })

  it('does not patch steady active workflow recipes without observable status changes', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'e2e-scheduled-recipe', namespace: 'sandbox-recipes' },
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            message: 'Workflow trigger infrastructure registered (workflow-agentic)',
          },
        },
        {
          phase: 'active',
          message: 'Workflow trigger infrastructure registered (workflow-agentic)',
          workloadStatuses: [],
        }
      )
    ).toBe(false)
  })

  it('honors explicit skipStatusPatch', () => {
    expect(
      shouldPatchRecipeStatus(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'e2e-scheduled-recipe', namespace: 'sandbox-recipes' },
          spec: { steps: [{ id: 'run', instruction: 'run' }] },
          status: {
            phase: 'active',
            message: 'Workflow running',
            lastTransitionTime: '2026-05-09T00:00:00Z',
          },
        },
        {
          phase: 'active',
          message: 'Workflow completed',
          workloadStatuses: [],
          skipStatusPatch: true,
        }
      )
    ).toBe(false)
  })

  // ── issue #375: publish computed Plugin Workload SDK state transitions ──
  // The dominant failure mode: the reconciler computes awaiting_policy→validated
  // but no OTHER observable diff (phase, top-level message, workloads, owned
  // conditions) changes, so the old shouldPatchRecipeStatus returned false and
  // the transition was never published — status stayed awaiting_policy for ~40
  // min. shouldPatchRecipeStatus must now compare the SDK capability projection
  // carried on result.pluginWorkloadSdkProjection.
  function validatedProjection() {
    return {
      conditions: [],
      capability: {
        state: 'validated' as const,
        promptBridge: true,
        clientNotifications: false,
        message: 'Capability validated (promptBridge)',
        bootstrapPodUid: 'pod-abc',
        policyRevision: 3,
        defaultTargetRef: 'primary-openai',
        validatedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
    }
  }

  function sdkRecipe(persistedSdk: Record<string, unknown>): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      spec: { steps: [], pluginWorkloadSdk: { promptBridge: {} } },
      status: {
        phase: 'active',
        message: 'All workloads deployed',
        // No PluginWorkloadSdkCapability condition, so the pre-existing
        // message-vs-condition guard stays inert and this asserts ONLY the new
        // projection comparison.
        pluginWorkloadSdk: persistedSdk as never,
      },
    })
  }

  it('patches a computed awaiting_policy → validated transition (issue #375 incident replica)', () => {
    // The exact incident shape: phase and top-level message are unchanged, the
    // ONLY change is the SDK capability state. Before the fix this returned
    // false and the validated state was never published.
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'awaiting_policy',
          promptBridge: true,
          clientNotifications: false,
          message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
          verifiedAt: '2026-08-17T17:24:50.000Z',
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: validatedProjection(),
        }
      )
    ).toBe(true)
  })

  it('refreshes a stale verifiedAt on an otherwise-identical validated projection (throttle open)', () => {
    const staleVerifiedAt = new Date(Date.now() - 6 * 60_000).toISOString()
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'validated',
          promptBridge: true,
          clientNotifications: false,
          message: 'Capability validated (promptBridge)',
          bootstrapPodUid: 'pod-abc',
          policyRevision: 3,
          defaultTargetRef: 'primary-openai',
          verifiedAt: staleVerifiedAt,
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: validatedProjection(),
        }
      )
    ).toBe(true)
  })

  it('does not patch a fresh verifiedAt on an identical validated projection (throttle closed / anti-loop)', () => {
    const freshVerifiedAt = new Date(Date.now() - 10_000).toISOString()
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'validated',
          promptBridge: true,
          clientNotifications: false,
          message: 'Capability validated (promptBridge)',
          bootstrapPodUid: 'pod-abc',
          policyRevision: 3,
          defaultTargetRef: 'primary-openai',
          verifiedAt: freshVerifiedAt,
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: validatedProjection(),
        }
      )
    ).toBe(false)
  })

  it('patches a computed validated → awaiting_policy transition (revocation symmetry)', () => {
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'validated',
          promptBridge: true,
          clientNotifications: false,
          message: 'Capability validated (promptBridge)',
          bootstrapPodUid: 'pod-abc',
          policyRevision: 3,
          defaultTargetRef: 'primary-openai',
          verifiedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: {
            conditions: [],
            capability: {
              state: 'awaiting_policy' as const,
              promptBridge: true,
              clientNotifications: false,
              message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
              bootstrapPodUid: 'pod-abc',
              verifiedAt: new Date().toISOString(),
            },
          },
        }
      )
    ).toBe(true)
  })

  it('does not patch when the SDK projection is semantically unchanged and verifiedAt is fresh', () => {
    // Anti-loop guard: two back-to-back reconciles with the same computed state
    // and a still-fresh verifiedAt must NOT keep emitting patches.
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'validated',
          promptBridge: true,
          clientNotifications: false,
          message: 'Capability validated (promptBridge)',
          bootstrapPodUid: 'pod-abc',
          policyRevision: 3,
          defaultTargetRef: 'primary-openai',
          verifiedAt: new Date(Date.now() - 5_000).toISOString(),
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: validatedProjection(),
        }
      )
    ).toBe(false)
  })

  it('patches an in-place re-bootstrap that only changes bootstrapModel/provider/contractVersion (issue #375 B1)', () => {
    // A validated promptBridge recipe re-bootstraps in place (SAME pod, same
    // policyRevision) against a DIFFERENT model/provider — e.g. the operator
    // corrects the target model. state stays 'validated', message is
    // families-only, pod/policyRevision unchanged, verifiedAt is fresh (throttle
    // closed). Only bootstrapModel/provider/contractVersion move — persisted
    // semantic fields read by control-api at runtime. They MUST force a patch.
    const freshVerifiedAt = new Date(Date.now() - 10_000).toISOString()
    expect(
      shouldPatchRecipeStatus(
        sdkRecipe({
          state: 'validated',
          promptBridge: true,
          clientNotifications: false,
          message: 'Capability validated (promptBridge)',
          bootstrapPodUid: 'pod-abc',
          bootstrapContractVersion: 2,
          bootstrapProvider: 'openai',
          bootstrapModel: 'gpt-5.4-mini',
          policyRevision: 3,
          defaultTargetRef: 'primary-openai',
          verifiedAt: freshVerifiedAt,
        }),
        {
          phase: 'active',
          message: 'All workloads deployed',
          workloadStatuses: [],
          pluginWorkloadSdkProjection: {
            conditions: [],
            capability: {
              state: 'validated' as const,
              promptBridge: true,
              clientNotifications: false,
              message: 'Capability validated (promptBridge)',
              bootstrapPodUid: 'pod-abc',
              bootstrapContractVersion: 2,
              bootstrapProvider: 'anthropic',
              bootstrapModel: 'claude-sonnet-4-6',
              policyRevision: 3,
              defaultTargetRef: 'primary-openai',
              verifiedAt: freshVerifiedAt,
            },
          },
        }
      )
    ).toBe(true)
  })
})

describe('infrastructure telemetry projections', () => {
  it('builds stable reconcile_outcome source ids bound to the canonical workflow run label', () => {
    const recipe = makeWorkflowRecipe({
      metadata: {
        name: 'run-child',
        namespace: 'sandbox-recipes',
        generation: 3,
        resourceVersion: 'rv-9',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
    })

    expect(
      reconcileOutcomeTelemetryProjection(
        recipe,
        { phase: 'active', message: 'ok', workloadStatuses: [] },
        '2026-07-11T10:00:00.000Z'
      )
    ).toEqual({
      sourceEventId: 'workflow-reconcile:sandbox-recipes:run-child:generation:3:active',
      occurredAt: '2026-07-11T10:00:00.000Z',
      telemetryType: 'reconcile_outcome',
      runId: 'run-123',
      payload: { phase: 'active', status: 'patched' },
    })
  })

  it('skips infrastructure telemetry for recipes without a canonical workflow run label', () => {
    const recipe = makeWorkflowRecipe({
      metadata: { name: 'parent', namespace: 'sandbox-recipes' },
    })

    expect(
      reconcileOutcomeTelemetryProjection(recipe, {
        phase: 'active',
        message: 'ok',
        workloadStatuses: [],
      })
    ).toBeUndefined()
    expect(controllerErrorTelemetryProjection(recipe, new Error('boom'))).toBeUndefined()
  })
})

describe('runtime credential refresh loop helpers', () => {
  it('uses a quarter of the refresh window bounded between 5s and 30s', () => {
    expect(runtimeCredentialRefreshIntervalMs({ runtimeTokenRefreshBeforeSeconds: 45 })).toBe(
      11_250
    )
    expect(runtimeCredentialRefreshIntervalMs({ runtimeTokenRefreshBeforeSeconds: 1 })).toBe(5_000)
    expect(runtimeCredentialRefreshIntervalMs({ runtimeTokenRefreshBeforeSeconds: 300 })).toBe(
      30_000
    )
  })

  it('selects only non-deleting WorkflowRecipes with in-progress workflow execution', () => {
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({ status: { phase: 'active', workflowExecution: { phase: 'running' } } })
      )
    ).toBe(true)
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({
          status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } },
        })
      )
    ).toBe(true)
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({
          status: { phase: 'deploying', workflowExecution: { phase: 'recovering' } },
        })
      )
    ).toBe(true)
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({
          status: { phase: 'active', workflowExecution: { phase: 'completed' } },
        })
      )
    ).toBe(false)
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({
          metadata: { name: 'deleting', namespace: 'sandbox-recipes', deletionTimestamp: 'now' },
          status: { phase: 'active', workflowExecution: { phase: 'running' } },
        })
      )
    ).toBe(false)
    expect(
      workflowNeedsRuntimeCredentialRefresh(
        makeWorkflowRecipe({
          spec: {
            steps: [],
            workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
          },
          status: { phase: 'active', workflowExecution: { phase: 'running' } },
        })
      )
    ).toBe(false)
  })

  it('selects initializing and recovering workflows for infrastructure reconcile retries', () => {
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } },
        })
      )
    ).toBe(true)
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          status: { phase: 'deploying', workflowExecution: { phase: 'recovering' } },
        })
      )
    ).toBe(true)
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          status: { phase: 'active', workflowExecution: { phase: 'running' } },
        })
      )
    ).toBe(false)
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          metadata: { name: 'deleting', namespace: 'sandbox-recipes', deletionTimestamp: 'now' },
          status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } },
        })
      )
    ).toBe(false)
  })

  it('forces timer-driven infrastructure retries past the status-only generation guard', async () => {
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    const sdkOnly = makeWorkflowRecipe({
      metadata: { name: 'sdk-only', namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
        pluginWorkloadSdk: { promptBridge: {} },
      },
      status: { phase: 'active' },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      eventQueue: { enqueue: typeof enqueue }
      handleRecipeEvent: typeof handleRecipeEvent
      refreshRuntimeCredentialsForInProgressRecipes: () => Promise<void>
      stopped: boolean
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[sdkOnly.metadata.name, sdkOnly]])
    internal.eventQueue = { enqueue }
    internal.handleRecipeEvent = handleRecipeEvent
    internal.stopped = false

    await internal.refreshRuntimeCredentialsForInProgressRecipes()

    expect(enqueue).toHaveBeenCalledWith(sdkOnly.metadata.name, expect.any(Function))
    expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', sdkOnly, {
      forceReconcile: true,
    })
  })

  it('keeps reconciling a promptBridge SDK recipe with no run so the eager mcp-host stays configured', () => {
    // phase=active, workflowExecution cleared (eager SDK path) — must still requeue.
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          spec: {
            steps: [{ id: 's1', instruction: 'ack' }],
            agent: { provider: 'zai', model: 'glm-4.7' },
            pluginWorkloadSdk: { promptBridge: {} },
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(true)
  })

  it('keeps reconciling a clientNotifications-only SDK recipe with no run so the eager mcp-host self-heals', () => {
    // Both families run the always-on eager SDK mcp-host. A clientNotifications-only
    // recipe still needs the level-triggered requeue so a dead eager pod
    // (restartPolicy: Never) is recreated without an unrelated spec edit.
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          spec: {
            steps: [{ id: 's1', instruction: 'ack' }],
            pluginWorkloadSdk: { clientNotifications: { allowedEventTypes: ['e2e.test'] } },
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(true)
  })

  it('keeps reconciling a stepless SDK-only recipe through the full capability lane', () => {
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          spec: {
            steps: [],
            workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
            pluginWorkloadSdk: { promptBridge: {} },
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(true)
  })

  it('does NOT keep reconciling a recipe with no Plugin Workload SDK and no run', () => {
    // No pluginWorkloadSdk → no eager mcp-host → no eager-reconcile requeue needed.
    expect(
      workflowNeedsInfrastructureReconcile(
        makeWorkflowRecipe({
          spec: {
            steps: [{ id: 's1', instruction: 'ack' }],
            agent: { provider: 'zai', model: 'glm-4.7' },
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(false)
  })

  it('refreshes cached in-progress workflow credentials without patching status', async () => {
    const refreshInProgressWorkflowRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const running = makeWorkflowRecipe({
      metadata: { name: 'running-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const completed = makeWorkflowRecipe({
      metadata: { name: 'completed-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'active', workflowExecution: { phase: 'completed' } },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      reconciler: {
        refreshInProgressWorkflowRuntimeCredentials: typeof refreshInProgressWorkflowRuntimeCredentials
      }
      refreshRuntimeCredentialsForInProgressRecipes: () => Promise<void>
      stopped: boolean
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([
      [running.metadata.name, running],
      [completed.metadata.name, completed],
    ])
    internal.reconciler = { refreshInProgressWorkflowRuntimeCredentials }
    internal.stopped = false

    await internal.refreshRuntimeCredentialsForInProgressRecipes()

    expect(refreshInProgressWorkflowRuntimeCredentials).toHaveBeenCalledTimes(1)
    expect(refreshInProgressWorkflowRuntimeCredentials).toHaveBeenCalledWith(running)
  })

  it('re-enqueues initializing workflows so pod readiness can progress without CRD events', async () => {
    const refreshInProgressWorkflowRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    const initializing = makeWorkflowRecipe({
      metadata: { name: 'initializing-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      reconciler: {
        refreshInProgressWorkflowRuntimeCredentials: typeof refreshInProgressWorkflowRuntimeCredentials
      }
      eventQueue: { enqueue: typeof enqueue }
      handleRecipeEvent: typeof handleRecipeEvent
      refreshRuntimeCredentialsForInProgressRecipes: () => Promise<void>
      stopped: boolean
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[initializing.metadata.name, initializing]])
    internal.reconciler = { refreshInProgressWorkflowRuntimeCredentials }
    internal.eventQueue = { enqueue }
    internal.handleRecipeEvent = handleRecipeEvent
    internal.stopped = false

    await internal.refreshRuntimeCredentialsForInProgressRecipes()

    expect(refreshInProgressWorkflowRuntimeCredentials).toHaveBeenCalledWith(initializing)
    expect(enqueue).toHaveBeenCalledWith(initializing.metadata.name, expect.any(Function))
    expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', initializing, {
      forceReconcile: true,
    })
  })
})

describe('workload status refresh loop helpers', () => {
  function makeWorkloadRecipe(overrides: Partial<WorkflowRecipeCRD> = {}): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      ...overrides,
      spec: {
        steps: [],
        workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
        ...(overrides.spec ?? {}),
      },
    })
  }

  it('selects active and degraded workload recipes for observed status refresh', () => {
    expect(
      workflowNeedsWorkloadStatusRefresh(makeWorkloadRecipe({ status: { phase: 'active' } }))
    ).toBe(true)
    expect(
      workflowNeedsWorkloadStatusRefresh(makeWorkloadRecipe({ status: { phase: 'degraded' } }))
    ).toBe(true)
    expect(
      workflowNeedsWorkloadStatusRefresh(makeWorkloadRecipe({ status: { phase: 'failed' } }))
    ).toBe(false)
    expect(
      workflowNeedsWorkloadStatusRefresh(
        makeWorkloadRecipe({
          metadata: { name: 'deleting', namespace: 'sandbox-recipes', deletionTimestamp: 'now' },
          status: { phase: 'active' },
        })
      )
    ).toBe(false)
    expect(
      workflowNeedsWorkloadStatusRefresh(
        makeWorkloadRecipe({
          spec: {
            steps: [],
            pluginWorkloadSdk: { promptBridge: {} },
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(false)
    expect(
      workflowNeedsWorkloadStatusRefresh(makeWorkflowRecipe({ status: { phase: 'active' } }))
    ).toBe(false)
    expect(
      workflowNeedsWorkloadStatusRefresh(
        makeWorkloadRecipe({
          spec: {
            steps: [{ id: 'step-1', instruction: 'run' }],
            workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
          },
          status: { phase: 'active' },
        })
      )
    ).toBe(false)
  })

  it('recipeReferencesNamedSecrets detects envSecret and imagePullSecrets (Issue #637 backstop)', () => {
    expect(recipeReferencesNamedSecrets(makeWorkloadRecipe())).toBe(false)
    expect(
      recipeReferencesNamedSecrets(
        makeWorkloadRecipe({
          spec: {
            steps: [],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                envSecret: { name: 'creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
              },
            ],
          },
        })
      )
    ).toBe(true)
    expect(
      recipeReferencesNamedSecrets(
        makeWorkloadRecipe({
          spec: {
            steps: [],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                imagePullSecrets: ['reg'],
              },
            ],
          },
        })
      )
    ).toBe(true)
  })

  it('workflowNeedsOwnershipBackstop selects ONLY workflow recipes that reference named Secrets (Issue #637)', () => {
    // Non-workflow recipe (steps==0): already covered by workflowNeedsWorkloadStatusRefresh.
    expect(
      workflowNeedsOwnershipBackstop(
        makeWorkloadRecipe({
          spec: {
            steps: [],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                envSecret: { name: 'creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
              },
            ],
          },
        })
      )
    ).toBe(false)
    // Workflow recipe (steps>0) without a named Secret: no backstop needed.
    expect(
      workflowNeedsOwnershipBackstop(
        makeWorkloadRecipe({
          spec: {
            steps: [{ id: 'step-1', instruction: 'run' }],
            workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
          },
        })
      )
    ).toBe(false)
    // Workflow recipe (steps>0) WITH an envSecret: backstop fires.
    expect(
      workflowNeedsOwnershipBackstop(
        makeWorkloadRecipe({
          spec: {
            steps: [{ id: 'step-1', instruction: 'run' }],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                envSecret: { name: 'creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
              },
            ],
          },
        })
      )
    ).toBe(true)
    // Workflow recipe with imagePullSecrets: backstop fires.
    expect(
      workflowNeedsOwnershipBackstop(
        makeWorkloadRecipe({
          spec: {
            steps: [{ id: 'step-1', instruction: 'run' }],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                imagePullSecrets: ['reg'],
              },
            ],
          },
        })
      )
    ).toBe(true)
    // Deleting recipe: never.
    expect(
      workflowNeedsOwnershipBackstop(
        makeWorkloadRecipe({
          metadata: { name: 'deleting', namespace: 'sandbox-recipes', deletionTimestamp: 'now' },
          spec: {
            steps: [{ id: 'step-1', instruction: 'run' }],
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'clerum/api:test',
                envSecret: { name: 'creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
              },
            ],
          },
        })
      )
    ).toBe(false)
  })

  it('re-enqueues steady workload recipes so readiness drift is observed without CRD events', async () => {
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const refreshWorkloadStatusOnly = vi.fn().mockResolvedValue(undefined)
    const active = makeWorkloadRecipe({
      metadata: { name: 'active-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'active' },
    })
    const degraded = makeWorkloadRecipe({
      metadata: { name: 'degraded-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'degraded' },
    })
    const failed = makeWorkloadRecipe({
      metadata: { name: 'failed-recipe', namespace: 'sandbox-recipes' },
      status: { phase: 'failed' },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      eventQueue: { enqueue: typeof enqueue }
      refreshWorkloadStatusOnly: typeof refreshWorkloadStatusOnly
      refreshWorkloadStatusesForSteadyRecipes: () => Promise<void>
      stopped: boolean
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([
      [active.metadata.name, active],
      [degraded.metadata.name, degraded],
      [failed.metadata.name, failed],
    ])
    internal.eventQueue = { enqueue }
    internal.refreshWorkloadStatusOnly = refreshWorkloadStatusOnly
    internal.stopped = false

    await internal.refreshWorkloadStatusesForSteadyRecipes()

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith(active.metadata.name, expect.any(Function))
    expect(enqueue).toHaveBeenCalledWith(degraded.metadata.name, expect.any(Function))
    // Non-workflow recipes go through the full status-refresh path (ownershipOnly: false).
    expect(refreshWorkloadStatusOnly).toHaveBeenCalledWith(active, { ownershipOnly: false })
    expect(refreshWorkloadStatusOnly).toHaveBeenCalledWith(degraded, { ownershipOnly: false })
  })

  it('re-enqueues steady WORKFLOW recipes that project a named Secret for an ownership-only backstop (Issue #637)', async () => {
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const refreshWorkloadStatusOnly = vi.fn().mockResolvedValue(undefined)
    // Workflow recipe (steps>0) WITH an envSecret: excluded from the status refresh,
    // but must still get the periodic ownership re-check (its only other revocation
    // path is the event-driven SecretWatcher).
    const workflowWithSecret = makeWorkloadRecipe({
      metadata: { name: 'wf-secret', namespace: 'sandbox-recipes' },
      spec: {
        steps: [{ id: 'run', instruction: 'go' }],
        workloads: [
          {
            id: 'api',
            type: 'deployment',
            image: 'clerum/api:test',
            envSecret: { name: 'creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
          },
        ],
      },
      status: { phase: 'active' },
    })
    // Workflow recipe (steps>0) WITHOUT a named Secret: no backstop, not enqueued.
    const workflowNoSecret = makeWorkloadRecipe({
      metadata: { name: 'wf-plain', namespace: 'sandbox-recipes' },
      spec: {
        steps: [{ id: 'run', instruction: 'go' }],
        workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
      },
      status: { phase: 'active' },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      eventQueue: { enqueue: typeof enqueue }
      refreshWorkloadStatusOnly: typeof refreshWorkloadStatusOnly
      refreshWorkloadStatusesForSteadyRecipes: () => Promise<void>
      stopped: boolean
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([
      [workflowWithSecret.metadata.name, workflowWithSecret],
      [workflowNoSecret.metadata.name, workflowNoSecret],
    ])
    internal.eventQueue = { enqueue }
    internal.refreshWorkloadStatusOnly = refreshWorkloadStatusOnly
    internal.stopped = false

    await internal.refreshWorkloadStatusesForSteadyRecipes()

    // Only the workflow-with-secret is enqueued, in ownership-only mode (no status patch).
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(workflowWithSecret.metadata.name, expect.any(Function))
    expect(refreshWorkloadStatusOnly).toHaveBeenCalledWith(workflowWithSecret, {
      ownershipOnly: true,
    })
  })

  it('triggerSecretDrivenReconcile forces a full reconcile so a Secret re-label reaches the ownership gate (Issue #637)', async () => {
    // A Secret re-label does NOT bump the recipe's generation, so a plain 'MODIFIED'
    // event is status-only and short-circuits before reconcile() (and the ownership
    // gate). The Secret-driven trigger MUST pass forceReconcile, or the event-driven
    // revocation never re-evaluates ownership and falls back to the slow 30s backstop.
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const recipe = makeWorkloadRecipe({
      metadata: { name: 'secret-driven', namespace: 'sandbox-recipes' },
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      eventQueue: { enqueue: typeof enqueue }
      handleRecipeEvent: typeof handleRecipeEvent
      triggerSecretDrivenReconcile: (name: string) => void
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[recipe.metadata.name, recipe]])
    internal.eventQueue = { enqueue }
    internal.handleRecipeEvent = handleRecipeEvent

    internal.triggerSecretDrivenReconcile(recipe.metadata.name)

    expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', recipe, { forceReconcile: true })
  })

  it('updates the cache but skips full reconcile for status-only watch events', async () => {
    const cached = makeWorkloadRecipe({
      metadata: { name: 'active-recipe', namespace: 'sandbox-recipes', generation: 7 },
      status: { phase: 'active', message: 'All workloads deployed' },
    })
    const statusOnly = makeWorkloadRecipe({
      metadata: {
        name: 'active-recipe',
        namespace: 'sandbox-recipes',
        generation: 7,
        resourceVersion: 'next',
      },
      status: { phase: 'degraded', message: 'Some workloads not ready' },
    })
    const reconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
    })

    type InternalWatcher = {
      recipes: Map<string, WorkflowRecipeCRD>
      reconciler: { reconcile: typeof reconcile }
      handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[cached.metadata.name, cached]])
    internal.reconciler = { reconcile }

    await internal.handleRecipeEvent('MODIFIED', statusOnly)

    expect(internal.recipes.get(statusOnly.metadata.name)).toBe(statusOnly)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('forces a full reconcile when status-only refresh observes workload drift', async () => {
    const recipe = makeWorkloadRecipe({
      metadata: { name: 'active-recipe', namespace: 'sandbox-recipes', generation: 7 },
      status: { phase: 'active', message: 'All workloads deployed' },
    })
    const result = {
      phase: 'degraded' as const,
      message: 'Some workloads not ready',
      workloadStatuses: [{ id: 'api', phase: 'degraded', ready: false }],
    }
    const observeCurrentWorkloadStatus = vi.fn().mockResolvedValue(result)
    const patchStatus = vi.fn().mockResolvedValue(undefined)
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)

    type InternalWatcher = {
      reconciler: {
        observeCurrentWorkloadStatus: typeof observeCurrentWorkloadStatus
        patchStatus: typeof patchStatus
      }
      handleRecipeEvent: typeof handleRecipeEvent
      refreshWorkloadStatusOnly: (recipe: WorkflowRecipeCRD) => Promise<void>
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.reconciler = { observeCurrentWorkloadStatus, patchStatus }
    internal.handleRecipeEvent = handleRecipeEvent

    await internal.refreshWorkloadStatusOnly(recipe)

    expect(patchStatus).toHaveBeenCalledWith(recipe, result)
    expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', recipe, { forceReconcile: true })
  })

  it('forces a full reconcile for an ALL-READY recipe that references a named Secret (Issue #637 ownership backstop)', async () => {
    const recipe = makeWorkloadRecipe({
      metadata: { name: 'active-recipe', namespace: 'sandbox-recipes', generation: 7 },
      status: { phase: 'active', message: 'All workloads deployed' },
      spec: {
        workloads: [
          {
            id: 'api',
            type: 'deployment',
            image: 'clerum/api:test',
            envSecret: { name: 'api-creds', keys: [{ secretKey: 'k', envVar: 'K' }] },
          },
        ],
      },
    })
    // NO drift: every workload is ready → the `ready === false` term is false, so the
    // forced reconcile can ONLY come from the ownershipRecheck term. This isolates
    // `ownershipRecheck`: reverting the `ownershipRecheck ||` guard makes it red (the
    // deterministic backstop that re-runs the Secret-ownership gate would be lost).
    const result = {
      phase: 'active' as const,
      message: 'All workloads deployed',
      workloadStatuses: [{ id: 'api', phase: 'running', ready: true }],
    }
    const observeCurrentWorkloadStatus = vi.fn().mockResolvedValue(result)
    const patchStatus = vi.fn().mockResolvedValue(undefined)
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)

    type InternalWatcher = {
      reconciler: {
        observeCurrentWorkloadStatus: typeof observeCurrentWorkloadStatus
        patchStatus: typeof patchStatus
      }
      handleRecipeEvent: typeof handleRecipeEvent
      refreshWorkloadStatusOnly: (recipe: WorkflowRecipeCRD) => Promise<void>
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.reconciler = { observeCurrentWorkloadStatus, patchStatus }
    internal.handleRecipeEvent = handleRecipeEvent

    await internal.refreshWorkloadStatusOnly(recipe)

    expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', recipe, { forceReconcile: true })
  })

  it('does NOT force a reconcile for an all-ready recipe with NO named Secret refs', async () => {
    // Proves the ownershipRecheck term is load-bearing (not always-true): a steady
    // recipe with no envSecret/imagePullSecrets and no drift must stay cheap.
    const recipe = makeWorkloadRecipe({
      metadata: { name: 'active-recipe', namespace: 'sandbox-recipes', generation: 7 },
      status: { phase: 'active', message: 'All workloads deployed' },
    })
    const result = {
      phase: 'active' as const,
      message: 'All workloads deployed',
      workloadStatuses: [{ id: 'api', phase: 'running', ready: true }],
    }
    const observeCurrentWorkloadStatus = vi.fn().mockResolvedValue(result)
    const patchStatus = vi.fn().mockResolvedValue(undefined)
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)

    type InternalWatcher = {
      reconciler: {
        observeCurrentWorkloadStatus: typeof observeCurrentWorkloadStatus
        patchStatus: typeof patchStatus
      }
      handleRecipeEvent: typeof handleRecipeEvent
      refreshWorkloadStatusOnly: (recipe: WorkflowRecipeCRD) => Promise<void>
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.reconciler = { observeCurrentWorkloadStatus, patchStatus }
    internal.handleRecipeEvent = handleRecipeEvent

    await internal.refreshWorkloadStatusOnly(recipe)

    expect(handleRecipeEvent).not.toHaveBeenCalled()
  })
})

describe('workflowNeedsTerminalRunTeardown', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'selects run-scoped workflow recipes when the terminal phase is %s',
    phase => {
      expect(
        workflowNeedsTerminalRunTeardown(
          makeWorkflowRecipe({
            metadata: {
              name: `terminal-${phase}`,
              namespace: 'sandbox-recipes',
              labels: { 'clerum.io/workflow-run-id': `run-${phase}` },
            },
            status: { phase: 'active', workflowExecution: { phase } },
          })
        )
      ).toBe(true)
    }
  )

  it('does not select non-terminal, non-run-scoped, non-workflow, or deleting recipes', () => {
    expect(
      workflowNeedsTerminalRunTeardown(
        makeWorkflowRecipe({
          metadata: {
            name: 'running',
            namespace: 'sandbox-recipes',
            labels: { 'clerum.io/workflow-run-id': 'run-running' },
          },
          status: { phase: 'active', workflowExecution: { phase: 'running' } },
        })
      )
    ).toBe(false)

    expect(
      workflowNeedsTerminalRunTeardown(
        makeWorkflowRecipe({
          metadata: { name: 'not-run-scoped', namespace: 'sandbox-recipes', labels: {} },
          status: { phase: 'active', workflowExecution: { phase: 'completed' } },
        })
      )
    ).toBe(false)

    expect(
      workflowNeedsTerminalRunTeardown(
        makeWorkflowRecipe({
          metadata: {
            name: 'blank-run-label',
            namespace: 'sandbox-recipes',
            labels: { 'clerum.io/workflow-run-id': '   ' },
          },
          status: { phase: 'active', workflowExecution: { phase: 'completed' } },
        })
      )
    ).toBe(false)

    expect(
      workflowNeedsTerminalRunTeardown(
        makeWorkflowRecipe({
          metadata: {
            name: 'workload-only',
            namespace: 'sandbox-recipes',
            labels: { 'clerum.io/workflow-run-id': 'run-workload-only' },
          },
          spec: {
            steps: [],
            workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
          },
          status: { phase: 'active', workflowExecution: { phase: 'completed' } },
        })
      )
    ).toBe(false)

    expect(
      workflowNeedsTerminalRunTeardown(
        makeWorkflowRecipe({
          metadata: {
            name: 'deleting',
            namespace: 'sandbox-recipes',
            deletionTimestamp: '2026-06-16T00:00:00Z',
            labels: { 'clerum.io/workflow-run-id': 'run-deleting' },
          },
          status: { phase: 'active', workflowExecution: { phase: 'completed' } },
        })
      )
    ).toBe(false)
  })
})

describe('status-only events drive DB sync (terminal + heartbeat)', () => {
  // Bug: a workflow RUN completes (status.workflowExecution.phase = completed)
  // but its workflow_runs DB row stays Running forever — the UI shows "running"
  // and dbRunProcessor keeps logging "orphaned running run reclaimed". Cause:
  // a completion is a .status change, so .metadata.generation is unchanged ⇒
  // isStatusOnlyModifiedEvent → true ⇒ the old early return skipped
  // syncFromRecipeExecution (the ONLY CRD->DB terminal sync caller). The fix
  // runs syncFromRecipeExecution for status-only events too, while still
  // skipping the expensive full reconcile.

  function makeRunChild(
    overrides: Omit<Partial<WorkflowRecipeCRD>, 'metadata'> & {
      metadata?: Partial<WorkflowRecipeCRD['metadata']>
    } = {},
    runId = 'run-abc'
  ): WorkflowRecipeCRD {
    const { metadata: metaOverride, ...rest } = overrides
    return makeWorkflowRecipe({
      ...rest,
      metadata: {
        name: 'run-child',
        namespace: 'sandbox-recipes',
        generation: 7,
        labels: { 'clerum.io/workflow-run-id': runId },
        ...(metaOverride ?? {}),
      },
    })
  }

  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
    stopped: boolean
    reconciler: {
      reconcile: ReturnType<typeof vi.fn>
      isRecipeStillActive: ReturnType<typeof vi.fn>
      ensureFinalizer: ReturnType<typeof vi.fn>
      patchStatus: ReturnType<typeof vi.fn>
    }
    dbRunProcessor: { syncFromRecipeExecution: ReturnType<typeof vi.fn> }
    handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
  }

  function makeInternal(
    cached: WorkflowRecipeCRD,
    syncImpl: () => Promise<void> = () => Promise.resolve()
  ): {
    internal: InternalWatcher
    reconcile: ReturnType<typeof vi.fn>
    sync: ReturnType<typeof vi.fn>
  } {
    const reconcile = vi.fn().mockResolvedValue({
      phase: 'completed',
      message: 'done',
      workloadStatuses: [],
    })
    const sync = vi.fn(syncImpl)
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[cached.metadata.name, cached]])
    internal.transientRetries = new Map()
    internal.stopped = false
    internal.reconciler = {
      reconcile,
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      patchStatus: vi.fn().mockResolvedValue(undefined),
    }
    internal.dbRunProcessor = { syncFromRecipeExecution: sync }
    return { internal, reconcile, sync }
  }

  it('does not reconcile a run child until the workflow_runs sync barrier completes', async () => {
    let markSyncStarted!: () => void
    let releaseSync!: () => void
    const syncStarted = new Promise<void>(resolve => {
      markSyncStarted = resolve
    })
    const syncBarrier = new Promise<void>(resolve => {
      releaseSync = resolve
    })
    const child = makeRunChild()
    const { internal, reconcile, sync } = makeInternal(child, async () => {
      markSyncStarted()
      await syncBarrier
    })

    const event = internal.handleRecipeEvent('ADDED', child)
    await syncStarted

    expect(sync).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()

    releaseSync()
    await event

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0])
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'runs syncFromRecipeExecution AND reconciles a %s run-scoped status-only event',
    async phase => {
      // Bug repro: completed run was left Running in DB because the status-only
      // completion event skipped the CRD->DB sync. PR #568 also requires the
      // terminal event to reach reconcile(), where run-scoped compute teardown
      // lives.
      const cached = makeRunChild({
        status: { phase: 'active', workflowExecution: { phase: 'running' } },
      })
      // Same generation (7) ⇒ status-only event; phase flips to completed.
      const completed = makeRunChild({
        metadata: { resourceVersion: 'next' },
        status: { phase: 'active', workflowExecution: { phase } },
      })
      const { internal, reconcile, sync } = makeInternal(cached)

      await internal.handleRecipeEvent('MODIFIED', completed)

      // CRD->DB terminal sync fires so the DB row transitions Running→Succeeded.
      expect(sync).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledWith(completed)
      expect(reconcile).toHaveBeenCalledWith(completed)
      // Cache is updated.
      expect(internal.recipes.get(completed.metadata.name)).toBe(completed)
    }
  )

  it('still returns early (no full reconcile/patch path) for non-terminal status-only events', async () => {
    // Guards the reason the status-only fast-path exists: it must NOT fall
    // through to reconcile/patchStatus even though it now runs the DB sync.
    const cached = makeRunChild({
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const statusOnly = makeRunChild({
      metadata: { resourceVersion: 'next' },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const { internal, reconcile } = makeInternal(cached)

    await internal.handleRecipeEvent('MODIFIED', statusOnly)

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('still returns early for terminal status-only events that are not run-scoped', async () => {
    const cached = makeRunChild({
      metadata: { labels: {} },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const completed = makeRunChild({
      metadata: { labels: {}, resourceVersion: 'next' },
      status: { phase: 'active', workflowExecution: { phase: 'completed' } },
    })
    const { internal, reconcile, sync } = makeInternal(cached)

    await internal.handleRecipeEvent('MODIFIED', completed)

    expect(sync).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('bumps the heartbeat: an in-progress status-only event still calls syncFromRecipeExecution', async () => {
    // The same call that fixes the terminal-stuck bug also bumps
    // last_reconciled_at (UPDATE_RUN_PROGRESS) for non-terminal runs, so a
    // running run is not falsely reclaimed as orphaned.
    const cached = makeRunChild({
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const stillRunning = makeRunChild({
      metadata: { resourceVersion: 'next' },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const { internal, sync, reconcile } = makeInternal(cached)

    await internal.handleRecipeEvent('MODIFIED', stillRunning)

    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith(stillRunning)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('does not crash the watch loop if syncFromRecipeExecution throws on a status-only event', async () => {
    // A DB sync failure must be logged, not propagated — the watch loop has to
    // keep processing events even if one completion sync fails transiently.
    const cached = makeRunChild({
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const completed = makeRunChild({
      metadata: { resourceVersion: 'next' },
      status: { phase: 'active', workflowExecution: { phase: 'completed' } },
    })
    const { internal, reconcile, sync } = makeInternal(cached, () =>
      Promise.reject(new Error('db down'))
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(internal.handleRecipeEvent('MODIFIED', completed)).resolves.toBeUndefined()

    expect(sync).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith(completed)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('regression: a non-status-only event (generation changed) runs syncFromRecipeExecution AND proceeds to reconcile', async () => {
    // Existing behavior must be preserved: when .spec changes (generation bump),
    // the full reconcile path still runs (with its own syncFromRecipeExecution
    // call at the start of the reconcile branch).
    const cached = makeRunChild({
      metadata: { generation: 7 },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const specChanged = makeRunChild({
      metadata: { generation: 8, resourceVersion: 'next' },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })
    const { internal, reconcile, sync } = makeInternal(cached)

    await internal.handleRecipeEvent('MODIFIED', specChanged)

    // Generation changed ⇒ NOT status-only ⇒ full reconcile branch runs, which
    // also calls syncFromRecipeExecution at its start.
    expect(sync).toHaveBeenCalledWith(specChanged)
    expect(reconcile).toHaveBeenCalledWith(specChanged)
  })
})

describe('infrastructure telemetry enqueue isolation', () => {
  function makeRunChild(): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: {
        name: 'run-child',
        namespace: 'sandbox-recipes',
        generation: 8,
        resourceVersion: 'rv-1',
        labels: { 'clerum.io/workflow-run-id': 'run-telemetry' },
      },
      status: { phase: 'deploying', workflowExecution: { phase: 'initializing' } },
    })
  }

  function makeInternal(
    recipe: WorkflowRecipeCRD,
    traceReporter: { enqueueInfrastructureTelemetry: ReturnType<typeof vi.fn> }
  ) {
    const result = {
      phase: 'active' as const,
      message: 'Workflow infrastructure ready',
      workloadStatuses: [],
    }
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as {
      recipes: Map<string, WorkflowRecipeCRD>
      transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
      stopped: boolean
      traceReporter: typeof traceReporter
      dbRunProcessor: null
      reconciler: {
        reconcile: ReturnType<typeof vi.fn>
        isRecipeStillActive: ReturnType<typeof vi.fn>
        ensureFinalizer: ReturnType<typeof vi.fn>
        patchStatus: ReturnType<typeof vi.fn>
      }
      handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
    }
    internal.recipes = new Map([[recipe.metadata.name, recipe]])
    internal.transientRetries = new Map()
    internal.stopped = false
    internal.traceReporter = traceReporter
    internal.dbRunProcessor = null
    internal.reconciler = {
      reconcile: vi.fn().mockResolvedValue(result),
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      patchStatus: vi.fn().mockResolvedValue(undefined),
    }
    return { internal, result }
  }

  it('enqueues reconcile_outcome only after the status patch commits', async () => {
    const recipe = makeRunChild()
    const enqueueInfrastructureTelemetry = vi.fn()
    const { internal, result } = makeInternal(recipe, { enqueueInfrastructureTelemetry })
    internal.reconciler.patchStatus.mockImplementation(async () => {
      expect(enqueueInfrastructureTelemetry).not.toHaveBeenCalled()
    })

    await internal.handleRecipeEvent('ADDED', recipe)

    expect(enqueueInfrastructureTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetryType: 'reconcile_outcome',
        runId: 'run-telemetry',
        payload: { phase: result.phase, status: 'patched' },
      })
    )
  })

  it('does not enqueue reconcile_outcome when the status patch fails', async () => {
    const recipe = makeRunChild()
    const enqueueInfrastructureTelemetry = vi.fn()
    const { internal } = makeInternal(recipe, { enqueueInfrastructureTelemetry })
    internal.reconciler.patchStatus.mockRejectedValue(new Error('patch failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await internal.handleRecipeEvent('ADDED', recipe)

    expect(enqueueInfrastructureTelemetry).toHaveBeenCalledTimes(1)
    expect(enqueueInfrastructureTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetryType: 'controller_error',
        runId: 'run-telemetry',
      })
    )
    errSpy.mockRestore()
  })

  it('isolates enqueue failures after a committed status patch', async () => {
    const recipe = makeRunChild()
    const enqueueInfrastructureTelemetry = vi.fn(() => {
      throw new Error('trace queue down')
    })
    const { internal } = makeInternal(recipe, { enqueueInfrastructureTelemetry })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(internal.handleRecipeEvent('ADDED', recipe)).resolves.toBeUndefined()

    expect(internal.reconciler.patchStatus).toHaveBeenCalled()
    expect(enqueueInfrastructureTelemetry).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(
      '[WR-K8s] Infrastructure telemetry enqueue failed:',
      expect.any(Error)
    )
    errSpy.mockRestore()
  })
})

describe('transient-result requeue (scheduleTransientRetry)', () => {
  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    eventQueue: { enqueue: (key: string, task: () => Promise<void>) => Promise<void> }
    handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
    transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
    stopped: boolean
    scheduleTransientRetry: (name: string, baseMs: number, fixedInterval?: boolean) => void
    clearTransientRetry: (name: string) => void
  }

  function makeInternal(recipe: WorkflowRecipeCRD) {
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[recipe.metadata.name, recipe]])
    internal.eventQueue = { enqueue }
    internal.handleRecipeEvent = handleRecipeEvent
    internal.transientRetries = new Map()
    internal.stopped = false
    return { internal, enqueue, handleRecipeEvent }
  }

  it('re-enqueues a transient result with NO status patch after the backoff delay', () => {
    vi.useFakeTimers()
    try {
      const recipe = makeWorkflowRecipe({
        metadata: { name: 'flaky', namespace: 'sandbox-recipes' },
      })
      const { internal, enqueue, handleRecipeEvent } = makeInternal(recipe)

      internal.scheduleTransientRetry('flaky', 5_000)
      // Nothing fires synchronously — the retry is purely timer-driven (no patch,
      // no MODIFIED event needed).
      expect(handleRecipeEvent).not.toHaveBeenCalled()

      vi.advanceTimersByTime(5_000)
      expect(enqueue).toHaveBeenCalledWith('flaky', expect.any(Function))
      expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', recipe, {
        forceReconcile: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies bounded exponential backoff across consecutive transient results', () => {
    vi.useFakeTimers()
    try {
      const recipe = makeWorkflowRecipe({
        metadata: { name: 'flaky', namespace: 'sandbox-recipes' },
      })
      const { internal, handleRecipeEvent } = makeInternal(recipe)

      internal.scheduleTransientRetry('flaky', 5_000) // attempt 0 → 5s
      vi.advanceTimersByTime(5_000)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)

      handleRecipeEvent.mockClear()
      internal.scheduleTransientRetry('flaky', 5_000) // attempt 1 → 10s
      vi.advanceTimersByTime(5_000)
      expect(handleRecipeEvent).not.toHaveBeenCalled() // 5s < 10s backoff
      vi.advanceTimersByTime(5_000)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearTransientRetry cancels a pending retry and resets backoff', () => {
    vi.useFakeTimers()
    try {
      const recipe = makeWorkflowRecipe({
        metadata: { name: 'flaky', namespace: 'sandbox-recipes' },
      })
      const { internal, handleRecipeEvent } = makeInternal(recipe)

      internal.scheduleTransientRetry('flaky', 5_000)
      internal.clearTransientRetry('flaky')
      vi.advanceTimersByTime(60_000)
      expect(handleRecipeEvent).not.toHaveBeenCalled()
      expect(internal.transientRetries.has('flaky')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // §5 (the regression this PR exists for): a `deploying` PROGRESS requeue uses a
  // FIXED interval and must NOT inherit the transient-ERROR exponential backoff.
  // If it did, repeated deploying sub-phase passes would grow the delay toward
  // the 60s cap and the 240s mcp-host readiness deadline could STILL be exceeded.
  // Here we drive N consecutive fixed-interval requeues and assert each one fires
  // at exactly the base 5s (no growth), in direct contrast to the exponential
  // test above.
  it('fixed-interval (progress) requeues keep firing at the base delay — no backoff growth', () => {
    vi.useFakeTimers()
    try {
      const recipe = makeWorkflowRecipe({
        metadata: { name: 'progressing', namespace: 'sandbox-recipes' },
      })
      const { internal, handleRecipeEvent } = makeInternal(recipe)

      // Simulate 4 consecutive deploying sub-phase passes. Each re-schedules a
      // fixed-interval requeue (as the watcher does when result.phase ===
      // 'deploying' && !skipStatusPatch). Every one must fire after exactly 5s.
      for (let pass = 1; pass <= 4; pass++) {
        handleRecipeEvent.mockClear()
        internal.scheduleTransientRetry('progressing', 5_000, true)
        // 1ms before the base delay: must NOT have fired yet.
        vi.advanceTimersByTime(4_999)
        expect(handleRecipeEvent).not.toHaveBeenCalled()
        // At the base delay: fires. If this had inherited exponential backoff,
        // pass 4 would need ~40s (5s * 2**3) and this assertion would fail.
        vi.advanceTimersByTime(1)
        expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
        // attempts pinned at 0 so a later genuine transient error backs off fresh.
        expect(internal.transientRetries.get('progressing')?.attempts).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  // §5 boundary: switching from an exponential transient backoff into a
  // fixed-interval progress requeue RESETS attempts to 0, so the next progress
  // poll is base (5s), not a continuation of the inflated backoff curve.
  it('a fixed-interval requeue resets backoff accumulated by prior transient retries', () => {
    vi.useFakeTimers()
    try {
      const recipe = makeWorkflowRecipe({
        metadata: { name: 'mixed', namespace: 'sandbox-recipes' },
      })
      const { internal, handleRecipeEvent } = makeInternal(recipe)

      // Two transient (error) passes inflate attempts to 2 → next would be 20s.
      internal.scheduleTransientRetry('mixed', 5_000) // attempt 0 → 5s
      vi.advanceTimersByTime(5_000)
      internal.scheduleTransientRetry('mixed', 5_000) // attempt 1 → 10s
      vi.advanceTimersByTime(10_000)
      expect(internal.transientRetries.get('mixed')?.attempts).toBe(2)

      // Now the run starts progressing → fixed-interval requeue. attempts resets
      // to 0 and the timer fires at the base 5s, NOT at 5s*2**2 = 20s.
      handleRecipeEvent.mockClear()
      internal.scheduleTransientRetry('mixed', 5_000, true)
      expect(internal.transientRetries.get('mixed')?.attempts).toBe(0)
      vi.advanceTimersByTime(5_000)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reconcile failure re-schedules the transient retry chain (issue #375 P2)', () => {
  // A transient (non-404) throw inside handleRecipeEvent used to log the failure
  // and return WITHOUT re-arming the per-recipe retry chain, so the 5s self-heal
  // died on the first error and only the 30s watchdog could recover it. The fix
  // keeps the loud error log AND re-schedules the bounded backoff retry; the 404
  // "already gone" branch must still clear and return without a retry.
  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
    stopped: boolean
    traceReporter: null
    dbRunProcessor: null
    eventQueue: { enqueue: (key: string, task: () => Promise<void>) => Promise<void> }
    reconciler: {
      reconcile: ReturnType<typeof vi.fn>
      isRecipeStillActive: ReturnType<typeof vi.fn>
      ensureFinalizer: ReturnType<typeof vi.fn>
      patchStatus: ReturnType<typeof vi.fn>
    }
    handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
  }

  function makeInternal(recipe: WorkflowRecipeCRD, reconcileError: unknown): InternalWatcher {
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[recipe.metadata.name, recipe]])
    internal.transientRetries = new Map()
    internal.stopped = false
    internal.traceReporter = null
    internal.dbRunProcessor = null
    internal.eventQueue = { enqueue: vi.fn((_key: string, task: () => Promise<void>) => task()) }
    internal.reconciler = {
      reconcile: vi.fn().mockRejectedValue(reconcileError),
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      patchStatus: vi.fn().mockResolvedValue(undefined),
    }
    return internal
  }

  function clearRetries(internal: InternalWatcher): void {
    for (const { timer } of internal.transientRetries.values()) clearTimeout(timer)
  }

  it('re-arms the transient retry after a non-404 reconcile failure (keeps the loud log)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const recipe = makeWorkflowRecipe({ metadata: { name: 'flaky', namespace: 'sandbox-recipes' } })
    const internal = makeInternal(recipe, new Error('control-api unreachable'))
    try {
      await internal.handleRecipeEvent('ADDED', recipe)

      // fail-loud preserved: the reconciliation-failed error is still logged.
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reconciliation failed for "flaky"'),
        expect.anything()
      )
      // NEW: the 5s self-heal chain is re-armed instead of dying on first error.
      expect(internal.transientRetries.has('flaky')).toBe(true)
    } finally {
      clearRetries(internal)
      errSpy.mockRestore()
    }
  })

  it('does not re-arm a retry when the recipe is already gone (404)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recipe = makeWorkflowRecipe({ metadata: { name: 'gone', namespace: 'sandbox-recipes' } })
    const internal = makeInternal(recipe, { code: 404 })
    try {
      await internal.handleRecipeEvent('ADDED', recipe)

      expect(internal.transientRetries.has('gone')).toBe(false)
      expect(internal.recipes.has('gone')).toBe(false)
    } finally {
      clearRetries(internal)
      warnSpy.mockRestore()
    }
  })
})

describe('Plugin Workload SDK computed-vs-published state divergence log (issue #375 P4)', () => {
  // Forensic observability: when the reconciler COMPUTES an SDK capability state
  // that differs from what is currently published, log old→new and whether a
  // patch was emitted. This one line would have discriminated H1 (transition
  // computed but not published) from H2 in minutes during the incident.
  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
    stopped: boolean
    traceReporter: null
    dbRunProcessor: null
    reconciler: {
      reconcile: ReturnType<typeof vi.fn>
      isRecipeStillActive: ReturnType<typeof vi.fn>
      ensureFinalizer: ReturnType<typeof vi.fn>
      patchStatus: ReturnType<typeof vi.fn>
    }
    handleRecipeEvent: (type: string, recipe: WorkflowRecipeCRD) => Promise<void>
  }

  function makeInternal(recipe: WorkflowRecipeCRD, result: unknown): InternalWatcher {
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map([[recipe.metadata.name, recipe]])
    internal.transientRetries = new Map()
    internal.stopped = false
    internal.traceReporter = null
    internal.dbRunProcessor = null
    internal.reconciler = {
      reconcile: vi.fn().mockResolvedValue(result),
      isRecipeStillActive: vi.fn().mockResolvedValue(true),
      ensureFinalizer: vi.fn().mockResolvedValue(undefined),
      patchStatus: vi.fn().mockResolvedValue(undefined),
    }
    return internal
  }

  function sdkRecipe(persistedState: 'awaiting_policy' | 'validated'): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes' },
      spec: { steps: [], pluginWorkloadSdk: { promptBridge: {} } },
      status: {
        phase: 'active',
        message: 'All workloads deployed',
        pluginWorkloadSdk: {
          state: persistedState,
          promptBridge: true,
          clientNotifications: false,
        },
      },
    })
  }

  it('logs the old→new SDK state and patchEmitted when the computed state diverges', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const recipe = sdkRecipe('awaiting_policy')
    const internal = makeInternal(recipe, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      pluginWorkloadSdkProjection: {
        conditions: [],
        capability: {
          state: 'validated' as const,
          promptBridge: true,
          clientNotifications: false,
          verifiedAt: new Date().toISOString(),
        },
      },
    })
    try {
      await internal.handleRecipeEvent('ADDED', recipe)
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /Plugin Workload SDK state.*sdk-recipe.*awaiting_policy -> validated.*patchEmitted=true/
        )
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('does not log a transition when the computed SDK state is unchanged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const recipe = sdkRecipe('validated')
    const internal = makeInternal(recipe, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      pluginWorkloadSdkProjection: {
        conditions: [],
        capability: {
          state: 'validated' as const,
          promptBridge: true,
          clientNotifications: false,
          verifiedAt: new Date().toISOString(),
        },
      },
    })
    try {
      await internal.handleRecipeEvent('ADDED', recipe)
      const transitionLogs = logSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('Plugin Workload SDK state')
      )
      expect(transitionLogs).toHaveLength(0)
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('grant-update NOTIFY dispatch (issue #375 P3 wiring, H4/H5)', () => {
  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    eventQueue: { enqueue: ReturnType<typeof vi.fn> }
    handleRecipeEvent: ReturnType<typeof vi.fn>
    handleGrantUpdateNotification: (recipeNamespace: string, recipeName: string) => void
  }

  function makeInternal(recipes: WorkflowRecipeCRD[]): {
    internal: InternalWatcher
    tasks: Array<() => Promise<void>>
  } {
    const tasks: Array<() => Promise<void>> = []
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map(recipes.map(r => [r.metadata.name, r]))
    internal.eventQueue = {
      enqueue: vi.fn((_key: string, task: () => Promise<void>) => {
        tasks.push(task)
        return Promise.resolve()
      }),
    }
    internal.handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    return { internal, tasks }
  }

  it('enqueues a forceReconcile for a matching recipe and reconciles the CURRENT cached recipe (H5)', async () => {
    const recipe = makeWorkflowRecipe({
      metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes', generation: 1 },
    })
    const { internal, tasks } = makeInternal([recipe])

    internal.handleGrantUpdateNotification('sandbox-recipes', 'sdk-recipe')

    expect(internal.eventQueue.enqueue).toHaveBeenCalledWith('sdk-recipe', expect.any(Function))
    expect(tasks).toHaveLength(1)

    // H5: a newer MODIFIED lands before the queued job runs. The job must
    // reconcile the FRESH cached recipe, not the snapshot captured at NOTIFY time.
    const fresher = makeWorkflowRecipe({
      metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes', generation: 2 },
    })
    internal.recipes.set('sdk-recipe', fresher)

    await tasks[0]()

    expect(internal.handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', fresher, {
      forceReconcile: true,
    })
    expect(internal.handleRecipeEvent).not.toHaveBeenCalledWith('MODIFIED', recipe, {
      forceReconcile: true,
    })
  })

  it('discards and warns on a namespace mismatch — no enqueue (H4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recipe = makeWorkflowRecipe({
      metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes' },
    })
    const { internal } = makeInternal([recipe])
    try {
      internal.handleGrantUpdateNotification('other-namespace', 'sdk-recipe')
      expect(internal.eventQueue.enqueue).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Discarding grant-update NOTIFY for "other-namespace/sdk-recipe"')
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('discards and warns on an unknown recipe — no enqueue (H4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { internal } = makeInternal([])
    try {
      internal.handleGrantUpdateNotification('sandbox-recipes', 'nope')
      expect(internal.eventQueue.enqueue).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown recipe'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('the queued job re-checks the guard and does nothing if the recipe vanished while queued (H5)', async () => {
    const recipe = makeWorkflowRecipe({
      metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes' },
    })
    const { internal, tasks } = makeInternal([recipe])

    internal.handleGrantUpdateNotification('sandbox-recipes', 'sdk-recipe')
    // Recipe deleted between NOTIFY and job execution.
    internal.recipes.delete('sdk-recipe')

    await tasks[0]()

    expect(internal.handleRecipeEvent).not.toHaveBeenCalled()
  })
})

// issue #299 §3.2/§5 — the periodic external-egress requeue timer. GitHub rotates
// its api.github.com A record (~15s TTL over 140.82.112.0/20) WITHOUT bumping the
// WorkflowRecipe CRD generation, so a generation-only reconcile trigger never
// re-runs the accumulator and the sliding-window set never converges on a fresh
// IP. This timer re-enqueues cached recipes that declare an exact-host EXTERNAL
// egress on a fixed cadence so the accumulator folds each new snapshot.
describe('external egress periodic refresh (issue #299 §3.2/§5)', () => {
  function makeUiEgressRecipe(name: string): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [{ id: 'ui', type: 'deployment', image: 'clerum/ui:test' }],
        ui: {
          workloadRef: 'ui',
          port: 8080,
          egress: { external: [{ fqdn: 'api.github.com', port: 443 }] },
        },
      },
    })
  }

  function makeWorkloadEgressRecipe(name: string): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [
          {
            id: 'api',
            type: 'deployment',
            image: 'clerum/api:test',
            egressBindings: [{ dns: 'api.github.com', port: 443 }],
          },
        ],
      },
    })
  }

  function makeClusterLocalOnlyRecipe(name: string): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [
          { id: 'db', type: 'deployment', image: 'clerum/db:test' },
          {
            id: 'api',
            type: 'deployment',
            image: 'clerum/api:test',
            egressBindings: [{ dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432 }],
          },
        ],
      },
    })
  }

  function makeTransportOnlyRecipe(name: string): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'clerum/mcp:test',
            transport: { type: 'streamableHttp' },
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
    })
  }

  function makePlainRecipe(name: string): WorkflowRecipeCRD {
    return makeWorkflowRecipe({
      metadata: { name, namespace: 'sandbox-recipes' },
      spec: {
        steps: [],
        workloads: [{ id: 'api', type: 'deployment', image: 'clerum/api:test' }],
      },
    })
  }

  describe('recipeHasExternalExactHostEgress', () => {
    it('is true for a UI external egress FQDN', () => {
      expect(recipeHasExternalExactHostEgress(makeUiEgressRecipe('ui'))).toBe(true)
    })

    it('is true for a non-transport workload egressBinding with an external FQDN', () => {
      expect(recipeHasExternalExactHostEgress(makeWorkloadEgressRecipe('wl'))).toBe(true)
    })

    it('is false when the only binding is a cluster-local sibling (not external)', () => {
      expect(recipeHasExternalExactHostEgress(makeClusterLocalOnlyRecipe('cl'))).toBe(false)
    })

    it('is false for a transport-only (HCC-delegated) egress workload', () => {
      // Transport egress is delegated to HCC/McpServer, NOT folded by the WRC
      // accumulator, so the timer must not select it.
      expect(recipeHasExternalExactHostEgress(makeTransportOnlyRecipe('tr'))).toBe(false)
    })

    it('is false for a recipe with no egress at all', () => {
      expect(recipeHasExternalExactHostEgress(makePlainRecipe('plain'))).toBe(false)
    })

    it('is false while the recipe is being deleted', () => {
      const recipe = makeUiEgressRecipe('deleting')
      recipe.metadata.deletionTimestamp = '2026-08-08T00:00:00Z'
      expect(recipeHasExternalExactHostEgress(recipe)).toBe(false)
    })

    it('excludes the UI workload id from the workload-binding scan (it is covered by ui.egress)', () => {
      // A recipe whose ONLY external binding lives on the ui workload itself must
      // still resolve true via ui.egress.external, never via the workload scan.
      const recipe = makeUiEgressRecipe('ui-wl')
      recipe.spec.workloads = [
        {
          id: 'ui',
          type: 'deployment',
          image: 'clerum/ui:test',
          egressBindings: [{ dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432 }],
        },
      ]
      // ui.egress.external drives the true result; the ui workload's own binding
      // (cluster-local here) is skipped.
      expect(recipeHasExternalExactHostEgress(recipe)).toBe(true)
    })
  })

  describe('externalEgressRefreshIntervalMs', () => {
    it('returns the configured interval (seconds → ms) when above the floor', () => {
      expect(
        externalEgressRefreshIntervalMs({
          externalEgressRefreshIntervalSeconds: 60,
          externalEgressRefreshFloorSeconds: 5,
        })
      ).toBe(60_000)
    })

    it('clamps up to the floor when the interval is below it', () => {
      expect(
        externalEgressRefreshIntervalMs({
          externalEgressRefreshIntervalSeconds: 3,
          externalEgressRefreshFloorSeconds: 5,
        })
      ).toBe(5_000)
    })

    // H2 (issue #299): advance the refresh to <= observed TTL / 2 so a rotating
    // low-TTL host (GitHub api, TTL ~15s) is sampled every rotation, not every 60s.
    it('advances to TTL/2 when the observed TTL makes it faster than the configured interval', () => {
      expect(
        externalEgressRefreshIntervalMs(
          { externalEgressRefreshIntervalSeconds: 60, externalEgressRefreshFloorSeconds: 5 },
          15_000 // observed min TTL 15s → 7.5s refresh
        )
      ).toBe(7_500)
    })

    it('never drops below the floor even for a tiny TTL', () => {
      expect(
        externalEgressRefreshIntervalMs(
          { externalEgressRefreshIntervalSeconds: 60, externalEgressRefreshFloorSeconds: 5 },
          6_000 // TTL/2 = 3s < floor 5s → floor
        )
      ).toBe(5_000)
    })

    it('keeps the configured interval when the observed TTL is large', () => {
      expect(
        externalEgressRefreshIntervalMs(
          { externalEgressRefreshIntervalSeconds: 60, externalEgressRefreshFloorSeconds: 5 },
          600_000 // TTL/2 = 300s > interval 60s → interval wins
        )
      ).toBe(60_000)
    })

    it('ignores a non-finite/absent observed TTL (falls back to the configured interval)', () => {
      expect(
        externalEgressRefreshIntervalMs(
          { externalEgressRefreshIntervalSeconds: 60, externalEgressRefreshFloorSeconds: 5 },
          Infinity
        )
      ).toBe(60_000)
    })
  })

  type InternalWatcher = {
    recipes: Map<string, WorkflowRecipeCRD>
    eventQueue: { enqueue: (key: string, task: () => Promise<void>) => Promise<void> }
    handleRecipeEvent: (
      type: string,
      recipe: WorkflowRecipeCRD,
      options?: { forceReconcile?: boolean }
    ) => Promise<void>
    stopped: boolean
    config: {
      externalEgressRefreshIntervalSeconds: number
      externalEgressRefreshFloorSeconds: number
    }
    externalEgressRefreshTimer: ReturnType<typeof setInterval> | null
    externalEgressRefreshRunning: boolean
    // H2 (issue #299): the refresh loop reads the reconciler's observed min TTL.
    reconciler: { externalEgressRefreshMinTtlMs: number }
    refreshExternalEgressForActiveRecipes: () => Promise<void>
    startExternalEgressRefreshLoop: () => void
    stop: () => Promise<void>
  }

  function makeInternal(recipes: WorkflowRecipeCRD[]) {
    const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
    const handleRecipeEvent = vi.fn().mockResolvedValue(undefined)
    const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
    internal.recipes = new Map(recipes.map(r => [r.metadata.name, r]))
    internal.eventQueue = { enqueue }
    internal.handleRecipeEvent = handleRecipeEvent
    internal.stopped = false
    internal.config = {
      externalEgressRefreshIntervalSeconds: 60,
      externalEgressRefreshFloorSeconds: 5,
    }
    internal.externalEgressRefreshTimer = null
    internal.externalEgressRefreshRunning = false
    internal.reconciler = { externalEgressRefreshMinTtlMs: Infinity }
    return { internal, enqueue, handleRecipeEvent }
  }

  it('refreshExternalEgressForActiveRecipes re-enqueues ONLY recipes with external exact-host egress', async () => {
    const { internal, enqueue, handleRecipeEvent } = makeInternal([
      makeUiEgressRecipe('with-ui-egress'),
      makeWorkloadEgressRecipe('with-wl-egress'),
      makePlainRecipe('plain'),
      makeClusterLocalOnlyRecipe('cluster-local'),
      makeTransportOnlyRecipe('transport'),
    ])

    await internal.refreshExternalEgressForActiveRecipes()

    expect(enqueue).toHaveBeenCalledWith('with-ui-egress', expect.any(Function))
    expect(enqueue).toHaveBeenCalledWith('with-wl-egress', expect.any(Function))
    expect(enqueue).not.toHaveBeenCalledWith('plain', expect.any(Function))
    expect(enqueue).not.toHaveBeenCalledWith('cluster-local', expect.any(Function))
    expect(enqueue).not.toHaveBeenCalledWith('transport', expect.any(Function))
    expect(enqueue).toHaveBeenCalledTimes(2)

    // A full reconcile is forced (generation is unchanged, so a plain MODIFIED
    // would short-circuit before the accumulator runs).
    for (const name of ['with-ui-egress', 'with-wl-egress']) {
      expect(handleRecipeEvent).toHaveBeenCalledWith('MODIFIED', internal.recipes.get(name), {
        forceReconcile: true,
      })
    }
  })

  it('refreshExternalEgressForActiveRecipes is a no-op while stopped', async () => {
    const { internal, enqueue } = makeInternal([makeUiEgressRecipe('with-ui-egress')])
    internal.stopped = true
    await internal.refreshExternalEgressForActiveRecipes()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('the timer re-enqueues external-egress recipes on each tick at the clamped interval', async () => {
    vi.useFakeTimers()
    try {
      const { internal, handleRecipeEvent } = makeInternal([
        makeUiEgressRecipe('with-ui-egress'),
        makePlainRecipe('plain'),
      ])

      internal.startExternalEgressRefreshLoop()
      expect(internal.externalEgressRefreshTimer).not.toBeNull()
      expect(handleRecipeEvent).not.toHaveBeenCalled()

      // 1ms before the 60s interval: nothing has fired.
      await vi.advanceTimersByTimeAsync(59_999)
      expect(handleRecipeEvent).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
      expect(handleRecipeEvent).toHaveBeenCalledWith(
        'MODIFIED',
        internal.recipes.get('with-ui-egress'),
        { forceReconcile: true }
      )

      // Second tick fires again — the requeue is periodic, not one-shot.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('advances the refresh to TTL/2 when the reconciler has observed a low TTL (H2 wiring)', async () => {
    vi.useFakeTimers()
    try {
      const { internal, handleRecipeEvent } = makeInternal([makeUiEgressRecipe('with-ui-egress')])
      // The reconciler observed GitHub's ~15s TTL → the loop must fire at 7.5s,
      // not the 60s configured interval.
      internal.reconciler = { externalEgressRefreshMinTtlMs: 15_000 }

      internal.startExternalEgressRefreshLoop()
      await vi.advanceTimersByTimeAsync(7_499)
      expect(handleRecipeEvent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('startExternalEgressRefreshLoop is idempotent (does not create a second timer)', () => {
    vi.useFakeTimers()
    try {
      const { internal } = makeInternal([makeUiEgressRecipe('with-ui-egress')])
      internal.startExternalEgressRefreshLoop()
      const first = internal.externalEgressRefreshTimer
      internal.startExternalEgressRefreshLoop()
      expect(internal.externalEgressRefreshTimer).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second refresh pass while one is still running (no concurrent duplicates)', async () => {
    vi.useFakeTimers()
    try {
      // handleRecipeEvent returns a promise that stays pending until we release it,
      // so the first pass is still in-flight when the second tick fires.
      let release: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const enqueue = vi.fn((_key: string, task: () => Promise<void>) => task())
      const handleRecipeEvent = vi.fn().mockReturnValue(gate)
      const internal = Object.create(WorkflowRecipeWatcher.prototype) as InternalWatcher
      internal.recipes = new Map([['with-ui-egress', makeUiEgressRecipe('with-ui-egress')]])
      internal.eventQueue = { enqueue }
      internal.handleRecipeEvent = handleRecipeEvent
      internal.stopped = false
      internal.config = {
        externalEgressRefreshIntervalSeconds: 60,
        externalEgressRefreshFloorSeconds: 5,
      }
      internal.externalEgressRefreshTimer = null
      internal.externalEgressRefreshRunning = false
      internal.reconciler = { externalEgressRefreshMinTtlMs: Infinity }

      internal.startExternalEgressRefreshLoop()
      await vi.advanceTimersByTimeAsync(60_000) // first tick — pass starts, stays in-flight
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)
      expect(internal.externalEgressRefreshRunning).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000) // second tick — must be skipped
      expect(handleRecipeEvent).toHaveBeenCalledTimes(1)

      release?.()
      await gate
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() clears the refresh timer so no further ticks fire', async () => {
    vi.useFakeTimers()
    try {
      const { internal, handleRecipeEvent } = makeInternal([makeUiEgressRecipe('with-ui-egress')])
      // Minimal shape for stop() — every other subsystem is absent in this fixture.
      const stoppableInternal = internal as unknown as {
        transientRetries: Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>
        runtimeCredentialRefreshTimer: ReturnType<typeof setInterval> | null
        workloadStatusRefreshTimer: ReturnType<typeof setInterval> | null
        watchRequest: { abort: () => void } | null
        secretWatchLoops: { stop: () => void }[]
        brokerRotationTimer: ReturnType<typeof setInterval> | null
        dbRunProcessor: { stop: () => Promise<void> } | null
        traceReporter: null
      }
      stoppableInternal.transientRetries = new Map()
      stoppableInternal.runtimeCredentialRefreshTimer = null
      stoppableInternal.workloadStatusRefreshTimer = null
      stoppableInternal.watchRequest = null
      stoppableInternal.secretWatchLoops = []
      stoppableInternal.brokerRotationTimer = null
      stoppableInternal.dbRunProcessor = null
      stoppableInternal.traceReporter = null

      internal.startExternalEgressRefreshLoop()
      expect(internal.externalEgressRefreshTimer).not.toBeNull()

      await internal.stop()
      expect(internal.externalEgressRefreshTimer).toBeNull()
      expect(internal.stopped).toBe(true)

      await vi.advanceTimersByTimeAsync(120_000)
      expect(handleRecipeEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
