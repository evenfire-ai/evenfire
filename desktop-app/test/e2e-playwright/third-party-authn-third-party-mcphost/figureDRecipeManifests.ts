import { WORKFLOW_RECIPE_NS } from '../workflow-approval-quadrants/constants'

type ModelConfig = {
  provider: string
  model: string
}

export function targetRecipeManifest(name: string, marker: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: WORKFLOW_RECIPE_NS, labels: { 'clerum.io/e2e': 'true' } },
    spec: {
      description:
        '3rd-party AuthN, 3rd-party MCP-Host target workflow triggered by a recipe runtime MCP-host after user DM approval.',
      inputContract: {
        type: 'object',
        properties: {
          marker: { type: 'string', default: marker },
        },
      },
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['autonomous'] } },
      runRetention: {
        maxRunDurationSeconds: 600,
        ttlSecondsAfterFinished: 7200,
      },
      output: {
        destination: 'pvc',
        name,
        format: 'json',
        storageSize: '64Mi',
      },
      steps: [
        {
          id: 'emit-figure-d-target-result',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const payload = {',
              '  figure: "D",',
              '  route: "3rd-party AuthN, 3rd-party MCP-Host",',
              '  marker: sdk.inputs.marker',
              '}',
              'const artifact = await sdk.artifacts.writeJson("figure-d-target-result.json", payload)',
              'return { ...payload, artifact }',
            ].join('\n'),
            capabilities: {
              artifacts: { maxCount: 1 },
            },
          },
        },
      ],
    },
  }
}

export function callerRecipeManifest(params: {
  name: string
  targetName: string
  approverUserId: string
  approvalMessage: string
  model: ModelConfig
}): Record<string, unknown> {
  const triggerArgs = {
    namespace: WORKFLOW_RECIPE_NS,
    name: params.targetName,
    targetUserId: params.approverUserId,
    approvalMessage: params.approvalMessage,
    timeoutSeconds: 240,
    inputs: { marker: params.targetName },
  }
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: params.name,
      namespace: WORKFLOW_RECIPE_NS,
      labels: { 'clerum.io/e2e': 'true' },
    },
    spec: {
      agent: { provider: params.model.provider, model: params.model.model },
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [
        {
          id: 'third-party-host-triggers-target',
          timeoutSeconds: 300,
          maxIterations: 3,
          toolChoice: 'required',
          allowedTools: { include: ['clerum__trigger_workflow'] },
          instruction: [
            'Call clerum__trigger_workflow exactly once with this JSON argument:',
            JSON.stringify(triggerArgs, null, 2),
            'After the tool returns, respond with FIGURE_D_TARGET_TRIGGERED.',
          ].join('\n'),
        },
      ],
    },
  }
}

export function stepApprovalRecipeManifest(params: {
  name: string
  approverUserId: string
  approvalMessage: string
  marker: string
  model: ModelConfig
}): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: params.name,
      namespace: WORKFLOW_RECIPE_NS,
      labels: { 'clerum.io/e2e': 'true' },
    },
    spec: {
      agent: { provider: params.model.provider, model: params.model.model },
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [
        {
          id: 'prepare-context',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: `return { marker: "${params.marker}", prepared: true }`,
          },
        },
        {
          id: 'approval-gated-step',
          dependsOn: ['prepare-context'],
          timeoutSeconds: 300,
          instruction: 'After approval, respond exactly with FIGURE_D_STEP_APPROVED.',
          requiresApproval: {
            target: { userId: params.approverUserId },
            message: params.approvalMessage,
            timeoutSeconds: 240,
          },
        },
        {
          id: 'finalize-after-approval',
          dependsOn: ['approval-gated-step'],
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: `return { marker: "${params.marker}", stepApprovalCompleted: true }`,
          },
        },
      ],
    },
  }
}
