import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRecipeSpec } from '../types'
import { WorkflowReconciler, type WorkflowReconcilerDeps } from './workflowReconciler'

/*
 * A-RP-007 / C-RP-011: WRC_GROK_SUBSCRIPTION_ENABLED must gate every piece of
 * derived Grok runtime state together — the `llm:grok:execute` control scope,
 * the `<recipe>-mcp-host-to-grok-proxy` egress policy and the mcp-host pod
 * env — even when Control API's allowlist annotation says the grant is
 * eligible. With the switch on, the eligible path is unchanged.
 */

const crashRecoveryMocks = vi.hoisted(() => ({
  deletePodIfExists: vi.fn().mockResolvedValue(undefined),
  waitForPodDeletion: vi.fn().mockResolvedValue(true),
  evaluateCompletedRuntimePodRecovery: vi.fn().mockReturnValue({
    action: 'replace',
    message:
      'mcp_host pod completed before workflow became terminal; creating replacement (attempt 1/3)',
    newPhase: 'recovering',
    newAttempt: 1,
  }),
  evaluateCrashRecovery: vi.fn().mockReturnValue({ action: 'none', message: 'Pod is healthy' }),
  getContainerWaitingReason: vi.fn().mockResolvedValue(undefined),
  getPodPhase: vi.fn().mockResolvedValue(undefined),
  getPodReadiness: vi.fn().mockResolvedValue({ ready: true, phase: 'Running', uid: 'pod-uid-1' }),
  isRecoverableContainerWaitingReason: vi.fn(() => false),
}))

const runtimeTokenIssuerMocks = vi.hoisted(() => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'runtime-access-token',
    refreshToken: 'runtime-refresh-token',
    mcpHostControlToken: 'mcp-host-control-token',
  }),
  issueMcpHostWorkflowControlToken: vi.fn().mockResolvedValue('mcp-host-control-token'),
}))

vi.mock('./crashRecovery', () => crashRecoveryMocks)
vi.mock('./mcpHostRuntimeTokenIssuerClient', () => runtimeTokenIssuerMocks)

vi.mock('../gfsBinding', () => ({
  mintRecipeHostGfsToken: vi.fn().mockResolvedValue({
    ['to'.concat('ken')]: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:3rd:sandbox-recipes/codex-recipe',
  }),
}))

const sandboxNamespace = 'sandbox-recipes'
const RECIPE = 'grok-recipe'
const GROK_PROXY_POLICY = `${RECIPE}-mcp-host-to-grok-proxy`
const GROK_MODEL = 'grok-4.6'
const GROK_GRANT = 'team-grok'

function eligibleGrokConfigMap() {
  return {
    metadata: {
      resourceVersion: '1',
      annotations: {
        'clerum.io/content-hash': 'aa',
        'clerum.io/grok-enabled': 'true',
        'clerum.io/grok-connection-status': 'connected',
        'clerum.io/grok-connections': JSON.stringify({
          [GROK_GRANT]: {
            status: 'connected',
            catalogRevision: 5,
            connectionRevision: 2,
            models: [GROK_MODEL],
          },
        }),
      },
    },
    data: {
      'grok-subscription': JSON.stringify([{ model: GROK_MODEL }]),
    },
  }
}

function createHarness(grokSubscriptionEnabled: boolean, pluginWorkloadSdkEnabled = false) {
  const mockCoreApi = {
    readNamespacedPod: vi.fn().mockImplementation(async (params: { name?: string }) => {
      if (typeof params.name === 'string' && params.name.endsWith('-mcp-host')) {
        return {
          metadata: {
            labels: { 'clerum.io/workflow-output-claim': 'shared-output' },
          },
        }
      }
      return {}
    }),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedEndpoints: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedConfigMap: vi.fn().mockResolvedValue(eligibleGrokConfigMap()),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    createNamespacedPod: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
      metadata: { name: 'existing-workflow-output', deletionTimestamp: undefined },
    }),
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  }
  const mockNetworkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
  const mockCustomApi = {
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  const deps = {
    coreApi: mockCoreApi,
    customApi: mockCustomApi,
    networkingApi: mockNetworkingApi,
    config: {
      coordinatorImage: 'coordinator:test',
      mcpHostImage: 'mcp-host:test',
      wrcEndpoint: 'http://wrc.example/api',
      sandboxNamespace,
      mcpServerNamespace: 'mcp-server',
      imagePullPolicy: 'IfNotPresent' as const,
      maxWorkflowSteps: 100,
      runtimeTokenTtlSeconds: 3600,
      runtimeTokenRefreshBeforeSeconds: 300,
      grokSubscriptionEnabled,
      pluginWorkloadSdkEnabled,
    },
    tokenFactory: {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('stub-token'),
      signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('coordinator-mcp-host-token'),
      signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('custom-coordinator-wrc-token'),
      signCoordinatorToWrcToken: vi.fn().mockResolvedValue('coordinator-wrc-token'),
    },
    pluginWorkloadSdkRevocationClient: {
      revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
      finalize: vi.fn(),
    },
  } as unknown as WorkflowReconcilerDeps
  return {
    reconciler: new WorkflowReconciler(deps),
    coreApi: mockCoreApi,
    networkingApi: mockNetworkingApi,
  }
}

async function reconcileRecipe(reconciler: WorkflowReconciler, spec: WorkflowRecipeSpec) {
  crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
    if (name.endsWith('-workflow-output-anchor')) return 'Running'
    if (name.endsWith('-workflow-output-prepare')) return 'Succeeded'
    return undefined
  })
  crashRecoveryMocks.getPodReadiness.mockResolvedValue({ ready: false, phase: 'Pending' })
  return reconciler.reconcile(
    RECIPE,
    `uid-${RECIPE}`,
    sandboxNamespace,
    spec,
    { workflowExecution: { phase: 'initializing' } },
    undefined,
    RECIPE,
    'run-1'
  )
}

function bindGrokGrant(reconciler: WorkflowReconciler) {
  reconciler.setCodexReconcileContext({
    recipeUid: `uid-${RECIPE}`,
    recipeName: RECIPE,
    runtimeScopeRecipeName: RECIPE,
    claimedParent: false,
    parentSpec: null,
    connectionKey: 'unassigned',
    grokConnectionKey: GROK_GRANT,
  })
}

function issuedScopes(): string[] {
  const last = runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mock.calls.at(-1)
  return (last?.[2] ?? []) as string[]
}

type PolicyCall = [{ body?: { metadata?: { name?: string } } }]

function createdPolicyNames(networkingApi: ReturnType<typeof createHarness>['networkingApi']) {
  return (networkingApi.createNamespacedNetworkPolicy.mock.calls as PolicyCall[]).map(
    call => call[0]?.body?.metadata?.name
  )
}

type PodCall = [
  {
    body?: {
      metadata?: { name?: string }
      spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> }
    }
  },
]

function mcpHostEnvNames(coreApi: ReturnType<typeof createHarness>['coreApi']): string[] {
  const pod = (coreApi.createNamespacedPod.mock.calls as PodCall[])
    .map(call => call[0]?.body)
    .find(body => body?.metadata?.name === `${RECIPE}-mcp-host`)
  expect(pod).toBeDefined()
  return (pod?.spec?.containers?.[0]?.env ?? []).map(env => env.name)
}

const ordinaryGrokSpec = (): WorkflowRecipeSpec => ({
  agent: { provider: 'grok-subscription', model: GROK_MODEL },
  steps: [{ id: 'brief', instruction: 'write the brief' }],
})

const stepLevelGrokSpec = (): WorkflowRecipeSpec => ({
  agent: { provider: 'openai', model: 'gpt-4o' },
  steps: [
    {
      id: 'brief',
      instruction: 'write the brief',
      agent: { provider: 'grok-subscription', model: GROK_MODEL },
    },
  ],
})

describe('WorkflowReconciler Grok WRC switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockResolvedValue({
      accessToken: 'runtime-access-token',
      refreshToken: 'runtime-refresh-token',
      mcpHostControlToken: 'mcp-host-control-token',
    })
  })

  for (const grokSubscriptionEnabled of [false, true]) {
    it(`hands the SDK-only provisioner a Grok verdict that follows the WRC flag (${grokSubscriptionEnabled ? 'on' : 'off'})`, async () => {
      const { reconciler } = createHarness(grokSubscriptionEnabled, true)
      bindGrokGrant(reconciler)
      const provisioner = (
        reconciler as unknown as {
          pluginWorkloadSdkProvisioner: { ensureEagerSdkMcpHost: (...args: unknown[]) => unknown }
        }
      ).pluginWorkloadSdkProvisioner
      const ensure = vi.spyOn(provisioner, 'ensureEagerSdkMcpHost').mockResolvedValue('deploying')

      await reconciler.reconcilePluginWorkloadSdkOnly(RECIPE, `uid-${RECIPE}`, sandboxNamespace, {
        agent: { provider: 'grok-subscription', model: GROK_MODEL },
        pluginWorkloadSdk: { promptBridge: {} },
      } as unknown as WorkflowRecipeSpec)

      expect(ensure).toHaveBeenCalledTimes(1)
      const { codexVerdict } = ensure.mock.calls[0][6] as {
        codexVerdict: {
          grokBinding: unknown
          grokProjection: { derivedScopes: string[]; requiresGrokProxyEgress: boolean }
        }
      }
      if (grokSubscriptionEnabled) {
        expect(codexVerdict.grokBinding).not.toBeNull()
        expect(codexVerdict.grokProjection.derivedScopes).toEqual(['llm:grok:execute'])
        expect(codexVerdict.grokProjection.requiresGrokProxyEgress).toBe(true)
      } else {
        expect(codexVerdict.grokBinding).toBeNull()
        expect(codexVerdict.grokProjection.derivedScopes).toEqual([])
        expect(codexVerdict.grokProjection.requiresGrokProxyEgress).toBe(false)
      }
    })
  }

  for (const [shape, spec] of [
    ['ordinary', ordinaryGrokSpec],
    ['step-level', stepLevelGrokSpec],
  ] as const) {
    it(`withholds Grok scope, proxy egress and pod env for a ${shape} recipe when the WRC flag is off`, async () => {
      const { reconciler, coreApi, networkingApi } = createHarness(false)
      bindGrokGrant(reconciler)

      await reconcileRecipe(reconciler, spec())

      expect(runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens).toHaveBeenCalled()
      expect(issuedScopes()).not.toContain('llm:grok:execute')
      expect(createdPolicyNames(networkingApi)).not.toContain(GROK_PROXY_POLICY)
      expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: GROK_PROXY_POLICY })
      )
      const env = mcpHostEnvNames(coreApi)
      expect(env).not.toContain('MCP_HOST_GROK_SUBSCRIPTION_ENABLED')
      expect(env).not.toContain('GROK_LLM_PROXY_RUNTIME_URL')
    })

    it(`keeps Grok scope, proxy egress and pod env for a ${shape} recipe when the WRC flag is on`, async () => {
      const { reconciler, coreApi, networkingApi } = createHarness(true)
      bindGrokGrant(reconciler)

      await reconcileRecipe(reconciler, spec())

      expect(issuedScopes()).toContain('llm:grok:execute')
      expect(createdPolicyNames(networkingApi)).toContain(GROK_PROXY_POLICY)
      const env = mcpHostEnvNames(coreApi)
      expect(env).toContain('MCP_HOST_GROK_SUBSCRIPTION_ENABLED')
      expect(env).toContain('GROK_LLM_PROXY_RUNTIME_URL')
    })
  }
})
