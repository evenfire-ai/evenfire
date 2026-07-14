import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeSpec } from '../../../src/types'
import {
  type NetworkPolicyConfig,
  buildWorkflowNetworkPolicies,
} from '../../../src/workflow/networkPolicyFactory'
import { buildCoordinatorPod, buildMcpHostPod } from '../../../src/workflow/podFactory'
import {
  buildWorkflowOutputPvcName,
  deriveWorkflowRuntimePlan,
} from '../../../src/workflow/runtimePlan'
import type { AgentSpec, WorkflowConfig } from '../../../src/workflow/types'

const workflowConfig: WorkflowConfig = {
  coordinatorImage: 'clerum/workflow-coordinator:test',
  mcpHostImage: 'clerum/mcp-host:test',
  wrcEndpoint: 'http://wrc:8082',
  sandboxNamespace: 'sandbox-recipes',
  mcpServerNamespace: 'mcp-server',
  imagePullPolicy: 'IfNotPresent',
  maxWorkflowSteps: 100,
  workflowDefaultRunDurationSeconds: 3600,
  workflowMaxRunDurationSeconds: 86_400,
  runtimeTokenTtlSeconds: 900,
  runtimeTokenRefreshBeforeSeconds: 300,
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
  workflowStatefulSetMaxReplicas: 20,
  workflowStatefulSetMaxVolumeClaimTemplates: 4,
  workflowStatefulSetMaxPvcPreflightChecks: 80,
}

const networkConfigBase: NetworkPolicyConfig = {
  recipeName: 'wf-runtime-plan',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8082,
  mcpHostPort: 8080,
  artifactReaderPort: 8080,
  snippetRunnerPort: 8095,
}

const agent: AgentSpec = {
  provider: 'openai',
  model: 'gpt-4o',
}

function snippetStep(id = 'snippet'): NonNullable<WorkflowRecipeSpec['steps']>[number] {
  return {
    id,
    run: {
      type: 'snippet',
      language: 'typescript',
      code: 'export default async () => ({ ok: true })',
    },
  }
}

describe('deriveWorkflowRuntimePlan', () => {
  it('derives only-workloads with no runtime pods, tokens, output, or policies', () => {
    const plan = deriveWorkflowRuntimePlan(
      { workloads: [{ id: 'api', image: 'example/api:test' }] },
      { recipeName: 'only-workloads' }
    )

    expect(plan.classification).toBe('only-workloads')
    expect(plan.coordinator.requiresRuntimePod).toBe(false)
    expect(plan.mcpHost.required).toBe(false)
    expect(plan.snippetRunner.required).toBe(false)
    expect(plan.artifactReader.required).toBe(false)
    expect(plan.output.strategy).toBe('none')
    expect(plan.tokens.triggerTokenSecretRequired).toBe(false)
    expect(plan.network).toEqual({
      includeMcpHost: false,
      includeSnippetRunner: false,
      includeArtifactReader: false,
    })
  })

  it('keeps deterministic custom coordinators independent from mcp-host', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        coordinatorImage: 'ghcr.io/acme/coordinator@sha256:' + 'a'.repeat(64),
        steps: [{ id: 'generate', instruction: 'Render deterministic artifacts' }],
      },
      { recipeName: 'custom-det', workflowRunId: 'run-1' }
    )

    expect(plan.classification).toBe('workflow-custom')
    expect(plan.coordinator.kind).toBe('custom')
    expect(plan.mcpHost.required).toBe(false)
    expect(plan.tokens.coordinator).toMatchObject({
      includeMcpHostToken: false,
      includeSnippetRunnerToken: false,
      useCustomCoordinatorWrcToken: true,
    })
    expect(plan.tokens.mcpHostRuntimeSecretRequired).toBe(false)
    expect(plan.tokens.triggerTokenSecretRequired).toBe(true)
    expect(plan.output).toMatchObject({
      strategy: 'wrc-managed-pvc',
      claimOwnership: 'wrc-managed',
      ensurePvc: true,
      prepareRequired: true,
      claimName: buildWorkflowOutputPvcName('custom-det'),
    })
    expect(plan.artifactReader.required).toBe(true)
    expect(plan.cleanup.deleteBeforeTriggeredRun).toEqual(['workflow-coordinator'])
    expect(plan.cleanup.deleteAfterCoordinatorReplacement).toEqual(['workflow-artifact-reader'])

    const pod = buildCoordinatorPod('custom-det', workflowConfig, plan.pods.coordinator)
    const envNames = new Set(pod.spec!.containers![0].env!.map(env => env.name))
    expect(envNames.has('MCP_HOST_ENDPOINT')).toBe(false)
    expect(envNames.has('CLERUM_MCPHOST_URL')).toBe(false)
    expect(pod.spec!.volumes!.some(volume => volume.name === 'recipe-output')).toBe(true)
  })

  it('derives broker-backed custom coordinators with mcp-host tokens and policies', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        coordinatorImage: 'ghcr.io/acme/coordinator@sha256:' + 'b'.repeat(64),
        agent,
        steps: [{ id: 'delegate', instruction: 'Use the broker', mcpServers: ['search'] }],
      },
      { recipeName: 'wf-runtime-plan', workflowRunId: 'run-1' }
    )

    expect(plan.classification).toBe('workflow-custom')
    expect(plan.coordinator.kind).toBe('custom')
    expect(plan.mcpHost.required).toBe(true)
    expect(plan.snippetRunner.required).toBe(false)
    expect(plan.tokens.coordinator).toMatchObject({
      includeMcpHostToken: true,
      includeSnippetRunnerToken: false,
      useCustomCoordinatorWrcToken: true,
    })
    expect(plan.tokens.mcpHostRuntimeSecretRequired).toBe(true)
    expect(plan.tokens.triggerTokenSecretRequired).toBe(true)

    const policies = buildWorkflowNetworkPolicies({ ...networkConfigBase, ...plan.network }, [
      'wf-runtime-plan-search',
    ])
    expect(policies.map(policy => policy.metadata!.name)).toEqual(
      expect.arrayContaining([
        'wf-runtime-plan-coord-to-mcp-host',
        'wf-runtime-plan-mcp-host-to-servers',
        'wf-runtime-plan-wrc-to-artifact-reader',
      ])
    )

    const mcpHostPod = buildMcpHostPod(
      'wf-runtime-plan',
      agent,
      workflowConfig,
      'wf-runtime-plan',
      'sandbox-recipes',
      plan.pods.mcpHost!.workflowOutputClaimName,
      plan.pods.mcpHost!.workflowOutputSubPath,
      undefined,
      {
        mountWorkflowOutput: plan.pods.mcpHost!.mountWorkflowOutput,
        workflowOutputScope: plan.pods.mcpHost!.workflowOutputScope,
      }
    )
    expect(mcpHostPod.spec!.volumes!.some(volume => volume.name === 'recipe-output')).toBe(true)
  })

  it('derives snippet workflows without confusing snippet runner and custom coordinator', () => {
    const plan = deriveWorkflowRuntimePlan(
      { steps: [snippetStep()], output: { destination: 'pvc', storageSize: '128Mi' } },
      {
        recipeName: 'snippet-child',
        runtimeScopeRecipeName: 'snippet-parent',
        workflowRunId: 'run-123',
      }
    )

    expect(plan.classification).toBe('workflow-snippet')
    expect(plan.coordinator.kind).toBe('builtin')
    expect(plan.mcpHost.required).toBe(false)
    expect(plan.snippetRunner.required).toBe(true)
    expect(plan.tokens.coordinator).toMatchObject({
      includeMcpHostToken: false,
      includeSnippetRunnerToken: true,
      useCustomCoordinatorWrcToken: false,
    })
    expect(plan.tokens.mcpHostRuntimeSecretRequired).toBe(false)
    expect(plan.tokens.triggerTokenSecretRequired).toBe(true)
    expect(plan.output).toMatchObject({
      strategy: 'wrc-managed-pvc',
      claimOwnership: 'wrc-managed',
      ensurePvc: true,
      prepareRequired: true,
      claimName: buildWorkflowOutputPvcName('snippet-parent'),
      subPath: 'workflow-output/snippet-parent/run-123',
    })
    expect(plan.pods.snippetRunner).toMatchObject({
      mountWorkflowOutput: true,
      workflowOutputClaimName: buildWorkflowOutputPvcName('snippet-parent'),
      workflowOutputScope: 'snippet-parent',
    })
    expect(plan.cleanup.deleteBeforeTriggeredRun).toEqual(['workflow-coordinator'])
    expect(plan.cleanup.deleteAfterCoordinatorReplacement).toEqual([
      'workflow-artifact-reader',
      'workflow-snippet-runner',
    ])
  })

  it('derives agentic workflows with mcp-host and artifact reader from one plan', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        agent,
        steps: [{ id: 'draft', instruction: 'Draft a report' }],
      },
      { recipeName: 'agentic', workflowRunId: 'run-1' }
    )

    expect(plan.classification).toBe('workflow-agentic')
    expect(plan.coordinator.kind).toBe('builtin')
    expect(plan.mcpHost.required).toBe(true)
    expect(plan.snippetRunner.required).toBe(false)
    expect(plan.artifactReader.required).toBe(true)
    expect(plan.output.strategy).toBe('wrc-managed-pvc')
    expect(plan.cleanup.deleteAfterCoordinatorReplacement).toEqual([
      'workflow-mcp-host',
      'workflow-artifact-reader',
    ])
  })

  it('does not invent PVC artifact resources for explicit non-PVC output', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        agent,
        output: { destination: 'stdout' },
        steps: [{ id: 'draft', instruction: 'Draft a report' }],
      },
      { recipeName: 'stdout-agentic', workflowRunId: 'run-1' }
    )

    expect(plan.output.strategy).toBe('none')
    expect(plan.output.mountRequired).toBe(false)
    expect(plan.artifactReader.required).toBe(false)
    expect(plan.network.includeArtifactReader).toBe(false)
    expect(plan.pods.mcpHost).toMatchObject({ mountWorkflowOutput: false })

    const mcpHostPod = buildMcpHostPod(
      'stdout-agentic',
      agent,
      workflowConfig,
      'stdout-agentic',
      'sandbox-recipes',
      plan.pods.mcpHost!.workflowOutputClaimName,
      plan.pods.mcpHost!.workflowOutputSubPath,
      undefined,
      { mountWorkflowOutput: plan.pods.mcpHost!.mountWorkflowOutput }
    )
    expect(mcpHostPod.spec!.volumes!.map(volume => volume.name)).not.toContain('recipe-output')
  })

  it('derives operator-owned external PVC output without WRC PVC ownership', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        agent,
        output: { destination: 'pvc', claimName: 'operator-output' },
        steps: [{ id: 'draft', instruction: 'Draft a report' }],
      },
      {
        recipeName: 'external-agentic',
        runtimeScopeRecipeName: 'parent-wf',
        workflowRunId: 'run-1',
      }
    )

    expect(plan.output).toMatchObject({
      strategy: 'external-pvc',
      claimOwnership: 'external',
      ensurePvc: false,
      prepareRequired: false,
      anchorRequired: true,
      claimName: 'operator-output',
      workflowOutputScope: 'parent-wf',
      subPath: 'workflow-output/parent-wf/run-1',
    })
    expect(plan.artifactReader.required).toBe(true)
    expect(plan.pods.coordinator.workflowOutputClaimName).toBe('operator-output')
    expect(plan.pods.mcpHost).toMatchObject({
      mountWorkflowOutput: true,
      workflowOutputClaimName: 'operator-output',
      workflowOutputScope: 'parent-wf',
    })
  })

  it('requires mcp-host for pluginWorkloadSdk even without agentic steps', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        agent,
        workloads: [{ id: 'sdk-caller', type: 'deployment', image: 'caller:test' }],
        pluginWorkloadSdk: {
          promptBridge: {},
          allowedCallers: ['sdk-caller'],
        },
      },
      { recipeName: 'sdk-only', pluginWorkloadSdkEnabled: true }
    )

    expect(plan.classification).toBe('only-workloads')
    expect(plan.mcpHost.required).toBe(true)
    expect(plan.network.includeMcpHost).toBe(true)
    expect(plan.tokens.mcpHostRuntimeSecretRequired).toBe(true)
    expect(plan.pods.mcpHost).toMatchObject({ mountWorkflowOutput: false })
  })

  it('does not require mcp-host for pluginWorkloadSdk when the feature flag is off', () => {
    const plan = deriveWorkflowRuntimePlan(
      {
        workloads: [{ id: 'sdk-caller', type: 'deployment', image: 'caller:test' }],
        pluginWorkloadSdk: {
          clientNotifications: { allowedEventTypes: ['ping'] },
          allowedCallers: ['sdk-caller'],
        },
      },
      { recipeName: 'sdk-flag-off', pluginWorkloadSdkEnabled: false }
    )

    expect(plan.mcpHost.required).toBe(false)
    expect(plan.network.includeMcpHost).toBe(false)
  })
})
