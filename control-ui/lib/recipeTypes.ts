'use client'

export const ALLOWED_WORKLOAD_TYPES = [
  'deployment',
  'statefulset',
  'cronjob',
  'job',
  'daemonset',
] as const
export type WorkloadType = (typeof ALLOWED_WORKLOAD_TYPES)[number]

export type WorkflowRecipeWorkload = {
  id: string
  type: WorkloadType
  image: string
  port?: number
  transport?: { type: string; path?: string }
  env?: Array<{ name: string; value?: string }>
  command?: string[]
  args?: string[]
  security?: {
    runAsUser?: number
    runAsGroup?: number
    fsGroup?: number
    addCapabilities?: string[]
  }
  resources?: {
    requests?: { cpu?: string; memory?: string }
    limits?: { cpu?: string; memory?: string }
  }
  volumeMounts?: Array<{ name: string; mountPath: string }>
  volumeClaimTemplates?: Array<{
    name: string
    storageClass?: string
    accessMode?: string
    size: string
  }>
  dependsOn?: string[]
  envSecret?: {
    name: string
    keys: Array<{ secretKey: string; envVar: string }>
  }
  egressBindings?: Array<{
    egressClass?: 'exact-host' | 'public-web'
    dns?: string
    port?: number
    protocol?: 'TCP' | 'UDP'
  }>
}

export type WorkflowRecipeStepRun = {
  type: 'snippet'
  language: 'typescript'
  code: string
  capabilities?: Record<string, unknown>
}

type WorkflowRecipeStepBase = {
  id: string
  dependsOn?: string[]
  mcpServers?: string[]
  agent?: { provider?: string; model?: string }
  timeoutSeconds?: number
  backoffSeconds?: number
  maxIterations?: number
  requiresApproval?: {
    target: { userId?: string; teamId?: string }
    message: string
    timeoutSeconds?: number
  }
}

export type WorkflowRecipeStep =
  | (WorkflowRecipeStepBase & { instruction: string; run?: never })
  | (WorkflowRecipeStepBase & { instruction?: never; run: WorkflowRecipeStepRun })
  | (WorkflowRecipeStepBase & { instruction?: never; run?: never })

export type WorkflowRecipeMcpServerRef = {
  id: string
  endpoint: string
}

export type WorkflowRecipeBinding = {
  from: string
  to: string
  port: number
  protocol?: 'TCP' | 'UDP'
}

export type WorkflowTriggerOnDemand = {
  requiresApproval?: boolean
  allowedActors?: Array<'user' | 'autonomous' | 'scheduled'>
}

export type WorkflowTriggerSchedule = {
  cron: string
  timezone?: string
  concurrencyPolicy?: 'Forbid' | 'Replace' | 'Allow'
  suspend?: boolean
  registeredUserId?: string
}

export type WorkflowTriggers = {
  onDemand?: WorkflowTriggerOnDemand
  schedule?: WorkflowTriggerSchedule
}

export type WorkflowRunRetention = {
  successfulHistoryLimit?: number
  failedHistoryLimit?: number
  ttlSecondsAfterFinished?: number
  maxRunDurationSeconds?: number
}

export type WorkflowRecipeDeclaredResource = {
  id: string
  type: 'pvc' | 'secret' | 'configmap' | string
  data?: Record<string, string>
  generateKeys?: string[]
}

export type WorkflowRecipeSpec = {
  contextRef?: string
  coordinatorImage?: string
  workloads?: WorkflowRecipeWorkload[]
  runtimeEgress?: {
    http?: {
      egressClass?: 'exact-host' | 'public-web'
      allowedHosts?: string[]
    }
  }
  resources?: WorkflowRecipeDeclaredResource[]
  steps?: WorkflowRecipeStep[]
  mcpServers?: WorkflowRecipeMcpServerRef[]
  agent?: {
    provider?: string
    model?: string
    secretRef?: Record<string, unknown>
    soulRef?: Record<string, unknown>
  }
  // Recipe-level security posture. Matches the CRD schema
  // (charts/clerum-crds/crds/workflowrecipe.yaml :: spec.security).
  // Typed explicitly so callers like `checkPolicyL1` in RecipeEditor can
  // read `spec.security?.allowContextRef` without unsafe `as` casts.
  security?: {
    isolationLevel?: 'minimal' | 'standard' | 'strict'
    allowContextRef?: boolean
  }
  output?: {
    name?: string
    destination?: 'configmap' | 'secret' | 'stdout' | 'pvc'
    namespace?: string
    format?: 'pdf' | 'xlsx' | 'json' | 'text' | 'html' | 'multi'
    storageSize?: string
  }
  inputs?: Record<string, unknown>
  inputContract?: Record<string, unknown>
  activeProfile?: string
  profiles?: Record<string, Record<string, unknown>>
  computed?: Array<{ name: string; expression: string }>
  networkBindings?: Array<{ workloadId: string; targetContextRef: string }>
  bindings?: WorkflowRecipeBinding[]
  triggers?: WorkflowTriggers
  runRetention?: WorkflowRunRetention
}

export type WorkflowRecipeResource = {
  apiVersion?: string
  kind?: string
  metadata?: { name: string; namespace?: string; creationTimestamp?: string }
  spec?: WorkflowRecipeSpec
  status?: {
    phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
    workloads?: Array<{ id: string; ready: boolean; replicas?: number }>
    message?: string
  }
}

export type OperatorDefaults = {
  security: {
    allowedCapabilities: string[]
    maxRunAsUser: number
    requireNonRoot: boolean
  }
  storage: {
    defaultStorageClass: string
    defaultAccessMode: string
    maxPvcSizeGi: number
    outputPath: string
  }
  resources: {
    defaultCpuRequest: string
    defaultMemoryRequest: string
    defaultCpuLimit: string
    defaultMemoryLimit: string
  }
  namespaces: {
    mcpWorkloads: string
    nonMcpWorkloads: string
  }
  registry: {
    prefix: string
    imagePullSecrets: string[]
  }
}

export type ValidationIssue = {
  phase: 'parse' | 'schema' | 'security'
  severity: 'error' | 'warning' | 'info'
  path: string
  message: string
}

export type ValidationResult = {
  valid: boolean
  issues: ValidationIssue[]
  parsed?: WorkflowRecipeResource
}

export type EnrichmentDiff = {
  path: string
  before: unknown
  after: unknown
  reason: string
}

export type EnrichmentResult = {
  enriched: WorkflowRecipeSpec
  diffs: EnrichmentDiff[]
}
