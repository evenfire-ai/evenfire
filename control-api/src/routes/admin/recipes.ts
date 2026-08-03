import { Router } from 'express'
import { isWorkflowRecipeDefaultAllowedCapability } from '@clerum/workflow-recipe-capability-policy'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { CONTENT_TYPES } from '../../http/contentTypes.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { K8sGateway } from '../../k8s.js'
import { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  type SecretOwnership,
  parseSecretOwnership,
} from '../../secretOwnership.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { invalidSecretDataKeyReason } from '../../services/secretKeys.js'
import {
  validateWorkflowRecipeEgressPreflight,
  validateWorkflowRecipeLimits,
} from '../../services/workflowRecipeLimits.js'
import { buildWrcWorkflowArtifactsUrl } from '../../services/workflows/wrcClient.js'
import { signWrcDelegationToken } from '../../utils/auth/delegationToken.js'

// Timeout for the proxied artifact fetch — short enough that a hung WRC
// cannot tie up a control-api worker indefinitely, long enough that a
// cold mcp-host response for a large PDF still completes.
const ARTIFACT_FETCH_TIMEOUT_MS = 30_000

const PLURAL = 'workflowrecipes' as const
const BASE = '/admin/recipes'
const UPDATE_CONFLICT_RETRY_ATTEMPTS = 3
const UPDATE_CONFLICT_RETRY_DELAY_MS = 25
const WORKFLOW_TEAM_ID_LABEL = 'clerum.io/workflow-team-id'
const MAX_TTL_SECONDS_AFTER_FINISHED = 30 * 24 * 60 * 60
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const K8S_DNS_SUBDOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const logger = rootLogger.child({ module: 'admin-recipes' })

// WorkflowRecipe CRD storage namespace.
//
// This is a design invariant, not an operational default: WorkflowRecipe CRDs
// always live in `sandbox-recipes`, co-located with the workflow coordinator
// and recipe mcp-host pods they orchestrate. The `mcp-server` namespace is
// reserved for McpServer transport children and their network policies so a
// recipe-authorized mcp-host can later reach only those transport servers.
//
// Author-supplied `metadata.namespace` is ignored and stripped before writes.
// The platform, admission policy, and control-api route decide placement;
// recipe YAML must not be able to reintroduce namespace selection.
const RECIPE_CRD_NAMESPACE = config.sandboxNamespace
const MCP_SERVER_NAMESPACE = config.mcpServersNamespace
// Issue #637 — WRC mounts UI workload Secrets from sandbox-ui (resolveWorkloadNamespace
// in workflow-recipes). The pre-persistence ownership check must classify in the SAME
// namespace WRC will, or it validates a UI workload's Secret against the wrong namespace.
const SANDBOX_UI_NAMESPACE = config.sandboxUiNamespace
const RECIPE_NAMESPACES: readonly string[] = [config.sandboxNamespace] as const
const WORKFLOW_RECIPE_SECRET_NAMESPACES = new Set([
  RECIPE_CRD_NAMESPACE,
  MCP_SERVER_NAMESPACE,
  SANDBOX_UI_NAMESPACE,
])

/**
 * Issue #637 — mirror of WRC's `resolveWorkloadNamespace` three-way split so the
 * control-api pre-persistence ownership check classifies a workload's Secret in
 * the same namespace the workload's pod will mount it from: transport → mcp-server,
 * `spec.ui.workloadRef` → sandbox-ui, everything else → sandbox-recipes.
 */
function resolveWorkloadSecretNamespace(
  workload: Record<string, unknown>,
  body: RecipeBody
): string {
  if (workload.transport !== undefined && workload.transport !== null) return MCP_SERVER_NAMESPACE
  const uiRef = getNestedObject(body.spec ?? {}, 'ui').workloadRef
  if (typeof uiRef === 'string' && uiRef && workload.id === uiRef) return SANDBOX_UI_NAMESPACE
  return RECIPE_CRD_NAMESPACE
}

const ALLOWED_WORKLOAD_TYPES = new Set(['deployment', 'statefulset', 'cronjob', 'job', 'daemonset'])

// Per-provider offline/refresh scope a recipe must request before it can opt an
// oauthClient into `backgroundAccess` — without a refresh token the broker
// cannot sustain access past the first access-token expiry. Providers absent
// from this map negotiate offline access out-of-band (Google via
// `access_type=offline`, Slack via app-level token rotation) so no scope check
// applies. Path B, spec §7.
const PROVIDER_OFFLINE_SCOPE: Record<string, string> = {
  salesforce: 'refresh_token',
  'microsoft-graph': 'offline_access',
}

const STEP_RUN_KEYS = new Set(['type', 'language', 'code', 'capabilities'])
const SENSITIVE_ENV_NAME_RE = /(PASSWORD|TOKEN|SECRET|API_KEY|CREDENTIAL|PRIVATE_KEY)/i
const TEMPLATE_INPUT_REF_RE = /\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}/g
const SENSITIVE_INPUT_NAME_RE =
  /(password|passwd|pwd|token|secret|credential|api[_-]?key|apikey|private[_-]?key|privatekey)/i
const JWT_LIKE_RE = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/
const SECRET_LIKE_VALUE_RE = /^(sk-[A-Za-z0-9_-]{8,}|pat[A-Za-z0-9_-]{8,})$/
const URL_WITH_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s]+)@/i
const INPUT_TEMPLATE_ONLY_RE = /^\{\{\s*inputs\.[A-Za-z0-9_.-]+\s*\}\}$/
const TEMPLATE_RE = /\{\{([^}]+)\}\}/g
// Pre-persistence mirror of workflow-recipes/src/reconciler/templateEngine.ts.
// Keep in parity with the WRC runtime guard; WRC remains the final source of truth.
const BLOCKED_TEMPLATE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
])
const WORKFLOW_SECRET_LABELS = {
  'clerum.io/managed-by': 'control-api',
  'clerum.io/scope': 'workflow-recipe',
}

function workflowSecretOwnershipLabels(
  ownership: Exclude<SecretOwnership, { kind: 'unlabeled' }>
): Record<string, string> {
  return ownership.kind === 'shared'
    ? { [SHARED_LABEL_KEY]: 'true' }
    : { [OWNER_RECIPE_LABEL_KEY]: ownership.recipeName }
}

function parseWorkflowSecretOwnershipBody(
  body: unknown
):
  | { ok: true; ownership: Exclude<SecretOwnership, { kind: 'unlabeled' }> }
  | { ok: false; error: string } {
  const ownership = (body as { ownership?: unknown }).ownership
  if (!isPlainObject(ownership)) {
    return {
      ok: false,
      error: 'ownership is required: { kind: "shared" } or { kind: "owner-recipe", recipeName }',
    }
  }
  if (ownership.kind === 'shared') return { ok: true, ownership: { kind: 'shared' } }
  if (ownership.kind === 'owner-recipe') {
    const recipeName = typeof ownership.recipeName === 'string' ? ownership.recipeName.trim() : ''
    if (!recipeName) {
      return { ok: false, error: 'ownership.recipeName is required when kind="owner-recipe"' }
    }
    return { ok: true, ownership: { kind: 'owner-recipe', recipeName } }
  }
  return { ok: false, error: 'ownership.kind must be "shared" or "owner-recipe"' }
}

export interface RecipeBody {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, unknown> }
  spec?: Record<string, unknown>
}

interface ValidationError {
  field: string
  message: string
  // Optional discriminator for policy/invariant violations so the UI can
  // branch on rule id instead of string-matching `message`. Structural errors
  // from `validateRecipeBody` leave this undefined.
  rule?: string
}

function extractK8sStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number')
    return maybe.response.statusCode
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return null
}

function isK8sNotFoundLike(err: unknown): boolean {
  // Duck-type `err?.name === 'K8sNotFoundError'` in addition to
  // `instanceof` because vi.resetModules() in tests (and in theory any
  // multi-instance load path) produces two distinct K8sNotFoundError
  // constructors that fail instanceof. The name-based check bridges them.
  return (
    err instanceof K8sNotFoundError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'K8sNotFoundError') ||
    extractK8sStatus(err) === 404
  )
}

function isK8sConflictLike(err: unknown): boolean {
  return extractK8sStatus(err) === 409
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function validateName(name: string): boolean {
  return RFC1123_RE.test(name)
}

function validateRecipeName(name: unknown): string | null {
  if (typeof name !== 'string' || !validateName(name)) {
    return 'name must be a lowercase RFC1123 label (letters, digits, hyphens; max 63 chars)'
  }
  return null
}

function sensitiveInputRefsInEnvValue(value: unknown): string[] {
  if (typeof value !== 'string' || !value.includes('{{')) return []

  const refs = new Set<string>()
  for (const match of value.matchAll(TEMPLATE_INPUT_REF_RE)) {
    const inputName = match[1]
    if (SENSITIVE_INPUT_NAME_RE.test(inputName)) {
      refs.add(`{{inputs.${inputName}}}`)
    }
  }
  return [...refs]
}

function isPlatformManagedWorkflowSecretName(name: string): boolean {
  return name.startsWith('wf-')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inlineEnvSecretReason(name: unknown, value: unknown): string | null {
  const envName = typeof name === 'string' ? name.trim() : ''
  if (value === undefined || value === null || value === '') return null
  const envValue = typeof value === 'string' ? value.trim() : String(value)
  const urlPassword = envValue.match(URL_WITH_PASSWORD_RE)?.[1]
  const hasSensitiveInputTemplate = sensitiveInputRefsInEnvValue(envValue).length > 0
  if (
    JWT_LIKE_RE.test(envValue) ||
    SECRET_LIKE_VALUE_RE.test(envValue) ||
    (urlPassword !== undefined && !INPUT_TEMPLATE_ONLY_RE.test(urlPassword)) ||
    envValue.includes('-----BEGIN ')
  ) {
    return 'env value looks sensitive'
  }
  if (SENSITIVE_ENV_NAME_RE.test(envName) && !hasSensitiveInputTemplate) {
    return 'env name looks sensitive'
  }
  return null
}

function extractInputDefaults(inputContract: unknown): Record<string, unknown> {
  if (!isPlainObject(inputContract) || !isPlainObject(inputContract.properties)) return {}
  const defaults: Record<string, unknown> = {}
  for (const [key, definition] of Object.entries(inputContract.properties)) {
    if (isPlainObject(definition) && Object.prototype.hasOwnProperty.call(definition, 'default')) {
      defaults[key] = definition.default
    }
  }
  return defaults
}

function resolveRecipeInputs(spec: Record<string, unknown>): Record<string, unknown> {
  const inputs = isPlainObject(spec.inputs) ? spec.inputs : {}
  const profiles = isPlainObject(spec.profiles) ? spec.profiles : undefined
  const activeProfile = typeof spec.activeProfile === 'string' ? spec.activeProfile : undefined
  const profile =
    activeProfile && profiles && isPlainObject(profiles[activeProfile])
      ? (profiles[activeProfile] as Record<string, unknown>)
      : {}
  return {
    ...extractInputDefaults(spec.inputContract),
    ...inputs,
    ...profile,
  }
}

function validateTemplateRef(
  ref: string,
  context: {
    inputs: Record<string, unknown>
    computedNames: Set<string>
    workloadPorts: Map<string, unknown>
    resourceData: Map<string, Record<string, unknown>>
  }
): string | null {
  const trimmed = ref.trim()
  for (const part of trimmed.split('.')) {
    if (BLOCKED_TEMPLATE_KEYS.has(part)) {
      return `Template injection blocked: "${trimmed}"`
    }
  }
  for (const part of trimmed.split(':')) {
    if (BLOCKED_TEMPLATE_KEYS.has(part)) {
      return `Template injection blocked: "${trimmed}"`
    }
  }

  if (trimmed.startsWith('inputs.')) {
    const key = trimmed.slice('inputs.'.length)
    return Object.prototype.hasOwnProperty.call(context.inputs, key)
      ? null
      : `Unresolved template reference "${trimmed}"`
  }

  if (trimmed.startsWith('computed.')) {
    const key = trimmed.slice('computed.'.length)
    return context.computedNames.has(key) ? null : `Unresolved template reference "${trimmed}"`
  }

  if (trimmed.includes(':')) {
    const colonIndex = trimmed.indexOf(':')
    const id = trimmed.slice(0, colonIndex)
    const field = trimmed.slice(colonIndex + 1)
    if ((field === 'host' || field === 'port') && context.workloadPorts.has(id)) {
      return null
    }
    const resource = context.resourceData.get(id)
    if (resource && Object.prototype.hasOwnProperty.call(resource, field)) {
      return null
    }
  }

  return `Unresolved template reference "${trimmed}"`
}

function validateTemplateString(
  value: string,
  field: string,
  context: Parameters<typeof validateTemplateRef>[1]
): ValidationError[] {
  const errors: ValidationError[] = []
  for (const match of value.matchAll(TEMPLATE_RE)) {
    const reason = validateTemplateRef(match[1], context)
    if (!reason) continue
    errors.push({
      field,
      rule: reason.startsWith('Template injection blocked')
        ? 'workflowTemplateInjectionBlocked'
        : 'workflowTemplateUnresolved',
      message: reason,
    })
  }
  return errors
}

function workloadEnvValueFieldPath(
  prefix: string,
  entry: Record<string, unknown>,
  index: number
): string {
  return typeof entry.name === 'string' && entry.name.trim() !== ''
    ? `${prefix}.env[${entry.name}].value`
    : `${prefix}.env[${index}].value`
}

function validateWorkloadTemplateReferences(body: RecipeBody): ValidationError[] {
  if (!body.spec || !isPlainObject(body.spec)) return []
  const workloads = Array.isArray(body.spec.workloads) ? body.spec.workloads : []
  if (workloads.length === 0) return []

  const workloadPorts = new Map<string, unknown>()
  workloads.forEach(workload => {
    if (!isPlainObject(workload)) return
    if (typeof workload.id === 'string' && workload.port !== undefined) {
      workloadPorts.set(workload.id, workload.port)
    }
  })

  const resourceData = new Map<string, Record<string, unknown>>()
  const resources = Array.isArray(body.spec.resources) ? body.spec.resources : []
  resources.forEach(resource => {
    if (!isPlainObject(resource)) return
    if (
      typeof resource.id === 'string' &&
      (resource.type === 'secret' || resource.type === 'configmap') &&
      isPlainObject(resource.data)
    ) {
      resourceData.set(resource.id, resource.data)
    }
  })

  const computedNames = new Set<string>()
  const computed = Array.isArray(body.spec.computed) ? body.spec.computed : []
  computed.forEach(entry => {
    if (isPlainObject(entry) && typeof entry.name === 'string') {
      computedNames.add(entry.name)
    }
  })

  const context = {
    inputs: resolveRecipeInputs(body.spec),
    computedNames,
    workloadPorts,
    resourceData,
  }
  const errors: ValidationError[] = []

  workloads.forEach((workload, workloadIndex) => {
    if (!isPlainObject(workload)) return
    const prefix = `spec.workloads[${workloadIndex}]`
    const env = Array.isArray(workload.env) ? workload.env : []
    env.forEach((entry, envIndex) => {
      if (!isPlainObject(entry) || typeof entry.value !== 'string') return
      errors.push(
        ...validateTemplateString(
          entry.value,
          workloadEnvValueFieldPath(prefix, entry, envIndex),
          context
        )
      )
    })
    const command = Array.isArray(workload.command) ? workload.command : []
    command.forEach((entry, commandIndex) => {
      if (typeof entry !== 'string') return
      errors.push(...validateTemplateString(entry, `${prefix}.command[${commandIndex}]`, context))
    })
    const args = Array.isArray(workload.args) ? workload.args : []
    args.forEach((entry, argIndex) => {
      if (typeof entry !== 'string') return
      errors.push(...validateTemplateString(entry, `${prefix}.args[${argIndex}]`, context))
    })
  })

  return errors
}

function getNestedObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  return isPlainObject(value) ? value : {}
}

export type WorkflowSecretRefKind = 'snippet' | 'workload' | 'oauthClient' | 'imagePullSecret'

export type WorkflowSecretRef = {
  field: string
  name: string
  key: string
  kind: WorkflowSecretRefKind
  namespace: string
}

export type PendingWorkflowCredentialRef = {
  kind: string
  secretName: string
  namespace: string
  keys: string[]
  field: string
  fields?: string[]
}

export type WorkflowRecipeSecretValidationResult = {
  errors: ValidationError[] | null
  pendingCredentials: PendingWorkflowCredentialRef[]
}

function collectSnippetSecretRefs(body: RecipeBody): WorkflowSecretRef[] {
  const refs = new Map<string, WorkflowSecretRef>()
  const steps = Array.isArray(body.spec?.steps) ? body.spec.steps : []

  steps.forEach((step, stepIndex) => {
    if (!isPlainObject(step)) return
    const run = isPlainObject(step.run) ? step.run : undefined
    if (run?.type !== 'snippet') return
    const capabilities = getNestedObject(run, 'capabilities')
    const secrets = Array.isArray(capabilities.secrets) ? capabilities.secrets : []

    secrets.forEach((entry, secretIndex) => {
      if (!isPlainObject(entry)) return
      const secretRef = getNestedObject(entry, 'secretRef')
      const name = typeof secretRef.name === 'string' ? secretRef.name : ''
      const key = typeof secretRef.key === 'string' ? secretRef.key : ''
      if (!name || !key) return
      const refKey = `${name}/${key}`
      if (!refs.has(refKey)) {
        refs.set(refKey, {
          field: `spec.steps[${stepIndex}].run.capabilities.secrets[${secretIndex}].secretRef`,
          name,
          key,
          kind: 'snippet',
          namespace: RECIPE_CRD_NAMESPACE,
        })
      }
    })
  })

  return [...refs.values()]
}

function collectWorkloadEnvSecretRefs(body: RecipeBody): WorkflowSecretRef[] {
  const refs = new Map<string, WorkflowSecretRef>()
  const workloads = Array.isArray(body.spec?.workloads) ? body.spec.workloads : []

  workloads.forEach((workload, workloadIndex) => {
    if (!isPlainObject(workload)) return
    const envSecret = getNestedObject(workload, 'envSecret')
    const name = typeof envSecret.name === 'string' ? envSecret.name : ''
    const keys = Array.isArray(envSecret.keys) ? envSecret.keys : []
    const namespace = resolveWorkloadSecretNamespace(workload, body)
    keys.forEach((entry, keyIndex) => {
      if (!isPlainObject(entry)) return
      const key = typeof entry.secretKey === 'string' ? entry.secretKey : ''
      if (!name || !key) return
      const refKey = `${namespace}/${name}/${key}`
      if (!refs.has(refKey)) {
        refs.set(refKey, {
          field: `spec.workloads[${workloadIndex}].envSecret.keys[${keyIndex}]`,
          name,
          key,
          kind: 'workload',
          namespace,
        })
      }
    })
  })

  return [...refs.values()]
}

function collectOauthClientSecretRefs(body: RecipeBody): WorkflowSecretRef[] {
  const refs = new Map<string, WorkflowSecretRef>()
  const oauthClients = Array.isArray(body.spec?.oauthClients) ? body.spec.oauthClients : []

  oauthClients.forEach((client, clientIndex) => {
    if (!isPlainObject(client)) return
    for (const refField of ['clientIdRef', 'clientSecretRef'] as const) {
      const secretRef = getNestedObject(client, refField)
      const name = typeof secretRef.name === 'string' ? secretRef.name : ''
      const key = typeof secretRef.key === 'string' ? secretRef.key : ''
      if (!name || !key) continue
      const refKey = `${RECIPE_CRD_NAMESPACE}/${name}/${key}`
      if (!refs.has(refKey)) {
        refs.set(refKey, {
          field: `spec.oauthClients[${clientIndex}].${refField}`,
          name,
          key,
          kind: 'oauthClient',
          namespace: RECIPE_CRD_NAMESPACE,
        })
      }
    }
  })

  return [...refs.values()]
}

function collectWorkloadImagePullSecretRefs(body: RecipeBody): WorkflowSecretRef[] {
  const refs = new Map<string, WorkflowSecretRef>()
  const workloads = Array.isArray(body.spec?.workloads) ? body.spec.workloads : []

  workloads.forEach((workload, workloadIndex) => {
    if (!isPlainObject(workload)) return
    const pullSecrets = Array.isArray(workload.imagePullSecrets) ? workload.imagePullSecrets : []
    const namespace = resolveWorkloadSecretNamespace(workload, body)
    pullSecrets.forEach((entry, pullIndex) => {
      const name = typeof entry === 'string' ? entry : ''
      if (!name) return
      const refKey = `${namespace}/${name}/imagePullSecret`
      if (!refs.has(refKey)) {
        refs.set(refKey, {
          field: `spec.workloads[${workloadIndex}].imagePullSecrets[${pullIndex}]`,
          name,
          key: '',
          kind: 'imagePullSecret',
          namespace,
        })
      }
    })
  })

  return [...refs.values()]
}

export function collectWorkflowRecipeCredentialSecretRefs(body: RecipeBody): WorkflowSecretRef[] {
  return [
    ...collectSnippetSecretRefs(body),
    ...collectWorkloadEnvSecretRefs(body),
    ...collectOauthClientSecretRefs(body),
  ]
}

function secretRule(kind: WorkflowSecretRefKind, suffix: string): string {
  if (kind === 'oauthClient') return `workflowOauthClientSecret${suffix}`
  return kind === 'snippet' ? `workflowSnippetSecret${suffix}` : `workflowWorkloadSecret${suffix}`
}

function secretRefNameField(ref: WorkflowSecretRef): string {
  return ref.kind === 'snippet' || ref.kind === 'oauthClient'
    ? `${ref.field}.name`
    : ref.field.replace(/\.keys\[\d+\]$/, '.name')
}

function secretRefKeyField(ref: WorkflowSecretRef): string {
  return ref.kind === 'snippet' || ref.kind === 'oauthClient'
    ? `${ref.field}.key`
    : `${ref.field}.secretKey`
}

export function hasWorkflowSecretKey(secret: unknown, key: string): boolean {
  if (!isPlainObject(secret)) return false
  const data = isPlainObject(secret.data) ? secret.data : {}
  const stringData = isPlainObject(secret.stringData) ? secret.stringData : {}
  return (
    Object.prototype.hasOwnProperty.call(data, key) ||
    Object.prototype.hasOwnProperty.call(stringData, key)
  )
}

function pendingWorkflowCredentialKind(
  ref: WorkflowSecretRef
): PendingWorkflowCredentialRef['kind'] | null {
  if (ref.kind === 'snippet') return 'workflowSnippetSecret'
  if (ref.kind === 'oauthClient') return 'workflowOauthClientSecret'
  if (ref.kind === 'workload') return 'workflowEnvSecret'
  return null
}

function pendingWorkflowCredentialField(ref: WorkflowSecretRef): string {
  return ref.kind === 'workload' ? ref.field.replace(/\.keys\[\d+\]$/, '') : ref.field
}

function addPendingWorkflowCredentialRef(
  pending: Map<string, PendingWorkflowCredentialRef>,
  ref: WorkflowSecretRef
): void {
  const kind = pendingWorkflowCredentialKind(ref)
  if (!kind) return

  const pendingKey = `${ref.namespace}/${ref.name}/${ref.kind}`
  const field = pendingWorkflowCredentialField(ref)
  const existing = pending.get(pendingKey)
  if (existing) {
    if (!existing.keys.includes(ref.key)) existing.keys.push(ref.key)
    if (existing.field !== field) {
      const fields = existing.fields ?? [existing.field]
      if (!fields.includes(field)) fields.push(field)
      existing.fields = fields
    }
    return
  }

  pending.set(pendingKey, {
    kind,
    secretName: ref.name,
    namespace: ref.namespace,
    keys: [ref.key],
    field,
  })
}

export async function collectMissingWorkflowRecipePendingCredentialRefs(
  recipeName: string,
  recipeSpec: Record<string, unknown>,
  gateway: K8sGateway
): Promise<PendingWorkflowCredentialRef[]> {
  const pending = new Map<string, PendingWorkflowCredentialRef>()
  const refs = collectWorkflowRecipeCredentialSecretRefs({
    metadata: { name: recipeName },
    spec: recipeSpec,
  })

  for (const ref of refs) {
    let existingResource: unknown
    try {
      existingResource = await gateway.getSecret(ref.name, ref.namespace)
    } catch (err) {
      if (!isK8sNotFoundLike(err)) throw err
      existingResource = null
    }
    if (existingResource && hasWorkflowSecretKey(existingResource, ref.key)) continue

    addPendingWorkflowCredentialRef(pending, ref)
  }

  return [...pending.values()]
}

function shouldDeferMissingWorkflowSecret(
  ref: WorkflowSecretRef,
  options: { deferMissingWorkflowSecrets?: boolean }
): boolean {
  return options.deferMissingWorkflowSecrets === true && ref.kind !== 'imagePullSecret'
}

export async function validateWorkflowRecipeSecrets(
  body: RecipeBody,
  gateway: K8sGateway,
  options: { deferMissingWorkflowSecrets?: boolean; includeOauthClientSecrets?: boolean } = {}
): Promise<ValidationError[] | null> {
  return (await validateWorkflowRecipeSecretsAndCollectPending(body, gateway, options)).errors
}

export async function validateWorkflowRecipeSecretsAndCollectPending(
  body: RecipeBody,
  gateway: K8sGateway,
  options: { deferMissingWorkflowSecrets?: boolean; includeOauthClientSecrets?: boolean } = {}
): Promise<WorkflowRecipeSecretValidationResult> {
  const errors: ValidationError[] = []
  const pendingCredentials = new Map<string, PendingWorkflowCredentialRef>()
  // Recipe being created/updated — the subject the ownership check compares
  // against (a Secret is accessible only when shared or owned by THIS recipe).
  const recipeName = typeof body.metadata?.name === 'string' ? body.metadata.name : ''
  const refs = [
    ...collectSnippetSecretRefs(body),
    ...collectWorkloadEnvSecretRefs(body),
    ...(options.includeOauthClientSecrets ? collectOauthClientSecretRefs(body) : []),
    ...collectWorkloadImagePullSecretRefs(body),
  ]
  for (const ref of refs) {
    const nameErr = validateRecipeName(ref.name)
    if (nameErr) {
      errors.push({
        field: secretRefNameField(ref),
        rule: secretRule(ref.kind, 'RefInvalid'),
        message: nameErr.replace('name', 'secretRef.name'),
      })
      continue
    }
    if (isPlatformManagedWorkflowSecretName(ref.name)) {
      errors.push({
        field: secretRefNameField(ref),
        rule: secretRule(ref.kind, 'RefReserved'),
        message: `Secret "${ref.name}" is platform-managed and cannot be used by WorkflowRecipe configuration.`,
      })
      continue
    }
    // imagePullSecrets carry no key — name + ownership are the only checks.
    if (ref.kind !== 'imagePullSecret') {
      const keyErr = invalidSecretDataKeyReason(ref.key)
      if (keyErr) {
        errors.push({
          field: secretRefKeyField(ref),
          rule: secretRule(ref.kind, 'KeyInvalid'),
          message: keyErr,
        })
        continue
      }
    }

    try {
      const secret = await gateway.getSecret(ref.name, ref.namespace)
      // Issue #637 — cross-recipe ownership gate (defense-in-depth; the WRC
      // reconciler is the authoritative enforcement point). A Secret that EXISTS
      // but is owned by another recipe is refused here for early, clear feedback.
      // Recipe-scoped API keys can be materialized after the WorkflowRecipe lands:
      // Control UI discovers missing envSecret/snippet refs from the persisted
      // recipe and then writes the Secret with matching ownership. Existing
      // foreign-owned Secrets are still denied immediately.
      const labels = (secret as { metadata?: { labels?: Record<string, string> } }).metadata?.labels
      const ownership = parseSecretOwnership(labels)
      // Reject ONLY "exists-but-foreign": a Secret explicitly owned by ANOTHER
      // recipe. Unlabeled/shared Secrets pass control-api — an unlabeled Secret
      // may be labeled before the recipe runs (deferred setup), and the WRC
      // reconciler (authoritative) still fails closed on unlabeled at runtime.
      // This keeps early rejection precise without blocking legitimate setup order.
      if (ownership.kind === 'owner-recipe' && ownership.recipeName !== recipeName) {
        errors.push({
          field: secretRefNameField(ref),
          rule: secretRule(ref.kind, 'OwnershipDenied'),
          message:
            `Secret "${ref.name}" is owned by recipe "${ownership.recipeName}" and is not ` +
            `accessible to recipe "${recipeName}". Label it clerum.io/shared=true or ` +
            `clerum.io/owner-recipe=${recipeName} to grant access.`,
        })
        continue
      }
      if (ref.kind !== 'imagePullSecret' && !hasWorkflowSecretKey(secret, ref.key)) {
        if (shouldDeferMissingWorkflowSecret(ref, options)) {
          addPendingWorkflowCredentialRef(pendingCredentials, ref)
        } else {
          errors.push({
            field: secretRefKeyField(ref),
            rule: secretRule(ref.kind, 'KeyNotFound'),
            message: `Secret "${ref.name}" in namespace "${ref.namespace}" does not contain key "${ref.key}".`,
          })
        }
      }
    } catch (err) {
      if (!isK8sNotFoundLike(err)) {
        logger.error(
          {
            err: getErrorMessage(err),
            secretName: ref.name,
            secretKey: ref.key,
            namespace: ref.namespace,
          },
          'Failed to validate WorkflowRecipe Secret reference'
        )
        throw err
      }
      if (shouldDeferMissingWorkflowSecret(ref, options)) {
        addPendingWorkflowCredentialRef(pendingCredentials, ref)
      } else {
        errors.push({
          field: secretRefNameField(ref),
          rule: secretRule(ref.kind, 'NotFound'),
          message: `Secret "${ref.name}" was not found in namespace "${ref.namespace}".`,
        })
      }
    }
  }

  return {
    errors: errors.length > 0 ? errors : null,
    pendingCredentials: [...pendingCredentials.values()],
  }
}

function isScheduledRecipe(body: RecipeBody): boolean {
  if (!body.spec || !isPlainObject(body.spec)) return false
  const triggers = isPlainObject(body.spec.triggers) ? body.spec.triggers : undefined
  return body.spec.scheduling != null || triggers?.schedule != null
}

function workflowTeamIdLabel(body: RecipeBody): string {
  const raw = body.metadata?.labels?.[WORKFLOW_TEAM_ID_LABEL]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stringLabels(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const labels: Record<string, string> = {}
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue === 'string') labels[key] = labelValue
  }
  return labels
}

function validateRecipeBody(body: RecipeBody): ValidationError[] {
  const errors: ValidationError[] = []

  const nameErr = validateRecipeName(body?.metadata?.name)
  if (nameErr) errors.push({ field: 'metadata.name', message: nameErr })

  if (!body?.spec || typeof body.spec !== 'object' || Array.isArray(body.spec)) {
    errors.push({ field: 'spec', message: 'spec must be a non-null object' })
    return errors // no point checking spec fields if spec is invalid
  }
  errors.push(...validateWorkflowRecipeLimits(body.spec))

  const runRetention = body.spec.runRetention
  if (runRetention !== undefined) {
    if (!isPlainObject(runRetention)) {
      errors.push({ field: 'spec.runRetention', message: 'runRetention must be an object' })
    } else {
      const ttl = runRetention.ttlSecondsAfterFinished
      if (ttl !== undefined) {
        const ttlNumber = Number(ttl)
        if (
          !Number.isInteger(ttlNumber) ||
          ttlNumber < 0 ||
          ttlNumber > MAX_TTL_SECONDS_AFTER_FINISHED
        ) {
          errors.push({
            field: 'spec.runRetention.ttlSecondsAfterFinished',
            message: `must be an integer between 0 and ${MAX_TTL_SECONDS_AFTER_FINISHED} seconds (30 days)`,
          })
        }
      }
    }
  }

  const steps = body.spec.steps
  const hasWorkflowSteps = Array.isArray(steps) && steps.length > 0
  const hasCustomCoordinator =
    typeof body.spec.coordinatorImage === 'string' && body.spec.coordinatorImage.trim() !== ''
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      errors.push({ field: 'spec.steps', message: 'steps must be an array' })
    } else {
      steps.forEach((step, i) => {
        const prefix = `spec.steps[${i}]`
        if (!isPlainObject(step)) {
          errors.push({ field: prefix, message: 'each step must be an object' })
          return
        }
        const hasRun = step.run !== undefined
        const hasInstruction = step.instruction !== undefined
        const hasAgent = step.agent !== undefined
        if (hasRun && hasInstruction) {
          errors.push({ field: prefix, message: 'step cannot declare both instruction and run' })
        }
        if (hasRun && hasAgent) {
          errors.push({ field: prefix, message: 'step cannot declare both agent and run' })
        }
        if (!hasCustomCoordinator && !hasRun && !hasInstruction) {
          errors.push({ field: prefix, message: 'step must declare instruction or run' })
        }
        if (hasRun) {
          if (!isPlainObject(step.run)) {
            errors.push({ field: `${prefix}.run`, message: 'run must be an object' })
            return
          }
          for (const key of Object.keys(step.run)) {
            if (!STEP_RUN_KEYS.has(key)) {
              errors.push({ field: `${prefix}.run.${key}`, message: 'unsupported run field' })
            }
          }
          if (step.run.type !== 'snippet') {
            errors.push({ field: `${prefix}.run.type`, message: 'run.type must be snippet' })
          }
        }
      })
    }
  }

  const triggers = body.spec.triggers
  if (hasWorkflowSteps && triggers === undefined) {
    errors.push({
      field: 'spec.triggers',
      message:
        'workflow recipes with steps must declare spec.triggers.onDemand or spec.triggers.schedule',
    })
  }
  if (triggers !== undefined) {
    if (!isPlainObject(triggers)) {
      errors.push({ field: 'spec.triggers', message: 'triggers must be an object' })
    } else {
      const onDemand = triggers.onDemand
      const schedule = triggers.schedule
      if (onDemand === undefined && schedule === undefined) {
        errors.push({
          field: 'spec.triggers',
          message: 'triggers must declare at least one of onDemand or schedule',
        })
      }
      if (!hasWorkflowSteps) {
        errors.push({
          field: 'spec.triggers',
          message: 'triggers requires spec.steps to be non-empty',
        })
      }
      if (onDemand !== undefined) {
        if (!isPlainObject(onDemand)) {
          errors.push({ field: 'spec.triggers.onDemand', message: 'onDemand must be an object' })
        } else if (Array.isArray(onDemand.allowedActors)) {
          const validActors = new Set(['user', 'autonomous', 'scheduled'])
          onDemand.allowedActors.forEach((actor, j) => {
            if (!validActors.has(String(actor))) {
              errors.push({
                field: `spec.triggers.onDemand.allowedActors[${j}]`,
                message: 'must be one of: user, autonomous, scheduled',
              })
            }
          })
        }
      }
      if (schedule !== undefined && !isPlainObject(schedule)) {
        errors.push({ field: 'spec.triggers.schedule', message: 'schedule must be an object' })
      }
    }
  }

  const output = body.spec.output
  if (output !== undefined) {
    if (!isPlainObject(output)) {
      errors.push({ field: 'spec.output', message: 'output must be an object' })
    } else {
      if (
        output.destination !== undefined &&
        !['configmap', 'secret', 'stdout', 'pvc'].includes(String(output.destination))
      ) {
        errors.push({
          field: 'spec.output.destination',
          message: 'destination must be one of: configmap, secret, stdout, pvc',
        })
      }
      if (output.claimName !== undefined) {
        if (typeof output.claimName !== 'string') {
          errors.push({ field: 'spec.output.claimName', message: 'claimName must be a string' })
        } else {
          const claimName = output.claimName.trim()
          if (String(output.destination) !== 'pvc') {
            errors.push({
              field: 'spec.output.claimName',
              message: 'claimName requires spec.output.destination=pvc',
            })
          } else if (
            !claimName ||
            claimName.length > 253 ||
            !K8S_DNS_SUBDOMAIN_RE.test(claimName)
          ) {
            errors.push({
              field: 'spec.output.claimName',
              message: 'claimName must be a valid Kubernetes PVC name',
            })
          }
        }
      }
    }
  }

  if (isScheduledRecipe(body)) {
    const teamId = workflowTeamIdLabel(body)
    if (!teamId) {
      errors.push({
        field: `metadata.labels.${WORKFLOW_TEAM_ID_LABEL}`,
        message: `scheduled WorkflowRecipe requires ${WORKFLOW_TEAM_ID_LABEL}`,
      })
    } else if (!UUID_RE.test(teamId)) {
      errors.push({
        field: `metadata.labels.${WORKFLOW_TEAM_ID_LABEL}`,
        message: `${WORKFLOW_TEAM_ID_LABEL} must be a UUID`,
      })
    }
  }

  const workloads = body.spec.workloads
  const workloadIds = new Set<string>()
  const transportWorkloadIds = new Set<string>()
  if (workloads !== undefined) {
    if (!Array.isArray(workloads)) {
      errors.push({ field: 'spec.workloads', message: 'workloads must be an array' })
    } else {
      workloads.forEach((w: unknown, i: number) => {
        if (!w || typeof w !== 'object') {
          errors.push({ field: `spec.workloads[${i}]`, message: 'each workload must be an object' })
          return
        }
        const wl = w as Record<string, unknown>
        if (!wl.id || typeof wl.id !== 'string') {
          errors.push({
            field: `spec.workloads[${i}].id`,
            message: 'id is required and must be a string',
          })
        } else {
          workloadIds.add(wl.id)
          if (wl.transport !== undefined) {
            transportWorkloadIds.add(wl.id)
          }
        }
        if (wl.type !== undefined && !ALLOWED_WORKLOAD_TYPES.has(String(wl.type))) {
          errors.push({
            field: `spec.workloads[${i}].type`,
            message: `type must be one of: ${[...ALLOWED_WORKLOAD_TYPES].join(', ')}`,
          })
        }
        if (!wl.image || typeof wl.image !== 'string') {
          errors.push({
            field: `spec.workloads[${i}].image`,
            message: 'image is required and must be a string',
          })
        }
        const env = wl.env
        if (Array.isArray(env)) {
          env.forEach((entry, j) => {
            if (!isPlainObject(entry)) return
            const reason = inlineEnvSecretReason(entry.name, entry.value)
            if (reason) {
              errors.push({
                field: `spec.workloads[${i}].env[${j}].value`,
                message: `${reason}; move this value to envSecret`,
                rule: 'workflowInlineSecretEnv',
              })
            }
          })
        }
        // Security context validation
        const sec = wl.security as Record<string, unknown> | undefined
        if (sec) {
          if (sec.runAsUser !== undefined) {
            const uid = Number(sec.runAsUser)
            if (!Number.isInteger(uid) || uid < 1) {
              errors.push({
                field: `spec.workloads[${i}].security.runAsUser`,
                message: 'runAsUser must be an integer >= 1 (root UID 0 is not allowed)',
              })
            }
          }
          if (Array.isArray(sec.addCapabilities)) {
            ;(sec.addCapabilities as unknown[]).forEach((cap, j) => {
              if (!isWorkflowRecipeDefaultAllowedCapability(cap)) {
                errors.push({
                  field: `spec.workloads[${i}].security.addCapabilities[${j}]`,
                  message: `capability "${cap}" is not in the allowed list`,
                })
              }
            })
          }
        }
      })
    }
  }

  const bindings = body.spec.bindings
  if (bindings !== undefined) {
    if (!Array.isArray(bindings)) {
      errors.push({ field: 'spec.bindings', message: 'bindings must be an array' })
    } else {
      bindings.forEach((binding: unknown, i: number) => {
        const prefix = `spec.bindings[${i}]`
        if (!isPlainObject(binding)) {
          errors.push({ field: prefix, message: 'each binding must be an object' })
          return
        }

        const from = typeof binding.from === 'string' ? binding.from.trim() : ''
        const to = typeof binding.to === 'string' ? binding.to.trim() : ''
        if (!from) {
          errors.push({ field: `${prefix}.from`, message: 'from is required and must be a string' })
        } else if (!workloadIds.has(from)) {
          errors.push({ field: `${prefix}.from`, message: `references unknown workload "${from}"` })
        }
        if (!to) {
          errors.push({ field: `${prefix}.to`, message: 'to is required and must be a string' })
        } else if (!workloadIds.has(to)) {
          errors.push({ field: `${prefix}.to`, message: `references unknown workload "${to}"` })
        }

        const port = Number(binding.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push({
            field: `${prefix}.port`,
            message: 'port must be an integer between 1 and 65535',
          })
        }
        if (binding.protocol !== undefined && !['TCP', 'UDP'].includes(String(binding.protocol))) {
          errors.push({ field: `${prefix}.protocol`, message: 'protocol must be TCP or UDP' })
        }

        if (from && to && workloadIds.has(from) && workloadIds.has(to)) {
          const transportEndpoints = [from, to].filter(id => transportWorkloadIds.has(id))
          if (transportEndpoints.length !== 1) {
            errors.push({
              field: prefix,
              message:
                'binding must connect exactly one MCP transport workload to one non-transport workload',
            })
          }
        }
      })
    }
  }

  const oauthClients = body.spec.oauthClients
  if (oauthClients !== undefined) {
    if (!Array.isArray(oauthClients)) {
      errors.push({ field: 'spec.oauthClients', message: 'oauthClients must be an array' })
    } else {
      oauthClients.forEach((c: unknown, i: number) => {
        if (!isPlainObject(c)) return // structural shape is CRD-enforced
        if (c.backgroundAccess !== true) return
        const provider = String(c.provider ?? '')
        const requiredScope = PROVIDER_OFFLINE_SCOPE[provider]
        if (!requiredScope) return
        const scopes = Array.isArray(c.scopes) ? (c.scopes as unknown[]) : []
        if (!scopes.includes(requiredScope)) {
          errors.push({
            field: `spec.oauthClients[${i}].scopes`,
            message: `backgroundAccess requires the "${requiredScope}" scope for provider "${provider}" — without a refresh token the broker cannot sustain access`,
            rule: 'background_access_missing_offline_scope',
          })
        }
      })
    }
  }

  // Path B — `workloads[].oauthClientRefs` must reference declared
  // backgroundAccess clients, and only non-MCP, non-UI workloads may opt in.
  const backgroundClientIds = new Set<string>(
    Array.isArray(oauthClients)
      ? oauthClients
          .filter(c => isPlainObject(c) && c.backgroundAccess === true && typeof c.id === 'string')
          .map(c => (c as { id: string }).id)
      : []
  )
  const uiWorkloadRef =
    isPlainObject(body.spec.ui) && typeof body.spec.ui.workloadRef === 'string'
      ? body.spec.ui.workloadRef
      : undefined
  if (Array.isArray(workloads)) {
    workloads.forEach((w: unknown, i: number) => {
      if (!isPlainObject(w) || w.oauthClientRefs === undefined) return
      const field = `spec.workloads[${i}].oauthClientRefs`
      if (!Array.isArray(w.oauthClientRefs)) {
        errors.push({ field, message: 'oauthClientRefs must be an array of strings' })
        return
      }
      if (w.transport !== undefined) {
        errors.push({
          field,
          message: 'oauthClientRefs is only valid on non-MCP workloads (no transport)',
          rule: 'oauth_client_ref_invalid_workload',
        })
      }
      if (typeof w.id === 'string' && w.id === uiWorkloadRef) {
        errors.push({
          field,
          message: 'the UI workload cannot use background OAuth — use the embed OAuth flow',
          rule: 'oauth_client_ref_invalid_workload',
        })
      }
      for (const ref of w.oauthClientRefs as unknown[]) {
        if (typeof ref !== 'string' || !backgroundClientIds.has(ref)) {
          errors.push({
            field,
            message: `references "${String(ref)}", which is not a declared oauthClient with backgroundAccess: true`,
            rule: 'oauth_client_ref_unknown',
          })
        }
      }
    })
  }

  errors.push(...validateWorkloadTemplateReferences(body))

  return errors
}

function sanitizeRecipeBody(
  body: RecipeBody,
  currentLabels?: Record<string, string>
): {
  metadata: { name: string; labels?: Record<string, string> }
  spec: Record<string, unknown>
} {
  const metadata = { ...(body.metadata ?? {}) }
  delete metadata.namespace
  const workflowTeamId = workflowTeamIdLabel(body)
  // Authors may only set the schedule ownership label. On updates, preserve
  // existing platform labels while removing stale schedule ownership if the
  // new spec no longer declares scheduling.
  const labels = currentLabels ? { ...currentLabels } : undefined
  if (labels) delete labels[WORKFLOW_TEAM_ID_LABEL]
  if (workflowTeamId) {
    if (labels) labels[WORKFLOW_TEAM_ID_LABEL] = workflowTeamId
  }
  const sanitizedLabels =
    labels ?? (workflowTeamId ? { [WORKFLOW_TEAM_ID_LABEL]: workflowTeamId } : undefined)
  return {
    metadata: {
      name: metadata.name as string,
      ...(sanitizedLabels ? { labels: sanitizedLabels } : {}),
    },
    spec: body.spec as Record<string, unknown>,
  }
}

/**
 * Default-deny invariant: agentic workflow (`spec.steps[]` present) with
 * `spec.contextRef` MUST also declare `spec.security.allowContextRef = true`
 * AND have a matching `WorkflowRecipePolicy` with `allowContextRef = true`
 * in the target namespace.
 *
 * Shared between `/validate` (L2, pre-flight) and `POST /recipes` (L3, submit)
 * so there is exactly ONE site encoding the rule in control-api. The reconciler
 * (workflow-recipes/policyEnforcer.ts) is L4 backstop.
 *
 * Returns `null` when the invariant is irrelevant (non-agentic or no
 * contextRef) or when both conditions are satisfied. Returns an array with
 * one `ValidationError` otherwise — callers decide the HTTP status.
 */
async function checkPolicyInvariant(
  body: RecipeBody,
  gateway: K8sGateway
): Promise<ValidationError[] | null> {
  const spec = body.spec as
    | {
        steps?: unknown[]
        contextRef?: string
        security?: { allowContextRef?: boolean }
      }
    | undefined
  const isAgentic = Array.isArray(spec?.steps) && spec.steps.length > 0
  const hasContextRef = typeof spec?.contextRef === 'string' && spec.contextRef.length > 0
  if (!isAgentic || !hasContextRef) return null

  // Post-refactor: CRD and matching policies always live in
  // RECIPE_CRD_NAMESPACE. The previous body-derived lookup was a source of
  // confusion — authors applied the policy in one ns and the recipe landed
  // in another.
  const targetNs = RECIPE_CRD_NAMESPACE

  const ctxRef = spec!.contextRef!
  const recipeFlag = spec?.security?.allowContextRef === true
  const policies = (await gateway.listResource('workflowrecipepolicies', targetNs)) as Array<{
    spec?: { allowContextRef?: boolean }
  }>
  const policyAllows = policies.some(p => p.spec?.allowContextRef === true)
  if (recipeFlag && policyAllows) return null

  // Build a message that surfaces THE specific missing piece, not a generic
  // "you need both". Three rejection shapes:
  //   (1) flag missing, policy missing  → both needed, but user control is
  //       on the recipe first (they own it), policy is operator-owned.
  //   (2) flag missing, policy present  → only the recipe flag is missing.
  //   (3) flag present,  policy missing → only the policy is missing
  //       (authoring a policy needs cluster-admin, not recipe author).
  let message: string
  if (!recipeFlag && !policyAllows) {
    message =
      `This agentic recipe references the shared Context "${ctxRef}". ` +
      `Two changes are required:\n` +
      `  • Add \`"security": { "allowContextRef": true }\` to spec (opt-in acknowledgment on the recipe).\n` +
      `  • Ensure a WorkflowRecipePolicy with \`allowContextRef: true\` exists in namespace "${targetNs}".\n` +
      `Alternatively, remove \`spec.contextRef\` — WRC will auto-create a private Context "wf-<recipeName>" ` +
      `with no sharing and no policy required.`
  } else if (!recipeFlag) {
    message =
      `This agentic recipe references the shared Context "${ctxRef}". ` +
      `A matching WorkflowRecipePolicy is already in place; add ` +
      `\`"security": { "allowContextRef": true }\` to spec to opt in.`
  } else {
    // recipeFlag is true, policy missing
    message =
      `This agentic recipe references the shared Context "${ctxRef}" with ` +
      `\`allowContextRef: true\` on the recipe, but no WorkflowRecipePolicy with ` +
      `\`allowContextRef: true\` exists in namespace "${targetNs}". ` +
      `Ask an operator to apply a WorkflowRecipePolicy that permits this feature, ` +
      `or remove \`spec.contextRef\` to use a private auto-context.`
  }

  return [
    {
      field: 'spec.contextRef',
      rule: 'agenticWorkflowContextRefBlocked',
      message,
    },
  ]
}

/**
 * Name collision check: if a recipe with `body.metadata.name` already exists
 * in the canonical recipe namespace, return a `recipeNameTaken` violation so the
 * editor banner can tell the admin to pick a different name BEFORE they
 * click Deploy (instead of after a 409 surfaces from `createResource`).
 *
 * Returns `null` when the name is available in sandbox-recipes.
 * Surfaces non-404 errors so the caller can render a meaningful message
 * (RBAC, network, etc.). The caller is responsible for deciding when to
 * skip this check — it's meant for CREATE flows only; EDIT flows should
 * pass `mode=edit` so the existing recipe is not flagged as a collision.
 */
async function checkRecipeNameAvailable(
  body: RecipeBody,
  gateway: K8sGateway
): Promise<ValidationError[] | null> {
  const name = body?.metadata?.name
  if (typeof name !== 'string' || name.length === 0) {
    // Name was already rejected by validateRecipeBody — skip.
    return null
  }

  for (const ns of RECIPE_NAMESPACES) {
    try {
      await gateway.getResource(PLURAL, name, ns)
      return [
        {
          field: 'metadata.name',
          rule: 'recipeNameTaken',
          message: `Recipe "${name}" already exists in namespace "${ns}". Choose a different name.`,
        },
      ]
    } catch (err) {
      if (!isK8sNotFoundLike(err)) {
        throw err
      }
      // 404 in sandbox-recipes — name is available.
    }
  }
  return null
}

async function updateRecipeWithConflictRetry(
  gateway: K8sGateway,
  name: string,
  body: { metadata?: { labels?: Record<string, string> }; spec: Record<string, unknown> },
  namespace: string
): Promise<unknown> {
  let lastConflict: unknown

  for (let attempt = 1; attempt <= UPDATE_CONFLICT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await gateway.updateResource(PLURAL, name, body, namespace)
    } catch (err) {
      if (!isK8sConflictLike(err)) throw err
      lastConflict = err
      if (attempt < UPDATE_CONFLICT_RETRY_ATTEMPTS) {
        await sleep(UPDATE_CONFLICT_RETRY_DELAY_MS * attempt)
      }
    }
  }

  throw lastConflict
}

export function createAdminRecipesRouter(gateway: K8sGateway): Router {
  const router = Router()

  /**
   * Look up a WorkflowRecipe in the canonical recipe namespace only.
   *
   * Returns the actual namespace where the recipe lives plus the fetched
   * resource (callers reuse it instead of doing a second `getResource` call).
   *
   * Throws `K8sNotFoundError` if the recipe is not in sandbox-recipes.
   * Throws the original error if any probe fails for a non-404 reason.
   */
  async function findRecipeNamespace(name: string): Promise<{ ns: string; resource: unknown }> {
    const results = await Promise.allSettled(
      RECIPE_NAMESPACES.map(ns => gateway.getResource(PLURAL, name, ns))
    )

    // 1. Surface any non-404 error first — never mask a real failure
    //    (RBAC, timeout, parse) as a "not found".
    //    Iterate ALL results before branching, to eliminate timing side-channels
    //    (an early return on first non-404 would leak which namespace errored first).
    let non404Error: unknown
    let hitNs: string | null = null
    let hitResource: unknown
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        if (!isK8sNotFoundLike(result.reason) && !non404Error) {
          non404Error = result.reason
        }
      } else if (hitNs === null) {
        // Capture first hit in declared namespace order
        hitNs = RECIPE_NAMESPACES[i]
        hitResource = result.value
      }
    }

    // 2. If any probe failed for a non-404 reason, surface that error.
    if (non404Error) throw non404Error

    // 3. Return the first successful hit (already captured above).
    if (hitNs !== null) {
      return { ns: hitNs, resource: hitResource }
    }

    // 4. All probes returned NotFound — surface the first 404 (or a synthetic one).
    const firstNotFound = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw (
      (firstNotFound?.reason as K8sNotFoundError | undefined) ??
      new K8sNotFoundError(`workflowrecipes/${name} not found`)
    )
  }

  /**
   * Resolve a parent recipe name to the recipe instance that actually owns
   * the running execution — i.e. the most-recently-created child (labelled
   * `clerum.io/parent-recipe=<parentName>`). Children are spawned per
   * WorkflowRun row by workflow-recipes; that child is what runs the
   * coordinator+mcp-host pods and where artifacts and execution status live.
   *
   * Falls back to the parent itself when no children exist (freshly installed
   * recipe that has never been run).
   *
   * Used for /status and /artifacts endpoints so they reflect the latest run
   * instead of the parent's stale reconcile-time state.
   */
  async function resolveLatestRun(
    parentName: string
  ): Promise<{ name: string; namespace: string; resource: unknown }> {
    const { resource: parent, ns } = await findRecipeNamespace(parentName)
    const all = (await gateway.listResource(PLURAL, ns)) as Array<{
      metadata?: {
        name?: string
        creationTimestamp?: string
        labels?: Record<string, string>
      }
      status?: Record<string, unknown>
    }>
    const latestChild = all
      .filter(r => r.metadata?.labels?.['clerum.io/parent-recipe'] === parentName)
      .sort((a, b) =>
        (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? '')
      )[0]
    if (latestChild?.metadata?.name) {
      return { name: latestChild.metadata.name, namespace: ns, resource: latestChild }
    }
    return { name: parentName, namespace: ns, resource: parent }
  }

  router.get(
    BASE,
    asyncHandler(async (_req, res) => {
      // No enforceNamespace: this route has no caller-supplied namespace to audit.
      // List only the platform-owned WorkflowRecipe namespace.
      const all = await gateway.listResource(PLURAL, RECIPE_CRD_NAMESPACE)
      // Filter out:
      //  - resources K8s is currently terminating (deletionTimestamp set), and
      //  - per-run child recipes (clerum.io/workflow-run-id label set). Workflow-recipes
      //    spawns a child WorkflowRecipe per WorkflowRun row to materialize the run; those
      //    are reconciliation artifacts, not user-installed templates, and don't belong
      //    in the recipes list. Runs surface through the per-recipe status modal instead.
      const items = (
        all as Array<{
          metadata?: { deletionTimestamp?: string; labels?: Record<string, string> }
        }>
      ).filter(r => {
        if (r.metadata?.deletionTimestamp) return false
        if (r.metadata?.labels?.['clerum.io/workflow-run-id']) return false
        return true
      })
      res.status(200).json({ items })
    })
  )

  router.post(
    `${BASE}/validate`,
    asyncHandler(async (req, res) => {
      const body = req.body as RecipeBody
      // Optional ?mode=create|edit. Defaults to 'create' because that's the
      // flow that can trigger a 409 Conflict — edit mode already knows the
      // recipe exists and shouldn't be flagged for its own name.
      const modeRaw = typeof req.query.mode === 'string' ? req.query.mode : 'create'
      const mode = modeRaw === 'edit' ? 'edit' : 'create'

      const errors = validateRecipeBody(body)
      if (errors.length > 0) {
        res.status(422).json({ valid: false, errors })
        return
      }
      const egressErrors = await validateWorkflowRecipeEgressPreflight(body.spec)
      if (egressErrors.length > 0) {
        res.status(422).json({ valid: false, errors: egressErrors })
        return
      }
      const policyErrors = await checkPolicyInvariant(body, gateway)
      if (policyErrors) {
        res.status(422).json({ valid: false, errors: policyErrors })
        return
      }
      if (mode === 'create') {
        const nameErrors = await checkRecipeNameAvailable(body, gateway)
        if (nameErrors) {
          res.status(422).json({ valid: false, errors: nameErrors })
          return
        }
      }
      const workflowSecretResult = await validateWorkflowRecipeSecretsAndCollectPending(
        body,
        gateway,
        {
          deferMissingWorkflowSecrets: true,
          includeOauthClientSecrets: true,
        }
      )
      if (workflowSecretResult.errors) {
        res.status(422).json({ valid: false, errors: workflowSecretResult.errors })
        return
      }
      const pendingCredentials = workflowSecretResult.pendingCredentials
      res.status(200).json({ valid: true, pendingCredentials })
    })
  )

  router.post(
    `${BASE}/secrets`,
    asyncHandler(async (req, res) => {
      const body = req.body as {
        name?: unknown
        namespace?: unknown
        data?: unknown
        stringData?: unknown
        ownership?: unknown
      }
      const nameErr = validateRecipeName(body?.name)
      if (nameErr) {
        res.status(400).json({ error: nameErr })
        return
      }
      const name = body.name as string
      if (isPlatformManagedWorkflowSecretName(name)) {
        res.status(400).json({ error: 'platform-managed workflow Secrets cannot be modified' })
        return
      }
      const namespace =
        typeof body.namespace === 'string' && body.namespace.length > 0
          ? body.namespace
          : RECIPE_CRD_NAMESPACE
      if (!WORKFLOW_RECIPE_SECRET_NAMESPACES.has(namespace)) {
        res.status(400).json({
          error: `WorkflowRecipe Secrets can only be managed in ${Array.from(
            WORKFLOW_RECIPE_SECRET_NAMESPACES
          ).join(' or ')}`,
        })
        return
      }

      const rawData = isPlainObject(body.stringData)
        ? body.stringData
        : isPlainObject(body.data)
          ? body.data
          : {}
      const stringData: Record<string, string> = {}
      for (const [key, value] of Object.entries(rawData)) {
        const keyErr = invalidSecretDataKeyReason(key)
        if (keyErr) {
          res.status(400).json({ error: keyErr, key })
          return
        }
        if (typeof value !== 'string') {
          res.status(400).json({ error: `secret value for key "${key}" must be a string` })
          return
        }
        stringData[key] = value
      }
      if (Object.keys(stringData).length === 0) {
        res.status(400).json({ error: 'at least one secret key/value is required' })
        return
      }
      // This endpoint writes `type: Opaque` (below). The kubelet only honors
      // `kubernetes.io/dockerconfigjson` / `dockercfg` Secrets for image pulls, so a
      // pull-secret-shaped payload written here would be accepted, stored, and then
      // SILENTLY ignored at pull time — surfacing much later as an unexplained
      // ImagePullBackOff. Refuse it instead of writing an object that cannot work.
      if (Object.keys(stringData).some(k => k === '.dockerconfigjson' || k === '.dockercfg')) {
        res.status(400).json({
          error:
            'this endpoint creates Opaque secrets, which Kubernetes ignores for image pulls. ' +
            'Images on the evenfire registry are handled automatically — no pull secret is ' +
            'needed. For a third-party registry, create a kubernetes.io/dockerconfigjson ' +
            'Secret in the workload namespace and label it clerum.io/owner-recipe=<recipe>.',
          key: '.dockerconfigjson',
        })
        return
      }
      const ownershipParse = parseWorkflowSecretOwnershipBody(body)
      if (!ownershipParse.ok) {
        res.status(400).json({ error: ownershipParse.error })
        return
      }
      const requestedOwnership = ownershipParse.ownership

      let created = false
      let existingData: Record<string, string> | undefined
      let existingLabels: Record<string, string> | undefined
      try {
        const existing = await gateway.getSecret(name, namespace)
        if (isPlainObject(existing) && isPlainObject(existing.data)) {
          existingData = existing.data as Record<string, string>
        }
        if (isPlainObject(existing) && isPlainObject(existing.metadata)) {
          existingLabels = stringLabels(existing.metadata.labels)
        }
      } catch (err) {
        if (!isK8sNotFoundLike(err)) throw err
        created = true
      }
      const existingOwnership = parseSecretOwnership(existingLabels)
      if (
        existingOwnership.kind === 'owner-recipe' &&
        requestedOwnership.kind === 'owner-recipe' &&
        existingOwnership.recipeName !== requestedOwnership.recipeName
      ) {
        res.status(403).json({
          error:
            `Secret "${name}" is owned by recipe "${existingOwnership.recipeName}" and cannot be ` +
            `modified for recipe "${requestedOwnership.recipeName}".`,
        })
        return
      }
      const preservedLabels = { ...(existingLabels ?? {}) }
      delete preservedLabels[OWNER_RECIPE_LABEL_KEY]
      delete preservedLabels[SHARED_LABEL_KEY]

      const payload = {
        name,
        namespace,
        type: 'Opaque',
        labels: {
          ...preservedLabels,
          ...WORKFLOW_SECRET_LABELS,
          ...workflowSecretOwnershipLabels(requestedOwnership),
        },
        ...(existingData && { data: existingData }),
        stringData,
      }
      if (created) {
        await gateway.createSecret(payload)
      } else {
        await gateway.updateSecret(payload)
      }

      res.status(created ? 201 : 200).json({
        name,
        namespace,
        keys: Object.keys(stringData),
        ownership: requestedOwnership,
        created,
      })
    })
  )

  router.post(
    BASE,
    asyncHandler(async (req, res) => {
      const body = req.body as RecipeBody
      const errors = validateRecipeBody(body)
      if (errors.length > 0) {
        res.status(422).json({ errors })
        return
      }
      const egressErrors = await validateWorkflowRecipeEgressPreflight(body.spec)
      if (egressErrors.length > 0) {
        res.status(422).json({ errors: egressErrors })
        return
      }
      // L3 policy invariant — same check as /validate, cannot be bypassed by
      // clients that skip the pre-flight call. Reuses the shared helper so
      // the rule has exactly one implementation site in control-api.
      const policyErrors = await checkPolicyInvariant(body, gateway)
      if (policyErrors) {
        res.status(422).json({ errors: policyErrors })
        return
      }
      // Fail-fast on name collisions before we try gateway.createResource —
      // turns an opaque 409 Conflict into a structured 422 the UI can render
      // directly ("recipe X already exists, choose another name").
      const nameErrors = await checkRecipeNameAvailable(body, gateway)
      if (nameErrors) {
        res.status(422).json({ errors: nameErrors })
        return
      }
      const workflowSecretResult = await validateWorkflowRecipeSecretsAndCollectPending(
        body,
        gateway,
        {
          deferMissingWorkflowSecrets: true,
          includeOauthClientSecrets: true,
        }
      )
      if (workflowSecretResult.errors) {
        res.status(422).json({ errors: workflowSecretResult.errors })
        return
      }
      const pendingCredentials = workflowSecretResult.pendingCredentials
      // The CRD always goes to RECIPE_CRD_NAMESPACE. Any namespace present in
      // the author YAML is deliberately discarded here because infra owns
      // placement; WorkflowRecipe YAML is not a namespace contract.
      // The reconciler still independently splits the rendered resources:
      //   - MCP workloads (transport) → mcp-server
      //   - non-MCP workloads + PVCs  → sandbox-recipes
      const sanitized = sanitizeRecipeBody(body)
      const created = await gateway.createResource(PLURAL, sanitized, RECIPE_CRD_NAMESPACE)
      res
        .status(201)
        .json(
          isPlainObject(created)
            ? { ...created, pendingCredentials }
            : { resource: created, pendingCredentials }
        )
    })
  )

  router.get(
    `${BASE}/:name`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const { resource } = await findRecipeNamespace(req.params.name)
        res.status(200).json(resource)
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  router.put(
    `${BASE}/:name`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      const body = req.body as RecipeBody
      // For updates, metadata.name is from the URL param; inject it for validation
      if (!body.metadata) body.metadata = {}
      body.metadata.name = req.params.name
      const errors = validateRecipeBody(body)
      if (errors.length > 0) {
        res.status(422).json({ errors })
        return
      }
      const egressErrors = await validateWorkflowRecipeEgressPreflight(body.spec)
      if (egressErrors.length > 0) {
        res.status(422).json({ errors: egressErrors })
        return
      }
      const policyErrors = await checkPolicyInvariant(body, gateway)
      if (policyErrors) {
        res.status(422).json({ errors: policyErrors })
        return
      }
      const workflowSecretResult = await validateWorkflowRecipeSecretsAndCollectPending(
        body,
        gateway,
        {
          deferMissingWorkflowSecrets: true,
          includeOauthClientSecrets: true,
        }
      )
      if (workflowSecretResult.errors) {
        res.status(422).json({ errors: workflowSecretResult.errors })
        return
      }
      const pendingCredentials = workflowSecretResult.pendingCredentials
      // Discover the canonical recipe resource and update it in sandbox-recipes.
      try {
        const { ns, resource } = await findRecipeNamespace(req.params.name)
        const currentLabels = isPlainObject(resource)
          ? stringLabels(isPlainObject(resource.metadata) ? resource.metadata.labels : undefined)
          : undefined
        const sanitized = sanitizeRecipeBody(body, currentLabels)
        const updated = await updateRecipeWithConflictRetry(gateway, req.params.name, sanitized, ns)
        res
          .status(200)
          .json(
            isPlainObject(updated)
              ? { ...updated, pendingCredentials }
              : { resource: updated, pendingCredentials }
          )
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        if (isK8sConflictLike(err)) {
          res.status(409).json({
            error: 'conflict',
            message: 'WorkflowRecipe was modified while updating; retry the request.',
          })
          return
        }
        throw err
      }
    })
  )

  router.delete(
    `${BASE}/:name`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const { ns } = await findRecipeNamespace(req.params.name)
        const deleted = await gateway.deleteResource(PLURAL, req.params.name, ns)
        res.status(200).json(deleted)
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  // Retry a recipe stuck in `failed`. Drives the canonical state-machine
  // transition `failed → retry → candidate` (workflow-recipes/src/reconciler/
  // stateMachine.ts:75). Once in `candidate`, the WRC reconciler's
  // non-deployable guard no longer skips it, so the next reconcile takes the
  // workload-status path and naturally settles on `active` or `degraded`
  // based on actual pod readiness — no separate "approve" or "deploy" call
  // needed for first-party recipes.
  router.post(
    `${BASE}/:name/retry`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const { ns, resource } = await findRecipeNamespace(req.params.name)
        const currentPhase = (resource as { status?: { phase?: string } }).status?.phase
        if (currentPhase !== 'failed') {
          res.status(409).json({
            error: 'invalid_transition',
            message: `Recipe is in phase "${currentPhase ?? 'unknown'}"; retry only applies to recipes in "failed".`,
          })
          return
        }
        // Mirrors stateMachine.transition('failed', 'retry') in workflow-recipes.
        // Duplicated rather than imported because control-api must not depend
        // on workflow-recipes source.
        await gateway.patchResourceStatus(
          PLURAL,
          req.params.name,
          { phase: 'candidate', message: 'Manual retry requested by operator' },
          ns
        )
        res.status(200).json({ name: req.params.name, phase: 'candidate' })
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  /**
   * Register a GET handler that fetches a recipe via `findRecipeNamespace`
   * and returns a derived JSON body from it. Centralizes the boilerplate
   * shared by `/:name/status` and `/:name/artifacts`:
   *   - namespace audit via enforceNamespace middleware (caller namespace silently ignored)
   *   - recipe name validation
   *   - canonical sandbox-recipes lookup via `findRecipeNamespace`
   *   - `K8sNotFoundError` → 404 mapping
   *   - non-404 errors propagate to the Express error handler (5xx)
   */
  function registerRecipeFieldRoute(
    subpath: string,
    extract: (resource: unknown) => Record<string, unknown>
  ): void {
    router.get(
      `${BASE}/:name/${subpath}`,
      asyncHandler(async (req, res) => {
        if (!validateName(req.params.name)) {
          res.status(400).json({ error: 'Invalid recipe name' })
          return
        }
        try {
          const { resource } = await findRecipeNamespace(req.params.name)
          res.status(200).json(extract(resource))
        } catch (err) {
          if (isK8sNotFoundLike(err)) {
            res.status(404).json({ error: getErrorMessage(err) })
            return
          }
          throw err
        }
      })
    )
  }

  // /:name/status and /:name/artifacts — both resolve to the latest run.
  //
  // Workflow-recipes spawns a child WorkflowRecipe per WorkflowRun row (labelled
  // `clerum.io/parent-recipe=<parentName>`); the child is the one that actually
  // executes. The parent CRD's own .status reflects whatever the reconciler
  // wrote on its last pass — which for a parent that was reconciled once and
  // then sat idle is a stale execution that has nothing to do with the current
  // run. Falls back to the parent's own .status only when no children exist
  // yet (e.g., a freshly installed recipe that has never been run).
  router.get(
    `${BASE}/:name/status`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const { resource } = await resolveLatestRun(req.params.name)
        const status = (resource as { status?: Record<string, unknown> }).status ?? {}
        res.status(200).json(status)
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  // Pod-level state for every workload in the recipe, across all three
  // namespaces WRC splits into (sandbox-recipes / sandbox-ui / mcp-server).
  // The recipe's own `.status.workloads[].ready` reflects only "WRC applied
  // the manifest"; the kubelet may still have the pod stuck in
  // `CreateContainerConfigError`, `ImagePullBackOff`, or `CrashLoopBackOff`.
  // This endpoint closes that gap for the Workloads tab on the detail page.
  router.get(
    `${BASE}/:name/pods`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const pods = await gateway.listPodsForRecipe(req.params.name)
        res.status(200).json({ pods })
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/:name/artifacts`,
    asyncHandler(async (req, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      try {
        const { resource } = await resolveLatestRun(req.params.name)
        const artifacts =
          (
            resource as {
              status?: {
                artifacts?: Array<{
                  name: string
                  format: string
                  sizeBytes: number
                  path: string
                  createdAt: string
                }>
              }
            }
          )?.status?.artifacts ?? []
        res.status(200).json({ artifacts })
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: getErrorMessage(err) })
          return
        }
        throw err
      }
    })
  )

  // ── Artifact download endpoint ───────────────────────────────────────────
  // Proxies a single artifact file from the workflow's mcp-host pod via WRC
  // (workflow-recipes). Control-api signs a short-lived delegation JWT
  // (iss=control-api, aud=clerum-wrc, scope=admin:artifact_read) which WRC
  // verifies with the control-api SPKI public key before re-signing a fresh
  // artifact_read token for the downstream mcp-host hop.
  //
  // This replaces the previous K8s Exec API path (readFileFromPod), which
  // required broad `pods/exec` RBAC in sandbox-recipes and offered no
  // recipeName binding or audit trail. The new flow keeps control-api
  // confined to control-plane and enforces recipeName at every hop through
  // the delegated artifact-read token chain.

  router.get(
    `${BASE}/:name/artifacts/:artifactName/download`,
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req: UiAuthedRequest, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }

      const artifactName = req.params.artifactName
      // Security: only allow safe filenames (block slashes, null bytes, path traversal).
      // WRC and mcp-host also validate this, but fail closed at the first hop.
      if (!artifactName || /[/\\\x00]/.test(artifactName) || artifactName.includes('..')) {
        res.status(400).json({ error: 'Invalid artifact name' })
        return
      }

      // The admin user ID is populated by requireAuthForControlUI middleware
      // mounted in app.ts on /admin/*. Reject if somehow missing (defense in
      // depth — should never happen for a mounted admin route).
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      // Resolve the parent name → latest child run. Artifacts and the running
      // mcp-host pod live on the child, not the parent; WRC validates the
      // delegation JWT's recipeName against its own state, so we must sign
      // the child's name (and its co-located namespace).
      let runName: string
      let recipeNamespace: string
      try {
        const resolved = await resolveLatestRun(req.params.name)
        runName = resolved.name
        recipeNamespace = resolved.namespace
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: 'Recipe not found' })
          return
        }
        throw err
      }
      const delegationToken = signWrcDelegationToken({
        adminUserId,
        recipeName: runName,
        recipeNamespace,
        scope: 'admin:artifact_read',
        artifactName,
      })

      // Build the WRC proxy URL. WRC exposes artifacts at
      //   GET /api/v1/workflow/:recipeName/artifacts/:filename
      // encodeURIComponent() is safe here because both values have already
      // been validated against strict allowlists
      // (RFC1123 for recipeName, filename regex for artifactName).
      const wrcUrl = buildWrcWorkflowArtifactsUrl(runName, artifactName)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), ARTIFACT_FETCH_TIMEOUT_MS)

      try {
        const upstream = await fetch(wrcUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${delegationToken}`,
            Accept: 'application/octet-stream',
          },
          signal: controller.signal,
        })

        if (!upstream.ok) {
          // Mirror upstream status codes for 4xx, collapse 5xx to preserve
          // the "control-api never leaks internal details" rule. Never echo
          // the upstream body verbatim — it may contain unexpected headers.
          if (upstream.status === 404) {
            res.status(404).json({ error: `Artifact "${artifactName}" not found` })
          } else if (upstream.status === 401 || upstream.status === 403) {
            res.status(upstream.status).json({ error: 'Not authorized to read artifact' })
          } else {
            res.status(502).json({ error: 'Upstream artifact service error' })
          }
          return
        }

        const arrayBuffer = await upstream.arrayBuffer()
        const fileBuffer = Buffer.from(arrayBuffer)

        const ext = artifactName.split('.').pop()?.toLowerCase() ?? ''
        const contentType =
          upstream.headers.get('content-type') ?? CONTENT_TYPES[ext] ?? 'application/octet-stream'

        res.setHeader('Content-Type', contentType)
        const safeFilename = artifactName.replace(/[^a-zA-Z0-9_.\-]/g, '_')
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
        res.setHeader('Content-Length', fileBuffer.length)
        res.send(fileBuffer)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          res.status(504).json({ error: 'Upstream artifact fetch timed out' })
          return
        }
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error(
          JSON.stringify({ event: 'artifact_proxy_error', recipe: req.params.name, error: msg })
        )
        res.status(502).json({ error: 'Upstream artifact service error' })
      } finally {
        clearTimeout(timeoutId)
      }
    })
  )

  // ── Admin single artifact delete endpoint ───────────────────────────────
  router.delete(
    `${BASE}/:name/artifacts/:artifactName`,
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req: UiAuthedRequest, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }
      const artifactName = req.params.artifactName
      if (!artifactName || /[/\\\x00]/.test(artifactName) || artifactName.includes('..')) {
        res.status(400).json({ error: 'Invalid artifact name' })
        return
      }
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      // Resolve parent → latest child run (artifacts live on the child's pod).
      let runName: string
      let recipeNamespace: string
      try {
        const resolved = await resolveLatestRun(req.params.name)
        runName = resolved.name
        recipeNamespace = resolved.namespace
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: 'Recipe not found' })
          return
        }
        throw err
      }
      const delegationToken = signWrcDelegationToken({
        adminUserId,
        recipeName: runName,
        recipeNamespace,
        artifactName,
        scope: 'admin:artifact_delete',
      })

      const wrcUrl = buildWrcWorkflowArtifactsUrl(runName, artifactName)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), ARTIFACT_FETCH_TIMEOUT_MS)

      try {
        const upstream = await fetch(wrcUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${delegationToken}` },
          signal: controller.signal,
        })
        if (!upstream.ok) {
          if (upstream.status === 404) {
            res.status(404).json({ error: `Artifact "${artifactName}" not found` })
          } else if (upstream.status === 401 || upstream.status === 403) {
            res.status(upstream.status).json({ error: 'Not authorized to delete artifact' })
          } else {
            res.status(502).json({ error: 'Upstream artifact service error' })
          }
          return
        }
        res.status(204).end()
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          res.status(504).json({ error: 'Upstream artifact delete timed out' })
          return
        }
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error(
          JSON.stringify({
            event: 'artifact_file_delete_proxy_error',
            recipe: runName,
            artifact: artifactName,
            error: msg,
          })
        )
        res.status(502).json({ error: 'Upstream artifact service error' })
      } finally {
        clearTimeout(timeoutId)
      }
    })
  )

  // ── Admin artifact delete endpoint ──────────────────────────────────────
  // Proxies a DELETE request to WRC → mcp-host to clear all artifacts for
  // a given recipe. Same dual-issuer model as the download endpoint: signs
  // a short-lived delegation JWT with scope admin:artifact_delete, which
  // WRC verifies before re-signing a fresh artifact_delete token for the
  // downstream mcp-host hop.

  router.delete(
    `${BASE}/:name/artifacts`,
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req: UiAuthedRequest, res) => {
      if (!validateName(req.params.name)) {
        res.status(400).json({ error: 'Invalid recipe name' })
        return
      }

      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      // Resolve parent → latest child run (artifacts live on the child's pod).
      let runName: string
      let recipeNamespace: string
      try {
        const resolved = await resolveLatestRun(req.params.name)
        runName = resolved.name
        recipeNamespace = resolved.namespace
      } catch (err) {
        if (isK8sNotFoundLike(err)) {
          res.status(404).json({ error: 'Recipe not found' })
          return
        }
        throw err
      }
      const delegationToken = signWrcDelegationToken({
        adminUserId,
        recipeName: runName,
        recipeNamespace,
        scope: 'admin:artifact_delete',
      })

      const wrcUrl = buildWrcWorkflowArtifactsUrl(runName)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), ARTIFACT_FETCH_TIMEOUT_MS)

      try {
        const upstream = await fetch(wrcUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${delegationToken}`,
          },
          signal: controller.signal,
        })

        if (!upstream.ok) {
          if (upstream.status === 404) {
            res.status(404).json({ error: 'Recipe not found or no artifacts' })
          } else if (upstream.status === 401 || upstream.status === 403) {
            res.status(upstream.status).json({ error: 'Not authorized to delete artifacts' })
          } else {
            res.status(502).json({ error: 'Upstream artifact service error' })
          }
          return
        }

        res.status(204).end()
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          res.status(504).json({ error: 'Upstream artifact delete timed out' })
          return
        }
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error(
          JSON.stringify({ event: 'artifact_delete_proxy_error', recipe: runName, error: msg })
        )
        res.status(502).json({ error: 'Upstream artifact service error' })
      } finally {
        clearTimeout(timeoutId)
      }
    })
  )

  return router
}
