import type { CodexExecutionProjection } from '@clerum/codex-catalog-projection'
import type { WorkflowRecipeSpec } from '../types'
import { resolveEagerSdkMcpHostAgent } from './agentResolution'
import type { CodexRecipeVerdict } from './codexRecipeVerdict'
import {
  buildMcpHostPod,
  declaredPluginWorkloadSdkCapabilities,
  pluginWorkloadSdkRuntimeContractHash,
  recipeDeclaresGrokSubscription,
} from './podFactory'
import type { WorkflowRuntimePlan } from './runtimePlan'
import type { WorkflowConfig } from './types'

export const EAGER_SDK_SANDBOX_NS = 'sandbox-recipes'
export const EAGER_SDK_TEST_IMAGE = 'registry.example/clerum/mcp-host-slim:sha-current'

export const EAGER_SDK_RUNTIME = {} as unknown as WorkflowRuntimePlan

export function eagerSdkTestConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    coordinatorImage: 'registry.example/coordinator:current',
    mcpHostImage: EAGER_SDK_TEST_IMAGE,
    wrcEndpoint: 'http://workflow-recipes.example',
    sandboxNamespace: EAGER_SDK_SANDBOX_NS,
    mcpServerNamespace: 'sandbox-mcp',
    imagePullPolicy: 'IfNotPresent',
    maxWorkflowSteps: 10,
    pluginWorkloadSdkEnabled: true,
    ...overrides,
  } as unknown as WorkflowConfig
}

export function ineligibleCodexProjection(): CodexExecutionProjection {
  return {
    targets: [],
    eligibleTargets: [],
    derivedScopes: [],
    requiresCodexProxyEgress: false,
    catalogContentHash: null,
    catalogRevision: null,
    connectionRevision: null,
    eligibility: 'ineligible',
    reason: 'unassigned',
    driftHashInput: '{}',
  }
}

export function ineligibleGrokProjection(): CodexRecipeVerdict['grokProjection'] {
  return {
    ...ineligibleCodexProjection(),
    reason: 'static_only',
    requiresGrokProxyEgress: false,
  }
}

/** Same buildMcpHostPod options the provisioner uses for the eager SDK pod. */
export function buildEagerSdkPolicyPod(input: {
  recipeName: string
  spec: WorkflowRecipeSpec
  config: WorkflowConfig
}) {
  const agent = resolveEagerSdkMcpHostAgent(input.spec)
  return buildMcpHostPod(
    input.recipeName,
    agent,
    input.config,
    input.recipeName,
    input.config.sandboxNamespace,
    undefined,
    undefined,
    undefined,
    {
      mountWorkflowOutput: false,
      pluginWorkloadSdkCapabilities: declaredPluginWorkloadSdkCapabilities(
        input.spec.pluginWorkloadSdk
      ),
      pluginWorkloadSdkRuntimeMode: 'sdk-only',
      grokSubscriptionEnabled: input.config.grokSubscriptionEnabled === true,
      recipeAgentProvider: agent?.provider,
      recipeDeclaresGrok: recipeDeclaresGrokSubscription(input.spec),
    }
  )
}

export function eagerSdkRuntimeContractHash(input: {
  recipeName: string
  spec: WorkflowRecipeSpec
  config: WorkflowConfig
}): string {
  return pluginWorkloadSdkRuntimeContractHash(buildEagerSdkPolicyPod(input))
}
