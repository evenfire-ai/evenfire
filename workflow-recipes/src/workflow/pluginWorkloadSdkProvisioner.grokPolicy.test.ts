import { describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import type { WorkflowRecipeSpec } from '../types'
import type { CodexRecipeVerdict } from './codexRecipeVerdict'
import {
  PluginWorkloadSdkProvisioner,
  type PluginWorkloadSdkProvisionerDeps,
} from './pluginWorkloadSdkProvisioner'
import {
  EAGER_SDK_RUNTIME,
  EAGER_SDK_SANDBOX_NS,
  EAGER_SDK_TEST_IMAGE,
  buildEagerSdkPolicyPod,
  eagerSdkRuntimeContractHash,
  eagerSdkTestConfig,
  ineligibleCodexProjection,
} from './pluginWorkloadSdkProvisioner.testFixtures'
import type { PluginWorkloadSdkCodexBindingProof } from './sdkOnlyCodexBinding'
import { mintSdkOnlyGrokBindingProof } from './sdkOnlyGrokBinding'

const RECIPE = 'grok-sdk'
const MODEL = 'grok-4.6'
const TEST_CONFIG = eagerSdkTestConfig({ grokSubscriptionEnabled: true })

const GROK_SPEC = {
  agent: { provider: 'grok-subscription', model: MODEL },
  pluginWorkloadSdk: { promptBridge: {} },
} as unknown as WorkflowRecipeSpec

const MINTED = mintSdkOnlyGrokBindingProof({
  connectionKey: 'team-grok',
  catalogRevision: 5,
  credentialRevision: 2,
  model: MODEL,
})

function verdictFor(opts: {
  grokBinding?: PluginWorkloadSdkCodexBindingProof | null
  grokBindingUndecidable?: boolean
}): CodexRecipeVerdict {
  const undecidable = opts.grokBindingUndecidable === true
  const binding = opts.grokBinding ?? null
  return {
    provenance: undecidable ? 'uncertain' : 'authoritative',
    provenanceReason: undecidable ? 'parent_spec_unavailable' : 'standalone',
    connectionKey: 'unassigned',
    projection: ineligibleCodexProjection(),
    hostBinding: null,
    hostBindingReason: 'unassigned',
    grokProjection: {
      targets: [],
      eligibleTargets: [],
      derivedScopes: binding ? ['llm:grok:execute'] : [],
      requiresCodexProxyEgress: false,
      requiresGrokProxyEgress: Boolean(binding) && !undecidable,
      catalogContentHash: null,
      catalogRevision: null,
      connectionRevision: null,
      eligibility: undecidable ? 'uncertain' : binding ? 'eligible' : 'ineligible',
      reason: undecidable ? 'provenance_uncertain' : binding ? 'eligible' : 'static_only',
      driftHashInput: '{}',
    },
    grokBinding: undecidable ? null : binding,
    grokBindingReason: undecidable ? 'provenance_uncertain' : binding ? 'eligible' : 'static_only',
  }
}

function readyBootstrapBody(binding: PluginWorkloadSdkCodexBindingProof | null) {
  return {
    status: 202,
    body: {
      configured: true,
      ready: true,
      provider: 'grok-subscription',
      model: MODEL,
      contractVersion: 3,
      policyReady: true,
      policyState: 'active',
      policyRevision: 7,
      policyHash: 'b'.repeat(64),
      defaultTargetRef: 'target/grok',
      defaultProvider: 'grok-subscription',
      defaultModel: MODEL,
      ...(binding ? { subscriptionBinding: binding } : {}),
    },
  }
}

function makeHarness(configureResult: unknown) {
  let podUid = 'pod-uid-1'
  const runtimeContractHash = eagerSdkRuntimeContractHash({
    recipeName: RECIPE,
    spec: GROK_SPEC,
    config: TEST_CONFIG,
  })
  const readNamespacedPod = vi.fn().mockImplementation(async () => ({
    metadata: {
      uid: podUid,
      annotations: {
        'clerum.io/plugin-workload-sdk-runtime-contract-hash': runtimeContractHash,
      },
    },
    spec: { containers: [{ name: 'mcp-host', image: EAGER_SDK_TEST_IMAGE }] },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [],
    },
  }))
  const deleteNamespacedPod = vi.fn().mockResolvedValue({})
  const createNamespacedPod = vi.fn().mockResolvedValue({})
  const configure = vi.fn().mockResolvedValue(configureResult)
  const signWrcConfigureToken = vi.fn().mockResolvedValue('configure-token')
  const deps = {
    coreApi: { readNamespacedPod, deleteNamespacedPod, createNamespacedPod },
    config: TEST_CONFIG,
    tokenFactory: { signWrcConfigureToken },
    modelConfigHandler: { configurePluginWorkloadSdkBootstrap: configure },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ensureMcpHostSecrets: vi.fn().mockResolvedValue(undefined),
    applyWorkflowNetworkPolicies: vi.fn().mockResolvedValue(undefined),
    ensureMcpHostHeadlessService: vi.fn().mockResolvedValue(undefined),
    createIfNotExists: vi.fn().mockResolvedValue(true),
    safeDelete: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginWorkloadSdkProvisionerDeps
  const provisioner = new PluginWorkloadSdkProvisioner(deps)

  const reconcile = (opts: {
    grokBinding?: PluginWorkloadSdkCodexBindingProof | null
    grokBindingUndecidable?: boolean
  }) =>
    provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      EAGER_SDK_SANDBOX_NS,
      RECIPE,
      GROK_SPEC,
      EAGER_SDK_RUNTIME,
      {
        mcpHostPhase: 'Running',
        codexVerdict: verdictFor(opts),
      }
    )

  return {
    provisioner,
    reconcile,
    configure,
  }
}

describe('eager Grok policy gate', () => {
  it('pins MCP_HOST_GROK_SUBSCRIPTION_ENABLED on the SDK pod contract', () => {
    const pod = buildEagerSdkPolicyPod({
      recipeName: RECIPE,
      spec: GROK_SPEC,
      config: TEST_CONFIG,
    })
    const env = pod.spec?.containers?.[0].env ?? []
    expect(env).toContainEqual({ name: 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED', value: 'true' })
    expect(env).toContainEqual({
      name: 'GROK_LLM_PROXY_RUNTIME_URL',
      value: 'http://grok-llm-proxy.control-plane.svc.cluster.local:8080',
    })
    expect(
      eagerSdkRuntimeContractHash({ recipeName: RECIPE, spec: GROK_SPEC, config: TEST_CONFIG })
    ).not.toBe(
      eagerSdkRuntimeContractHash({
        recipeName: RECIPE,
        spec: GROK_SPEC,
        config: eagerSdkTestConfig({ grokSubscriptionEnabled: false }),
      })
    )
  })

  it('omits Grok proxy env when the WRC flag is off', () => {
    const pod = buildEagerSdkPolicyPod({
      recipeName: RECIPE,
      spec: GROK_SPEC,
      config: eagerSdkTestConfig({ grokSubscriptionEnabled: false }),
    })
    const env = pod.spec?.containers?.[0].env ?? []
    expect(env).not.toContainEqual({
      name: 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED',
      value: 'true',
    })
  })

  it('accepts a Grok hash on subscriptionBinding and reports ready', async () => {
    const harness = makeHarness(readyBootstrapBody(MINTED))
    expect(await harness.reconcile({ grokBinding: MINTED })).toBe('ready')
    expect(harness.configure).toHaveBeenCalledWith(
      'grok-subscription',
      MODEL,
      expect.any(String),
      'configure-token',
      'promptBridge',
      MINTED
    )
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({
      contractVersion: 3,
      provider: 'grok-subscription',
      subscriptionBinding: MINTED,
      policyReady: true,
    })
  })

  it('skips reconfigure when Grok provenance is uncertain and the same pod still holds the binding', async () => {
    const harness = makeHarness(readyBootstrapBody(MINTED))
    expect(await harness.reconcile({ grokBinding: MINTED })).toBe('ready')
    expect(harness.configure).toHaveBeenCalledTimes(1)
    expect(await harness.reconcile({ grokBinding: MINTED, grokBindingUndecidable: true })).toBe(
      'ready'
    )
    expect(harness.configure).toHaveBeenCalledTimes(1)
  })

  it('rejects a Grok bootstrap whose hash is a Codex digest', async () => {
    // Minted and echoed hashes MUST be the Grok digest. If parse used
    // computeCodexPolicyHash, the echo would match and this would report ready.
    const forged: PluginWorkloadSdkCodexBindingProof = {
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: MODEL,
      bindingHash: computeCodexPolicyHash({
        model: MODEL,
        catalogRevision: 5,
        credentialRevision: 2,
        connectionKey: 'team-grok',
      }),
    }
    const harness = makeHarness(readyBootstrapBody(forged))
    expect(await harness.reconcile({ grokBinding: forged })).toBe('deploying')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toBeUndefined()
    expect(harness.configure).toHaveBeenCalled()
  })

  it('accepts execution_binding_missing as awaiting_policy when Grok has no grant', async () => {
    const harness = makeHarness({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'grok-subscription',
        model: MODEL,
        contractVersion: 3,
        policyState: 'binding_missing',
        policyReason: 'execution_binding_missing',
      },
    })
    expect(await harness.reconcile({ grokBinding: null })).toBe('awaiting_policy')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({
      policyReady: false,
      policyReason: 'execution_binding_missing',
    })
  })
})
