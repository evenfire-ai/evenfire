import { createHash } from 'node:crypto'
import type { WorkflowRecipeSpec, WorkflowSnippetRunSpec } from '../types'
import type { RecipeClassification } from './types'

const WORKFLOW_OUTPUT_PVC_SUFFIX = '-workflow-output'

export type WorkflowCoordinatorKind = 'none' | 'builtin' | 'custom'
export type WorkflowOutputClaimOwnership = 'none' | 'wrc-managed' | 'external'
export type WorkflowRuntimeComponent =
  | 'workflow-coordinator'
  | 'workflow-mcp-host'
  | 'workflow-artifact-reader'
  | 'workflow-snippet-runner'

export interface WorkflowRuntimePlanContext {
  recipeName: string
  runtimeScopeRecipeName?: string
  workflowRunId?: string
  /** When true, `spec.pluginWorkloadSdk` forces an always-on mcp-host even with no agentic steps. */
  pluginWorkloadSdkEnabled?: boolean
}

export type WorkflowOutputPlan =
  | {
      strategy: 'none'
      mountRequired: false
      artifactReaderRequired: false
      anchorRequired: false
      prepareRequired: false
      ensurePvc: false
      claimOwnership: 'none'
      workflowOutputScope: string
      claimName?: undefined
      subPath?: undefined
    }
  | {
      strategy: 'wrc-managed-pvc'
      mountRequired: true
      artifactReaderRequired: true
      anchorRequired: true
      prepareRequired: true
      ensurePvc: true
      claimOwnership: 'wrc-managed'
      workflowOutputScope: string
      claimName: string
      subPath: string
    }
  | {
      strategy: 'external-pvc'
      mountRequired: true
      artifactReaderRequired: true
      anchorRequired: true
      prepareRequired: false
      ensurePvc: false
      claimOwnership: 'external'
      workflowOutputScope: string
      claimName: string
      subPath: string
    }

export interface WorkflowRuntimePlan {
  classification: RecipeClassification
  coordinator: {
    kind: WorkflowCoordinatorKind
    imageOverride?: string
    requiresRuntimePod: boolean
    needsMcpHostEndpoint: boolean
    needsSnippetRunnerEndpoint: boolean
  }
  mcpHost: {
    required: boolean
    runtimeCredentialsRequired: boolean
  }
  snippetRunner: {
    required: boolean
  }
  artifactReader: {
    required: boolean
  }
  output: WorkflowOutputPlan
  tokens: {
    coordinator: {
      includeMcpHostToken: boolean
      includeSnippetRunnerToken: boolean
      useCustomCoordinatorWrcToken: boolean
    }
    mcpHostRuntimeSecretRequired: boolean
    triggerTokenSecretRequired: boolean
  }
  network: {
    includeMcpHost: boolean
    includeSnippetRunner: boolean
    includeArtifactReader: boolean
  }
  pods: {
    coordinator: {
      needsMcpHost: boolean
      needsSnippetRunner: boolean
      mountWorkflowOutput: boolean
      customCoordinator: boolean
      coordinatorImageOverride?: string
      workflowOutputClaimName?: string
      workflowOutputSubPath?: string
      workflowOutputScope?: string
    }
    mcpHost?: {
      mountWorkflowOutput: boolean
      workflowOutputClaimName?: string
      workflowOutputSubPath?: string
      workflowOutputScope?: string
    }
    artifactReader?: {
      workflowOutputClaimName: string
      workflowOutputSubPath: string
      workflowOutputScope: string
    }
    snippetRunner?: {
      mountWorkflowOutput: boolean
      workflowOutputClaimName?: string
      workflowOutputSubPath?: string
      workflowOutputScope?: string
    }
  }
  cleanup: {
    deleteBeforeTriggeredRun: WorkflowRuntimeComponent[]
    deleteAfterCoordinatorReplacement: WorkflowRuntimeComponent[]
  }
}

export function getCustomCoordinatorImage(spec: WorkflowRecipeSpec): string | undefined {
  const image = spec.coordinatorImage?.trim()
  return image ? image : undefined
}

export function isSnippetRun(
  run: WorkflowSnippetRunSpec | undefined
): run is WorkflowSnippetRunSpec {
  return (run as { type?: string } | undefined)?.type === 'snippet'
}

export function workflowStepUsesSnippetRunner(step: {
  run?: { type?: string } | undefined
}): boolean {
  return step.run?.type === 'snippet'
}

export function workflowStepNeedsMcpHost(
  step: {
    instruction?: unknown
    agent?: unknown
    mcpServers?: readonly unknown[] | undefined
    requiresApproval?: unknown
    run?: { type?: string } | undefined
  },
  options: { customCoordinator: boolean; hasWorkflowAgent?: boolean }
): boolean {
  if (Boolean(step.agent) || Boolean(step.requiresApproval)) return true
  if (!workflowStepUsesSnippetRunner(step) && Boolean(step.mcpServers?.length)) return true
  if (options.customCoordinator && options.hasWorkflowAgent && Boolean(step.instruction)) {
    return true
  }
  return !options.customCoordinator && Boolean(step.instruction)
}

export function hasSnippetSteps(spec: WorkflowRecipeSpec): boolean {
  return (spec.steps ?? []).some(step => workflowStepUsesSnippetRunner(step))
}

export function needsWorkflowMcpHost(spec: WorkflowRecipeSpec): boolean {
  const customCoordinator = getCustomCoordinatorImage(spec) !== undefined
  return (spec.steps ?? []).some(step =>
    workflowStepNeedsMcpHost(step, {
      customCoordinator,
      hasWorkflowAgent: Boolean(spec.agent),
    })
  )
}

export function classifyWorkflowRecipe(spec: WorkflowRecipeSpec): RecipeClassification {
  const steps = spec.steps ?? []
  if (steps.length === 0) return 'only-workloads'
  if (getCustomCoordinatorImage(spec)) return 'workflow-custom'
  if (steps.every(step => step.run)) return 'workflow-snippet'
  return 'workflow-agentic'
}

export function buildWorkflowOutputPvcName(recipeName: string): string {
  const direct = `${recipeName}${WORKFLOW_OUTPUT_PVC_SUFFIX}`
  if (direct.length <= 63) return direct
  const hash = createHash('sha256').update(recipeName).digest('hex').slice(0, 8)
  const maxStemLen = 63 - WORKFLOW_OUTPUT_PVC_SUFFIX.length - hash.length - 1
  const stem = recipeName.slice(0, Math.max(1, maxStemLen)).replace(/-+$/g, '')
  return `${stem || recipeName.slice(0, 1)}-${hash}${WORKFLOW_OUTPUT_PVC_SUFFIX}`
}

function safeWorkflowOutputSegment(value: string, fallback: string): string {
  const segment = value
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
  return segment || fallback
}

export function buildWorkflowOutputSubPath(
  runtimeScopeRecipeName: string,
  recipeName: string,
  runId?: string
): string {
  const runSegment = runId?.trim()
  if (runSegment) {
    return [
      'workflow-output',
      safeWorkflowOutputSegment(runtimeScopeRecipeName, recipeName),
      safeWorkflowOutputSegment(runSegment, recipeName),
    ].join('/')
  }
  return ['workflow-output', safeWorkflowOutputSegment(recipeName, 'workflow')].join('/')
}

function trimOutputClaimName(spec: WorkflowRecipeSpec): string | undefined {
  const claimName = spec.output?.claimName?.trim()
  return claimName || undefined
}

function deriveOutputPlan(
  spec: WorkflowRecipeSpec,
  runtimeScopeRecipeName: string,
  recipeName: string,
  workflowRunId: string | undefined,
  mountRequired: boolean
): WorkflowOutputPlan {
  if (!mountRequired) {
    return {
      strategy: 'none',
      mountRequired: false,
      artifactReaderRequired: false,
      anchorRequired: false,
      prepareRequired: false,
      ensurePvc: false,
      claimOwnership: 'none',
      workflowOutputScope: runtimeScopeRecipeName,
    }
  }

  const subPath = buildWorkflowOutputSubPath(runtimeScopeRecipeName, recipeName, workflowRunId)
  const explicitOutputClaimName = trimOutputClaimName(spec)
  if (explicitOutputClaimName) {
    return {
      strategy: 'external-pvc',
      mountRequired: true,
      artifactReaderRequired: true,
      anchorRequired: true,
      prepareRequired: false,
      ensurePvc: false,
      claimOwnership: 'external',
      workflowOutputScope: runtimeScopeRecipeName,
      claimName: explicitOutputClaimName,
      subPath,
    }
  }

  return {
    strategy: 'wrc-managed-pvc',
    mountRequired: true,
    artifactReaderRequired: true,
    anchorRequired: true,
    prepareRequired: true,
    ensurePvc: true,
    claimOwnership: 'wrc-managed',
    workflowOutputScope: runtimeScopeRecipeName,
    claimName: buildWorkflowOutputPvcName(runtimeScopeRecipeName),
    subPath,
  }
}

export function deriveWorkflowRuntimePlan(
  spec: WorkflowRecipeSpec,
  context: WorkflowRuntimePlanContext
): WorkflowRuntimePlan {
  const runtimeScopeRecipeName = context.runtimeScopeRecipeName ?? context.recipeName
  const classification = classifyWorkflowRecipe(spec)
  const coordinatorImageOverride = getCustomCoordinatorImage(spec)
  const coordinatorKind: WorkflowCoordinatorKind =
    classification === 'only-workloads' ? 'none' : coordinatorImageOverride ? 'custom' : 'builtin'
  const needsMcpHostForSteps = needsWorkflowMcpHost(spec)
  const needsMcpHostForSdk =
    context.pluginWorkloadSdkEnabled === true && Boolean(spec.pluginWorkloadSdk)
  const needsMcpHost = needsMcpHostForSteps || needsMcpHostForSdk
  const needsSnippetRunner = hasSnippetSteps(spec)
  const usesCustomCoordinator = coordinatorKind === 'custom'
  const outputMountRequired =
    classification !== 'only-workloads' &&
    (spec.output?.destination === 'pvc' ||
      (spec.output?.destination == null &&
        (needsSnippetRunner || needsMcpHost || usesCustomCoordinator)))
  const output = deriveOutputPlan(
    spec,
    runtimeScopeRecipeName,
    context.recipeName,
    context.workflowRunId,
    outputMountRequired
  )
  return {
    classification,
    coordinator: {
      kind: coordinatorKind,
      imageOverride: coordinatorImageOverride,
      requiresRuntimePod: classification !== 'only-workloads',
      needsMcpHostEndpoint: needsMcpHost,
      needsSnippetRunnerEndpoint: needsSnippetRunner,
    },
    mcpHost: {
      required: needsMcpHost,
      runtimeCredentialsRequired: needsMcpHost,
    },
    snippetRunner: {
      required: needsSnippetRunner,
    },
    artifactReader: {
      required: output.artifactReaderRequired,
    },
    output,
    tokens: {
      coordinator: {
        includeMcpHostToken: needsMcpHost,
        includeSnippetRunnerToken: needsSnippetRunner,
        useCustomCoordinatorWrcToken: usesCustomCoordinator,
      },
      mcpHostRuntimeSecretRequired: needsMcpHost,
      triggerTokenSecretRequired: classification !== 'only-workloads',
    },
    network: {
      includeMcpHost: needsMcpHost,
      includeSnippetRunner: needsSnippetRunner,
      includeArtifactReader: output.artifactReaderRequired,
    },
    pods: {
      coordinator: {
        needsMcpHost,
        needsSnippetRunner,
        mountWorkflowOutput: output.mountRequired,
        customCoordinator: usesCustomCoordinator,
        coordinatorImageOverride,
        workflowOutputClaimName: output.claimName,
        workflowOutputSubPath: output.subPath,
        workflowOutputScope: output.mountRequired ? output.workflowOutputScope : undefined,
      },
      mcpHost: needsMcpHost
        ? {
            mountWorkflowOutput: output.mountRequired,
            workflowOutputClaimName: output.claimName,
            workflowOutputSubPath: output.subPath,
            workflowOutputScope: output.mountRequired ? output.workflowOutputScope : undefined,
          }
        : undefined,
      artifactReader: output.artifactReaderRequired
        ? {
            workflowOutputClaimName: output.claimName,
            workflowOutputSubPath: output.subPath,
            workflowOutputScope: output.workflowOutputScope,
          }
        : undefined,
      snippetRunner: needsSnippetRunner
        ? {
            mountWorkflowOutput: output.mountRequired,
            workflowOutputClaimName: output.claimName,
            workflowOutputSubPath: output.subPath,
            workflowOutputScope: output.mountRequired ? output.workflowOutputScope : undefined,
          }
        : undefined,
    },
    cleanup: {
      deleteBeforeTriggeredRun: [
        'workflow-coordinator',
        ...(needsMcpHost ? (['workflow-mcp-host'] as const) : []),
      ],
      deleteAfterCoordinatorReplacement: [
        ...(needsMcpHost ? (['workflow-mcp-host'] as const) : []),
        ...(output.artifactReaderRequired ? (['workflow-artifact-reader'] as const) : []),
        ...(needsSnippetRunner ? (['workflow-snippet-runner'] as const) : []),
      ],
    },
  }
}
