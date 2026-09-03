import { describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import type { WorkflowRecipeSpec } from '../types'
import type { CodexRecipeVerdict } from './codexRecipeVerdict'
import {
  PluginWorkloadSdkProvisioner,
  type PluginWorkloadSdkProvisionerDeps,
} from './pluginWorkloadSdkProvisioner'
import { buildMcpHostPod, pluginWorkloadSdkRuntimeContractHash } from './podFactory'
import type { WorkflowRuntimePlan } from './runtimePlan'
import type { PluginWorkloadSdkCodexBindingProof } from './sdkOnlyCodexBinding'
import type { WorkflowConfig } from './types'

const SANDBOX_NS = 'sandbox-recipes'
const IMAGE = 'registry.example/clerum/mcp-host-slim:sha-current'
const RECIPE = 'codex-sdk'
const MODEL = 'gpt-5.3-codex'

const RUNTIME = {} as unknown as WorkflowRuntimePlan

const TEST_CONFIG = {
  coordinatorImage: 'registry.example/coordinator:current',
  mcpHostImage: IMAGE,
  wrcEndpoint: 'http://workflow-recipes.example',
  sandboxNamespace: SANDBOX_NS,
  mcpServerNamespace: 'mcp-server',
  imagePullPolicy: 'IfNotPresent',
  maxWorkflowSteps: 10,
  pluginWorkloadSdkEnabled: true,
} as unknown as WorkflowConfig

const CODEX_SPEC = {
  agent: { provider: 'codex-subscription', model: MODEL },
  pluginWorkloadSdk: { promptBridge: {} },
} as unknown as WorkflowRecipeSpec

function codexBinding(
  overrides: Partial<Omit<PluginWorkloadSdkCodexBindingProof, 'bindingHash'>> = {}
): PluginWorkloadSdkCodexBindingProof {
  const fields = {
    connectionKey: 'team-plus',
    catalogRevision: 4,
    credentialRevision: 2,
    model: MODEL,
    ...overrides,
  }
  return { ...fields, bindingHash: computeCodexPolicyHash(fields) }
}

const MINTED = codexBinding()

/** Build the one verdict the provisioner reads, from a case's intent. */
function verdictFor(opts: {
  codexBinding?: PluginWorkloadSdkCodexBindingProof | null
  codexBindingUndecidable?: boolean
}): CodexRecipeVerdict {
  const undecidable = opts.codexBindingUndecidable === true
  const binding = opts.codexBinding ?? null
  return {
    provenance: undecidable ? 'uncertain' : 'authoritative',
    provenanceReason: undecidable ? 'parent_spec_unavailable' : 'standalone',
    connectionKey: 'team-plus',
    projection: {
      targets: [],
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: null,
      catalogRevision: null,
      connectionRevision: null,
      eligibility: undecidable ? 'uncertain' : binding ? 'eligible' : 'ineligible',
      reason: undecidable ? 'provenance_uncertain' : binding ? 'eligible' : 'unassigned',
      driftHashInput: '{}',
    },
    hostBinding: binding,
    hostBindingReason: binding ? 'eligible' : 'unassigned',
  }
}

/** A v3 bootstrap body that survives parseEagerSdkBootstrapProof as policy-ready. */
function readyBootstrapBody(binding: PluginWorkloadSdkCodexBindingProof | null) {
  return {
    status: 202,
    body: {
      configured: true,
      ready: true,
      provider: 'codex-subscription',
      model: MODEL,
      contractVersion: 3,
      policyReady: true,
      policyState: 'active',
      policyRevision: 7,
      policyHash: 'b'.repeat(64),
      defaultTargetRef: 'target/codex',
      defaultProvider: 'codex-subscription',
      defaultModel: MODEL,
      ...(binding ? { codexBinding: binding } : {}),
    },
  }
}

function desiredRuntimeContractHash(): string {
  return pluginWorkloadSdkRuntimeContractHash(
    buildMcpHostPod(
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
  )
}

function makeHarness(configureResult: unknown) {
  let podUid = 'pod-uid-1'
  const runtimeContractHash = desiredRuntimeContractHash()
  const readNamespacedPod = vi.fn().mockImplementation(async () => ({
    metadata: {
      uid: podUid,
      annotations: {
        'clerum.io/plugin-workload-sdk-runtime-contract-hash': runtimeContractHash,
      },
    },
    spec: { containers: [{ name: 'mcp-host', image: IMAGE }] },
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

  // The provisioner now takes ONE verdict instead of a binding plus a
  // derived boolean. These helpers keep each existing case's semantics: a
  // minted binding means eligible+authoritative, and "undecidable" means the
  // projection itself could not decide.
  const reconcile = (opts: {
    codexBinding?: PluginWorkloadSdkCodexBindingProof | null
    codexBindingUndecidable?: boolean
  }) =>
    provisioner.ensureEagerSdkMcpHost(
      RECIPE,
      'recipe-uid',
      SANDBOX_NS,
      RECIPE,
      CODEX_SPEC,
      RUNTIME,
      {
        mcpHostPhase: 'Running',
        codexVerdict: verdictFor(opts),
      }
    )

  return {
    provisioner,
    reconcile,
    configure,
    deleteNamespacedPod,
    signWrcConfigureToken,
    setPodUid: (uid: string) => {
      podUid = uid
    },
  }
}

describe('eager Codex policy gate', () => {
  it('reports ready from a cached proof of the SAME pod when the snapshot goes unavailable', async () => {
    // The early-return's `ready` arm. It is only reachable with a proof already
    // cached from a readable-snapshot pass, so the proof is seeded by a real
    // configure round rather than reached into.
    const harness = makeHarness(readyBootstrapBody(MINTED))

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('ready')
    expect(harness.configure).toHaveBeenCalledTimes(1)
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({
      contractVersion: 3,
      podUid: 'pod-uid-1',
      policyReady: true,
      codexBinding: MINTED,
    })

    // ConfigMap read fails on the next pass: the live host still holds the
    // binding this same pod was configured with, so the recipe stays ready and
    // WRC must NOT re-broker with a binding it can no longer justify.
    expect(await harness.reconcile({ codexBindingUndecidable: true })).toBe('ready')
    expect(harness.configure).toHaveBeenCalledTimes(1)
  })

  it('discards a cached proof whose pod was replaced instead of reporting ready', async () => {
    // The proof is the pod's, not the recipe's. A replacement pod has
    // never been configured, so a snapshot outage must not let its predecessor's
    // proof stand in for it.
    const harness = makeHarness(readyBootstrapBody(MINTED))
    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('ready')

    harness.setPodUid('pod-uid-2')
    // Both spies carry the seeding round's call; clear so the assertions below
    // speak only about the pass that saw the replaced pod.
    harness.configure.mockClear()
    harness.signWrcConfigureToken.mockClear()

    expect(await harness.reconcile({ codexBindingUndecidable: true })).toBe('awaiting_policy')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toBeUndefined()
    expect(harness.configure).not.toHaveBeenCalled()
    expect(harness.signWrcConfigureToken).not.toHaveBeenCalled()
  })

  it('rejects a bootstrap that echoes a Codex binding other than the minted one', async () => {
    // A host answering with a different policy than the one WRC minted is
    // a broken host, not a pending policy. Three consecutive rounds exhaust the
    // configure budget and surface provider_unavailable.
    const harness = makeHarness(
      readyBootstrapBody(codexBinding({ credentialRevision: 99, connectionKey: 'team-plus' }))
    )

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toBeUndefined()
    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('provider_unavailable')
    expect(harness.configure).toHaveBeenCalledTimes(3)
  })

  it('rejects a bootstrap that drops the binding while WRC minted one', async () => {
    // Same defect from the other side: the host reports binding_missing for a
    // binding WRC did send. Accepting it would leave the recipe reporting a
    // pending policy forever while the real fault is the host.
    const harness = makeHarness({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'codex-subscription',
        model: MODEL,
        contractVersion: 3,
        policyState: 'binding_missing',
        policyReason: 'codex_execution_binding_missing',
      },
    })

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toBeUndefined()
  })

  it('accepts binding_missing as awaiting_policy when the grant really was revoked', async () => {
    // The revocation path must keep working: with a readable ConfigMap that
    // denies the grant, WRC configures WITHOUT a binding, the host clears its
    // own, and the recipe reports awaiting_policy — not a configure failure.
    const harness = makeHarness({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'codex-subscription',
        model: MODEL,
        contractVersion: 3,
        policyState: 'binding_missing',
        policyReason: 'codex_execution_binding_missing',
      },
    })

    expect(await harness.reconcile({ codexBinding: null, codexBindingUndecidable: false })).toBe(
      'awaiting_policy'
    )
    expect(harness.configure).toHaveBeenCalledWith(
      'codex-subscription',
      MODEL,
      expect.any(String),
      'configure-token',
      'promptBridge',
      null
    )
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({
      policyReady: false,
      policyReason: 'codex_execution_binding_missing',
    })
  })

  it('reports a pre-v3 mcp-host as a stale contract, not as an unavailable provider', async () => {
    // A host on an old image answers the Codex bootstrap with a v2 identity.
    // Charging that to the configure budget renders as "the configured provider
    // is unavailable" and sends the operator hunting a broker outage; the real
    // fix is an image bump.
    const harness = makeHarness({
      status: 502,
      body: {
        error: 'mcp_host bootstrap identity is not Plugin Workload SDK v3',
        policyReason: 'codex_bootstrap_contract_stale',
      },
    })

    for (let round = 0; round < 4; round += 1) {
      expect(await harness.reconcile({ codexBinding: MINTED })).toBe('awaiting_policy')
    }
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({
      contractVersion: 2,
      provider: 'codex-subscription',
      policyReady: false,
      policyReason: 'codex_bootstrap_contract_stale',
    })
  })

  it('never lets a cached stale-contract proof answer ready when the snapshot goes unavailable', async () => {
    // The stale-contract arm caches a proof so the CR can name the reason. That
    // proof then sits in exactly the slot the snapshot-outage early-return reads
    // to answer 'ready'. If it ever satisfied that check, a recipe on a pre-v3
    // image would report Validated the moment the ConfigMap blinked — issue
    // #533 with extra steps. Two independent fields keep it out (policyReady is
    // false AND contractVersion is not 3); this pins the outcome, not the path.
    const harness = makeHarness({
      status: 502,
      body: {
        error: 'mcp_host bootstrap identity is not Plugin Workload SDK v3',
        policyReason: 'codex_bootstrap_contract_stale',
      },
    })

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('awaiting_policy')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toMatchObject({ contractVersion: 2 })

    harness.configure.mockClear()
    expect(await harness.reconcile({ codexBindingUndecidable: true })).toBe('awaiting_policy')
    // The early-return short-circuits before configure either way, so the
    // status above is the whole assertion: 'ready' would be the regression.
    expect(harness.configure).not.toHaveBeenCalled()
  })

  it('still charges an ordinary bootstrap error to the configure budget', async () => {
    // Guard for the branch above: only the tagged stale-contract answer is
    // exempt. A plain 502 must keep converging on provider_unavailable.
    const harness = makeHarness({ status: 502, body: { error: 'mcp_host bootstrap failed' } })

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('provider_unavailable')
  })

  it('rejects a bootstrap whose binding is minted for a different model', async () => {
    // The echoed binding is well-formed and self-consistent, just not ours.
    // Without pinning the model, the five-field hash would verify and the proof
    // would be accepted for a model this host was never bootstrapped with.
    const harness = makeHarness(readyBootstrapBody(codexBinding({ model: 'gpt-5.1' })))

    expect(await harness.reconcile({ codexBinding: MINTED })).toBe('deploying')
    expect(harness.provisioner.getBootstrapProof(RECIPE)).toBeUndefined()
  })
})
