import { describe, expect, it, vi } from 'vitest'
import type { WorkflowRecipeSpec } from '../types'
import { PluginWorkloadSdkProvisioner } from './pluginWorkloadSdkProvisioner'
import type { PluginWorkloadSdkProvisionerDeps } from './pluginWorkloadSdkProvisioner'
import { buildMcpHostPod, pluginWorkloadSdkRuntimeContractHash } from './podFactory'
import type { WorkflowRuntimePlan } from './runtimePlan'
import type { WorkflowConfig } from './types'

const SANDBOX_NS = 'sandbox-recipes'
const DESIRED_IMAGE = 'registry.example/clerum/mcp-host-slim:sha-new'
const STALE_IMAGE = 'registry.example/clerum/mcp-host-slim:sha-old'
const RECIPE = 'demo'

// A healthy Running pod with no container waiting reason — the wedged-pod
// recovery branch is skipped, so the image-drift branch is what decides.
function podWithPhase(
  image: string,
  phase: 'Running' | 'Pending',
  opts: { deleting?: boolean; runtimeContractHash?: string; tokenGeneration?: string } = {}
) {
  const annotations = {
    ...(opts.runtimeContractHash
      ? { 'clerum.io/plugin-workload-sdk-runtime-contract-hash': opts.runtimeContractHash }
      : {}),
    ...(opts.tokenGeneration
      ? { 'clerum.io/mcp-host-runtime-token-generation': opts.tokenGeneration }
      : {}),
  }
  return {
    metadata: {
      uid: 'pod-uid-1',
      ...(opts.deleting ? { deletionTimestamp: '2026-06-19T18:00:00Z' } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec: { containers: [{ name: 'mcp-host', image }] },
    status: { phase, conditions: [], containerStatuses: [] },
  }
}

function makeProvisioner(
  podImage: string,
  phase: 'Running' | 'Pending' = 'Running',
  opts: {
    deleting?: boolean
    runtimeContractHash?: string
    tokenRefresh?: {
      reminted: boolean
      reason?: 'scope' | 'binding' | 'ttl'
      tokenGeneration?: string
    }
    tokenGeneration?: string
  } = {}
) {
  const readNamespacedPod = vi.fn().mockResolvedValue(
    podWithPhase(podImage, phase, {
      deleting: opts.deleting,
      runtimeContractHash: opts.runtimeContractHash,
      tokenGeneration: opts.tokenGeneration,
    })
  )
  const deleteNamespacedPod = vi.fn().mockResolvedValue({})
  const createNamespacedPod = vi.fn().mockResolvedValue({})
  const coreApi = {
    readNamespacedPod,
    deleteNamespacedPod,
    createNamespacedPod,
  }

  const deps = {
    coreApi,
    config: TEST_CONFIG,
    tokenFactory: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ensureMcpHostSecrets: vi.fn().mockResolvedValue(opts.tokenRefresh),
    applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
    ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
    modelConfigHandler: {
      configurePluginWorkloadSdkBootstrap: vi.fn().mockResolvedValue({ status: 503 }),
    },
    createIfNotExists: vi.fn().mockResolvedValue(true),
    safeDelete: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginWorkloadSdkProvisionerDeps

  const provisioner = new PluginWorkloadSdkProvisioner(deps)
  return { provisioner, readNamespacedPod, deleteNamespacedPod, createNamespacedPod }
}

// spec.agent resolves to a complete agent so ensureEagerSdkMcpHost does not
// bail out before reaching the image-drift branch.
const SPEC = {
  agent: { provider: 'openai', model: 'gpt-4' },
  pluginWorkloadSdk: { promptBridge: {} },
} as unknown as WorkflowRecipeSpec
const RUNTIME = {} as unknown as WorkflowRuntimePlan
const TEST_CONFIG = {
  coordinatorImage: 'registry.example/coordinator:current',
  mcpHostImage: DESIRED_IMAGE,
  wrcEndpoint: 'http://workflow-recipes.example',
  sandboxNamespace: SANDBOX_NS,
  mcpServerNamespace: 'mcp-server',
  imagePullPolicy: 'IfNotPresent',
  maxWorkflowSteps: 10,
  workflowDefaultRunDurationSeconds: 60,
  workflowMaxRunDurationSeconds: 600,
  runtimeTokenTtlSeconds: 600,
  runtimeTokenRefreshBeforeSeconds: 60,
  workflowMaxWorkloadsPerRecipe: 10,
  workflowUiEgressInternalMaxItems: 10,
  workflowMaxSteps: 10,
  workflowStepDependsOnMaxItems: 10,
  workflowStepAllowedToolsMaxItems: 10,
  workflowStepMcpServersMaxItems: 10,
  workflowStatefulSetMaxReplicas: 3,
  workflowStatefulSetMaxVolumeClaimTemplates: 3,
  workflowStatefulSetMaxPvcPreflightChecks: 3,
  pluginWorkloadSdkEnabled: true,
} as unknown as WorkflowConfig

function desiredRuntimeContractHash(): string {
  const desiredPod = buildMcpHostPod(
    RECIPE,
    SPEC.agent,
    TEST_CONFIG,
    RECIPE,
    SANDBOX_NS,
    undefined,
    undefined,
    undefined,
    {
      mountWorkflowOutput: false,
      pluginWorkloadSdkCapabilities: ['promptBridge'],
      pluginWorkloadSdkRuntimeMode: 'sdk-only',
    }
  )
  return pluginWorkloadSdkRuntimeContractHash(desiredPod)
}

describe('ensureEagerSdkMcpHost image-drift roll', () => {
  it('rolls a healthy eager mcp-host pod when its image drifts from the platform image', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(STALE_IMAGE)

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    // Pod deleted so the next reconcile recreates it from the platform image;
    // status requeues as 'deploying' and the stale pod is NOT left in place.
    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: `${RECIPE}-mcp-host`,
      namespace: SANDBOX_NS,
    })
    // Recreate happens on a later reconcile (after the prior pod terminates),
    // never racing createIfNotExists against the terminating pod in this pass.
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('does not roll the pod when its image already matches the platform image', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(
      DESIRED_IMAGE,
      'Running',
      { runtimeContractHash: desiredRuntimeContractHash() }
    )

    await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(deleteNamespacedPod).not.toHaveBeenCalled()
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rolls a same-image pod when the runtime contract hash is missing', async () => {
    const { provisioner, deleteNamespacedPod } = makeProvisioner(DESIRED_IMAGE)

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: `${RECIPE}-mcp-host`,
      namespace: SANDBOX_NS,
    })
  })

  it('rolls a pending eager mcp-host pod on image drift before waiting for readiness', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(
      STALE_IMAGE,
      'Pending'
    )

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Pending' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: `${RECIPE}-mcp-host`,
      namespace: SANDBOX_NS,
    })
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('does not re-delete or configure a terminating eager mcp-host pod', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(
      STALE_IMAGE,
      'Running',
      { deleting: true }
    )

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).not.toHaveBeenCalled()
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('recreates the eager mcp-host pod from the platform image after the stale pod terminated', async () => {
    // Closes the second half of the drift loop: the delete-only tests above prove
    // the stale pod is removed, but the whole point of issue #598 is that the NEXT
    // reconcile (stale pod gone -> phase undefined) recreates the pod from
    // config.mcpHostImage. A regression that deletes but fails to recreate would
    // leave the recipe permanently pod-less while every delete-only test stays green.
    const readNamespacedPod = vi.fn().mockRejectedValue({ code: 404 })
    const createNamespacedPod = vi.fn().mockResolvedValue({})
    const deleteNamespacedPod = vi.fn().mockResolvedValue({})
    const coreApi = { readNamespacedPod, deleteNamespacedPod, createNamespacedPod }
    const deps = {
      coreApi,
      config: TEST_CONFIG,
      tokenFactory: {},
      modelConfigHandler: {
        configurePluginWorkloadSdkBootstrap: vi.fn().mockResolvedValue({ status: 503 }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
      applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
      ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
      // Invoke the create thunk so the recreated pod body is observable on
      // createNamespacedPod, proving it is built from the platform image.
      createIfNotExists: vi.fn(async (fn: () => Promise<unknown>) => {
        await fn()
        return true
      }),
      safeDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkProvisionerDeps
    const provisioner = new PluginWorkloadSdkProvisioner(deps)

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: undefined }
    )

    expect(status).toBe('deploying')
    // No stale pod to delete on the recreate pass — only the create fires.
    expect(deleteNamespacedPod).not.toHaveBeenCalled()
    expect(createNamespacedPod).toHaveBeenCalledTimes(1)
    const body = createNamespacedPod.mock.calls[0][0].body
    const mcpHostContainer = body.spec.containers.find(
      (container: { name?: string }) => container.name === 'mcp-host'
    )
    expect(mcpHostContainer?.image).toBe(DESIRED_IMAGE)
  })

  it('lets wedge recovery win over drift when a stale pod is also wedged (no double-roll)', async () => {
    // A pod that is BOTH on a stale image AND wedged (ImagePullBackOff) must be
    // rolled by the pre-existing wedge-recovery branch, which deletes and then lets
    // the create block recreate it in the SAME pass. The new drift branch must not
    // fire a second delete: wedge recovery sets mcpHostPhase=undefined first, which
    // makes the drift guard false. This pins the load-bearing branch ordering.
    const wedgedPod = {
      metadata: { uid: 'pod-uid-1' },
      spec: { containers: [{ name: 'mcp-host', image: STALE_IMAGE }] },
      status: {
        phase: 'Pending',
        conditions: [],
        containerStatuses: [
          { name: 'mcp-host', state: { waiting: { reason: 'ImagePullBackOff' } } },
        ],
      },
    }
    const readNamespacedPod = vi.fn().mockResolvedValue(wedgedPod)
    const deleteNamespacedPod = vi.fn().mockResolvedValue({})
    const createNamespacedPod = vi.fn().mockResolvedValue({})
    const coreApi = { readNamespacedPod, deleteNamespacedPod, createNamespacedPod }
    const deps = {
      coreApi,
      config: {
        mcpHostImage: DESIRED_IMAGE,
        sandboxNamespace: SANDBOX_NS,
        pluginWorkloadSdkEnabled: true,
      },
      tokenFactory: {},
      modelConfigHandler: {
        configurePluginWorkloadSdkBootstrap: vi.fn().mockResolvedValue({ status: 503 }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
      applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
      ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
      createIfNotExists: vi.fn(async (fn: () => Promise<unknown>) => {
        await fn()
        return true
      }),
      safeDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkProvisionerDeps
    const provisioner = new PluginWorkloadSdkProvisioner(deps)

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Pending' }
    )

    expect(status).toBe('deploying')
    // Wedge recovery deletes once and recreates in-pass; the drift branch must NOT
    // add a second delete (that would prove it fired after wedge already rolled).
    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1)
    expect(createNamespacedPod).toHaveBeenCalledTimes(1)
  })

  it('does not broker /configure into a terminating Ready pod already on the platform image (promptBridge)', async () => {
    // Safety property — credential into a dying pod: a promptBridge recipe whose
    // pod is terminating (deletionTimestamp set) must short-circuit to 'deploying'
    // via the `deleting` guard BEFORE the configure path, so the provider key is
    // never brokered into a pod about to be replaced.
    //
    // This case deliberately uses DESIRED_IMAGE + a Ready condition: the
    // image-drift guard does NOT fire (image already matches) and readiness IS
    // 'ready', so the ONLY thing standing between the reconcile and a
    // signWrcConfigureToken/handle call is the `deleting` guard. Removing that
    // guard makes this test fail (configure brokered into the terminating pod) —
    // i.e. the negative assertions below are load-bearing, not incidental.
    const promptBridgeSpec = {
      agent: { provider: 'openai', model: 'gpt-4' },
      pluginWorkloadSdk: { promptBridge: {} },
    } as unknown as WorkflowRecipeSpec
    const handle = vi.fn()
    const signWrcConfigureToken = vi.fn().mockResolvedValue('configure-token')
    const readNamespacedPod = vi.fn().mockResolvedValue({
      metadata: { uid: 'pod-uid-1', deletionTimestamp: '2026-06-19T18:00:00Z' },
      spec: { containers: [{ name: 'mcp-host', image: DESIRED_IMAGE }] },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [],
      },
    })
    const deleteNamespacedPod = vi.fn().mockResolvedValue({})
    const createNamespacedPod = vi.fn().mockResolvedValue({})
    const coreApi = { readNamespacedPod, deleteNamespacedPod, createNamespacedPod }
    const deps = {
      coreApi,
      config: {
        mcpHostImage: DESIRED_IMAGE,
        sandboxNamespace: SANDBOX_NS,
        pluginWorkloadSdkEnabled: true,
      },
      tokenFactory: { signWrcConfigureToken },
      modelConfigHandler: { handle },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
      applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
      ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
      createIfNotExists: vi.fn().mockResolvedValue(true),
      safeDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkProvisionerDeps
    const provisioner = new PluginWorkloadSdkProvisioner(deps)

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      promptBridgeSpec,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).not.toHaveBeenCalled()
    expect(signWrcConfigureToken).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
  })

  it('resets the configure failure budget after an image-drift roll', async () => {
    // Explicit WRC rolls remain a broker-state boundary. Even if a unit-test
    // double reuses the same pod UID after the roll, failures accumulated against
    // the old pod must not survive and trip provider_unavailable on the next
    // transient configure blip.
    const promptBridgeSpec = {
      agent: { provider: 'openai', model: 'gpt-4' },
      pluginWorkloadSdk: { promptBridge: {} },
    } as unknown as WorkflowRecipeSpec
    const expectedRuntimeContractHash = pluginWorkloadSdkRuntimeContractHash(
      buildMcpHostPod(
        RECIPE,
        promptBridgeSpec.agent,
        TEST_CONFIG,
        RECIPE,
        SANDBOX_NS,
        undefined,
        undefined,
        undefined,
        {
          mountWorkflowOutput: false,
          pluginWorkloadSdkCapabilities: ['promptBridge'],
          pluginWorkloadSdkRuntimeMode: 'sdk-only',
        }
      )
    )
    let podImage = DESIRED_IMAGE
    // Keep the UID stable across the test double's replacement so this assertion
    // specifically proves the explicit roll reset, not only identity-key rollover.
    let podUid = 'pod-uid-1'
    const readNamespacedPod = vi.fn().mockImplementation(async () => ({
      metadata: {
        uid: podUid,
        annotations: {
          'clerum.io/plugin-workload-sdk-runtime-contract-hash': expectedRuntimeContractHash,
        },
      },
      spec: { containers: [{ name: 'mcp-host', image: podImage }] },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [],
      },
    }))
    const deleteNamespacedPod = vi.fn().mockResolvedValue({})
    const createNamespacedPod = vi.fn().mockResolvedValue({})
    // /configure always fails, so the failure budget is the only variable.
    const handle = vi.fn().mockResolvedValue({ status: 500 })
    const signWrcConfigureToken = vi.fn().mockResolvedValue('configure-token')
    const coreApi = { readNamespacedPod, deleteNamespacedPod, createNamespacedPod }
    const deps = {
      coreApi,
      config: TEST_CONFIG,
      tokenFactory: { signWrcConfigureToken },
      modelConfigHandler: { handle },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
      applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
      ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
      createIfNotExists: vi.fn().mockResolvedValue(true),
      safeDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkProvisionerDeps
    const provisioner = new PluginWorkloadSdkProvisioner(deps)
    const reconcile = () =>
      provisioner.ensureEagerSdkMcpHost(
        RECIPE,
        'recipe-uid',
        SANDBOX_NS,
        RECIPE,
        promptBridgeSpec,
        RUNTIME,
        {
          mcpHostPhase: 'Running',
        }
      )

    // Two configure failures on a healthy, image-matching pod (budget -> 2 of 3).
    expect(await reconcile()).toBe('deploying')
    expect(await reconcile()).toBe('deploying')
    // Image drifts: the pod is rolled and the failure budget must reset.
    podImage = STALE_IMAGE
    expect(await reconcile()).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1)
    // The replacement pod comes up healthy on the platform image. A single
    // configure blip on it must NOT trip provider_unavailable, even with the same
    // mocked UID, because the roll reset the budget.
    podImage = DESIRED_IMAGE
    expect(await reconcile()).toBe('deploying')
  })
})

describe('ensureEagerSdkMcpHost runtime token roll', () => {
  it('rolls a healthy eager mcp-host when runtime JWT scopes were reminted', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(
      DESIRED_IMAGE,
      'Running',
      {
        runtimeContractHash: desiredRuntimeContractHash(),
        tokenRefresh: { reminted: true, reason: 'scope' },
      }
    )

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: `${RECIPE}-mcp-host`,
      namespace: SANDBOX_NS,
    })
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('does not roll the eager mcp-host on a TTL-only runtime token remint', async () => {
    const { provisioner, deleteNamespacedPod } = makeProvisioner(DESIRED_IMAGE, 'Running', {
      runtimeContractHash: desiredRuntimeContractHash(),
      tokenRefresh: { reminted: true, reason: 'ttl' },
    })

    await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(deleteNamespacedPod).not.toHaveBeenCalled()
  })

  it('rolls a healthy eager mcp-host when Secret token generation drifted after a failed roll', async () => {
    const { provisioner, deleteNamespacedPod, createNamespacedPod } = makeProvisioner(
      DESIRED_IMAGE,
      'Running',
      {
        runtimeContractHash: desiredRuntimeContractHash(),
        tokenGeneration: '1',
        tokenRefresh: { reminted: false, tokenGeneration: '2' },
      }
    )

    const status = await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(status).toBe('deploying')
    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: `${RECIPE}-mcp-host`,
      namespace: SANDBOX_NS,
    })
    expect(createNamespacedPod).not.toHaveBeenCalled()
  })

  it('does not roll when Secret and pod token generations already match', async () => {
    const { provisioner, deleteNamespacedPod } = makeProvisioner(DESIRED_IMAGE, 'Running', {
      runtimeContractHash: desiredRuntimeContractHash(),
      tokenGeneration: '2',
      tokenRefresh: { reminted: false, tokenGeneration: '2' },
    })

    await provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      SPEC,
      RUNTIME,
      { mcpHostPhase: 'Running' }
    )

    expect(deleteNamespacedPod).not.toHaveBeenCalled()
  })
})

describe('ensureEagerSdkMcpHost ConfigMap snapshot skip', () => {
  const CODEX_SPEC = {
    agent: { provider: 'codex-subscription', model: 'gpt-5.6-luna' },
    pluginWorkloadSdk: { promptBridge: {} },
  } as unknown as WorkflowRecipeSpec

  function desiredCodexRuntimeContractHash(): string {
    const desiredPod = buildMcpHostPod(
      RECIPE,
      CODEX_SPEC.agent,
      TEST_CONFIG,
      RECIPE,
      SANDBOX_NS,
      undefined,
      undefined,
      undefined,
      {
        mountWorkflowOutput: false,
        pluginWorkloadSdkCapabilities: ['promptBridge'],
        pluginWorkloadSdkRuntimeMode: 'sdk-only',
      }
    )
    return pluginWorkloadSdkRuntimeContractHash(desiredPod)
  }

  it('does not send a binding-less Codex configure when the allowlist snapshot is unavailable', async () => {
    const configure = vi.fn()
    const signWrcConfigureToken = vi.fn()
    const readNamespacedPod = vi.fn().mockResolvedValue({
      metadata: {
        uid: 'pod-uid-1',
        annotations: {
          'clerum.io/plugin-workload-sdk-runtime-contract-hash': desiredCodexRuntimeContractHash(),
        },
      },
      spec: { containers: [{ name: 'mcp-host', image: DESIRED_IMAGE }] },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [],
      },
    })
    const deps = {
      coreApi: {
        readNamespacedPod,
        deleteNamespacedPod: vi.fn(),
        createNamespacedPod: vi.fn(),
      },
      config: TEST_CONFIG,
      tokenFactory: { signWrcConfigureToken },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
      applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
      ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
      modelConfigHandler: { configurePluginWorkloadSdkBootstrap: configure },
      createIfNotExists: vi.fn().mockResolvedValue(true),
      safeDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkProvisionerDeps
    const provisioner = new PluginWorkloadSdkProvisioner(deps)

    await expect(
      provisioner.ensureEagerSdkMcpHost(
        RECIPE,
        'recipe-uid',
        SANDBOX_NS,
        RECIPE,
        CODEX_SPEC,
        RUNTIME,
        { mcpHostPhase: 'Running', codexSnapshotUnavailable: true }
      )
    ).resolves.toBe('awaiting_policy')
    expect(configure).not.toHaveBeenCalled()
    expect(deps.tokenFactory.signWrcConfigureToken).not.toHaveBeenCalled()
  })
})
