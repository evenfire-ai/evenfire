/**
 * Workflow Reconciler — handles recipes with `spec.steps[]`.
 *
 * Orchestrates the creation of:
 * - Coordinator Pod + mcp_host Pod (Two-Pod Model)
 * - JWT Secrets for inter-component auth
 * - SOUL.md ConfigMap from object storage
 * - Workflow config ConfigMap
 * - Headless Service for mcp_host DNS
 * - NetworkPolicies for inter-Pod communication
 */
import * as k8s from '@kubernetes/client-node'
import { decodeJwt } from 'jose'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { Pool } from 'pg'
import {
  hasInvalidDigest,
  hasLatestTag,
  hasUnsafeImageReferenceSyntax,
  hasValidSha256Digest,
  matchesAllowedImagePrefix,
} from '@clerum/image-policy'
import { mintRecipeHostGfsToken } from '../gfsBinding'
import { createLogger } from '../observability/logger'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants'
import { getErrorCode, isRetryableInfraError } from '../reconciler/k8sErrors'
import {
  resolveStatefulSetHeadlessServiceName,
  resolveWorkloadMcpServerLabel,
  resolveWorkloadRuntimeResourceName,
} from '../reconciler/resourceBuilder'
import { classifySecretAccess } from '../reconciler/secretOwnership'
import { effectiveWorkflowContextRefForSpec } from '../reconciler/workflowContext'
import type {
  StatusCondition,
  WorkflowRecipeGfsScope,
  WorkflowRecipeSpec,
  WorkflowSnippetRunSpec,
} from '../types'
import { resolveMcpHostAgent } from './agentResolution'
import {
  type PodReadiness,
  deletePodIfExists,
  evaluateCompletedRuntimePodRecovery,
  evaluateCrashRecovery,
  getContainerWaitingReason,
  getPodPhase,
  getPodReadiness,
  isRecoverableContainerWaitingReason,
} from './crashRecovery'
import { JwtTokenFactory } from './jwtTokenFactory'
import {
  type WorkflowControlScope,
  issueMcpHostRuntimeTokens,
  issueMcpHostWorkflowControlToken,
} from './mcpHostRuntimeTokenIssuerClient'
import type { ModelConfigHandler } from './modelConfigHandler'
import { NetworkPolicyConfig, buildWorkflowNetworkPolicies } from './networkPolicyFactory'
import { ObjectStorageClient, StorageCredentials, StorageRef } from './objectStorageClient'
import { PluginWorkloadSdkProvisioner } from './pluginWorkloadSdkProvisioner'
import {
  type SnippetRunnerSecretAlias,
  WORKFLOW_OUTPUT_CLAIM_LABEL,
  WORKFLOW_OUTPUT_SCOPE_LABEL,
  buildArtifactReaderHeadlessService,
  buildArtifactReaderPod,
  buildCoordinatorPod,
  buildMcpHostHeadlessService,
  buildMcpHostPod,
  buildMcpHostRouteAliasHeadlessService,
  buildSnippetRunnerHeadlessService,
  buildSnippetRunnerPod,
  buildWorkflowOutputAnchorPod,
  buildWorkflowOutputAnchorPodName,
  buildWorkflowOutputPreparePod,
  buildWorkflowOutputPreparePodName,
  workflowOutputLabelValue,
} from './podFactory'
import {
  buildArtifactReaderServiceName,
  buildArtifactReaderUrl,
  buildMcpHostRouteAliasServiceName,
  buildMcpHostServiceName,
  buildMcpHostUrl,
  buildPluginWorkloadSdkTokenSecretName,
  buildSnippetRunnerServiceName,
} from './resourceNames'
import {
  CUSTOM_COORDINATOR_ACTIVE_DEADLINE_BUFFER_SECONDS,
  DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_STEP_TIMEOUT_SECONDS,
  MAX_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS,
  WORKFLOW_OUTPUT_PVC_NAME,
} from './runtimeConstants'
import {
  isAllowedRuntimeHttpEgressCidr,
  resolveRuntimeHttpEgressCidrs,
} from './runtimeEgressResolver'
import type { RuntimeHttpEgressResolver } from './runtimeEgressResolver'
import {
  type WorkflowRuntimeComponent,
  type WorkflowRuntimePlan,
  buildWorkflowOutputPvcName,
  deriveWorkflowRuntimePlan,
  getCustomCoordinatorImage,
  hasSnippetSteps,
  isSnippetRun,
  needsWorkflowMcpHost,
} from './runtimePlan'
import {
  type SchedulingRecipe,
  WORKFLOW_TEAM_ID_LABEL,
  deleteScheduling,
  reconcileScheduling,
} from './schedulingHandler'
import { buildMcpHostRuntimeTokenSecret, createCoordinatorTokens } from './secretFactory'
import { SNIPPET_RUN_KEYS } from './snippetRunSchema'
import {
  CyclicDependencyError,
  UnknownDependencyError,
  buildExecutionGroups,
} from './stepDependencyGraph'
import {
  AgentSpec,
  RecipeClassification,
  StepStatus,
  WorkflowConfig,
  WorkflowExecutionStatus,
  WorkflowPhase,
} from './types'
import { validateWorkflowRecipeLimits } from './workflowLimits'

const DEFAULT_WORKFLOW_OUTPUT_STORAGE_SIZE = '256Mi'
const WORKFLOW_OUTPUT_PVC_DELETE_WAIT_MS = 30_000
const WORKFLOW_OUTPUT_PVC_DELETE_POLL_MS = 1_000
const MAX_WORKFLOW_OUTPUT_PREPARE_ATTEMPTS = 3
const MIN_RUNTIME_TOKEN_FILE_REFRESH_LEAD_SECONDS = 75
const RUNTIME_TOKEN_REFRESH_EXPIRY_SAFETY_SECONDS = 5
const MAX_SNIPPET_CODE_LENGTH = 20_000
const SNIPPET_SECRET_ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX = 'admin-ui/'
const DEFAULT_RUNTIME_HTTP_EGRESS_DNS_OVERLAP_SECONDS = 5 * 60
const MAX_RUNTIME_HTTP_EGRESS_ALLOWED_HOSTS = 20
const MAX_RUNTIME_HTTP_EGRESS_POLICY_CIDRS = 64
const RUNTIME_HTTP_EGRESS_CURRENT_CIDRS_ANNOTATION = 'clerum.io/runtime-http-egress-current-cidrs'
const RUNTIME_HTTP_EGRESS_PREVIOUS_CIDRS_ANNOTATION = 'clerum.io/runtime-http-egress-previous-cidrs'
const RUNTIME_HTTP_EGRESS_PREVIOUS_EXPIRES_AT_ANNOTATION =
  'clerum.io/runtime-http-egress-previous-expires-at'
const RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION =
  'clerum.io/runtime-http-egress-previous-cidr-expiries'
const RUNTIME_HTTP_EGRESS_RESOLVED_AT_ANNOTATION = 'clerum.io/runtime-http-egress-resolved-at'
const MCP_HOST_READINESS_WAIT_TIMEOUT_MS = 4 * 60_000
const DNS_SUBDOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const WORKFLOW_OUTPUT_EXTERNAL_CLAIM_LABEL = 'clerum.io/workflow-output-external'

type ExternalWorkflowOutputPvcState =
  | 'ready'
  | 'terminating'
  | 'missing'
  | 'wrc-managed-conflict'
  | 'unauthorized'

export const WORKFLOW_OUTPUT_CONDITION_TYPES = new Set([
  'WorkflowOutputRwoCompatibility',
  'WorkflowOutputWrcManagedLifecycle',
  'WorkflowOutputPrepareGate',
  'WorkflowOutputExternalClaim',
  'WorkflowOutputLegacyGlobalClaim',
])

interface CoordinatorTokenRefreshOptions {
  includeMcpHostToken?: boolean
  useCustomCoordinatorWrcToken?: boolean
  includeSnippetRunnerToken?: boolean
  gfsToken?: string
  gfsSubject?: string
  gfsScopes?: WorkflowRecipeGfsScope[]
}

interface RuntimeHttpEgressPolicyState {
  currentCidrs: string[]
  effectiveCidrs: string[]
  annotations: Record<string, string>
}

type PublicHttpEgressClass = 'exact-host' | 'public-web'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeCidrs(cidrs: string[]): string[] {
  return [...new Set(cidrs.map(cidr => cidr.trim()).filter(Boolean))].sort()
}

function serializeCidrs(cidrs: string[]): string {
  return normalizeCidrs(cidrs).join(',')
}

function parseCidrsAnnotation(value: string | undefined): string[] {
  if (!value) return []
  return normalizeCidrs(value.split(','))
}

function parseTrustedRuntimeHttpEgressCidrsAnnotation(value: string | undefined): string[] {
  return parseCidrsAnnotation(value).filter(isAllowedRuntimeHttpEgressCidr)
}

function serializeRuntimeHttpEgressCidrExpiries(expiries: Map<string, Date>): string {
  const ordered = [...expiries.entries()]
    .filter(([cidr]) => isAllowedRuntimeHttpEgressCidr(cidr))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cidr, expiresAt]) => [cidr, expiresAt.toISOString()])
  return JSON.stringify(Object.fromEntries(ordered))
}

function parseTrustedRuntimeHttpEgressCidrExpiriesAnnotation(
  value: string | undefined,
  now: Date,
  maxFutureMs?: number
): Map<string, Date> {
  const expiries = new Map<string, Date>()
  if (!value) return expiries
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return expiries
    for (const [cidr, expiresAtText] of Object.entries(parsed)) {
      if (!isAllowedRuntimeHttpEgressCidr(cidr) || typeof expiresAtText !== 'string') continue
      const expiresAt = parseFutureDate(expiresAtText, now, maxFutureMs)
      if (expiresAt) expiries.set(cidr, expiresAt)
    }
  } catch {
    return expiries
  }
  return expiries
}

function parseFutureDate(
  value: string | undefined,
  now: Date,
  maxFutureMs?: number
): Date | undefined {
  if (!value) return undefined
  const parsedMs = Date.parse(value)
  if (!Number.isFinite(parsedMs)) return undefined
  if (maxFutureMs !== undefined && parsedMs > now.getTime() + maxFutureMs) return undefined
  const parsed = new Date(parsedMs)
  return parsed.getTime() > now.getTime() ? parsed : undefined
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const parsedMs = Date.parse(value)
  return Number.isFinite(parsedMs) ? new Date(parsedMs) : undefined
}

function latestDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

function addRuntimeHttpEgressPreviousExpiry(
  expiries: Map<string, Date>,
  cidr: string,
  expiresAt: Date
): void {
  if (!isAllowedRuntimeHttpEgressCidr(cidr)) return
  const existing = expiries.get(cidr)
  if (!existing || expiresAt.getTime() > existing.getTime()) {
    expiries.set(cidr, expiresAt)
  }
}

const GFS_SCOPE_ORDER: WorkflowRecipeGfsScope[] = [
  'gfs.read',
  'gfs.write',
  'gfs.delete',
  'gfs.manage_acl',
  'gfs.share',
]

const WORKFLOW_CONTROL_SCOPE_ORDER: WorkflowControlScope[] = [
  'workflow:list',
  'workflow:read',
  'workflow:trigger',
  'workflow:approval:resolve',
  'workflow:approval:decide',
  'plugin-workload-sdk',
]

function orderedScopesEqual<T extends string>(actual: T[], expected: T[]): boolean {
  if (actual.length !== expected.length) return false
  return actual.every((scope, index) => scope === expected[index])
}

function workflowControlScopesEqual(
  actual: WorkflowControlScope[],
  expected: WorkflowControlScope[]
): boolean {
  return orderedScopesEqual(actual, expected)
}

function gfsScopesEqual(
  actual: WorkflowRecipeGfsScope[],
  expected: WorkflowRecipeGfsScope[]
): boolean {
  return orderedScopesEqual(actual, expected)
}

function workflowHasGfsPublishTargets(spec: WorkflowRecipeSpec): boolean {
  return (spec.gfs?.publishTargets ?? []).length > 0
}

function deriveRecipeHostGfsScopes(spec: WorkflowRecipeSpec): WorkflowRecipeGfsScope[] {
  // Workflow/plugin hosts get a read ceiling by default so operators can grant
  // readable GFS inputs after install without requiring a recipe spec rewrite.
  // The database-backed GFS grant store remains the authority; this token scope
  // only caps what a host may use if a matching grant exists.
  const scopes = new Set<WorkflowRecipeGfsScope>(['gfs.read'])
  if ((spec.gfs?.publishTargets ?? []).length > 0) {
    scopes.add('gfs.write')
  }
  for (const mount of spec.gfs?.mounts ?? []) {
    for (const scope of mount.scopes ?? []) {
      if ((GFS_SCOPE_ORDER as string[]).includes(scope)) {
        scopes.add(scope)
      }
    }
  }
  return GFS_SCOPE_ORDER.filter(scope => scopes.has(scope))
}

function deriveWorkflowControlScopes(
  spec: WorkflowRecipeSpec,
  opts: { pluginWorkloadSdkEnabled?: boolean } = {}
): WorkflowControlScope[] {
  const scopes = new Set<WorkflowControlScope>()
  // Plugin Workload SDK (plan §3.6): only recipes that declare the
  // capability — and only while the feature flag is on — receive the scope
  // the control-api authorizer requires (scope_denied otherwise).
  if (opts.pluginWorkloadSdkEnabled && spec.pluginWorkloadSdk) {
    scopes.add('plugin-workload-sdk')
  }
  for (const step of spec.steps ?? []) {
    // Workflow broker privileges are security boundaries, so derive scopes only
    // from explicitly named tools. Wildcards/globs remain fail-closed.
    for (const tool of step.allowedTools?.include ?? []) {
      if (tool === 'clerum__list_workflows' || tool === 'workflow_list') {
        scopes.add('workflow:list')
      }
      if (
        tool === 'clerum__read_workflow' ||
        tool === 'workflow_status' ||
        tool === 'workflow_health'
      ) {
        scopes.add('workflow:read')
      }
      if (tool === 'clerum__trigger_workflow' || tool === 'workflow_trigger') {
        scopes.add('workflow:trigger')
        scopes.add('workflow:approval:resolve')
        scopes.add('workflow:approval:decide')
      }
    }
    if (step.requiresApproval) {
      scopes.add('workflow:approval:resolve')
      scopes.add('workflow:approval:decide')
    }
  }
  return WORKFLOW_CONTROL_SCOPE_ORDER.filter(scope => scopes.has(scope))
}

function hasCompleteAgent(
  agent: AgentSpec | { provider?: string; model?: string } | undefined
): boolean {
  return Boolean(agent?.provider && agent.model)
}

function requestedCustomCoordinatorActiveDeadlineSeconds(spec: WorkflowRecipeSpec): number {
  const steps = spec.steps ?? []
  if (steps.length === 0) return DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS

  const declaredTimeouts = steps.reduce((sum, step) => {
    const timeout = Number.isInteger(step.timeoutSeconds)
      ? Math.max(1, step.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS)
      : DEFAULT_STEP_TIMEOUT_SECONDS
    return sum + timeout
  }, 0)

  return Math.max(
    DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS,
    declaredTimeouts + CUSTOM_COORDINATOR_ACTIVE_DEADLINE_BUFFER_SECONDS
  )
}

function resolveCustomCoordinatorActiveDeadlineSeconds(spec: WorkflowRecipeSpec): number {
  return Math.min(
    requestedCustomCoordinatorActiveDeadlineSeconds(spec),
    MAX_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS
  )
}

function validateCustomCoordinatorRuntimePolicy(spec: WorkflowRecipeSpec): string | undefined {
  const requestedDeadline = requestedCustomCoordinatorActiveDeadlineSeconds(spec)
  if (requestedDeadline > MAX_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS) {
    return (
      'custom coordinator step timeouts exceed the maximum active deadline ' +
      `of ${MAX_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS}s`
    )
  }
  return undefined
}

function resolveSnippetSecretRefName(
  spec: WorkflowRecipeSpec,
  secretName: string,
  resourceInstances?: Record<string, string>
): string {
  const resourceIds = new Set((spec.resources ?? []).map(resource => resource.id))
  if (!resourceIds.has(secretName)) return secretName
  return resourceInstances?.[secretName] ?? secretName
}

function collectSnippetSecretAliases(
  spec: WorkflowRecipeSpec,
  resourceInstances?: Record<string, string>
): SnippetRunnerSecretAlias[] {
  const byAlias = new Map<string, SnippetRunnerSecretAlias>()
  for (const step of spec.steps ?? []) {
    if (!isSnippetRun(step.run)) continue
    for (const item of step.run.capabilities?.secrets ?? []) {
      const existing = byAlias.get(item.alias)
      const next = {
        alias: item.alias,
        secretName: resolveSnippetSecretRefName(spec, item.secretRef.name, resourceInstances),
        secretKey: item.secretRef.key,
      }
      if (
        existing &&
        (existing.secretName !== next.secretName || existing.secretKey !== next.secretKey)
      ) {
        throw new Error(`snippet secret alias "${item.alias}" maps to multiple secret refs`)
      }
      byAlias.set(item.alias, next)
    }
  }
  return [...byAlias.values()]
}

function collectSnippetSecretRefs(
  spec: WorkflowRecipeSpec,
  resourceInstances?: Record<string, string>
): SnippetRunnerSecretAlias[] {
  const byRef = new Map<string, SnippetRunnerSecretAlias>()
  for (const item of collectSnippetSecretAliases(spec, resourceInstances)) {
    byRef.set(`${item.secretName}/${item.secretKey}`, item)
  }
  return [...byRef.values()]
}

function collectSnippetMcpServerIds(spec: WorkflowRecipeSpec): string[] {
  const ids = new Set<string>()
  for (const step of spec.steps ?? []) {
    if (!isSnippetRun(step.run)) continue
    for (const server of step.run.capabilities?.mcp?.servers ?? []) ids.add(server)
  }
  return [...ids]
}

function collectSnippetDatabaseWorkloadIds(spec: WorkflowRecipeSpec): string[] {
  const ids = new Set<string>()
  for (const step of spec.steps ?? []) {
    if (!isSnippetRun(step.run)) continue
    for (const workload of step.run.capabilities?.mongo?.workloads ?? []) ids.add(workload)
    for (const workload of step.run.capabilities?.postgres?.workloads ?? []) ids.add(workload)
  }
  return [...ids]
}

function hasSnippetPublicHttpEgress(spec: WorkflowRecipeSpec): boolean {
  // NetworkPolicy is pod-scoped. Per-step host enforcement remains in the snippet SDK.
  const egressClass = runtimeHttpEgressClass(spec)
  if (egressClass === 'public-web') {
    return (spec.steps ?? []).some(
      step => isSnippetRun(step.run) && step.run.capabilities?.http?.egressClass === 'public-web'
    )
  }
  return Boolean(
    spec.runtimeEgress?.http?.allowedHosts?.length &&
    (spec.steps ?? []).some(
      step => isSnippetRun(step.run) && Boolean(step.run.capabilities?.http?.allowedHosts?.length)
    )
  )
}

function hasCustomCoordinatorPublicHttpEgress(spec: WorkflowRecipeSpec): boolean {
  if (!spec.coordinatorImage?.trim()) return false
  return runtimeHttpEgressClass(spec) === 'public-web'
    ? spec.runtimeEgress?.http?.egressClass === 'public-web'
    : Boolean(spec.runtimeEgress?.http?.allowedHosts?.length)
}

function runtimeHttpEgressClass(spec: WorkflowRecipeSpec): PublicHttpEgressClass {
  return spec.runtimeEgress?.http?.egressClass === 'public-web' ? 'public-web' : 'exact-host'
}

function validatePublicHttpHost(host: string): string | undefined {
  if (host !== host.trim()) return `HTTP egress host "${host}" must not include whitespace`
  if (host.length < 1 || host.length > 253) return `HTTP egress host "${host}" length is invalid`
  if (host !== host.toLowerCase()) return `HTTP egress host "${host}" must be lowercase`
  if (host.includes('*')) return `HTTP egress host "${host}" must not contain wildcards`
  if (host.includes('/') || host.includes(':')) {
    return `HTTP egress host "${host}" must be a hostname, not a URL or host:port`
  }
  if (isIP(host) !== 0) return `HTTP egress host "${host}" must not be an IP literal`
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.svc') ||
    host.endsWith('.cluster.local') ||
    host === 'kubernetes.default' ||
    host === 'metadata.goog'
  ) {
    return `HTTP egress host "${host}" must be a public DNS hostname`
  }
  if (!host.includes('.')) return `HTTP egress host "${host}" must be a public DNS hostname`
  const labels = host.split('.')
  if (labels.some(label => label.length === 0 || label.length > 63)) {
    return `HTTP egress host "${host}" has an invalid DNS label`
  }
  if (labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    return `HTTP egress host "${host}" must be a DNS hostname`
  }
  return undefined
}

function validateRuntimeEgressPolicy(spec: WorkflowRecipeSpec): string | undefined {
  const egressClass = spec.runtimeEgress?.http?.egressClass ?? 'exact-host'
  if (egressClass !== 'exact-host' && egressClass !== 'public-web') {
    return `runtimeEgress.http.egressClass must be exact-host or public-web`
  }
  const hosts = spec.runtimeEgress?.http?.allowedHosts ?? []
  if (egressClass === 'public-web') {
    if (hosts.length > 0) {
      return `runtimeEgress.http.allowedHosts must be omitted when egressClass is public-web`
    }
    return undefined
  }
  if (hosts.length > MAX_RUNTIME_HTTP_EGRESS_ALLOWED_HOSTS) {
    return `runtimeEgress.http.allowedHosts must contain at most ${MAX_RUNTIME_HTTP_EGRESS_ALLOWED_HOSTS} hosts`
  }
  const seen = new Set<string>()
  for (const host of hosts) {
    const error = validatePublicHttpHost(host)
    if (error) return error
    if (seen.has(host)) return `HTTP egress host "${host}" is duplicated`
    seen.add(host)
  }
  return undefined
}

async function readCoordinatorRuntimeIfExists(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<{ image?: string; tier?: string } | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace })
    return {
      image: pod.spec?.containers?.[0]?.image,
      tier: pod.metadata?.labels?.['clerum.io/coordinator-tier'],
    }
  } catch (error: unknown) {
    if (getErrorCode(error) === 404) return undefined
    throw error
  }
}

/**
 * Resolve `clerum.io/mcpserver` pod-label values for NetworkPolicy selection.
 * Workflow workload-spawned servers use their runtime-safe label value;
 * external McpServer CRDs use the endpoint hostname.
 */
export function resolveMcpServerFullNames(
  recipeName: string,
  mcpServers: Array<{ id: string; endpoint?: string }> | undefined,
  workloadIdsWithTransport?: ReadonlySet<string>,
  workloadMcpServerLabels?: ReadonlyMap<string, string>
): string[] {
  const workloadIds = workloadIdsWithTransport ?? new Set<string>()
  return (mcpServers ?? []).map(s => {
    // Workload-spawned: pod label follows resourceBuilder and must stay
    // Kubernetes-label-safe for child recipes with long parent names.
    if (workloadIds.has(s.id)) {
      return workloadMcpServerLabels?.get(s.id) ?? `${recipeName}-${s.id}`
    }
    // External McpServer CRD: pod label equals the endpoint hostname (McpServer.metadata.name).
    if (s.endpoint) {
      const m = s.endpoint.match(/^https?:\/\/([^.:/]+)/)
      return m ? m[1] : s.id
    }
    // Legacy fallback (no endpoint, not a workload): use `{recipeName}-{id}`.
    return `${recipeName}-${s.id}`
  })
}

export interface WorkflowReconcileResult {
  phase: string
  message: string
  workflowPhase?: WorkflowPhase
  clearWorkflowExecution?: boolean
  workflowConditions?: StatusCondition[]
  /**
   * Set when a transient K8s API blip aborted reconcile: the caller must NOT
   * patch the CRD status (preserve the current execution state) and should
   * requeue. Propagated up through WRC's ReconcileResult.
   */
  skipStatusPatch?: boolean
}

function mcpHostReadinessMessage(readiness: PodReadiness): string {
  const details = [`phase=${readiness.phase ?? 'missing'}`]
  if (readiness.waitingReason) details.push(`waiting=${readiness.waitingReason}`)
  if (readiness.schedulingReason) details.push(`scheduling=${readiness.schedulingReason}`)
  return `Waiting for mcp-host pod to become Ready (${details.join(', ')})`
}

function workflowOutputPrepareWaitMessage(podName: string, readiness: PodReadiness): string {
  const details = [`phase=${readiness.phase ?? 'missing'}`]
  if (readiness.waitingReason) details.push(`waiting=${readiness.waitingReason}`)
  if (readiness.schedulingReason) details.push(`scheduling=${readiness.schedulingReason}`)
  return `Waiting for workflow output prepare pod "${podName}" to complete before starting runtime pods (${details.join(', ')})`
}

function workflowOutputAnchorWaitMessage(podName: string, readiness: PodReadiness): string {
  const details = [`phase=${readiness.phase ?? 'missing'}`]
  if (readiness.waitingReason) details.push(`waiting=${readiness.waitingReason}`)
  if (readiness.schedulingReason) details.push(`scheduling=${readiness.schedulingReason}`)
  return `Waiting for workflow output anchor pod "${podName}" to mount the output PVC before starting prepare/runtime pods (${details.join(', ')})`
}

function workflowPhaseForMcpHostReadinessWait(
  execution: WorkflowExecutionStatus | undefined
): WorkflowPhase {
  return execution?.phase === 'recovering' ? 'recovering' : 'initializing'
}

function hasMcpHostReadinessWaitExpired(
  execution: WorkflowExecutionStatus | undefined,
  nowMs = Date.now()
): boolean {
  if (!execution?.startedAt) return false

  const startedAtMs = Date.parse(execution.startedAt)
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs >= MCP_HOST_READINESS_WAIT_TIMEOUT_MS
}

function trimOutputClaimName(spec: WorkflowRecipeSpec | undefined): string | undefined {
  const claimName = spec?.output?.claimName?.trim()
  return claimName || undefined
}

function buildStatusCondition(
  type: string,
  reason: string,
  message: string,
  lastTransitionTime: string
): StatusCondition {
  return { type, status: 'True', reason, message, lastTransitionTime }
}

function buildWorkflowOutputConditions(
  runtime: WorkflowRuntimePlan,
  now: string,
  existingConditions?: StatusCondition[]
): StatusCondition[] {
  const output = runtime.output
  if (!output.mountRequired) return []

  const transitionTime = (type: string): string =>
    existingConditions?.find(c => c.type === type && c.status === 'True')?.lastTransitionTime ?? now

  const conditions: StatusCondition[] = [
    buildStatusCondition(
      'WorkflowOutputRwoCompatibility',
      'RwoOutputClaimCoLocation',
      `Workflow output claim "${output.claimName}" uses RWO compatibility mode: concurrent runs for this recipe are scheduled with required pod affinity to one node.`,
      transitionTime('WorkflowOutputRwoCompatibility')
    ),
  ]

  if (output.claimOwnership === 'wrc-managed') {
    conditions.push(
      buildStatusCondition(
        'WorkflowOutputWrcManagedLifecycle',
        'WrcManagedOutputClaim',
        `WRC manages workflow output PVC "${output.claimName}". Deleting the parent WorkflowRecipe deletes PVC-backed artifact bytes while DB run history remains.`,
        transitionTime('WorkflowOutputWrcManagedLifecycle')
      )
    )
    conditions.push(
      buildStatusCondition(
        'WorkflowOutputPrepareGate',
        'RunScopedOutputPrepared',
        `WRC prepares run-scoped workflow output directories on "${output.claimName}" before starting runtime pods so non-root workflow containers can write artifacts.`,
        transitionTime('WorkflowOutputPrepareGate')
      )
    )
  } else {
    conditions.push(
      buildStatusCondition(
        'WorkflowOutputExternalClaim',
        'ExternalOutputClaim',
        `WorkflowRecipe output reuses existing PVC "${output.claimName}". WRC will not create, resize, or delete this claim.`,
        transitionTime('WorkflowOutputExternalClaim')
      )
    )
  }

  if (output.claimName === WORKFLOW_OUTPUT_PVC_NAME) {
    conditions.push(
      buildStatusCondition(
        'WorkflowOutputLegacyGlobalClaim',
        'LegacyGlobalOutputClaim',
        `Workflow output is using legacy global PVC "${WORKFLOW_OUTPUT_PVC_NAME}". On GKE RWO this is a compatibility path, not the target state.`,
        transitionTime('WorkflowOutputLegacyGlobalClaim')
      )
    )
  }

  return conditions
}

function isPreCoordinatorWorkflowPhase(execution: WorkflowExecutionStatus | undefined): boolean {
  const phase = execution?.phase
  return !phase || phase === 'pending' || phase === 'initializing' || phase === 'recovering'
}

function evaluateWorkflowOutputPrepareRecovery(
  currentExecution: WorkflowExecutionStatus | undefined
):
  | { action: 'replace'; message: string; newAttempt: number }
  | { action: 'fail'; message: string } {
  const attempt = currentExecution?.attempt ?? 0
  if (attempt >= MAX_WORKFLOW_OUTPUT_PREPARE_ATTEMPTS) {
    return {
      action: 'fail',
      message: `Workflow output prepare pod failed after ${MAX_WORKFLOW_OUTPUT_PREPARE_ATTEMPTS} recovery attempts`,
    }
  }
  return {
    action: 'replace',
    message: `Workflow output prepare pod failed before runtime pod startup; recreating it (attempt ${attempt + 1}/${MAX_WORKFLOW_OUTPUT_PREPARE_ATTEMPTS})`,
    newAttempt: attempt + 1,
  }
}

// Re-export canonical CRD type for consumers (tests, etc.)
export type { WorkflowRecipeSpec } from '../types'

export interface WorkflowReconcilerDeps {
  coreApi: k8s.CoreV1Api
  customApi: k8s.CustomObjectsApi
  networkingApi: k8s.NetworkingV1Api
  /**
   * Postgres pool used by the DB-backed scheduling handler. Optional so unit
   * tests that don't touch `spec.scheduling` can omit it — tests that exercise
   * the scheduling path provide a mock.
   */
  pgPool?: Pool
  config: WorkflowConfig
  tokenFactory: JwtTokenFactory
  resolveRuntimeHttpEgressCidrs?: RuntimeHttpEgressResolver
  /**
   * WRC-side Secret Broker used to POST /configure to a recipe mcp-host with
   * the provider API key. Optional so unit tests and dev mode can omit it;
   * the Plugin Workload SDK eager-configure path no-ops without it (the
   * mcp-host stays unconfigured until a triggered run injects a model).
   */
  modelConfigHandler?: ModelConfigHandler
}

export class WorkflowReconciler {
  private readonly log = createLogger('wrc', 'reconciler')
  private readonly pluginWorkloadSdkProvisioner: PluginWorkloadSdkProvisioner

  constructor(private readonly deps: WorkflowReconcilerDeps) {
    this.pluginWorkloadSdkProvisioner = new PluginWorkloadSdkProvisioner({
      coreApi: deps.coreApi,
      config: deps.config,
      tokenFactory: deps.tokenFactory,
      modelConfigHandler: deps.modelConfigHandler,
      log: this.log,
      ensureMcpHostSecrets: (namespace, recipeName, runtimeScopeRecipeName, spec) =>
        this.ensureMcpHostSecrets(namespace, recipeName, runtimeScopeRecipeName, spec),
      applyWorkflowNetworkPolicies: (
        recipeName,
        recipeUid,
        spec,
        runtime,
        awaitsTriggeredRun,
        eagerSdkMcpHost
      ) =>
        this.applyWorkflowNetworkPolicies(
          recipeName,
          recipeUid,
          spec,
          runtime,
          awaitsTriggeredRun,
          eagerSdkMcpHost
        ),
      ensureMcpHostHeadlessService: recipeName => this.ensureMcpHostHeadlessService(recipeName),
      createIfNotExists: (createFn, label) => this.createIfNotExists(createFn, label),
      safeDelete: deleteFn => this.safeDelete(deleteFn),
    })
  }

  private get runtimeTokenRefreshBeforeSeconds(): number {
    return this.deps.config.runtimeTokenRefreshBeforeSeconds
  }

  private get runtimeTokenFileRefreshBeforeSeconds(): number {
    const maxLead = Math.max(
      1,
      this.deps.config.runtimeTokenTtlSeconds - RUNTIME_TOKEN_REFRESH_EXPIRY_SAFETY_SECONDS
    )
    return Math.min(
      maxLead,
      Math.max(this.runtimeTokenRefreshBeforeSeconds, MIN_RUNTIME_TOKEN_FILE_REFRESH_LEAD_SECONDS)
    )
  }

  validateWorkflowSpec(spec: WorkflowRecipeSpec): string | undefined {
    const maxWorkflowSteps = this.deps.config.maxWorkflowSteps
    const stepCount = spec.steps?.length ?? 0
    if (stepCount > maxWorkflowSteps) {
      return `WorkflowRecipe has ${stepCount} steps, exceeding WRC_MAX_WORKFLOW_STEPS=${maxWorkflowSteps}`
    }
    const validationError = this.validateExecutableSteps(spec)
    if (validationError) return validationError
    const outputValidationError = this.validateWorkflowOutputSpec(spec)
    if (outputValidationError) return outputValidationError
    const runtimeEgressPolicyError = validateRuntimeEgressPolicy(spec)
    if (runtimeEgressPolicyError) return runtimeEgressPolicyError
    const coordinatorImageOverride = getCustomCoordinatorImage(spec)
    const imagePolicyError = this.validateCustomCoordinatorImagePolicy(coordinatorImageOverride)
    if (imagePolicyError) return imagePolicyError
    if (coordinatorImageOverride) {
      const runtimePolicyError = validateCustomCoordinatorRuntimePolicy(spec)
      if (runtimePolicyError) return runtimePolicyError
    }
    if (hasSnippetSteps(spec) && this.deps.config.enableSnippetRuntime === false) {
      return 'snippet workflow runtime is disabled'
    }
    return undefined
  }

  async reconcile(
    recipeName: string,
    recipeUid: string,
    namespace: string,
    spec: WorkflowRecipeSpec,
    currentStatus?: {
      workflowExecution?: WorkflowExecutionStatus
      steps?: StepStatus[]
      conditions?: StatusCondition[]
      resourceInstances?: Record<string, string>
    },
    resolvedInputs?: Record<string, unknown>,
    runtimeScopeRecipeName = recipeName,
    workflowRunId?: string,
    workflowTeamId?: string,
    workflowActorId?: string,
    workflowActorType?: string
  ): Promise<WorkflowReconcileResult> {
    const preflightError = this.validateWorkflowSpec(spec)
    if (preflightError) return { phase: 'failed', message: preflightError, workflowPhase: 'failed' }
    const secretPreflightError = await this.validateSnippetSecretRefs(
      recipeName,
      spec,
      currentStatus?.resourceInstances
    )
    if (secretPreflightError) {
      return { phase: 'failed', message: secretPreflightError, workflowPhase: 'failed' }
    }
    const runtime = deriveWorkflowRuntimePlan(spec, {
      recipeName,
      runtimeScopeRecipeName,
      workflowRunId: workflowRunId?.trim(),
      pluginWorkloadSdkEnabled: this.deps.config.pluginWorkloadSdkEnabled,
    })
    const classification = runtime.classification
    const needsMcpHost = runtime.mcpHost.required
    const needsSnippetRunner = runtime.snippetRunner.required
    const usesCustomCoordinator = runtime.coordinator.kind === 'custom'
    const needsArtifactReader = runtime.artifactReader.required
    const workflowOutputClaimOwnership = runtime.output.claimOwnership
    const workflowOutputClaimName = runtime.output.mountRequired ? runtime.output.claimName : ''
    const workflowOutputSubPath = runtime.output.mountRequired ? runtime.output.subPath : ''
    const desiredCoordinatorImage =
      runtime.coordinator.imageOverride ?? this.deps.config.coordinatorImage
    const workflowRunIdValue = workflowRunId?.trim()
    const workflowActorIdValue = workflowActorId?.trim()
    const workflowUsageUserId =
      workflowActorType === 'user'
        ? workflowActorIdValue
        : workflowActorType === 'admin' && workflowActorIdValue
          ? `${CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX}${workflowActorIdValue}`
          : undefined
    // eagerMcpHostForSdk: no run is triggered yet, but the recipe declares
    // pluginWorkloadSdk, so the mcp-host must be always-on to host the SDK
    // server (:8099). ONLY the mcp-host starts; the coordinator and run-scoped
    // pods still defer — the coordinator requires a CLERUM_WORKFLOW_RUN_ID and
    // crashes without one.
    const hasPluginWorkloadSdk =
      this.deps.config.pluginWorkloadSdkEnabled && !!spec.pluginWorkloadSdk
    const awaitsTriggeredRun = needsMcpHost && !workflowRunIdValue
    const eagerMcpHostForSdk = hasPluginWorkloadSdk && !workflowRunIdValue
    const workflowConditions = buildWorkflowOutputConditions(
      runtime,
      new Date().toISOString(),
      currentStatus?.conditions
    )
    const withWorkflowConditions = (result: WorkflowReconcileResult): WorkflowReconcileResult => ({
      ...result,
      workflowConditions,
    })
    const outputAnchorPodName = runtime.output.anchorRequired
      ? buildWorkflowOutputAnchorPodName(runtimeScopeRecipeName)
      : undefined
    const needsWorkflowOutputPrepare = runtime.output.prepareRequired && !awaitsTriggeredRun
    const outputPreparePodName = needsWorkflowOutputPrepare
      ? buildWorkflowOutputPreparePodName(recipeName)
      : undefined
    const log = createLogger('wrc', recipeName)
    log.info(`Reconciling workflow`, {
      classification,
      needsMcpHost,
      awaitsTriggeredRun,
      needsSnippetRunner,
      customCoordinator: usesCustomCoordinator,
    })

    try {
      // Check crash recovery for existing Pods
      let coordPhase = await getPodPhase(
        this.deps.coreApi,
        `${recipeName}-coordinator`,
        this.deps.config.sandboxNamespace
      )
      const coordWaitingReason = await getContainerWaitingReason(
        this.deps.coreApi,
        `${recipeName}-coordinator`,
        this.deps.config.sandboxNamespace
      )
      let outputAnchorPhase = outputAnchorPodName
        ? await getPodPhase(
            this.deps.coreApi,
            outputAnchorPodName,
            this.deps.config.sandboxNamespace
          )
        : undefined
      let outputPreparePhase = outputPreparePodName
        ? await getPodPhase(
            this.deps.coreApi,
            outputPreparePodName,
            this.deps.config.sandboxNamespace
          )
        : undefined
      let mcpHostPhase = needsMcpHost
        ? await getPodPhase(
            this.deps.coreApi,
            `${recipeName}-mcp-host`,
            this.deps.config.sandboxNamespace
          )
        : undefined
      let artifactReaderPhase = needsArtifactReader
        ? await getPodPhase(
            this.deps.coreApi,
            `${recipeName}-artifact-reader`,
            this.deps.config.sandboxNamespace
          )
        : undefined
      let snippetRunnerPhase = needsSnippetRunner
        ? await getPodPhase(
            this.deps.coreApi,
            `${recipeName}-snippet-runner`,
            this.deps.config.sandboxNamespace
          )
        : undefined
      const mcpHostWaitingReason = needsMcpHost
        ? await getContainerWaitingReason(
            this.deps.coreApi,
            `${recipeName}-mcp-host`,
            this.deps.config.sandboxNamespace
          )
        : undefined
      if (coordPhase) {
        const existingCoordinator = await readCoordinatorRuntimeIfExists(
          this.deps.coreApi,
          `${recipeName}-coordinator`,
          this.deps.config.sandboxNamespace
        )
        const desiredCoordinatorTier = usesCustomCoordinator ? 'custom' : 'builtin'
        if (existingCoordinator?.tier && existingCoordinator.tier !== desiredCoordinatorTier) {
          return withWorkflowConditions({
            phase: 'failed',
            message:
              'coordinator tier is immutable after the workflow runtime pod has been created',
            workflowPhase: 'failed',
          })
        }
        if (
          usesCustomCoordinator &&
          existingCoordinator?.image &&
          existingCoordinator.image !== desiredCoordinatorImage
        ) {
          return withWorkflowConditions({
            phase: 'failed',
            message:
              'coordinator image is immutable after the workflow runtime pod has been created',
            workflowPhase: 'failed',
          })
        }
      }

      if (awaitsTriggeredRun) {
        for (const component of runtime.cleanup.deleteBeforeTriggeredRun) {
          // Plugin Workload SDK: keep the mcp-host alive across the
          // awaiting-trigger window — it hosts the always-on SDK server.
          // Only the coordinator (and run-scoped pods) are torn down here.
          if (eagerMcpHostForSdk && component === 'workflow-mcp-host') continue
          await this.deleteRuntimeComponentIfExists(recipeName, component)
        }

        // Plugin Workload SDK: bring up the mcp-host (and broker the provider
        // for promptBridge) before the run-scoped output/PVC gating below — a
        // pure-SDK recipe has no run yet, so it must not wait on run output
        // infrastructure to expose the always-on SDK server.
        if (eagerMcpHostForSdk) {
          // The eager mcp-host hosts only the always-on SDK server; it produces
          // no run artifacts yet, so it must NOT mount the workflow-output PVC
          // (that PVC is provisioned by the triggered-run path). Mounting it
          // here would wedge the pod in Pending — the PVC does not exist until a
          // run starts. The triggered run later recreates the pod with the mount.
          const eagerStatus = await this.pluginWorkloadSdkProvisioner.ensureEagerSdkMcpHost(
            recipeName,
            recipeUid,
            namespace,
            runtimeScopeRecipeName,
            spec,
            runtime,
            { mcpHostPhase }
          )
          if (eagerStatus === 'failed') {
            return withWorkflowConditions({
              phase: 'failed',
              message: 'Plugin Workload SDK mcp-host could not start',
              workflowPhase: 'failed',
            })
          }
          if (eagerStatus === 'provider_unavailable') {
            // The eager mcp-host is Ready but its provider could not be brokered
            // after repeated /configure attempts (e.g. a bad secretRef). Stay
            // active so the level-triggered reconcile keeps retrying — the
            // recipe self-heals once the broker config is fixed — but surface a
            // distinct condition so this is no longer indistinguishable from
            // "still booting".
            const providerUnavailableMessage = `Plugin Workload SDK mcp-host provider unavailable: /configure failed repeatedly (${classification})`
            return {
              phase: 'active',
              message: providerUnavailableMessage,
              clearWorkflowExecution: true,
              workflowConditions: [
                ...workflowConditions,
                buildStatusCondition(
                  'PluginWorkloadSdkProviderUnavailable',
                  'EagerConfigureFailed',
                  providerUnavailableMessage,
                  new Date().toISOString()
                ),
              ],
            }
          }
          const eagerReady = eagerStatus === 'ready'
          const eagerMessage = eagerReady
            ? `Plugin Workload SDK mcp-host registered (${classification})`
            : `Plugin Workload SDK mcp-host starting (${classification})`
          return withWorkflowConditions({
            // While the eager mcp-host is still booting (eagerStatus ===
            // 'deploying'), return 'deploying' — NOT 'active' — so the watcher
            // requeues at the fixed progress interval and re-runs the eager
            // /configure once the pod becomes Ready. Returning 'active' here
            // drops the requeue (requeueAfterMs=undefined at workflowRecipe
            // Reconciler), so a pod that becomes Ready AFTER this reconcile is
            // never re-reconciled and stays "waiting for /configure" forever —
            // the SDK provider is never armed and promptBridge fails with
            // provider_unavailable. 'ready' projects 'active' (configured).
            phase: eagerReady ? 'active' : 'deploying',
            message: eagerMessage,
            clearWorkflowExecution: true,
          })
        }
      }

      // If coordinator Pod has failed, evaluate crash recovery
      if (
        !awaitsTriggeredRun &&
        (coordPhase === 'Failed' ||
          coordPhase === 'Unknown' ||
          isRecoverableContainerWaitingReason(coordPhase, coordWaitingReason))
      ) {
        const recovery = evaluateCrashRecovery(
          coordPhase,
          currentStatus?.workflowExecution,
          coordWaitingReason
        )
        if (recovery.action === 'fail') {
          return withWorkflowConditions({
            phase: 'failed',
            message: recovery.message,
            workflowPhase: 'failed',
          })
        }
        if (recovery.action === 'replace') {
          log.info(recovery.message)
          // Persist attempt counter to CRD status BEFORE deleting the Pod —
          // without this, attempt stays at 0 and MAX_ATTEMPTS guard never fires.
          const existingExecution = currentStatus?.workflowExecution ?? {}
          await this.deps.customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: {
                status: {
                  workflowExecution: {
                    ...existingExecution,
                    phase: recovery.newPhase,
                    attempt: recovery.newAttempt,
                  },
                },
              },
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
          for (const component of runtime.cleanup.deleteAfterCoordinatorReplacement) {
            await this.deleteRuntimeComponentIfExists(recipeName, component)
            if (component === 'workflow-mcp-host') mcpHostPhase = undefined
            if (component === 'workflow-artifact-reader') artifactReaderPhase = undefined
            if (component === 'workflow-snippet-runner') snippetRunnerPhase = undefined
          }
          await deletePodIfExists(
            this.deps.coreApi,
            `${recipeName}-coordinator`,
            this.deps.config.sandboxNamespace
          )
          coordPhase = undefined
          // Fall through to Pod creation below
        }
      }

      // Similarly for mcp_host Pod
      const isPreCoordinatorPhase = isPreCoordinatorWorkflowPhase(currentStatus?.workflowExecution)
      if (
        needsMcpHost &&
        !awaitsTriggeredRun &&
        (mcpHostPhase === 'Failed' ||
          mcpHostPhase === 'Unknown' ||
          (isPreCoordinatorPhase &&
            (mcpHostPhase === 'Succeeded' ||
              isRecoverableContainerWaitingReason(mcpHostPhase, mcpHostWaitingReason))))
      ) {
        const recovery =
          mcpHostPhase === 'Succeeded'
            ? evaluateCompletedRuntimePodRecovery(currentStatus?.workflowExecution, 'mcp_host')
            : evaluateCrashRecovery(
                mcpHostPhase,
                currentStatus?.workflowExecution,
                mcpHostWaitingReason
              )
        if (recovery.action === 'fail') {
          return withWorkflowConditions({
            phase: 'failed',
            message: recovery.message,
            workflowPhase: 'failed',
          })
        }
        if (recovery.action === 'replace') {
          log.info(`mcp_host: ${recovery.message}`)
          const existingExecution = currentStatus?.workflowExecution ?? {}
          await this.deps.customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: {
                status: {
                  workflowExecution: {
                    ...existingExecution,
                    phase: recovery.newPhase,
                    attempt: recovery.newAttempt,
                  },
                },
              },
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
          await deletePodIfExists(
            this.deps.coreApi,
            `${recipeName}-mcp-host`,
            this.deps.config.sandboxNamespace
          )
          mcpHostPhase = undefined
        }
      }

      const coordinatorGfsScopes = deriveRecipeHostGfsScopes(spec)
      const coordinatorGfsSubject = `host:3rd:${namespace}/${runtimeScopeRecipeName}`
      const coordinatorGfsBinding = workflowHasGfsPublishTargets(spec)
        ? await mintRecipeHostGfsToken(namespace, runtimeScopeRecipeName, {
            scopes: coordinatorGfsScopes,
          })
        : undefined
      const coordinatorGfsToken = coordinatorGfsBinding ? coordinatorGfsBinding.token : undefined

      // 1. Create coordinator token Secret
      const tokenSecret = await createCoordinatorTokens(
        recipeName,
        this.deps.tokenFactory,
        this.deps.config.sandboxNamespace,
        {
          ...runtime.tokens.coordinator,
          ['gfs' + 'To' + 'ken']: coordinatorGfsToken,
        }
      )
      // WRC→mcp-host tokens are now minted fresh per request inside
      // configureModel()/getArtifact() — nothing is stored in-process anymore.
      const tokenSecretCreated = await this.createIfNotExists(
        () =>
          this.deps.coreApi.createNamespacedSecret({
            namespace: this.deps.config.sandboxNamespace,
            body: tokenSecret,
          }),
        `Secret "wf-${recipeName}-coordinator-token"`
      )
      if (!tokenSecretCreated) {
        await this.refreshCoordinatorTokenIfExpiring(recipeName, namespace, {
          ...runtime.tokens.coordinator,
          ['gfs' + 'To' + 'ken']: coordinatorGfsToken,
          gfsSubject: coordinatorGfsSubject,
          gfsScopes: coordinatorGfsScopes,
        })
      }

      if (needsMcpHost && !awaitsTriggeredRun) {
        await this.ensureMcpHostSecrets(namespace, recipeName, runtimeScopeRecipeName, spec)
      }

      if (runtime.output.ensurePvc) {
        const outputPvcReady = await this.ensureWorkflowOutputPvc(
          runtimeScopeRecipeName,
          runtime.output.claimName,
          spec
        )
        if (!outputPvcReady) {
          return withWorkflowConditions({
            phase: 'deploying',
            message: `Workflow output PVC "${runtime.output.claimName}" is terminating; waiting for Kubernetes to finish deletion before creating runtime pods`,
            workflowPhase: 'initializing',
          })
        }
      } else if (workflowOutputClaimOwnership === 'external') {
        const externalPvcState = await this.isExternalWorkflowOutputPvcReady(
          workflowOutputClaimName,
          runtimeScopeRecipeName
        )
        if (externalPvcState !== 'ready') {
          if (externalPvcState === 'wrc-managed-conflict') {
            return withWorkflowConditions({
              phase: 'failed',
              message: `External workflow output PVC "${workflowOutputClaimName}" is managed by WRC; choose an operator-owned PVC or remove spec.output.claimName`,
              workflowPhase: 'failed',
            })
          }
          if (externalPvcState === 'unauthorized') {
            return withWorkflowConditions({
              phase: 'failed',
              message:
                `External workflow output PVC "${workflowOutputClaimName}" is not labeled for workflow output scope "${runtimeScopeRecipeName}". ` +
                `Add labels ${WORKFLOW_OUTPUT_EXTERNAL_CLAIM_LABEL}=true, ${WORKFLOW_OUTPUT_CLAIM_LABEL}=${workflowOutputLabelValue(workflowOutputClaimName)}, and ${WORKFLOW_OUTPUT_SCOPE_LABEL}=${workflowOutputLabelValue(runtimeScopeRecipeName)} or remove spec.output.claimName.`,
              workflowPhase: 'failed',
            })
          }
          return withWorkflowConditions({
            phase: 'deploying',
            message:
              externalPvcState === 'terminating'
                ? `External workflow output PVC "${workflowOutputClaimName}" is terminating; waiting before creating runtime pods`
                : `External workflow output PVC "${workflowOutputClaimName}" was not found in ${this.deps.config.sandboxNamespace}; create it or remove spec.output.claimName`,
            workflowPhase: 'initializing',
          })
        }
      }

      if (runtime.output.anchorRequired && outputAnchorPodName) {
        if (outputAnchorPhase === 'Failed' || outputAnchorPhase === 'Unknown') {
          await deletePodIfExists(
            this.deps.coreApi,
            outputAnchorPodName,
            this.deps.config.sandboxNamespace
          )
          outputAnchorPhase = undefined
        }
        if (!outputAnchorPhase) {
          const anchorPod = buildWorkflowOutputAnchorPod(runtimeScopeRecipeName, this.deps.config, {
            workflowOutputClaimName,
          })
          await this.createIfNotExists(
            () =>
              this.deps.coreApi.createNamespacedPod({
                namespace: this.deps.config.sandboxNamespace,
                body: anchorPod,
              }),
            `Pod "${outputAnchorPodName}"`
          )
          if (!awaitsTriggeredRun) {
            return withWorkflowConditions({
              phase: 'deploying',
              message: `Created workflow output anchor pod "${outputAnchorPodName}"; waiting for it to mount the output PVC before starting prepare/runtime pods`,
              workflowPhase: 'initializing',
            })
          }
        }
        if (!awaitsTriggeredRun && outputAnchorPhase !== 'Running') {
          const readiness = await getPodReadiness(
            this.deps.coreApi,
            outputAnchorPodName,
            this.deps.config.sandboxNamespace
          )
          return withWorkflowConditions({
            phase: 'deploying',
            message: workflowOutputAnchorWaitMessage(outputAnchorPodName, readiness),
            workflowPhase:
              currentStatus?.workflowExecution?.phase === 'recovering'
                ? 'recovering'
                : 'initializing',
          })
        }
      }

      if (needsWorkflowOutputPrepare && outputPreparePodName) {
        if (outputPreparePhase === 'Failed') {
          const recovery = evaluateWorkflowOutputPrepareRecovery(currentStatus?.workflowExecution)
          if (recovery.action === 'fail') {
            return withWorkflowConditions({
              phase: 'failed',
              message: recovery.message,
              workflowPhase: 'failed',
            })
          }
          const existingExecution = currentStatus?.workflowExecution ?? {}
          await this.deps.customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: recipeName,
              body: {
                status: {
                  workflowExecution: {
                    ...existingExecution,
                    phase: 'recovering',
                    attempt: recovery.newAttempt,
                    message: recovery.message,
                  },
                },
              },
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
          await deletePodIfExists(
            this.deps.coreApi,
            outputPreparePodName,
            this.deps.config.sandboxNamespace
          )
          return withWorkflowConditions({
            phase: 'deploying',
            message: recovery.message,
            workflowPhase: 'recovering',
          })
        }
        if (outputPreparePhase === 'Unknown') {
          await deletePodIfExists(
            this.deps.coreApi,
            outputPreparePodName,
            this.deps.config.sandboxNamespace
          )
          outputPreparePhase = undefined
        }
        if (!outputPreparePhase) {
          const preparePod = buildWorkflowOutputPreparePod(recipeName, this.deps.config, {
            workflowOutputClaimName,
            workflowOutputSubPath,
            workflowOutputScope: runtimeScopeRecipeName,
          })
          await this.createIfNotExists(
            () =>
              this.deps.coreApi.createNamespacedPod({
                namespace: this.deps.config.sandboxNamespace,
                body: preparePod,
              }),
            `Pod "${outputPreparePodName}"`
          )
          return withWorkflowConditions({
            phase: 'deploying',
            message: `Created workflow output prepare pod "${outputPreparePodName}"; waiting before starting runtime pods`,
            workflowPhase: 'initializing',
          })
        }
        if (outputPreparePhase !== 'Succeeded') {
          const readiness = await getPodReadiness(
            this.deps.coreApi,
            outputPreparePodName,
            this.deps.config.sandboxNamespace
          )
          return withWorkflowConditions({
            phase: 'deploying',
            message: workflowOutputPrepareWaitMessage(outputPreparePodName, readiness),
            workflowPhase: 'initializing',
          })
        }
      }

      // 2. Create SOUL.md ConfigMap
      await this.ensureSoulConfigMap(recipeName, spec)

      // 3. Create workflow config ConfigMap
      await this.ensureWorkflowConfigMap(recipeName, recipeUid, spec, resolvedInputs)

      if (needsMcpHost && !awaitsTriggeredRun) {
        await this.ensureMcpHostHeadlessService(recipeName)
        const routeAliasSvc = buildMcpHostRouteAliasHeadlessService(
          recipeName,
          this.deps.config.sandboxNamespace
        )
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedService({
              namespace: this.deps.config.sandboxNamespace,
              body: routeAliasSvc,
            }),
          `Headless Service "${buildMcpHostRouteAliasServiceName(recipeName, this.deps.config.sandboxNamespace)}"`
        )
      }
      if (needsArtifactReader && !awaitsTriggeredRun) {
        const readerSvc = buildArtifactReaderHeadlessService(
          recipeName,
          this.deps.config.sandboxNamespace
        )
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedService({
              namespace: this.deps.config.sandboxNamespace,
              body: readerSvc,
            }),
          `Headless Service "${buildArtifactReaderServiceName(recipeName)}"`
        )
      }
      if (needsSnippetRunner && !awaitsTriggeredRun) {
        const snippetRunnerSvc = buildSnippetRunnerHeadlessService(
          recipeName,
          this.deps.config.sandboxNamespace
        )
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedService({
              namespace: this.deps.config.sandboxNamespace,
              body: snippetRunnerSvc,
            }),
          `Headless Service "${buildSnippetRunnerServiceName(recipeName)}"`
        )
      }

      // 5. Create NetworkPolicies before Pods. The namespace default-deny is
      // already active, and custom coordinators can call WRC immediately on
      // startup. Applying allow policies first avoids a startup race where the
      // first status/probe request is blocked before coord-to-wrc exists.
      await this.applyWorkflowNetworkPolicies(
        recipeName,
        recipeUid,
        spec,
        runtime,
        awaitsTriggeredRun
      )

      // 6. Create Pods — mcp-host FIRST, then coordinator. If the coordinator
      // resolves DNS before mcp-host's EndpointSlice exists, undici caches the
      // NXDOMAIN for 5-30s and startup latency balloons.
      //
      // NOTE: artifact-producing workflows mount `/output` from run-scoped
      // storage. The WRC-managed claim uses
      // `workflow-output/<parentRecipe>/<runId>` for child runs; explicit PVC
      // output uses the same run-scoped layout inside the dedicated claim.

      // Eager→run transition: a recipe that ran the eager SDK path created the
      // mcp-host WITHOUT the workflow-output mount (no PVC existed yet). When a
      // run is now triggered and needs that mount, the still-running eager pod
      // would be 409-skipped by createIfNotExists and the run would have no
      // output volume. Detect the mount-less pod and delete it so it is rebuilt
      // with the mount below. Scoped to the pre-coordinator phase so it only
      // fires as a run starts — never on an already-running/completed workflow.
      if (
        needsMcpHost &&
        !awaitsTriggeredRun &&
        isPreCoordinatorPhase &&
        mcpHostPhase &&
        runtime.pods.mcpHost?.mountWorkflowOutput &&
        !(await this.mcpHostPodHasWorkflowOutputMount(recipeName))
      ) {
        await deletePodIfExists(
          this.deps.coreApi,
          `${recipeName}-mcp-host`,
          this.deps.config.sandboxNamespace
        )
        const priorPodPhase = await getPodPhase(
          this.deps.coreApi,
          `${recipeName}-mcp-host`,
          this.deps.config.sandboxNamespace
        )
        if (priorPodPhase === 'Running' || priorPodPhase === 'Pending') {
          return withWorkflowConditions({
            phase: 'deploying',
            message: 'Waiting for prior eager mcp-host pod to terminate before run-scoped recreate',
            workflowPhase: currentStatus?.workflowExecution?.phase ?? 'initializing',
          })
        }
        mcpHostPhase = undefined
      }

      if (
        needsMcpHost &&
        !awaitsTriggeredRun &&
        (!mcpHostPhase || mcpHostPhase === 'Failed' || mcpHostPhase === 'Unknown')
      ) {
        const mcpHostAgent = this.resolveMcpHostAgent(spec)
        if (!mcpHostAgent) {
          return withWorkflowConditions({
            phase: 'failed',
            message: 'Workflow spec missing required agent configuration',
            workflowPhase: 'failed',
          })
        }
        const mcpHostPod = buildMcpHostPod(
          recipeName,
          mcpHostAgent,
          this.deps.config,
          runtimeScopeRecipeName,
          namespace,
          runtime.pods.mcpHost!.workflowOutputClaimName,
          runtime.pods.mcpHost!.workflowOutputSubPath,
          effectiveWorkflowContextRefForSpec(recipeName, spec),
          {
            gfsScopes: coordinatorGfsScopes,
            mountWorkflowOutput: runtime.pods.mcpHost!.mountWorkflowOutput,
            workflowOutputScope: runtime.pods.mcpHost!.workflowOutputScope,
            pluginWorkloadSdkEnabled:
              this.deps.config.pluginWorkloadSdkEnabled && Boolean(spec.pluginWorkloadSdk),
          }
        )
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedPod({
              namespace: this.deps.config.sandboxNamespace,
              body: mcpHostPod,
            }),
          `Pod "${recipeName}-mcp-host"`
        )
      }

      if (needsMcpHost && !awaitsTriggeredRun && isPreCoordinatorPhase) {
        const readiness = await getPodReadiness(
          this.deps.coreApi,
          `${recipeName}-mcp-host`,
          this.deps.config.sandboxNamespace
        )
        if (!readiness.ready) {
          const message = mcpHostReadinessMessage(readiness)
          if (hasMcpHostReadinessWaitExpired(currentStatus?.workflowExecution)) {
            return withWorkflowConditions({
              phase: 'failed',
              message: `${message}; readiness deadline exceeded`,
              workflowPhase: 'failed',
            })
          }

          return withWorkflowConditions({
            phase: 'deploying',
            message,
            workflowPhase: workflowPhaseForMcpHostReadinessWait(currentStatus?.workflowExecution),
          })
        }
      }

      if (
        !awaitsTriggeredRun &&
        needsArtifactReader &&
        (!artifactReaderPhase ||
          artifactReaderPhase === 'Failed' ||
          artifactReaderPhase === 'Unknown')
      ) {
        if (artifactReaderPhase === 'Failed' || artifactReaderPhase === 'Unknown') {
          await deletePodIfExists(
            this.deps.coreApi,
            `${recipeName}-artifact-reader`,
            this.deps.config.sandboxNamespace
          )
          artifactReaderPhase = undefined
        }
        const artifactReaderPod = buildArtifactReaderPod(
          recipeName,
          this.deps.config,
          runtime.pods.artifactReader!
        )
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedPod({
              namespace: this.deps.config.sandboxNamespace,
              body: artifactReaderPod,
            }),
          `Pod "${recipeName}-artifact-reader"`
        )
      }

      if (
        !awaitsTriggeredRun &&
        needsSnippetRunner &&
        (!snippetRunnerPhase || snippetRunnerPhase === 'Failed' || snippetRunnerPhase === 'Unknown')
      ) {
        if (snippetRunnerPhase === 'Failed' || snippetRunnerPhase === 'Unknown') {
          await deletePodIfExists(
            this.deps.coreApi,
            `${recipeName}-snippet-runner`,
            this.deps.config.sandboxNamespace
          )
          snippetRunnerPhase = undefined
        }
        let secretAliases: SnippetRunnerSecretAlias[]
        try {
          secretAliases = collectSnippetSecretAliases(spec, currentStatus?.resourceInstances)
        } catch (err) {
          return withWorkflowConditions({
            phase: 'failed',
            message: err instanceof Error ? err.message : String(err),
            workflowPhase: 'failed',
          })
        }
        const snippetRunnerPod = buildSnippetRunnerPod(recipeName, this.deps.config, {
          ...runtime.pods.snippetRunner!,
          secretAliases,
        })
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedPod({
              namespace: this.deps.config.sandboxNamespace,
              body: snippetRunnerPod,
            }),
          `Pod "${recipeName}-snippet-runner"`
        )
      }

      if (
        !awaitsTriggeredRun &&
        (!coordPhase || coordPhase === 'Failed' || coordPhase === 'Unknown')
      ) {
        const coordPod = buildCoordinatorPod(recipeName, this.deps.config, {
          ...runtime.pods.coordinator,
          activeDeadlineSeconds: usesCustomCoordinator
            ? resolveCustomCoordinatorActiveDeadlineSeconds(spec)
            : undefined,
          workflowRunId: workflowRunIdValue,
          workflowTeamId,
          workflowUserId: workflowUsageUserId,
          needsGfsPublish: workflowHasGfsPublishTargets(spec),
        })
        await this.createIfNotExists(
          () =>
            this.deps.coreApi.createNamespacedPod({
              namespace: this.deps.config.sandboxNamespace,
              body: coordPod,
            }),
          `Pod "${recipeName}-coordinator"`
        )
      }

      // 7. Set recipe-type annotation
      await this.setRecipeTypeAnnotation(recipeName, namespace, classification)

      // 8. Reconcile scheduling — DB-backed worker, not a K8s CronJob. The WRC
      // only keeps `workflow_schedules` in sync; control-api's worker owns the
      // advance-loop and the row-lock advisory coordination.
      //
      // Canonical shape is `spec.triggers.schedule`. Legacy `spec.scheduling`
      // is still accepted for backwards compat — normalize to a single
      // SchedulingSpec before calling reconcileScheduling().
      const scheduleTrigger = spec.triggers?.schedule
      const normalizedScheduling = scheduleTrigger
        ? {
            cron: scheduleTrigger.cron,
            timezone: scheduleTrigger.timezone,
            suspend: scheduleTrigger.suspend,
          }
        : spec.scheduling
      if (!this.deps.pgPool) {
        if (normalizedScheduling) {
          log.warn('schedule present but pgPool not wired — skipping schedule reconcile')
        }
      } else {
        // Denormalize the on-demand actor allow-list into the schedule row
        // so the control-api worker can gate scheduled fires without a
        // cross-store JOIN back to the CRD. An unset / empty list is
        // treated as "no restriction" (matches admin endpoint semantics).
        const allowedActors =
          spec.triggers?.onDemand?.allowedActors && spec.triggers.onDemand.allowedActors.length > 0
            ? spec.triggers.onDemand.allowedActors
            : null
        const schedRecipe: SchedulingRecipe = {
          metadata: {
            name: recipeName,
            namespace,
            uid: recipeUid,
            labels: workflowTeamId ? { [WORKFLOW_TEAM_ID_LABEL]: workflowTeamId } : undefined,
          },
          spec: {
            scheduling: normalizedScheduling,
            allowedActors,
            runRetention: spec.runRetention ?? null,
          },
        }
        const schedResult = await reconcileScheduling(this.deps.pgPool, schedRecipe)
        if (normalizedScheduling || schedResult.action === 'deleted') {
          log.info(`Scheduling: ${schedResult.action}`)
        }
      }

      if (awaitsTriggeredRun) {
        return withWorkflowConditions({
          phase: 'active',
          message: `Workflow trigger infrastructure registered (${classification})`,
          clearWorkflowExecution: true,
        })
      }

      // Determine phase — narrow from CRD's open string to closed WorkflowPhase union.
      // Unknown/stale phase values fall back to "initializing" to prevent propagation.
      const rawPhase = currentStatus?.workflowExecution?.phase
      const KNOWN_PHASES: readonly string[] = [
        'pending',
        'initializing',
        'running',
        'completed',
        'failed',
        'recovering',
        'cancelled',
      ]
      const workflowPhase: WorkflowPhase =
        rawPhase && KNOWN_PHASES.includes(rawPhase) ? (rawPhase as WorkflowPhase) : 'initializing'

      // Phase transition: when the coordinator reports the workflow as completed/failed,
      // the CRD must advance beyond "deploying" so the UI and reconciler reflect final state.
      // "completed" → "active" (infrastructure still exists, execution done)
      // "failed"    → "failed" (surfaces failure in CRD status)
      let recipePhase = 'deploying'
      if (workflowPhase === 'running' || workflowPhase === 'completed') recipePhase = 'active'
      else if (workflowPhase === 'failed' || workflowPhase === 'cancelled') recipePhase = 'failed'

      return withWorkflowConditions({
        phase: recipePhase,
        message: `Workflow infrastructure created (${classification})`,
        workflowPhase,
      })
    } catch (error) {
      // Transient K8s API blip (connect ETIMEDOUT, ECONNRESET, 5xx, 429, …)
      // during workflow infrastructure reconcile. Do NOT latch the workflow to
      // the terminal `failed` phase — that would brick a recoverable run with no
      // retry. Preserve the current workflow execution phase/message and signal
      // skipStatusPatch so WRC leaves status untouched and requeues. Mirrors the
      // outer WRC catch-all (isRetryableInfraError); same classifier.
      if (isRetryableInfraError(error)) {
        log.warn(`Transient infra error reconciling workflow — will retry, not failing`, {
          error: error instanceof Error ? error.message : String(error),
        })
        const preserved = currentStatus?.workflowExecution
        const preservedPhase = preserved?.phase as WorkflowPhase | undefined
        const workflowPhase: WorkflowPhase = preservedPhase ?? 'recovering'
        // Keep the recipe phase consistent with the preserved execution phase;
        // a transient blip must never surface `failed` to the recipe/UI.
        let recipePhase = 'deploying'
        if (workflowPhase === 'running' || workflowPhase === 'completed') recipePhase = 'active'
        return {
          phase: recipePhase,
          message: preserved?.message ?? String(error),
          workflowPhase,
          skipStatusPatch: true,
        }
      }
      log.error(`Failed to reconcile workflow`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return withWorkflowConditions({
        phase: 'failed',
        message: String(error),
        workflowPhase: 'failed',
      })
    }
  }

  private async ensureWorkflowOutputPvc(
    recipeName: string,
    claimName: string,
    spec: WorkflowRecipeSpec
  ): Promise<boolean> {
    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: claimName,
        namespace: this.deps.config.sandboxNamespace,
        labels: {
          'clerum.io/recipe': recipeName,
          'clerum.io/component': 'workflow-output',
          'clerum.io/managed-by': 'wrc',
          [WORKFLOW_OUTPUT_CLAIM_LABEL]: workflowOutputLabelValue(claimName),
          [WORKFLOW_OUTPUT_SCOPE_LABEL]: workflowOutputLabelValue(recipeName),
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: spec.output?.storageSize ?? DEFAULT_WORKFLOW_OUTPUT_STORAGE_SIZE,
          },
        },
      },
    }

    try {
      await this.deps.coreApi.createNamespacedPersistentVolumeClaim({
        namespace: this.deps.config.sandboxNamespace,
        body: pvc,
      })
      this.log.info(`Created PersistentVolumeClaim "${claimName}"`)
      return true
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) throw error
    }

    const existing = await this.readWorkflowOutputPvc(claimName)
    if (!existing) {
      try {
        await this.deps.coreApi.createNamespacedPersistentVolumeClaim({
          namespace: this.deps.config.sandboxNamespace,
          body: pvc,
        })
        this.log.info(`Created PersistentVolumeClaim "${claimName}" after delete race`)
        return true
      } catch (error: unknown) {
        if (getErrorCode(error) !== 409) throw error
      }
      const racedExisting = await this.readWorkflowOutputPvc(claimName)
      if (!racedExisting || racedExisting.metadata?.deletionTimestamp) {
        this.log.warn(`PersistentVolumeClaim "${claimName}" is terminating after create race`)
        return false
      }
      this.assertWorkflowOutputPvcManagedByScope(racedExisting, claimName, recipeName)
      this.log.info(`PersistentVolumeClaim "${claimName}" already exists (skip)`)
      return true
    }

    if (existing.metadata?.deletionTimestamp) {
      this.log.warn(`PersistentVolumeClaim "${claimName}" is terminating; waiting to recreate`)
      const waitResult = await this.waitForWorkflowOutputPvcDeletion(claimName)
      if (waitResult === 'ready') {
        const readyExisting = await this.readWorkflowOutputPvc(claimName)
        if (!readyExisting || readyExisting.metadata?.deletionTimestamp) {
          this.log.warn(`PersistentVolumeClaim "${claimName}" changed while waiting for deletion`)
          return false
        }
        this.assertWorkflowOutputPvcManagedByScope(readyExisting, claimName, recipeName)
        this.log.info(`PersistentVolumeClaim "${claimName}" already exists (skip)`)
        return true
      }
      if (waitResult === 'terminating') {
        this.log.warn(`PersistentVolumeClaim "${claimName}" is still terminating after wait`)
        return false
      }
      try {
        await this.deps.coreApi.createNamespacedPersistentVolumeClaim({
          namespace: this.deps.config.sandboxNamespace,
          body: pvc,
        })
        this.log.info(`Created PersistentVolumeClaim "${claimName}" after terminating PVC deleted`)
        return true
      } catch (error: unknown) {
        if (getErrorCode(error) !== 409) throw error
      }
      const racedExisting = await this.readWorkflowOutputPvc(claimName)
      if (!racedExisting || racedExisting.metadata?.deletionTimestamp) {
        this.log.warn(`PersistentVolumeClaim "${claimName}" is terminating after recreate race`)
        return false
      }
      this.assertWorkflowOutputPvcManagedByScope(racedExisting, claimName, recipeName)
      this.log.info(`PersistentVolumeClaim "${claimName}" already exists (skip)`)
      return true
    }

    this.assertWorkflowOutputPvcManagedByScope(existing, claimName, recipeName)
    this.log.info(`PersistentVolumeClaim "${claimName}" already exists (skip)`)
    return true
  }

  private assertWorkflowOutputPvcManagedByScope(
    pvc: k8s.V1PersistentVolumeClaim,
    claimName: string,
    recipeName: string
  ): void {
    const labels = pvc.metadata?.labels ?? {}
    const expectedClaim = workflowOutputLabelValue(claimName)
    const expectedScope = workflowOutputLabelValue(recipeName)
    const mismatches: string[] = []
    if (labels['clerum.io/managed-by'] !== 'wrc') mismatches.push('managed-by')
    if (labels['clerum.io/component'] !== 'workflow-output') mismatches.push('component')
    if (labels[WORKFLOW_OUTPUT_CLAIM_LABEL] !== expectedClaim) {
      mismatches.push(WORKFLOW_OUTPUT_CLAIM_LABEL)
    }
    if (labels[WORKFLOW_OUTPUT_SCOPE_LABEL] !== expectedScope) {
      mismatches.push(WORKFLOW_OUTPUT_SCOPE_LABEL)
    }
    if (mismatches.length === 0) return

    throw new Error(
      `Workflow output PVC "${claimName}" already exists but is not managed by WRC for workflow output scope "${recipeName}" (${mismatches.join(', ')})`
    )
  }

  private async waitForWorkflowOutputPvcDeletion(
    claimName: string
  ): Promise<'deleted' | 'ready' | 'terminating'> {
    const deadline = Date.now() + WORKFLOW_OUTPUT_PVC_DELETE_WAIT_MS
    while (Date.now() < deadline) {
      await delay(WORKFLOW_OUTPUT_PVC_DELETE_POLL_MS)
      const pvc = await this.readWorkflowOutputPvc(claimName)
      if (!pvc) return 'deleted'
      if (!pvc.metadata?.deletionTimestamp) return 'ready'
    }
    return 'terminating'
  }

  private async readWorkflowOutputPvc(
    claimName: string
  ): Promise<k8s.V1PersistentVolumeClaim | undefined> {
    try {
      return await this.deps.coreApi.readNamespacedPersistentVolumeClaim({
        name: claimName,
        namespace: this.deps.config.sandboxNamespace,
      })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) return undefined
      throw error
    }
  }

  private async isExternalWorkflowOutputPvcReady(
    claimName: string,
    runtimeScopeRecipeName: string
  ): Promise<ExternalWorkflowOutputPvcState> {
    const pvc = await this.readWorkflowOutputPvc(claimName)
    if (!pvc) return 'missing'
    if (pvc.metadata?.deletionTimestamp) return 'terminating'
    const labels = pvc.metadata?.labels ?? {}
    const expectedClaim = workflowOutputLabelValue(claimName)
    const expectedScope = workflowOutputLabelValue(runtimeScopeRecipeName)
    if (labels['clerum.io/managed-by'] === 'wrc') return 'wrc-managed-conflict'
    if (
      labels[WORKFLOW_OUTPUT_EXTERNAL_CLAIM_LABEL] !== 'true' ||
      labels[WORKFLOW_OUTPUT_CLAIM_LABEL] !== expectedClaim ||
      labels[WORKFLOW_OUTPUT_SCOPE_LABEL] !== expectedScope
    ) {
      return 'unauthorized'
    }
    return 'ready'
  }

  private async deleteRuntimeComponentIfExists(
    recipeName: string,
    component: WorkflowRuntimeComponent
  ): Promise<void> {
    const podSuffixByComponent: Record<WorkflowRuntimeComponent, string> = {
      'workflow-coordinator': 'coordinator',
      'workflow-mcp-host': 'mcp-host',
      'workflow-artifact-reader': 'artifact-reader',
      'workflow-snippet-runner': 'snippet-runner',
    }
    await deletePodIfExists(
      this.deps.coreApi,
      `${recipeName}-${podSuffixByComponent[component]}`,
      this.deps.config.sandboxNamespace
    )
  }

  /**
   * Tear down a run's COMPUTE pods once it reaches a terminal phase, while
   * PRESERVING the artifact-reader pod, the workflow-output PVC, and the
   * run-scoped WorkflowRecipe CR. The artifact-reader keeps serving `/output`
   * (PVC-backed) downloads until the archive-cron deletes the CR at its TTL —
   * so dropping mcp-host/coordinator/snippet-runner here frees CPU/RAM without
   * losing any artifacts.
   *
   * Idempotent: deleting an already-gone pod is a 404 no-op (deletePodIfExists).
   * Deliberately EXCLUDES `workflow-artifact-reader`.
   *
   * The component list is an explicit literal (not derived from
   * `runtime.cleanup.*`) on purpose: the "artifact-reader is preserved"
   * invariant must be obvious and asserted in one place. Folding it into the
   * `deriveWorkflowRuntimePlan` model would couple terminal teardown to the
   * crash-recovery cleanup lists for a larger, riskier change with no behaviour
   * gain — the exclusion is pinned by a dedicated unit test instead.
   */
  async teardownComputePodsForTerminalRun(recipeName: string): Promise<void> {
    const computeComponents: WorkflowRuntimeComponent[] = [
      'workflow-coordinator',
      'workflow-mcp-host',
      'workflow-snippet-runner',
    ]
    for (const component of computeComponents) {
      await this.deleteRuntimeComponentIfExists(recipeName, component)
    }
  }

  async ensureMcpHostRuntimeCredentials(
    recipeNamespace: string,
    recipeName: string,
    spec: WorkflowRecipeSpec,
    runtimeScopeRecipeName = recipeName
  ): Promise<void> {
    const runtime = deriveWorkflowRuntimePlan(spec, {
      recipeName,
      runtimeScopeRecipeName,
      pluginWorkloadSdkEnabled: this.deps.config.pluginWorkloadSdkEnabled,
    })
    if (!runtime.mcpHost.required) return
    await this.ensureMcpHostSecrets(recipeNamespace, recipeName, runtimeScopeRecipeName, spec)
  }

  async ensureCoordinatorRuntimeCredentials(
    recipeNamespace: string,
    recipeName: string,
    spec: WorkflowRecipeSpec,
    runtimeScopeRecipeName = recipeName
  ): Promise<void> {
    const runtime = deriveWorkflowRuntimePlan(spec, {
      recipeName,
      runtimeScopeRecipeName,
      pluginWorkloadSdkEnabled: this.deps.config.pluginWorkloadSdkEnabled,
    })
    const coordinatorGfsScopes = deriveRecipeHostGfsScopes(spec)
    const coordinatorGfsSubject = `host:3rd:${recipeNamespace}/${runtimeScopeRecipeName}`
    const coordinatorGfsBinding = workflowHasGfsPublishTargets(spec)
      ? await mintRecipeHostGfsToken(recipeNamespace, runtimeScopeRecipeName, {
          scopes: coordinatorGfsScopes,
        })
      : undefined
    await this.refreshCoordinatorTokenIfExpiring(recipeName, recipeNamespace, {
      ...runtime.tokens.coordinator,
      gfsToken: coordinatorGfsBinding ? coordinatorGfsBinding.token : undefined,
      gfsSubject: coordinatorGfsSubject,
      gfsScopes: coordinatorGfsScopes,
    })
  }

  async refreshRuntimeHttpEgressNetworkPolicies(
    _recipeNamespace: string,
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    _runtimeScopeRecipeName = recipeName
  ): Promise<void> {
    if (!this.needsRuntimeHttpEgressRefresh(spec)) return
    let policies: k8s.V1NetworkPolicy[]
    try {
      policies = await this.buildRuntimeHttpEgressNetworkPoliciesForSpec(
        recipeName,
        recipeUid,
        spec
      )
    } catch (error) {
      await this.pruneExpiredRuntimeHttpEgressNetworkPolicyOverlaps(recipeName, recipeUid, spec)
      throw error
    }
    for (const policy of policies) {
      await this.applyNetworkPolicy(policy)
    }
  }

  private async buildRuntimeHttpEgressNetworkPoliciesForSpec(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec
  ): Promise<k8s.V1NetworkPolicy[]> {
    const runtimeHttpEgressPolicyNames = this.runtimeHttpEgressPolicyNames(recipeName, spec)
    if (runtimeHttpEgressPolicyNames.length === 0) return []

    const runtimeHttpEgressState =
      runtimeHttpEgressClass(spec) === 'exact-host'
        ? await this.resolveRuntimeHttpEgressPolicyState(
            this.deps.config.sandboxNamespace,
            runtimeHttpEgressPolicyNames,
            spec.runtimeEgress?.http?.allowedHosts ?? []
          )
        : { currentCidrs: [], effectiveCidrs: [], annotations: {} }
    return this.buildRuntimeHttpEgressNetworkPoliciesForState(
      recipeName,
      recipeUid,
      spec,
      runtimeHttpEgressPolicyNames,
      runtimeHttpEgressState
    )
  }

  private buildRuntimeHttpEgressNetworkPoliciesForState(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    runtimeHttpEgressPolicyNames: string[],
    runtimeHttpEgressState: RuntimeHttpEgressPolicyState
  ): k8s.V1NetworkPolicy[] {
    const hasCustomCoordinatorHttpEgress = hasCustomCoordinatorPublicHttpEgress(spec)
    const hasSnippetHttpEgress = hasSnippetPublicHttpEgress(spec)
    const egressClass = runtimeHttpEgressClass(spec)
    const workloadIdsWithTransport = new Set(
      (spec.workloads ?? []).filter(w => w.transport != null).map(w => w.id)
    )
    const workloadMcpServerLabels = this.resolveTransportWorkloadMcpServerLabels(
      recipeName,
      recipeUid,
      spec
    )
    const snippetMcpServerFullNames = hasSnippetHttpEgress
      ? this.resolveSnippetMcpServerFullNames(
          recipeName,
          recipeUid,
          spec,
          workloadIdsWithTransport,
          workloadMcpServerLabels
        )
      : []
    const runtimeHttpPolicyNameSet = new Set(runtimeHttpEgressPolicyNames)
    const policies = buildWorkflowNetworkPolicies(
      {
        recipeName,
        sandboxNamespace: this.deps.config.sandboxNamespace,
        controlPlaneNamespace: 'control-plane',
        mcpServerNamespace: this.deps.config.mcpServerNamespace,
        wrcPort: 8082,
        mcpHostPort: 8080,
        artifactReaderPort: 8080,
        snippetRunnerPort: 8095,
        includeMcpHost: false,
        includeCoordinatorGfs: false,
        includeArtifactReader: false,
        includeSnippetRunner: hasSnippetHttpEgress,
        coordinatorPublicHttpEgress: hasCustomCoordinatorHttpEgress,
        coordinatorPublicHttpEgressClass: egressClass,
        coordinatorPublicHttpEgressCidrs: hasCustomCoordinatorHttpEgress
          ? egressClass === 'exact-host'
            ? runtimeHttpEgressState.effectiveCidrs
            : undefined
          : undefined,
        coordinatorWorkloadEgress: hasCustomCoordinatorHttpEgress
          ? this.resolveCustomCoordinatorWorkloadNetworkBindings(recipeName, recipeUid, spec)
          : undefined,
        snippetRunnerPublicHttpEgress: hasSnippetHttpEgress,
        snippetRunnerPublicHttpEgressClass: egressClass,
        snippetRunnerPublicHttpEgressCidrs: hasSnippetHttpEgress
          ? egressClass === 'exact-host'
            ? runtimeHttpEgressState.effectiveCidrs
            : undefined
          : undefined,
        snippetRunnerWorkloadEgress: hasSnippetHttpEgress
          ? this.resolveSnippetWorkloadNetworkBindings(recipeName, recipeUid, spec)
          : undefined,
      },
      [],
      snippetMcpServerFullNames
    ).filter(policy => runtimeHttpPolicyNameSet.has(policy.metadata?.name ?? ''))

    this.annotateRuntimeHttpEgressPolicies(
      policies,
      runtimeHttpPolicyNameSet,
      runtimeHttpEgressState.annotations
    )
    return policies
  }

  private async pruneExpiredRuntimeHttpEgressNetworkPolicyOverlaps(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec
  ): Promise<void> {
    const runtimeHttpEgressPolicyNames = this.runtimeHttpEgressPolicyNames(recipeName, spec)
    if (runtimeHttpEgressPolicyNames.length === 0) return
    if (runtimeHttpEgressClass(spec) === 'public-web') return
    const state = await this.readExistingRuntimeHttpEgressPolicyState(
      this.deps.config.sandboxNamespace,
      runtimeHttpEgressPolicyNames
    )
    if (!state) return
    const policies = this.buildRuntimeHttpEgressNetworkPoliciesForState(
      recipeName,
      recipeUid,
      spec,
      runtimeHttpEgressPolicyNames,
      state
    )
    for (const policy of policies) {
      await this.applyNetworkPolicy(policy)
    }
  }

  private async pruneLegacyMcpServersInternetEgressPolicy(recipeName: string): Promise<void> {
    await this.safeDelete(() =>
      this.deps.networkingApi.deleteNamespacedNetworkPolicy({
        name: `${recipeName}-mcp-servers-egress-internet`,
        namespace: this.deps.config.mcpServerNamespace,
      })
    )
  }

  private needsRuntimeHttpEgressRefresh(spec: WorkflowRecipeSpec): boolean {
    return hasCustomCoordinatorPublicHttpEgress(spec) || hasSnippetPublicHttpEgress(spec)
  }

  private runtimeHttpEgressPolicyNames(recipeName: string, spec: WorkflowRecipeSpec): string[] {
    const names: string[] = []
    if (hasCustomCoordinatorPublicHttpEgress(spec)) names.push(`${recipeName}-coord-to-wrc`)
    if (hasSnippetPublicHttpEgress(spec)) names.push(`${recipeName}-snippet-runner-egress`)
    return names
  }

  private async buildWorkflowNetworkPoliciesForSpec(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    runtime: WorkflowRuntimePlan,
    awaitsTriggeredRun: boolean,
    eagerSdkMcpHost = false
  ): Promise<k8s.V1NetworkPolicy[]> {
    const runtimeHttpEgressPolicyNames = this.runtimeHttpEgressPolicyNames(recipeName, spec)
    const runtimeHttpEgressState =
      runtimeHttpEgressPolicyNames.length > 0 && runtimeHttpEgressClass(spec) === 'exact-host'
        ? await this.resolveRuntimeHttpEgressPolicyState(
            this.deps.config.sandboxNamespace,
            runtimeHttpEgressPolicyNames,
            spec.runtimeEgress?.http?.allowedHosts ?? []
          )
        : undefined
    const hasCustomCoordinatorHttpEgress = hasCustomCoordinatorPublicHttpEgress(spec)
    const hasSnippetHttpEgress = hasSnippetPublicHttpEgress(spec)
    const egressClass = runtimeHttpEgressClass(spec)
    // "Is the mcp-host allowed to be live in this reconcile?" — true on the
    // run path (not awaiting) and on the eager Plugin Workload SDK path, which
    // deploys the mcp-host (and its NetworkPolicy lanes) before any run is
    // triggered. The artifact-reader/snippet-runner stay run-only.
    const mcpHostLaneLive = !awaitsTriggeredRun || eagerSdkMcpHost
    const npConfig: NetworkPolicyConfig = {
      recipeName,
      sandboxNamespace: this.deps.config.sandboxNamespace,
      controlPlaneNamespace: 'control-plane',
      mcpServerNamespace: this.deps.config.mcpServerNamespace,
      wrcPort: 8082,
      mcpHostPort: 8080,
      artifactReaderPort: 8080,
      snippetRunnerPort: 8095,
      includeMcpHost: runtime.network.includeMcpHost && mcpHostLaneLive,
      // The outer WorkflowRecipe reconciler owns this declarative lane so it can
      // revoke before phase short-circuits while gating creation on provenance.
      includeCoordinatorGfs: false,
      includeArtifactReader: runtime.network.includeArtifactReader && !awaitsTriggeredRun,
      includeSnippetRunner: runtime.network.includeSnippetRunner && !awaitsTriggeredRun,
      // Plugin Workload SDK (plan §6.1): open the SDK lane when the recipe
      // declares the capability, the feature flag is on, and the recipe
      // mcp-host is deployed — including the eager (pre-run) SDK path.
      pluginWorkloadSdkSandboxAccess:
        this.deps.config.pluginWorkloadSdkEnabled === true &&
        spec.pluginWorkloadSdk != null &&
        runtime.network.includeMcpHost &&
        mcpHostLaneLive,
      coordinatorPublicHttpEgress: hasCustomCoordinatorHttpEgress,
      coordinatorPublicHttpEgressClass: egressClass,
      coordinatorPublicHttpEgressCidrs: hasCustomCoordinatorHttpEgress
        ? egressClass === 'exact-host'
          ? runtimeHttpEgressState?.effectiveCidrs
          : undefined
        : undefined,
      coordinatorWorkloadEgress: this.resolveCustomCoordinatorWorkloadNetworkBindings(
        recipeName,
        recipeUid,
        spec
      ),
      snippetRunnerPublicHttpEgress: hasSnippetHttpEgress,
      snippetRunnerPublicHttpEgressClass: egressClass,
      snippetRunnerPublicHttpEgressCidrs: hasSnippetHttpEgress
        ? egressClass === 'exact-host'
          ? runtimeHttpEgressState?.effectiveCidrs
          : undefined
        : undefined,
      snippetRunnerWorkloadEgress: this.resolveSnippetWorkloadNetworkBindings(
        recipeName,
        recipeUid,
        spec
      ),
    }
    const workloadIdsWithTransport = new Set(
      (spec.workloads ?? []).filter(w => w.transport != null).map(w => w.id)
    )
    const workloadMcpServerLabels = this.resolveTransportWorkloadMcpServerLabels(
      recipeName,
      recipeUid,
      spec
    )
    const mcpServerFullNames = resolveMcpServerFullNames(
      recipeName,
      spec.mcpServers,
      workloadIdsWithTransport,
      workloadMcpServerLabels
    )
    const snippetMcpServerFullNames = this.resolveSnippetMcpServerFullNames(
      recipeName,
      recipeUid,
      spec,
      workloadIdsWithTransport,
      workloadMcpServerLabels
    )
    const policies = buildWorkflowNetworkPolicies(
      npConfig,
      mcpServerFullNames,
      snippetMcpServerFullNames
    )
    if (runtimeHttpEgressState) {
      this.annotateRuntimeHttpEgressPolicies(
        policies,
        new Set(runtimeHttpEgressPolicyNames),
        runtimeHttpEgressState.annotations
      )
    }
    return policies
  }

  /**
   * Build, apply, and legacy-prune the workflow NetworkPolicies in one unit.
   * Shared by the triggered-run path and the eager SDK path (the latter passes
   * eagerSdkMcpHost=true to open the mcp-host + SDK lanes before any run). The
   * legacy prune runs on both paths so the eager mcp-host doesn't keep a stale
   * internet-egress policy the run path would have removed.
   */
  private async applyWorkflowNetworkPolicies(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    runtime: WorkflowRuntimePlan,
    awaitsTriggeredRun: boolean,
    eagerSdkMcpHost = false
  ): Promise<void> {
    const policies = await this.buildWorkflowNetworkPoliciesForSpec(
      recipeName,
      recipeUid,
      spec,
      runtime,
      awaitsTriggeredRun,
      eagerSdkMcpHost
    )
    for (const policy of policies) {
      await this.applyNetworkPolicy(policy)
    }
    await this.pruneLegacyMcpServersInternetEgressPolicy(recipeName)
  }

  private async resolveRuntimeHttpEgressPolicyState(
    namespace: string,
    policyNames: string[],
    hosts: string[]
  ): Promise<RuntimeHttpEgressPolicyState> {
    const now = new Date()
    const currentCidrs = normalizeCidrs(
      await (this.deps.resolveRuntimeHttpEgressCidrs ?? resolveRuntimeHttpEgressCidrs)(hosts)
    )
    const currentSerialized = serializeCidrs(currentCidrs)
    const previousExpiries = new Map<string, Date>()

    // Coordinator and snippet policies share one WorkflowRecipe runtimeEgress contract.
    // Merge valid annotations from all matching policies so a partial refresh or restart
    // preserves the widest still-active overlap window before writing identical state back.
    // Taking the latest expiration avoids one policy shortening another policy's DNS rollover.
    for (const policyName of policyNames) {
      const annotations = await this.readNetworkPolicyAnnotations(namespace, policyName)
      if (!annotations) continue

      const existingCurrent = parseCidrsAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_CURRENT_CIDRS_ANNOTATION]
      )
      if (existingCurrent.length > 0 && serializeCidrs(existingCurrent) !== currentSerialized) {
        const rolloverExpiresAt = new Date(now.getTime() + this.runtimeHttpEgressOverlapMs)
        for (const cidr of existingCurrent.filter(isAllowedRuntimeHttpEgressCidr)) {
          addRuntimeHttpEgressPreviousExpiry(previousExpiries, cidr, rolloverExpiresAt)
        }
      }

      const existingPreviousExpiresAt = parseFutureDate(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_EXPIRES_AT_ANNOTATION],
        now,
        this.maxTrustedRuntimeHttpEgressPreviousExpiryMs
      )
      const hasPreviousCidrExpiriesAnnotation =
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION] !== undefined
      const existingPreviousExpiries = parseTrustedRuntimeHttpEgressCidrExpiriesAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION],
        now,
        this.maxTrustedRuntimeHttpEgressPreviousExpiryMs
      )
      for (const cidr of parseTrustedRuntimeHttpEgressCidrsAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDRS_ANNOTATION]
      )) {
        const expiresAt = hasPreviousCidrExpiriesAnnotation
          ? existingPreviousExpiries.get(cidr)
          : existingPreviousExpiresAt
        if (expiresAt) {
          addRuntimeHttpEgressPreviousExpiry(previousExpiries, cidr, expiresAt)
        }
      }
    }

    const activePreviousEntries = [...previousExpiries.entries()].filter(
      ([, expiresAt]) => expiresAt.getTime() > now.getTime()
    )
    const activePreviousCidrs = normalizeCidrs(activePreviousEntries.map(([cidr]) => cidr))
    const effectiveCidrs = normalizeCidrs([...currentCidrs, ...activePreviousCidrs])
    if (effectiveCidrs.length > MAX_RUNTIME_HTTP_EGRESS_POLICY_CIDRS) {
      throw new Error(
        `runtime HTTP egress resolved ${effectiveCidrs.length} CIDRs, exceeding max ${MAX_RUNTIME_HTTP_EGRESS_POLICY_CIDRS}`
      )
    }

    const annotations: Record<string, string> = {
      [RUNTIME_HTTP_EGRESS_CURRENT_CIDRS_ANNOTATION]: currentSerialized,
      // Observability only; policy decisions use current/previous CIDR annotations above.
      [RUNTIME_HTTP_EGRESS_RESOLVED_AT_ANNOTATION]: now.toISOString(),
    }
    if (activePreviousCidrs.length > 0) {
      const activePreviousExpiries = new Map(activePreviousEntries)
      const previousExpiresAt = [...activePreviousExpiries.values()].reduce<Date | undefined>(
        latestDate,
        undefined
      )
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDRS_ANNOTATION] =
        serializeCidrs(activePreviousCidrs)
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_EXPIRES_AT_ANNOTATION] =
        previousExpiresAt!.toISOString()
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION] =
        serializeRuntimeHttpEgressCidrExpiries(activePreviousExpiries)
    }

    return { currentCidrs, effectiveCidrs, annotations }
  }

  private async readExistingRuntimeHttpEgressPolicyState(
    namespace: string,
    policyNames: string[]
  ): Promise<RuntimeHttpEgressPolicyState | undefined> {
    const now = new Date()
    const currentCidrs = new Set<string>()
    const previousExpiries = new Map<string, Date>()
    let latestResolvedAt: Date | undefined
    let prunedPrevious = false

    for (const policyName of policyNames) {
      const annotations = await this.readNetworkPolicyAnnotations(namespace, policyName)
      if (!annotations) continue

      for (const cidr of parseTrustedRuntimeHttpEgressCidrsAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_CURRENT_CIDRS_ANNOTATION]
      )) {
        currentCidrs.add(cidr)
      }

      latestResolvedAt = latestDate(
        latestResolvedAt,
        parseDate(annotations[RUNTIME_HTTP_EGRESS_RESOLVED_AT_ANNOTATION])
      )
      const existingPreviousExpiresAt = parseFutureDate(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_EXPIRES_AT_ANNOTATION],
        now,
        this.maxTrustedRuntimeHttpEgressPreviousExpiryMs
      )
      const hasPreviousCidrExpiriesAnnotation =
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION] !== undefined
      const existingPreviousExpiries = parseTrustedRuntimeHttpEgressCidrExpiriesAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION],
        now,
        this.maxTrustedRuntimeHttpEgressPreviousExpiryMs
      )
      const rawPreviousCidrs = parseCidrsAnnotation(
        annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDRS_ANNOTATION]
      )
      for (const cidr of rawPreviousCidrs) {
        if (!isAllowedRuntimeHttpEgressCidr(cidr)) {
          prunedPrevious = true
          continue
        }
        const expiresAt = hasPreviousCidrExpiriesAnnotation
          ? existingPreviousExpiries.get(cidr)
          : existingPreviousExpiresAt
        if (expiresAt && expiresAt.getTime() > now.getTime()) {
          addRuntimeHttpEgressPreviousExpiry(previousExpiries, cidr, expiresAt)
        } else {
          prunedPrevious = true
        }
      }
    }

    if (!prunedPrevious) return undefined
    const trustedCurrentCidrs = normalizeCidrs([...currentCidrs])
    if (trustedCurrentCidrs.length === 0) return undefined
    const activePreviousEntries = [...previousExpiries.entries()].filter(
      ([, expiresAt]) => expiresAt.getTime() > now.getTime()
    )
    const activePreviousCidrs = normalizeCidrs(activePreviousEntries.map(([cidr]) => cidr))
    const effectiveCidrs = normalizeCidrs([...trustedCurrentCidrs, ...activePreviousCidrs])
    const annotations: Record<string, string> = {
      [RUNTIME_HTTP_EGRESS_CURRENT_CIDRS_ANNOTATION]: serializeCidrs(trustedCurrentCidrs),
    }
    if (latestResolvedAt) {
      annotations[RUNTIME_HTTP_EGRESS_RESOLVED_AT_ANNOTATION] = latestResolvedAt.toISOString()
    }
    if (activePreviousCidrs.length > 0) {
      const activePreviousExpiries = new Map(activePreviousEntries)
      const previousExpiresAt = [...activePreviousExpiries.values()].reduce<Date | undefined>(
        latestDate,
        undefined
      )
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDRS_ANNOTATION] =
        serializeCidrs(activePreviousCidrs)
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_EXPIRES_AT_ANNOTATION] =
        previousExpiresAt!.toISOString()
      annotations[RUNTIME_HTTP_EGRESS_PREVIOUS_CIDR_EXPIRIES_ANNOTATION] =
        serializeRuntimeHttpEgressCidrExpiries(activePreviousExpiries)
    }
    return { currentCidrs: trustedCurrentCidrs, effectiveCidrs, annotations }
  }

  private get runtimeHttpEgressOverlapMs(): number {
    return (
      (this.deps.config.runtimeEgressDnsOverlapSeconds ??
        DEFAULT_RUNTIME_HTTP_EGRESS_DNS_OVERLAP_SECONDS) * 1_000
    )
  }

  private get maxTrustedRuntimeHttpEgressPreviousExpiryMs(): number {
    return this.runtimeHttpEgressOverlapMs * 2
  }

  private async readNetworkPolicyAnnotations(
    namespace: string,
    name: string
  ): Promise<Record<string, string> | undefined> {
    try {
      const policy = await this.deps.networkingApi.readNamespacedNetworkPolicy({ namespace, name })
      return policy.metadata?.annotations ?? {}
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) return undefined
      throw error
    }
  }

  private annotateRuntimeHttpEgressPolicies(
    policies: k8s.V1NetworkPolicy[],
    names: Set<string>,
    annotations: Record<string, string>
  ): void {
    for (const policy of policies) {
      if (!names.has(policy.metadata?.name ?? '')) continue
      policy.metadata = {
        ...policy.metadata,
        annotations: {
          ...(policy.metadata?.annotations ?? {}),
          ...annotations,
        },
      }
    }
  }

  async reconcileDelete(
    recipeName: string,
    recipeNamespace?: string,
    spec?: WorkflowRecipeSpec
  ): Promise<void> {
    const ns = this.deps.config.sandboxNamespace
    const log = createLogger('wrc', recipeName)
    log.info(`Deleting workflow resources`)
    this.pluginWorkloadSdkProvisioner.clearRecipeState(recipeName)

    // Best-effort cleanup of the recipe's subdirectory on the workflow output PVC.
    // Must run BEFORE pod deletion while mcp-host is still reachable; failures
    // are logged and swallowed so a transient HTTP error does not strand the
    // CRD finalizer. A small amount of stale data in the recipe output scope is
    // preferable to an undeletable WorkflowRecipe.
    // recipeNamespace is optional on reconcileDelete's signature (legacy); fall
    // back to the sandbox default when the caller didn't supply it. After the
    // full CRD watcher propagation every path carries the namespace.
    await this.cleanupRecipeArtifacts(recipeName, recipeNamespace ?? ns)

    // Idempotent delete of the workflow_schedules row. No-op if the recipe
    // never had scheduling or the row was already cleared.
    if (this.deps.pgPool && recipeNamespace) {
      try {
        await deleteScheduling(this.deps.pgPool, recipeNamespace, recipeName)
      } catch (err) {
        log.error('Failed to delete workflow_schedules row', {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Cleanup trigger grants, approval target allowlists, and live approval
      // requests. Without this, a
      // recipe-delete + recipe-recreate cycle with the same name inherits
      // stale user/team grant, team approval target rows, or pending/approved
      // approval decisions from the prior incarnation.
      //
      // Pattern mirrors the scheduling delete above — same pool, same
      // ns/name scoping, same idempotent semantics. Failure logged and
      // swallowed: stranding the CRD finalizer over a transient DB blip
      // is worse than an orphaned grant row that a human can DELETE by
      // hand if needed.
      try {
        const client = await this.deps.pgPool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `DELETE FROM user_workflow_triggers
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
            [recipeNamespace, recipeName]
          )
          await client.query(
            `DELETE FROM team_workflow_triggers
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
            [recipeNamespace, recipeName]
          )
          await client.query(
            `DELETE FROM workflow_recipe_allowed_teams
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
            [recipeNamespace, recipeName]
          )
          const legacyAllowedUsers = await client.query(
            `SELECT to_regclass('public.workflow_recipe_allowed_users')::text AS "regclass"`
          )
          const legacyAllowedUsersRow = legacyAllowedUsers.rows[0] as
            | { regclass?: string | null }
            | undefined
          if (legacyAllowedUsersRow?.regclass) {
            await client.query(
              `DELETE FROM workflow_recipe_allowed_users
                WHERE recipe_namespace = $1 AND recipe_name = $2`,
              [recipeNamespace, recipeName]
            )
          }
          await client.query(
            `UPDATE workflow_approval_requests
                SET status = 'cancelled',
                    cancelled_at = COALESCE(cancelled_at, NOW()),
                    cancelled_by = COALESCE(cancelled_by, 'workflow-recipe-delete')
              WHERE recipe_namespace = $1
                AND recipe_name = $2
                AND status IN ('pending', 'approved')`,
            [recipeNamespace, recipeName]
          )
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(rollbackErr => {
            log.error('Failed to rollback workflow trigger policy cleanup', {
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            })
          })
          throw err
        } finally {
          client.release()
        }
      } catch (err) {
        log.error('Failed to delete workflow trigger policy rows', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Parallelize all independent deletions with allSettled so one failure
    // doesn't prevent the remaining cleanup attempts. Runtime pod/PVC deletion
    // failures are rethrown after all attempts so the CRD finalizer retries.
    const npNames = [
      `${recipeName}-coord-to-mcp-host`,
      `${recipeName}-coord-to-mcp-host-ingress`,
      `${recipeName}-coord-to-wrc`,
      `${recipeName}-wrc-to-mcp-host`,
      `${recipeName}-wrc-to-artifact-reader`,
      `${recipeName}-mcp-host-to-servers`,
      `${recipeName}-mcp-host-to-llm-api`,
      `${recipeName}-mcp-host-to-approval-gateway`,
      `${recipeName}-coord-to-snippet-runner`,
      `${recipeName}-coord-to-snippet-runner-ingress`,
      `${recipeName}-snippet-runner-egress`,
    ]
    // NP-02: wf-mcp-host-ingress lives in mcpServerNamespace, not sandboxNamespace.
    // NP-03: now one NP per mcp-server (named `wf-mcp-ingress-${mcpServerName}`).
    // List-by-label is the cleanest cleanup — all managed NPs have recipe label.
    const mcpServerNpNames: string[] = [] // legacy single-NP name no longer used;
    // per-mcp-server NPs are deleted via label selector below.
    const mcpNs = this.deps.config.mcpServerNamespace

    const cleanupTasks: Array<{ label: string; run: () => Promise<void> }> = [
      {
        label: `Pod "${recipeName}-coordinator"`,
        run: () => deletePodIfExists(this.deps.coreApi, `${recipeName}-coordinator`, ns),
      },
      {
        label: `Pod "${recipeName}-mcp-host"`,
        run: () => deletePodIfExists(this.deps.coreApi, `${recipeName}-mcp-host`, ns),
      },
      {
        label: `Pod "${recipeName}-artifact-reader"`,
        run: () => deletePodIfExists(this.deps.coreApi, `${recipeName}-artifact-reader`, ns),
      },
      {
        label: `Pod "${recipeName}-snippet-runner"`,
        run: () => deletePodIfExists(this.deps.coreApi, `${recipeName}-snippet-runner`, ns),
      },
      {
        label: `Pod "${buildWorkflowOutputPreparePodName(recipeName)}"`,
        run: () =>
          deletePodIfExists(this.deps.coreApi, buildWorkflowOutputPreparePodName(recipeName), ns),
      },
      {
        label: `Pod "${buildWorkflowOutputAnchorPodName(recipeName)}"`,
        run: () =>
          deletePodIfExists(this.deps.coreApi, buildWorkflowOutputAnchorPodName(recipeName), ns),
      },
      {
        label: `Secret "wf-${recipeName}-coordinator-token"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedSecret({
              name: `wf-${recipeName}-coordinator-token`,
              namespace: ns,
            })
          ),
      },
      {
        label: `Secret "wf-${recipeName}-mcp-host-runtime-tokens"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedSecret({
              name: `wf-${recipeName}-mcp-host-runtime-tokens`,
              namespace: ns,
            })
          ),
      },
      {
        // Plugin Workload SDK workload token — provisioned by the eager SDK path
        // (ensurePluginWorkloadSdkTokenSecret); tear it down with the recipe.
        label: `Secret "${buildPluginWorkloadSdkTokenSecretName(recipeName)}"`,
        run: () => this.pluginWorkloadSdkProvisioner.deletePluginWorkloadSdkTokenSecret(recipeName),
      },
      {
        label: `ConfigMap "wf-${recipeName}-soul-md"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedConfigMap({
              name: `wf-${recipeName}-soul-md`,
              namespace: ns,
            })
          ),
      },
      {
        label: `ConfigMap "${recipeName}-workflow-config"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedConfigMap({
              name: `${recipeName}-workflow-config`,
              namespace: ns,
            })
          ),
      },
      {
        label: `Service "${buildMcpHostServiceName(recipeName)}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedService({
              name: buildMcpHostServiceName(recipeName),
              namespace: ns,
            })
          ),
      },
      {
        label: `Service "${buildMcpHostRouteAliasServiceName(recipeName, ns)}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedService({
              name: buildMcpHostRouteAliasServiceName(recipeName, ns),
              namespace: ns,
            })
          ),
      },
      {
        label: `Service "${buildArtifactReaderServiceName(recipeName)}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedService({
              name: buildArtifactReaderServiceName(recipeName),
              namespace: ns,
            })
          ),
      },
      {
        label: `Service "${buildSnippetRunnerServiceName(recipeName)}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteNamespacedService({
              name: buildSnippetRunnerServiceName(recipeName),
              namespace: ns,
            })
          ),
      },
      ...npNames.map(npName => ({
        label: `NetworkPolicy "${npName}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.networkingApi.deleteNamespacedNetworkPolicy({ name: npName, namespace: ns })
          ),
      })),
      // Snippet per-workload ingress policies are generated from workload
      // resource names and may be hash-suffixed when long. Delete by the same
      // exact WRC recipe labels used at creation so dynamic names cannot linger.
      {
        label: 'NetworkPolicies by sandbox recipe label',
        run: () =>
          this.safeDelete(() =>
            this.deleteNetworkPoliciesByLabelSelector(
              ns,
              `clerum.io/recipe=${recipeName},clerum.io/managed-by=wrc`
            )
          ),
      },
      ...mcpServerNpNames.map(npName => ({
        label: `NetworkPolicy "${npName}"`,
        run: () =>
          this.safeDelete(() =>
            this.deps.networkingApi.deleteNamespacedNetworkPolicy({
              name: npName,
              namespace: mcpNs,
            })
          ),
      })),
      // NP-03: Delete per-mcp-server ingress NPs by label selector (wf-mcp-ingress-*).
      {
        label: 'NetworkPolicies by mcp-server recipe label',
        run: () =>
          this.safeDelete(() =>
            this.deleteNetworkPoliciesByLabelSelector(
              mcpNs,
              `clerum.io/recipe=${recipeName},clerum.io/managed-by=wrc`
            )
          ),
      },
      // Clean up per-workload transport Services in mcp-server. Agentic
      // recipes WITHOUT contextRef have their Services created by WRC directly
      // (not via HCC delegation), and adjustManifestNamespace strips ownerRefs
      // because the recipe CRD lives in sandbox-recipes while the Service
      // lives in mcp-server (cross-namespace ownerRefs are invalid). K8s GC
      // will not collect them on CRD delete, so we sweep them here.
      //
      // Label selector uses `clerum.io/managed-by=workflow-recipes` (NOT
      // `wrc`) because that is the value emitted by `standardLabels()` in
      // resourceBuilder.ts; the `wrc` value above only tags NetworkPolicy
      // objects that workflowReconciler itself builds.
      {
        label: 'Transport Services by mcp-server recipe label',
        run: () =>
          this.safeDelete(() =>
            this.deps.coreApi.deleteCollectionNamespacedService({
              namespace: mcpNs,
              labelSelector: `clerum.io/recipe=${recipeName},clerum.io/managed-by=workflow-recipes`,
            })
          ),
      },
    ]

    // Child runs use the parent recipe's workflow output PVC, so deleting a
    // child may 404 here. The parent PVC is deleted with the parent recipe.
    // Explicit external output claims are operator-owned even if they reuse
    // the generated claim name, so never delete when the deleted CRD declares
    // spec.output.claimName.
    if (!trimOutputClaimName(spec)) {
      const pvcName = buildWorkflowOutputPvcName(recipeName)
      cleanupTasks.push({
        label: `PersistentVolumeClaim "${pvcName}"`,
        run: () => this.deletePersistentVolumeClaimIfExists(pvcName, ns),
      })
    }

    const cleanupResults = await Promise.allSettled(cleanupTasks.map(task => task.run()))
    const failures = cleanupResults.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              label: cleanupTasks[index]?.label ?? `cleanup task ${index}`,
              reason: result.reason,
            },
          ]
        : []
    )
    if (failures.length > 0) {
      for (const failure of failures) {
        log.error('Workflow runtime resource cleanup failed', {
          resource: failure.label,
          error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        })
      }
      throw new Error(
        `Failed to delete workflow runtime resources: ${failures.map(f => f.label).join(', ')}`
      )
    }
  }

  private async deleteNetworkPoliciesByLabelSelector(
    namespace: string,
    labelSelector: string
  ): Promise<void> {
    const list = await this.deps.networkingApi.listNamespacedNetworkPolicy({
      namespace,
      labelSelector,
    })
    await Promise.all(
      (list.items ?? [])
        .map(policy => policy.metadata?.name)
        .filter((name): name is string => Boolean(name))
        .map(name => this.deps.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace }))
    )
  }

  /**
   * Best-effort artifact cleanup before pod teardown. Prefer artifact-reader
   * because it exists for every `/output`-backed run; fall back to mcp-host for
   * older or partially reconciled runs. Failures are swallowed so a transient
   * HTTP error never blocks the finalizer.
   */
  private async cleanupRecipeArtifacts(recipeName: string, recipeNamespace: string): Promise<void> {
    const log = createLogger('wrc', recipeName)
    const candidates = [
      {
        component: 'artifact-reader',
        serviceName: buildArtifactReaderServiceName(recipeName),
        url: buildArtifactReaderUrl(recipeName, this.deps.config.sandboxNamespace),
      },
      {
        component: 'mcp-host',
        serviceName: buildMcpHostServiceName(recipeName),
        url: buildMcpHostUrl(recipeName, this.deps.config.sandboxNamespace),
      },
    ]

    const availableCandidates: typeof candidates = []
    for (const candidate of candidates) {
      try {
        await this.deps.coreApi.readNamespacedService({
          name: candidate.serviceName,
          namespace: this.deps.config.sandboxNamespace,
        })
      } catch (err) {
        if (getErrorCode(err) === 404) {
          log.info(`artifact cleanup: ${candidate.component} service absent; skipping target`)
          continue
        }
        log.warn(`artifact cleanup: failed to check ${candidate.component} service`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      availableCandidates.push(candidate)
    }

    if (availableCandidates.length === 0) {
      log.info('artifact cleanup: no artifact cleanup service found; skipping HTTP cleanup')
      return
    }

    let token: string
    try {
      token = await this.deps.tokenFactory.signWrcArtifactDeleteToken(recipeName, recipeNamespace)
    } catch (err) {
      log.warn('artifact cleanup: failed to mint delete token; skipping', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    for (const candidate of availableCandidates) {
      const target = `${candidate.url}/api/v1/workflow/artifacts`
      try {
        const res = await fetch(target, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok) {
          log.warn(`artifact cleanup: ${candidate.component} returned non-2xx`, {
            status: res.status,
          })
          continue
        }
        log.info(`artifact cleanup: ${candidate.component} /artifacts DELETE succeeded`)
        // Once `/output` cleanup succeeds, remaining mcp-host artifacts are pod-local /tmp scratch.
        // Pod deletion clears that ephemeral data; there is no second durable store to clean.
        return
      } catch (err) {
        log.warn(`artifact cleanup: ${candidate.component} DELETE request failed`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private validateCustomCoordinatorImagePolicy(image: string | undefined): string | undefined {
    if (!image) return undefined
    if (this.deps.config.enableCustomCoordinatorImage !== true) {
      return 'custom coordinator images are disabled'
    }
    if (hasUnsafeImageReferenceSyntax(image)) {
      return 'custom coordinator image reference is invalid'
    }
    if (hasLatestTag(image)) {
      return 'custom coordinator image must not use :latest'
    }
    if (hasInvalidDigest(image)) {
      return 'custom coordinator image digest must be a valid sha256 digest'
    }
    if (this.deps.config.requireCoordinatorImageDigest === true && !hasValidSha256Digest(image)) {
      return 'custom coordinator image must include a valid sha256 digest'
    }
    const prefixes = this.deps.config.allowedCoordinatorImagePrefixes ?? []
    if (prefixes.length === 0) {
      return 'custom coordinator image allowlist is empty'
    }
    if (!prefixes.some(prefix => matchesAllowedImagePrefix(image, prefix))) {
      return 'custom coordinator image is not allowed by WRC policy'
    }
    return undefined
  }

  /**
   * Provision the mcp-host's backing Secrets: the runtime-token Secret (always)
   * and the Plugin Workload SDK workload-token Secret (when the SDK is enabled
   * and declared). Shared by the triggered-run path and the eager SDK path so
   * the two cannot drift on which Secrets the pod needs to boot Ready.
   */
  private async ensureMcpHostSecrets(
    namespace: string,
    recipeName: string,
    runtimeScopeRecipeName: string,
    spec: WorkflowRecipeSpec
  ): Promise<void> {
    await this.ensureMcpHostRuntimeTokenSecret(
      namespace,
      recipeName,
      runtimeScopeRecipeName,
      deriveWorkflowControlScopes(spec, {
        pluginWorkloadSdkEnabled: this.deps.config.pluginWorkloadSdkEnabled,
      }),
      deriveRecipeHostGfsScopes(spec)
    )
    if (this.deps.config.pluginWorkloadSdkEnabled && spec.pluginWorkloadSdk) {
      await this.pluginWorkloadSdkProvisioner.ensurePluginWorkloadSdkTokenSecret(recipeName, spec)
    }
  }

  /**
   * Create the mcp-host headless Service that backs its in-cluster DNS name
   * (wf-<recipe>-mcp-host). Shared by the triggered-run and eager SDK paths;
   * without it the SDK endpoint and coordinator→mcp-host calls fail at DNS.
   */
  private async ensureMcpHostHeadlessService(recipeName: string): Promise<void> {
    const headlessSvc = buildMcpHostHeadlessService(recipeName, this.deps.config.sandboxNamespace)
    const namespace = this.deps.config.sandboxNamespace
    const name = buildMcpHostServiceName(recipeName)
    try {
      await this.deps.coreApi.createNamespacedService({ namespace, body: headlessSvc })
      this.log.info(`Created Headless Service "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) throw error
      const existing = await this.deps.coreApi.readNamespacedService({ name, namespace })
      // Skip the replace when the live Service already matches the desired
      // spec — this method runs on every eager reconcile, and an unconditional
      // GET+PUT churns resourceVersions and apiserver writes for no drift.
      const normalizePorts = (ports: k8s.V1ServicePort[] | undefined) =>
        (ports ?? []).map(p => ({
          name: p.name ?? null,
          port: p.port,
          targetPort: p.targetPort ?? null,
          protocol: p.protocol ?? 'TCP',
        }))
      const desiredSpec = {
        selector: headlessSvc.spec?.selector ?? null,
        ports: normalizePorts(headlessSvc.spec?.ports),
      }
      const existingSpec = {
        selector: existing.spec?.selector ?? null,
        ports: normalizePorts(existing.spec?.ports),
      }
      if (JSON.stringify(desiredSpec) === JSON.stringify(existingSpec)) {
        return
      }
      const updatedSvc: k8s.V1Service = {
        ...headlessSvc,
        metadata: {
          ...headlessSvc.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        },
        spec: {
          ...headlessSvc.spec,
          clusterIP: existing.spec?.clusterIP ?? headlessSvc.spec?.clusterIP,
        },
      }
      await this.deps.coreApi.replaceNamespacedService({ name, namespace, body: updatedSvc })
      this.log.info(`Updated Headless Service "${name}"`)
    }
  }

  /**
   * True when the existing mcp-host pod carries the workflow-output mount (its
   * presence is signalled by the output-claim label). Eager SDK pods are built
   * without the mount, so a missing label means the pod must be recreated before
   * a triggered run that needs output. Returns true on read failure (fail-safe:
   * don't churn a pod we can't inspect).
   */
  private async mcpHostPodHasWorkflowOutputMount(recipeName: string): Promise<boolean> {
    try {
      const pod = await this.deps.coreApi.readNamespacedPod({
        name: `${recipeName}-mcp-host`,
        namespace: this.deps.config.sandboxNamespace,
      })
      return pod.metadata?.labels?.[WORKFLOW_OUTPUT_CLAIM_LABEL] !== undefined
    } catch {
      return true
    }
  }

  private resolveMcpHostAgent(spec: WorkflowRecipeSpec): AgentSpec | undefined {
    return resolveMcpHostAgent(spec)
  }

  private validateWorkflowOutputSpec(spec: WorkflowRecipeSpec): string | undefined {
    const claimName = trimOutputClaimName(spec)
    if (!claimName) return undefined

    if (spec.output?.destination !== 'pvc') {
      return 'spec.output.claimName requires spec.output.destination=pvc'
    }
    if (claimName.length > 253 || !DNS_SUBDOMAIN_RE.test(claimName)) {
      return 'spec.output.claimName must be a valid Kubernetes PVC name'
    }
    const namespace = spec.output?.namespace?.trim()
    if (namespace && namespace !== this.deps.config.sandboxNamespace) {
      return `spec.output.namespace must be omitted or match ${this.deps.config.sandboxNamespace}; workflow output PVCs are mounted in the runtime namespace`
    }
    return undefined
  }

  private validateExecutableSteps(spec: WorkflowRecipeSpec): string | undefined {
    const limitError = validateWorkflowRecipeLimits(spec, this.deps.config)
    if (limitError) return limitError

    const steps = spec.steps ?? []
    try {
      buildExecutionGroups(steps.map(step => ({ id: step.id, dependsOn: step.dependsOn ?? [] })))
    } catch (err) {
      if (err instanceof CyclicDependencyError) {
        return `dependency cycle detected: ${err.cycle.join(' -> ')}`
      }
      if (err instanceof UnknownDependencyError) {
        return `step "${err.stepId}" depends on unknown step "${err.unknownDependency}"`
      }
      throw err
    }

    for (const step of steps) {
      const hasRun = step.run !== undefined
      const hasInstruction = typeof step.instruction === 'string' && step.instruction.trim() !== ''
      const hasCustomCoordinator = getCustomCoordinatorImage(spec) !== undefined
      const hasBrokerAgent = hasCompleteAgent(spec.agent) || hasCompleteAgent(step.agent)
      const needsBroker =
        hasInstruction ||
        Boolean(step.agent) ||
        Boolean(step.mcpServers?.length) ||
        Boolean(step.requiresApproval)
      if (hasRun && hasInstruction) {
        return `step "${step.id}" cannot configure both run and instruction`
      }
      if (!hasCustomCoordinator && hasRun === hasInstruction) {
        return `step "${step.id}" must configure exactly one of run or instruction`
      }
      if (hasRun) {
        const run = step.run
        if (step.agent) {
          return `step "${step.id}" cannot configure an agent when run is set`
        }
        if (step.requiresApproval) {
          return `step "${step.id}" cannot require approval when run is set`
        }
        if (!isSnippetRun(run)) return `step "${step.id}" run.type must be snippet`
        const snippetError = this.validateSnippetStep(step.id, run, spec)
        if (snippetError) return snippetError
      } else if (hasCustomCoordinator && needsBroker && !hasBrokerAgent) {
        if (step.requiresApproval) {
          return `step "${step.id}" requires an agent configuration for approval`
        }
        return `step "${step.id}" requires an agent configuration for broker-backed custom execution`
      } else if (hasInstruction && !spec.agent && (!step.agent?.provider || !step.agent.model)) {
        return `step "${step.id}" requires an agent configuration`
      } else if (step.requiresApproval && !needsWorkflowMcpHost(spec)) {
        return `step "${step.id}" requires an agentic broker for approval`
      }
    }
    return undefined
  }

  private validateSnippetStep(
    stepId: string,
    run: WorkflowSnippetRunSpec,
    spec: WorkflowRecipeSpec
  ): string | undefined {
    for (const key of Object.keys(run as unknown as Record<string, unknown>)) {
      if (!SNIPPET_RUN_KEYS.has(key))
        return `step "${stepId}" run contains unsupported field "${key}"`
    }
    if (run.language !== 'typescript') {
      return `step "${stepId}" snippet language must be typescript`
    }
    if (typeof run.code !== 'string' || run.code.trim() === '') {
      return `step "${stepId}" snippet code must be a non-empty string`
    }
    if (run.code.length > MAX_SNIPPET_CODE_LENGTH) {
      return `step "${stepId}" snippet code exceeds ${MAX_SNIPPET_CODE_LENGTH} characters`
    }

    const workloadIds = new Set((spec.workloads ?? []).map(workload => workload.id))
    const mcpServerIds = new Set((spec.mcpServers ?? []).map(server => server.id))
    for (const workload of spec.workloads ?? []) {
      if (workload.transport) mcpServerIds.add(workload.id)
    }

    const mongoAccess = run.capabilities?.mongo?.access
    if (run.capabilities?.mongo && mongoAccess !== 'read' && mongoAccess !== 'readWrite') {
      return `step "${stepId}" mongo capability must declare access read or readWrite`
    }
    for (const workload of run.capabilities?.mongo?.workloads ?? []) {
      if (!workloadIds.has(workload)) {
        return `step "${stepId}" references undeclared mongo workload "${workload}"`
      }
    }
    const postgresAccess = run.capabilities?.postgres?.access
    if (run.capabilities?.postgres && postgresAccess !== 'read' && postgresAccess !== 'readWrite') {
      return `step "${stepId}" postgres capability must declare access read or readWrite`
    }
    for (const workload of run.capabilities?.postgres?.workloads ?? []) {
      if (!workloadIds.has(workload)) {
        return `step "${stepId}" references undeclared postgres workload "${workload}"`
      }
    }

    const secretAliases = new Set<string>()
    for (const secret of run.capabilities?.secrets ?? []) {
      if (!SNIPPET_SECRET_ALIAS_RE.test(secret.alias)) {
        return `step "${stepId}" has invalid snippet secret alias "${secret.alias}"`
      }
      if (secretAliases.has(secret.alias)) {
        return `step "${stepId}" declares duplicate snippet secret alias "${secret.alias}"`
      }
      secretAliases.add(secret.alias)
      if (!secret.secretRef?.name || !secret.secretRef?.key) {
        return `step "${stepId}" snippet secret alias "${secret.alias}" must reference name and key`
      }
      if (secret.secretRef.name.startsWith('wf-')) {
        return `step "${stepId}" cannot reference platform-managed secret "${secret.secretRef.name}"`
      }
    }

    const workflowHttpClass = runtimeHttpEgressClass(spec)
    const requestedHttpClass = run.capabilities?.http?.egressClass ?? 'exact-host'
    if (requestedHttpClass !== 'exact-host' && requestedHttpClass !== 'public-web') {
      return `step "${stepId}" HTTP egressClass must be exact-host or public-web`
    }
    const workflowHttpHosts = new Set(spec.runtimeEgress?.http?.allowedHosts ?? [])
    const requestedHttpHosts = run.capabilities?.http?.allowedHosts ?? []
    if (requestedHttpClass === 'public-web') {
      if (workflowHttpClass !== 'public-web') {
        return `step "${stepId}" HTTP egressClass public-web requires spec.runtimeEgress.http.egressClass public-web`
      }
      if (requestedHttpHosts.length > 0) {
        return `step "${stepId}" HTTP allowedHosts must be omitted when egressClass is public-web`
      }
    }
    if (
      requestedHttpClass === 'exact-host' &&
      workflowHttpClass === 'public-web' &&
      requestedHttpHosts.length > 0
    ) {
      return `step "${stepId}" HTTP allowedHosts cannot be used when spec.runtimeEgress.http.egressClass is public-web`
    }
    for (const host of requestedHttpHosts) {
      const hostError = validatePublicHttpHost(host)
      if (hostError) return `step "${stepId}" ${hostError}`
      if (!workflowHttpHosts.has(host)) {
        return `step "${stepId}" HTTP host "${host}" must be declared in spec.runtimeEgress.http.allowedHosts`
      }
    }

    const requestedMcpServers = run.capabilities?.mcp?.servers ?? []
    for (const server of requestedMcpServers) {
      if (!mcpServerIds.has(server)) {
        return `step "${stepId}" references undeclared MCP server "${server}"`
      }
    }
    if (requestedMcpServers.length > 0) {
      const allowedTools = run.capabilities?.mcp?.allowedTools?.include ?? []
      if (allowedTools.length === 0) {
        return `step "${stepId}" must declare explicit MCP allowedTools`
      }
      for (const tool of allowedTools) {
        if (tool.includes('*')) {
          return `step "${stepId}" snippet MCP allowedTools cannot include wildcards`
        }
        if (!requestedMcpServers.some(server => tool.startsWith(`${server}__`))) {
          return `step "${stepId}" snippet MCP tool "${tool}" must be scoped to an allowed server`
        }
      }
    }

    return undefined
  }

  private async validateSnippetSecretRefs(
    recipeName: string,
    spec: WorkflowRecipeSpec,
    resourceInstances?: Record<string, string>
  ): Promise<string | undefined> {
    const ns = this.deps.config.sandboxNamespace
    const read = (name: string, namespace: string) =>
      this.deps.coreApi.readNamespacedSecret({ name, namespace })
    for (const secret of collectSnippetSecretRefs(spec, resourceInstances)) {
      // Issue #637 — route snippet capability Secrets through the SAME ownership
      // chokepoint as every other surface (classifySecretAccess), so the snippet
      // path cannot drift from the shared ownership/error semantics. The
      // snippet-runner pod mounts this Secret as a `secretKeyRef` env var in
      // sandbox-recipes; without this gate a recipe could name another recipe's
      // co-tenant Secret and exfiltrate its keys. Fail closed on ownership BEFORE
      // the key-presence check.
      const access = await classifySecretAccess(
        read,
        getErrorCode,
        secret.secretName,
        ns,
        recipeName
      )
      if (access.state === 'denied') {
        return (
          `snippet secret "${secret.secretName}" is not accessible to recipe ` +
          `"${recipeName}" — it requires clerum.io/shared=true or ` +
          `clerum.io/owner-recipe=${recipeName}`
        )
      }
      if (access.state === 'error') {
        // Ownership could not be verified (non-404 read error) — fail closed; the
        // outer reconcile maps the throw to a retryable/degraded outcome.
        throw new Error(
          `snippet secret "${secret.secretName}" ownership could not be verified in namespace "${ns}"`
        )
      }
      if (access.state === 'missing') {
        return `snippet secret "${secret.secretName}" was not found in namespace "${ns}"`
      }
      if (!access.keys.has(secret.secretKey)) {
        return (
          `snippet secret key "${secret.secretKey}" was not found in Secret ` +
          `"${secret.secretName}" in namespace "${ns}"`
        )
      }
    }
    return undefined
  }

  private resolveSnippetWorkloadNetworkBindings(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec
  ): Array<{ resourceName: string; port: number }> {
    const requestedIds = new Set(collectSnippetDatabaseWorkloadIds(spec))
    if (requestedIds.size === 0) return []
    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: {
        name: recipeName,
        namespace: this.deps.config.sandboxNamespace,
        uid: recipeUid,
      },
      spec,
    }
    return (spec.workloads ?? [])
      .filter(workload => requestedIds.has(workload.id))
      .map(workload => ({
        resourceName: resolveWorkloadRuntimeResourceName(recipeRef, workload),
        port: workload.port ?? (this.isPostgresSnippetWorkload(spec, workload.id) ? 5432 : 27017),
      }))
  }

  private resolveCustomCoordinatorWorkloadNetworkBindings(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec
  ): Array<{ resourceName: string; port: number }> {
    if (!spec.coordinatorImage?.trim()) return []
    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: {
        name: recipeName,
        namespace: this.deps.config.sandboxNamespace,
        uid: recipeUid,
      },
      spec,
    }
    return (spec.workloads ?? [])
      .filter(workload => !workload.transport && typeof workload.port === 'number')
      .map(workload => ({
        resourceName: resolveWorkloadRuntimeResourceName(recipeRef, workload),
        port: workload.port!,
      }))
  }

  private isPostgresSnippetWorkload(spec: WorkflowRecipeSpec, workloadId: string): boolean {
    return (spec.steps ?? []).some(
      step =>
        isSnippetRun(step.run) && step.run.capabilities?.postgres?.workloads?.includes(workloadId)
    )
  }

  private resolveSnippetMcpServerFullNames(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    workloadIdsWithTransport: ReadonlySet<string>,
    workloadMcpServerLabels = this.resolveTransportWorkloadMcpServerLabels(
      recipeName,
      recipeUid,
      spec
    )
  ): string[] {
    const requestedIds = new Set(collectSnippetMcpServerIds(spec))
    if (requestedIds.size === 0) return []
    const selected = new Map<string, { id: string; endpoint?: string }>()
    for (const server of spec.mcpServers ?? []) {
      if (requestedIds.has(server.id)) selected.set(server.id, server)
    }
    for (const workload of spec.workloads ?? []) {
      if (requestedIds.has(workload.id) && workload.transport) {
        selected.set(workload.id, { id: workload.id })
      }
    }
    return resolveMcpServerFullNames(
      recipeName,
      [...selected.values()],
      workloadIdsWithTransport,
      workloadMcpServerLabels
    )
  }

  private resolveTransportWorkloadMcpServerLabels(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec
  ): Map<string, string> {
    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: {
        name: recipeName,
        namespace: this.deps.config.sandboxNamespace,
        uid: recipeUid,
      },
      spec,
    }
    return new Map(
      (spec.workloads ?? [])
        .filter(workload => workload.transport != null)
        .map(workload => [workload.id, resolveWorkloadMcpServerLabel(recipeRef, workload)])
    )
  }

  // ─── SOUL.md ConfigMap ──────────────────────────────────────────────

  private async ensureSoulConfigMap(recipeName: string, spec: WorkflowRecipeSpec): Promise<void> {
    let soulContent =
      '# Default SOUL.md\nYou are a helpful AI assistant executing workflow steps.\n'

    if (spec.agent?.soulRef?.storageRef) {
      try {
        // Read storage credentials from control-plane
        const credSecret = await this.deps.coreApi.readNamespacedSecret({
          name: 'clerum-storage-credentials',
          namespace: 'control-plane',
        })
        const rawAccessKey = credSecret.data?.['access-key']
        const rawSecretKey = credSecret.data?.['secret-key']
        if (!rawAccessKey || !rawSecretKey) {
          throw new Error('Storage credentials Secret missing access-key or secret-key fields')
        }
        const creds: StorageCredentials = {
          accessKey: Buffer.from(rawAccessKey, 'base64').toString(),
          secretKey: Buffer.from(rawSecretKey, 'base64').toString(),
        }
        const ref: StorageRef = {
          ...spec.agent.soulRef.storageRef,
          provider: spec.agent.soulRef.storageRef.provider ?? 's3',
        }
        const client = new ObjectStorageClient(creds, ref)
        const content = await client.download(recipeName)
        soulContent = content.toString('utf-8')
      } catch (error) {
        createLogger('wrc', recipeName).error(`Failed to download SOUL.md`, {
          error: error instanceof Error ? error.message : String(error),
        })
        // Proceed with default — non-fatal
      }
    }

    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: `wf-${recipeName}-soul-md`,
        namespace: this.deps.config.sandboxNamespace,
        labels: {
          'clerum.io/recipe': recipeName,
          'clerum.io/managed-by': 'wrc',
        },
        // No ownerRef: cross-namespace ownerRefs are deleted by K8s GC (1.24+).
        // Cleanup handled explicitly by reconcileDelete() finalizer.
      },
      data: {
        'SOUL.md': soulContent,
      },
    }

    await this.createIfNotExists(
      () =>
        this.deps.coreApi.createNamespacedConfigMap({
          namespace: this.deps.config.sandboxNamespace,
          body: configMap,
        }),
      `ConfigMap "wf-${recipeName}-soul-md"`
    )
  }

  // ─── Workflow Config ConfigMap ──────────────────────────────────────

  private async ensureWorkflowConfigMap(
    recipeName: string,
    recipeUid: string,
    spec: WorkflowRecipeSpec,
    resolvedInputs?: Record<string, unknown>
  ): Promise<void> {
    // Substitute {{inputs.KEY}} placeholders in step instructions with resolved input values.
    // This ensures the coordinator Pod receives concrete values rather than template literals.
    const substituteInputs = (text: string): string => {
      if (!resolvedInputs) return text
      return text.replace(/\{\{inputs\.([\w-]+)\}\}/g, (_match, key: string) => {
        const val = resolvedInputs[key]
        return val !== undefined ? String(val) : `{{inputs.${key}}}`
      })
    }
    const effectiveInputs = resolvedInputs ?? spec.inputs
    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: {
        name: recipeName,
        namespace: this.deps.config.sandboxNamespace,
        uid: recipeUid,
      },
      spec,
    }
    // Build server registry from explicit mcpServers plus transport workloads.
    // The runner reads this mounted config as the source of truth for manual SDK
    // MCP calls; the coordinator request is only an invocation and cannot widen
    // endpoints or tools at runtime.
    const resolvedMcpServersForConfig = new Map<
      string,
      { id: string; endpoint: string; transport?: string }
    >()
    const serverRegistry = new Map<string, { name: string; url: string }>()
    for (const srv of (spec.mcpServers ?? []) as Array<{
      id: string
      endpoint?: string
      transport?: string
    }>) {
      if (!srv.id || !srv.endpoint) continue
      resolvedMcpServersForConfig.set(srv.id, {
        id: srv.id,
        endpoint: srv.endpoint,
        ...(srv.transport && { transport: srv.transport }),
      })
      serverRegistry.set(srv.id, { name: srv.id, url: srv.endpoint })
    }
    for (const workload of spec.workloads ?? []) {
      if (!workload.transport || !workload.port) continue
      const resourceName = resolveWorkloadRuntimeResourceName(recipeRef, workload)
      const path = workload.transport.path ?? '/mcp'
      const endpoint = `http://${resourceName}.${this.deps.config.mcpServerNamespace}.svc.cluster.local:${workload.port}${path}`
      resolvedMcpServersForConfig.set(workload.id, {
        id: workload.id,
        endpoint,
        transport: workload.transport.type,
      })
      serverRegistry.set(workload.id, { name: workload.id, url: endpoint })
    }
    const resolvedWorkloads = (spec.workloads ?? []).map(workload => {
      const resourceName = resolveWorkloadRuntimeResourceName(recipeRef, workload)
      const serviceName =
        workload.type === 'statefulset'
          ? resolveStatefulSetHeadlessServiceName(recipeRef, workload)
          : resourceName
      return {
        id: workload.id,
        type: workload.type,
        port: workload.port,
        serviceName,
        resourceName,
        namespace: this.deps.config.sandboxNamespace,
        host: `${serviceName}.${this.deps.config.sandboxNamespace}.svc.cluster.local`,
        ...(workload.transport && { transport: workload.transport }),
      }
    })
    const workflowConfig = {
      name: recipeName,
      namespace: this.deps.config.sandboxNamespace,
      recipeName,
      workloads: resolvedWorkloads,
      ...(spec.coordinatorImage && { coordinatorImage: spec.coordinatorImage }),
      ...(spec.runtimeEgress && { runtimeEgress: spec.runtimeEgress }),
      ...(effectiveInputs && { inputs: effectiveInputs }),
      ...(spec.inputContract && { inputContract: spec.inputContract }),
      ...(spec.agent && {
        agent: {
          provider: spec.agent.provider,
          model: spec.agent.model,
        },
      }),
      steps: (spec.steps ?? []).map(s => ({
        id: s.id,
        ...(s.instruction && { instruction: substituteInputs(s.instruction) }),
        ...(s.run && {
          run: {
            type: 'snippet',
            language: s.run.language,
            code: s.run.code,
            ...(s.run.capabilities && { capabilities: s.run.capabilities }),
          },
        }),
        dependsOn: s.dependsOn ?? [],
        timeoutSeconds: s.timeoutSeconds ?? 300,
        backoffSeconds: s.backoffSeconds ?? 30,
        ...(s.maxRetries !== undefined && { maxRetries: s.maxRetries }),
        // Resolve string ID references → { name, url } objects so the coordinator can
        // connect to the correct MCP server endpoint without knowing K8s service names.
        mcpServers: (s.mcpServers ?? [])
          .map((ref: unknown) => {
            if (typeof ref === 'string') {
              const resolved = serverRegistry.get(ref)
              if (!resolved) {
                this.log.warn(`Step "${s.id}" references unknown mcpServer ID "${ref}" — skipping`)
                return null
              }
              return resolved
            }
            return ref as { name: string; url: string }
          })
          .filter((x): x is { name: string; url: string } => x !== null),
        ...(s.allowedTools && { allowedTools: s.allowedTools }),
        ...(s.maxIterations && { maxIterations: s.maxIterations }),
        ...(s.toolChoice !== undefined && { toolChoice: s.toolChoice }),
        ...(s.agent && {
          agent: {
            ...(s.agent.provider && { provider: s.agent.provider }),
            ...(s.agent.model && { model: s.agent.model }),
            ...(s.agent.soul && { soul: s.agent.soul }),
          },
        }),
        ...(s.requiresApproval && { requiresApproval: s.requiresApproval }),
      })),
      mcpServers: [...resolvedMcpServersForConfig.values()],
      output: spec.output ?? { destination: 'stdout' },
    }

    const configMapName = `${recipeName}-workflow-config`
    const ns = this.deps.config.sandboxNamespace
    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        namespace: ns,
        labels: {
          'clerum.io/recipe': recipeName,
          'clerum.io/managed-by': 'wrc',
        },
        // No ownerRef: cross-namespace ownerRefs are deleted by K8s GC (1.24+).
        // Cleanup handled explicitly by reconcileDelete() finalizer.
      },
      data: {
        'config.json': JSON.stringify(workflowConfig, null, 2),
      },
    }

    // Use create-or-replace so that spec changes (new workloads, corrected endpoints)
    // are reflected in the ConfigMap and picked up by the next coordinator Pod.
    try {
      await this.deps.coreApi.createNamespacedConfigMap({ namespace: ns, body: configMap })
      this.log.info(`Created ConfigMap "${configMapName}"`)
    } catch (createErr) {
      if (getErrorCode(createErr) !== 409) throw createErr
      const existing = await this.deps.coreApi.readNamespacedConfigMap({
        name: configMapName,
        namespace: ns,
      })
      configMap.metadata!.resourceVersion = existing.metadata?.resourceVersion
      await this.deps.coreApi.replaceNamespacedConfigMap({
        name: configMapName,
        namespace: ns,
        body: configMap,
      })
      this.log.info(`Updated ConfigMap "${configMapName}"`)
    }
  }

  // ─── Recipe-Type Annotation ─────────────────────────────────────────

  private async setRecipeTypeAnnotation(
    recipeName: string,
    namespace: string,
    classification: RecipeClassification
  ): Promise<void> {
    try {
      // Merge-patch creates the annotations map when it does not exist yet.
      await this.deps.customApi.patchNamespacedCustomObject(
        {
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: WORKFLOWRECIPE_PLURAL,
          name: recipeName,
          body: {
            metadata: {
              annotations: {
                'clerum.io/recipe-type': classification,
              },
            },
          },
        },
        { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
      )
    } catch {
      // Non-fatal — annotation is informational
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async createIfNotExists(
    createFn: () => Promise<unknown>,
    label: string
  ): Promise<boolean> {
    try {
      await createFn()
      this.log.info(`Created ${label}`)
      return true
    } catch (error: unknown) {
      if (getErrorCode(error) === 409) {
        this.log.info(`${label} already exists (skip)`)
        return false
      } else {
        throw error
      }
    }
  }

  private async applyNetworkPolicy(policy: k8s.V1NetworkPolicy): Promise<void> {
    const name = policy.metadata?.name
    const namespace = policy.metadata?.namespace
    if (!name || !namespace)
      throw new Error('NetworkPolicy metadata.name and namespace are required')

    try {
      await this.deps.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy })
      this.log.info(`Created NetworkPolicy "${name}"`)
      return
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) throw error
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.deps.networkingApi.readNamespacedNetworkPolicy({
        name,
        namespace,
      })
      policy.metadata = {
        ...policy.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      }
      try {
        await this.deps.networkingApi.replaceNamespacedNetworkPolicy({
          name,
          namespace,
          body: policy,
        })
        this.log.info(`Updated NetworkPolicy "${name}"`)
        return
      } catch (error: unknown) {
        if (getErrorCode(error) !== 409 || attempt === 1) throw error
      }
    }
  }

  private async safeDelete(deleteFn: () => Promise<unknown>): Promise<void> {
    try {
      await deleteFn()
    } catch (error: unknown) {
      if (getErrorCode(error) !== 404) {
        this.log.error('Delete failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async deletePersistentVolumeClaimIfExists(
    name: string,
    namespace: string
  ): Promise<void> {
    try {
      await this.deps.coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  /** Replaces coordinator JWTs in-place when either expires near the refresh window. */
  private async refreshCoordinatorTokenIfExpiring(
    recipeName: string,
    recipeNamespace: string,
    options: CoordinatorTokenRefreshOptions = {}
  ): Promise<void> {
    try {
      const includeMcpHostToken = options.includeMcpHostToken ?? true
      const expectedWrcSubject = options.useCustomCoordinatorWrcToken
        ? 'custom-coordinator'
        : 'coordinator'
      const existing = await this.deps.coreApi.readNamespacedSecret({
        name: `wf-${recipeName}-coordinator-token`,
        namespace: recipeNamespace,
      })
      const rawMcpHost = existing.data?.['mcp-host-token']
      const rawWrc = existing.data?.['wrc-token']
      const rawSnippetRunner = existing.data?.['snippet-runner-token']
      const rawGfs = existing.data?.['gfs-token']
      const gfsJwt = rawGfs ? Buffer.from(rawGfs, 'base64' as BufferEncoding).toString('utf-8') : ''
      const mcpHostJwt = rawMcpHost ? Buffer.from(rawMcpHost, 'base64').toString('utf-8') : ''
      const wrcJwt = rawWrc ? Buffer.from(rawWrc, 'base64').toString('utf-8') : ''
      const mcpHostExp = includeMcpHostToken ? WorkflowReconciler.jwtExp(mcpHostJwt) : 0
      const wrcExp = WorkflowReconciler.jwtExp(wrcJwt)
      const wrcSubject = WorkflowReconciler.jwtSubject(wrcJwt)
      const nowSecs = Math.floor(Date.now() / 1000)
      const refreshBeforeSeconds = this.runtimeTokenFileRefreshBeforeSeconds
      const expectedGfsSubject = options.gfsSubject ?? `host:3rd:${recipeNamespace}/${recipeName}`
      const expectedGfsScopes = options.gfsScopes ?? []
      const gfsSubject = rawGfs ? WorkflowReconciler.jwtSubject(gfsJwt) : ''
      const gfsScopes = rawGfs ? WorkflowReconciler.jwtGfsScopes(gfsJwt) : []
      const gfsSubjectMismatch =
        Boolean(rawGfs) && Boolean(options.gfsSubject) && gfsSubject !== expectedGfsSubject
      const gfsScopesMismatch =
        Boolean(rawGfs) &&
        Boolean(options.gfsScopes) &&
        !gfsScopesEqual(gfsScopes, expectedGfsScopes)
      const gfsExp = options.gfsToken ? WorkflowReconciler.jwtExp(gfsJwt) : 0
      const needsGfsToken =
        Boolean(options.gfsToken) &&
        (gfsExp === 0 ||
          gfsExp - nowSecs < refreshBeforeSeconds ||
          gfsSubjectMismatch ||
          gfsScopesMismatch)
      const shouldPruneGfsToken = !options.gfsToken && Boolean(rawGfs)
      const needsMcpHostRefresh =
        includeMcpHostToken && (mcpHostExp === 0 || mcpHostExp - nowSecs < refreshBeforeSeconds)
      const needsWrcRefresh =
        wrcExp === 0 || wrcExp - nowSecs < refreshBeforeSeconds || wrcSubject !== expectedWrcSubject
      const shouldPruneMcpHostToken = !includeMcpHostToken && Boolean(rawMcpHost)
      const needsSnippetRunnerToken =
        options.includeSnippetRunnerToken === true && !rawSnippetRunner
      const shouldPruneSnippetRunnerToken =
        options.includeSnippetRunnerToken !== true && Boolean(rawSnippetRunner)
      if (
        needsMcpHostRefresh ||
        needsWrcRefresh ||
        shouldPruneMcpHostToken ||
        needsSnippetRunnerToken ||
        shouldPruneSnippetRunnerToken ||
        needsGfsToken ||
        shouldPruneGfsToken
      ) {
        const data: Record<string, string | null> = {}
        if (needsMcpHostRefresh) {
          const freshMcpHost = await this.deps.tokenFactory.signCoordinatorToMcpHostToken(
            recipeName,
            recipeNamespace
          )
          data['mcp-host-token'] = Buffer.from(freshMcpHost).toString('base64')
        } else if (shouldPruneMcpHostToken) {
          data['mcp-host-token'] = null
        }
        if (needsWrcRefresh) {
          const freshWrc = options.useCustomCoordinatorWrcToken
            ? await this.deps.tokenFactory.signCustomCoordinatorToWrcToken(
                recipeName,
                recipeNamespace
              )
            : await this.deps.tokenFactory.signCoordinatorToWrcToken(recipeName, recipeNamespace)
          data['wrc-token'] = Buffer.from(freshWrc).toString('base64')
        }
        if (needsSnippetRunnerToken) {
          data['snippet-runner-token'] = Buffer.from(
            randomBytes(32).toString('base64url')
          ).toString('base64')
        } else if (shouldPruneSnippetRunnerToken) {
          data['snippet-runner-token'] = null
        }
        if (needsGfsToken && options.gfsToken) {
          data['gfs-token'] = Buffer.from(options.gfsToken).toString('base64' as BufferEncoding)
        } else if (shouldPruneGfsToken) {
          data['gfs-token'] = null
        }
        await this.deps.coreApi.patchNamespacedSecret(
          {
            name: `wf-${recipeName}-coordinator-token`,
            namespace: recipeNamespace,
            body: {
              data,
            },
          },
          { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
        )
        const mcpHostRemaining =
          includeMcpHostToken && mcpHostExp > 0
            ? `${mcpHostExp - nowSecs}s`
            : includeMcpHostToken
              ? 'unknown(parse error)'
              : 'not required'
        const wrcRemaining = wrcExp > 0 ? `${wrcExp - nowSecs}s` : 'unknown(parse error)'
        this.log.info(
          `Refreshed coordinator tokens for ${recipeName} (mcp-host exp in ${mcpHostRemaining}, wrc exp in ${wrcRemaining})`
        )
      }
    } catch (err) {
      this.log.error(`Failed to refresh coordinator tokens for ${recipeName}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Provisions the mcp-host-runtime-token Secret. JWT claims stay scoped to the
   * WorkflowRecipe namespace; the network call to the approval gateway is
   * deferred until the Secret is missing or expiring.
   */
  private async ensureMcpHostRuntimeTokenSecret(
    recipeNamespace: string,
    recipeName: string,
    runtimeScopeRecipeName = recipeName,
    workflowControlScopes: WorkflowControlScope[] = [],
    gfsScopes: WorkflowRecipeGfsScope[] = ['gfs.read']
  ): Promise<void> {
    const secretName = `wf-${recipeName}-mcp-host-runtime-tokens`
    const sandboxNamespace = this.deps.config.sandboxNamespace

    try {
      const existing = await this.deps.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: sandboxNamespace,
      })
      await this.refreshMcpHostRuntimeTokensIfExpiring(
        recipeNamespace,
        recipeName,
        runtimeScopeRecipeName,
        workflowControlScopes,
        gfsScopes,
        existing
      )
      return
    } catch (err) {
      if (getErrorCode(err) !== 404) throw err
    }

    const mcpHostRuntimeTokens = await issueMcpHostRuntimeTokens(
      recipeNamespace,
      runtimeScopeRecipeName,
      workflowControlScopes
    )
    const mcpHostControlToken = mcpHostRuntimeTokens.mcpHostControlToken
    const gfs = await mintRecipeHostGfsToken(recipeNamespace, runtimeScopeRecipeName, {
      scopes: gfsScopes,
    })

    const mcpHostRuntimeSecret = buildMcpHostRuntimeTokenSecret(
      recipeName,
      mcpHostRuntimeTokens.accessToken,
      mcpHostRuntimeTokens.refreshToken,
      sandboxNamespace,
      mcpHostControlToken,
      gfs.token
    )
    try {
      await this.deps.coreApi.createNamespacedSecret({
        namespace: sandboxNamespace,
        body: mcpHostRuntimeSecret,
      })
      this.log.info(`Created Secret "${secretName}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) throw err
      const existing = await this.deps.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: sandboxNamespace,
      })
      await this.refreshMcpHostRuntimeTokensIfExpiring(
        recipeNamespace,
        recipeName,
        runtimeScopeRecipeName,
        workflowControlScopes,
        gfsScopes,
        existing
      )
      this.log.info(`Secret "${secretName}" already exists (skip)`)
    }
  }

  /**
   * Refreshes the mcp-host-runtime-token Secret if either stored JWT is missing or will expire
   * within the configured runtime refresh window. Refresh failures are fatal to reconcile so the
   * mounted Secret never silently drifts stale after a pod restart.
   */
  private async refreshMcpHostRuntimeTokensIfExpiring(
    recipeNamespace: string,
    recipeName: string,
    runtimeScopeRecipeName: string,
    workflowControlScopes: WorkflowControlScope[],
    expectedGfsScopes: WorkflowRecipeGfsScope[],
    existing: k8s.V1Secret
  ): Promise<void> {
    const rawAccess = existing.data?.['mcp-host-runtime-access-token']
    const rawRefresh = existing.data?.['mcp-host-runtime-refresh-token']
    const accessJwt = rawAccess ? Buffer.from(rawAccess, 'base64').toString('utf-8') : ''
    const refreshJwt = rawRefresh ? Buffer.from(rawRefresh, 'base64').toString('utf-8') : ''
    const accessExp = WorkflowReconciler.jwtExp(accessJwt)
    const refreshExp = WorkflowReconciler.jwtExp(refreshJwt)
    const accessBinding = WorkflowReconciler.jwtRuntimeBinding(accessJwt)
    const refreshBinding = WorkflowReconciler.jwtRuntimeBinding(refreshJwt)
    const rawMcpHostControl = existing.data?.['mcp-host-workflow-control-token']
    const mcpHostControlJwt = rawMcpHostControl
      ? Buffer.from(rawMcpHostControl, 'base64').toString('utf-8')
      : ''
    const mcpHostControlExp = WorkflowReconciler.jwtExp(mcpHostControlJwt)
    const rawGfsAccess = existing.data?.['mcp-host-gfs-token']
    const gfsAccessJwt = rawGfsAccess ? Buffer.from(rawGfsAccess, 'base64').toString('utf-8') : ''
    const gfsAccessExp = WorkflowReconciler.jwtExp(gfsAccessJwt)
    const gfsAccessSub = WorkflowReconciler.jwtSubject(gfsAccessJwt)
    const gfsAccessScopes = WorkflowReconciler.jwtGfsScopes(gfsAccessJwt)
    const controlBinding = WorkflowReconciler.jwtRuntimeBinding(mcpHostControlJwt)
    const controlScopes = WorkflowReconciler.jwtWorkflowControlScopes(mcpHostControlJwt)
    const nowSecs = Math.floor(Date.now() / 1000)
    const expectedRuntimeHostRef = `${recipeNamespace}/${runtimeScopeRecipeName}`
    const expectedControlHostRef = expectedRuntimeHostRef
    const expectedGfsSubject = `host:3rd:${recipeNamespace}/${runtimeScopeRecipeName}`
    const runtimeBindingMismatch =
      !WorkflowReconciler.matchesRuntimeBinding(
        accessBinding,
        recipeNamespace,
        runtimeScopeRecipeName,
        expectedRuntimeHostRef
      ) ||
      !WorkflowReconciler.matchesRuntimeBinding(
        refreshBinding,
        recipeNamespace,
        runtimeScopeRecipeName,
        expectedRuntimeHostRef
      )
    const controlBindingMismatch =
      !!rawMcpHostControl &&
      !WorkflowReconciler.matchesRuntimeBinding(
        controlBinding,
        recipeNamespace,
        runtimeScopeRecipeName,
        expectedControlHostRef
      )
    const controlScopesMismatch = !workflowControlScopesEqual(controlScopes, workflowControlScopes)
    const gfsSubjectMismatch = !!rawGfsAccess && gfsAccessSub !== expectedGfsSubject
    const gfsScopesMismatch = !gfsScopesEqual(gfsAccessScopes, expectedGfsScopes)
    const refreshBeforeSeconds = this.runtimeTokenFileRefreshBeforeSeconds
    const needsMcpHostRuntimeRefresh =
      accessExp === 0 ||
      refreshExp === 0 ||
      runtimeBindingMismatch ||
      accessExp - nowSecs < refreshBeforeSeconds ||
      refreshExp - nowSecs < refreshBeforeSeconds

    const needsWorkflowControlRefresh =
      mcpHostControlExp === 0 ||
      controlBindingMismatch ||
      controlScopesMismatch ||
      mcpHostControlExp - nowSecs < refreshBeforeSeconds

    const needsGfsAccessRefresh =
      gfsAccessExp === 0 ||
      gfsSubjectMismatch ||
      gfsScopesMismatch ||
      gfsAccessExp - nowSecs < refreshBeforeSeconds

    if (!needsMcpHostRuntimeRefresh && !needsWorkflowControlRefresh && !needsGfsAccessRefresh)
      return

    if (
      runtimeBindingMismatch ||
      controlBindingMismatch ||
      controlScopesMismatch ||
      gfsSubjectMismatch ||
      gfsScopesMismatch
    ) {
      this.log.warn('mcpHost runtime token binding drift detected; reissuing tokens', {
        recipeName,
        runtimeScopeRecipeName,
        accessBinding,
        refreshBinding,
        controlBinding,
        controlScopes,
        expectedControlScopes: workflowControlScopes,
        gfsAccessSub,
        expectedGfsSubject,
        gfsAccessScopes,
        expectedGfsScopes,
      })
    }

    try {
      const data: Record<string, string> = {}
      const refreshedMcpHostRuntimeTokens = needsMcpHostRuntimeRefresh
        ? await issueMcpHostRuntimeTokens(
            recipeNamespace,
            runtimeScopeRecipeName,
            workflowControlScopes
          )
        : null

      if (refreshedMcpHostRuntimeTokens) {
        data['mcp-host-runtime-access-token'] = Buffer.from(
          refreshedMcpHostRuntimeTokens.accessToken
        ).toString('base64')
        data['mcp-host-runtime-refresh-token'] = Buffer.from(
          refreshedMcpHostRuntimeTokens.refreshToken
        ).toString('base64')
      }

      if (needsWorkflowControlRefresh || refreshedMcpHostRuntimeTokens) {
        const mcpHostControlToken = refreshedMcpHostRuntimeTokens
          ? refreshedMcpHostRuntimeTokens.mcpHostControlToken
          : await this.issueMcpHostControlToken(
              recipeNamespace,
              runtimeScopeRecipeName,
              workflowControlScopes
            )
        data['mcp-host-workflow-control-token'] =
          Buffer.from(mcpHostControlToken).toString('base64')
      }

      if (needsGfsAccessRefresh) {
        const gfs = await mintRecipeHostGfsToken(recipeNamespace, runtimeScopeRecipeName, {
          scopes: expectedGfsScopes,
        })
        data['mcp-host-gfs-token'] = Buffer.from(gfs.token).toString('base64')
      }

      await this.deps.coreApi.patchNamespacedSecret(
        {
          name: `wf-${recipeName}-mcp-host-runtime-tokens`,
          namespace: this.deps.config.sandboxNamespace,
          body: {
            data,
          },
        },
        { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
      )
      this.log.info(
        `Refreshed workflow auth Secret for ${recipeName} (mcpHostRuntime=${needsMcpHostRuntimeRefresh}, mcpHostControl=${needsWorkflowControlRefresh})`
      )
    } catch (err) {
      this.log.error(`Failed to refresh mcpHost runtime tokens for ${recipeName}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private async issueMcpHostControlToken(
    recipeNamespace: string,
    recipeName: string,
    workflowControlScopes: WorkflowControlScope[]
  ): Promise<string> {
    try {
      return await issueMcpHostWorkflowControlToken(
        recipeNamespace,
        recipeName,
        workflowControlScopes
      )
    } catch (err) {
      this.log.warn(
        `Failed to issue mcpHost control token for "${recipeName}" — workflow tools will be unavailable: ${err instanceof Error ? err.message : err}`
      )
      throw err
    }
  }

  /** Decodes the `exp` claim from a JWT without signature verification. Returns 0 on parse error. */
  private static jwtExp(jwt: string): number {
    try {
      const payload = decodeJwt(jwt)
      return typeof payload.exp === 'number' ? payload.exp : 0
    } catch {
      return 0
    }
  }

  private static jwtRuntimeBinding(jwt: string): {
    recipeNamespace: string
    recipeName: string
    hostRef: string
  } | null {
    try {
      const payload = decodeJwt(jwt)
      const hostRefs = Array.isArray(payload.hostRefs) ? payload.hostRefs : []
      const hostRef = typeof hostRefs[0] === 'string' ? hostRefs[0].trim() : ''
      const recipeNamespace =
        typeof payload.recipeNamespace === 'string' ? payload.recipeNamespace.trim() : ''
      const recipeName = typeof payload.recipeName === 'string' ? payload.recipeName.trim() : ''
      if (!recipeNamespace || !recipeName || !hostRef) return null
      return { recipeNamespace, recipeName, hostRef }
    } catch {
      return null
    }
  }

  private static jwtWorkflowControlScopes(jwt: string): WorkflowControlScope[] {
    try {
      const payload = decodeJwt(jwt)
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : []
      const normalized: WorkflowControlScope[] = []
      const seen = new Set<string>()
      for (const scope of scopes) {
        if (
          typeof scope === 'string' &&
          (WORKFLOW_CONTROL_SCOPE_ORDER as string[]).includes(scope) &&
          !seen.has(scope)
        ) {
          seen.add(scope)
          normalized.push(scope as WorkflowControlScope)
        }
      }
      return WORKFLOW_CONTROL_SCOPE_ORDER.filter(scope => normalized.includes(scope))
    } catch {
      return []
    }
  }

  private static jwtGfsScopes(jwt: string): WorkflowRecipeGfsScope[] {
    try {
      const payload = decodeJwt(jwt)
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : []
      const normalized: WorkflowRecipeGfsScope[] = []
      const seen = new Set<string>()
      for (const scope of scopes) {
        if (
          typeof scope === 'string' &&
          (GFS_SCOPE_ORDER as string[]).includes(scope) &&
          !seen.has(scope)
        ) {
          seen.add(scope)
          normalized.push(scope as WorkflowRecipeGfsScope)
        }
      }
      return GFS_SCOPE_ORDER.filter(scope => normalized.includes(scope))
    } catch {
      return []
    }
  }

  /** Decodes the JWT subject without signature verification. Returns empty string on parse error. */
  private static jwtSubject(jwt: string): string {
    try {
      const payload = decodeJwt(jwt)
      return typeof payload.sub === 'string' ? payload.sub : ''
    } catch {
      return ''
    }
  }

  private static matchesRuntimeBinding(
    binding: { recipeNamespace: string; recipeName: string; hostRef: string } | null,
    recipeNamespace: string,
    recipeName: string,
    hostRef: string
  ): boolean {
    return (
      binding?.recipeNamespace === recipeNamespace &&
      binding.recipeName === recipeName &&
      binding.hostRef === hostRef
    )
  }
}
