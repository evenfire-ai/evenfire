import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { parse as parseYaml } from 'yaml'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { extractK8sError } from '../../http/k8sError.js'
import { validateMcpServerSpecPreflight } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { type AdminUserRecord, findAdminById } from '../../services/adminAuthService.js'
import {
  addHookRefToHost,
  listHostsReferencingHook,
  syncHookRefsInHosts,
} from '../../services/hostGuardrailRefs.js'
import { createKey, listImages, listKeys, revokeKey } from '../../services/orgApiKeyClient.js'
import type { RegistryEntry } from '../../services/registryClient.js'
import {
  RegistryProxyError,
  applyPublishScope,
  createOrgGrant,
  deleteVersion,
  downloadBundle,
  getCategories,
  getCredentialSchema,
  getDigest,
  getEntry,
  getEntryVersion,
  listGrantedToMe,
  listOrgEntries,
  listOrgGrants,
  publishEntry,
  reportInstall,
  resolvePublishScope,
  revokeOrgGrant,
  searchEntries,
  updateVersionMetadata,
  uploadArtifacts,
} from '../../services/registryClient.js'
import { isRegistryAuthActive } from '../../services/registryConnectionDb.js'
import {
  REGISTRY_OPERATION_ID_ANNOTATION,
  REGISTRY_SPEC_DIGEST_ANNOTATION,
  type RegistryMutationOutcome,
  type RegistryResourceSnapshot,
  classifyCreatedRegistryMutationReadback,
  classifyRegistryAssociationReadback,
  classifyRegistryMutationReadback,
  registrySpecDigest,
} from '../../services/registryMutation.js'
import {
  ensureRegistryPullSecret,
  ensureRegistryPullSecrets,
  platformWorkloadNamespaces,
} from '../../services/registryPullSecretService.js'
import {
  REGISTRY_SECRET_OPERATION_ID_ANNOTATION,
  invalidSecretTypeReason,
} from '../../services/secretConstraints.js'
import { findSecretReferenceState } from '../../services/secretReferenceService.js'
import { SecretSnapshot, toSecretSnapshot } from '../../services/secretRepository.js'
import {
  validateWorkflowRecipeEgressPreflight,
  validateWorkflowRecipeLimits,
} from '../../services/workflowRecipeLimits.js'
import type { SecretPreconditions, SecretUpsertRequest } from '../../types.js'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  shouldAttachEvenfirePullSecret,
} from './registryImagePullSecret.js'
import { checkEvenfireImageRefMatchesEntry } from './registryImageRefIdentity.js'
import {
  pullSecretErrorResponse,
  recipeReferencesPlatformImage,
} from './registryPullSecretProvisioning.js'

const DETERMINISTIC_REGISTRY_NO_COMMIT_STATUSES = new Set([
  400, 401, 403, 404, 405, 406, 411, 413, 415, 422,
])

/** Validate a Kubernetes resource name (RFC 1123 DNS subdomain). */
function isValidK8sName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && name.length <= 253
}

/** Generate a spec-compliant name: mcp-{slug}-v{version}-{hash8} (max 63 chars). */
export function generateRegistryName(entryName: string, version: string): string {
  const slug = entryName
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const vSlug = version.replace(/\./g, '-')
  const hash = createHash('sha256').update(`${entryName}:${version}`).digest('hex').slice(0, 8)
  return `mcp-${slug}-v${vSlug}-${hash}`.slice(0, 63).replace(/-$/, '')
}

/**
 * Read the catalog id from a resource's metadata. Org-scoped catalog names
 * contain '@' and '/' (illegal as label VALUES), so the id lives in an
 * annotation. Fall back to the label so resources installed before that change
 * (which carry it as a label) still read as installed until reconciled.
 */
export function getCatalogId(
  meta: { annotations?: Record<string, string>; labels?: Record<string, string> } | undefined
): string | undefined {
  return meta?.annotations?.['clerum.io/catalog-id'] ?? meta?.labels?.['clerum.io/catalog-id']
}

/** Read the catalog version (annotation-first, label fallback). See getCatalogId. */
export function getCatalogVersion(
  meta: { annotations?: Record<string, string>; labels?: Record<string, string> } | undefined
): string | undefined {
  return (
    meta?.annotations?.['clerum.io/catalog-version'] ?? meta?.labels?.['clerum.io/catalog-version']
  )
}

/**
 * Build the catalog-id / catalog-version annotation pair stamped onto every
 * managed McpServer / WorkflowRecipe / Secret. These are annotations (not
 * labels) because org-scoped names contain '@' and '/', which are illegal K8s
 * label values and make the apiserver reject the resource with a 422.
 */
export function catalogAnnotations(entryName: string, version: string): Record<string, string> {
  return {
    'clerum.io/catalog-id': entryName,
    'clerum.io/catalog-version': version,
  }
}

/**
 * A digest-pinned image ref: exactly one `@`, immediately followed by
 * `sha256:<64 hex>` and nothing else.
 *
 * Anchoring at the front is what makes it exact. An unanchored `/@sha256:…$/`
 * also accepts `repo@bar@sha256:…`, and the digest was then read with
 * `split('@')[1]` — which yields `bar`. That value is written into every Host's
 * `guardrails.hooks[].digest`, and the Host-side pin is exactly what mcp-host
 * compares against `status.observedDigest` to detect drift and quarantine a
 * hook, so a junk pin degrades the check that quarantine depends on.
 *
 * Shared by install-hook and upgrade-hook so the two cannot drift apart again —
 * they did: upgrade was fixed while install kept both halves of the bug.
 */
export function isDigestPinnedImageRef(ref: unknown): boolean {
  return typeof ref === 'string' && /^[^@]+@sha256:[0-9a-f]{64}$/.test(ref)
}

/** The `sha256:…` digest of a ref that passed `isDigestPinnedImageRef`. */
export function imageRefDigest(ref: unknown): string | undefined {
  return isDigestPinnedImageRef(ref) ? (ref as string).split('@').pop() : undefined
}

const MAX_RECIPE_YAML_SIZE = 100 * 1024 // 100 KB (spec §7.3)
const DELETE_SETTLE_TIMEOUT_MS = 3_000
const DELETE_SETTLE_POLL_MS = 100
const UPDATE_CONFLICT_RETRY_ATTEMPTS = 3
const UPDATE_CONFLICT_RETRY_DELAY_MS = 100
const REMOTE_MCP_EGRESS_PROXY_IMAGE =
  process.env.CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE || 'clerum/nginx-egress-proxy:0.1.0'

type RegistryCredentialSchema = {
  required: boolean
  authType: string
  keys: Array<{ name: string }>
  oauth2?: { authorizationUrl?: string; tokenUrl?: string; scopes?: string[] }
}

const NO_CREDENTIAL_SCHEMA: RegistryCredentialSchema = {
  required: false,
  authType: 'none',
  keys: [],
}

// ── install-hook trust policy (guardrails spec §8.4) ────────────────────────
const HOOK_TRUST_ORDER: Record<string, number> = { low: 0, mid: 1, high: 2 }
// Lifecycle points that ALWAYS receive message/response content (§8.4/§8.7). preCall
// is the one point with two flavors — content-bearing unless the hook declares
// `contentAccess: metadata` — so it is handled separately in isContentBearingHook.
//
// The tool-lane points (§6.2) are here because the tool lane has NO metadata
// projection: preToolUse receives {tool, arguments} and postToolUse receives the
// tool result, and remoteToolHook never consults contentAccess. Leaving them out
// classified a preToolUse-only hook as content-free, so a low-trust third-party
// hook with egressBindings or a remote target passed the content/egress gate
// while reading every tool argument and result at runtime.
const INHERENTLY_CONTENT_POINTS = new Set([
  'moderate',
  'postCallSuccess',
  'onError',
  'preToolUse',
  'postToolUse',
])

/**
 * §8.4/§8.7 — does this hook receive message/response CONTENT at any of its
 * lifecycle points? moderate/postCallSuccess/onError and both tool-lane points
 * always do; preCall does unless it explicitly declared `contentAccess: metadata`
 * (mcp-host's projection enforces the same rule, so the gate and the runtime
 * agree — the two land together, §12.4). Absent contentAccess ⇒ content-bearing
 * (conservative).
 */
export function isContentBearingHook(
  lifecyclePoints: string[] | undefined,
  contentAccess?: string
): boolean {
  if (!Array.isArray(lifecyclePoints)) return false
  if (lifecyclePoints.some(p => INHERENTLY_CONTENT_POINTS.has(p))) return true
  if (lifecyclePoints.includes('preCall')) return contentAccess !== 'metadata'
  return false
}

/**
 * §8.4 content/egress separation gate: a content-bearing hook that can ALSO reach
 * the network (declared `egressBindings` or a `remote` target) is an exfiltration
 * path and is admissible only at `trust_level: high`. Returns true when the hook
 * must be refused. Content-alone or egress-alone is fine below high.
 */
export function contentEgressRequiresHighTrust(args: {
  lifecyclePoints: string[] | undefined
  contentAccess?: string
  hasEgress: boolean
  isRemote: boolean
  trustLevel: string
}): boolean {
  return (
    isContentBearingHook(args.lifecyclePoints, args.contentAccess) &&
    (args.hasEgress || args.isRemote) &&
    args.trustLevel !== 'high'
  )
}

/** Registry `hook_meta` shape (mirrors the registry HookMeta / LlmHook.spec, §8.5). */
type HookMetaShape = {
  target: {
    image?: { ref?: string; port?: number; security?: Record<string, unknown> }
    service?: { name?: string; namespace?: string; port?: number }
    remote?: { baseUrl?: string }
  }
  lifecyclePoints: string[]
  contentAccess?: string
  path?: string
  defaultConfig?: Record<string, unknown>
  requiredEgress?: unknown[]
}

type HostGuardrailsShape = {
  hooks?: Record<string, Array<{ id: string; digest?: string }>>
  minInstalledHookTrustLevel?: string
  capabilityCeiling?: string[]
}
type HostShape = {
  metadata?: { uid?: string; resourceVersion?: string }
  spec?: { guardrails?: HostGuardrailsShape } & Record<string, unknown>
}

/** The `@org` scope from an org-scoped entry name (`@org/name`), or null. */
function hookOrgScope(entryName: string): string | null {
  const m = /^@([^/]+)\//.exec(entryName)
  return m ? `@${m[1]}` : null
}

/**
 * Official evenfire scopes — always curated (the platform's own reserved orgs).
 * Hardcoded so a misconfigured `CONTROL_API_CURATED_HOOK_ORGS` can never drop
 * platform trust, and so the env list is reserved for extra THIRD-PARTY orgs.
 */
const OFFICIAL_EVENFIRE_HOOK_ORGS = ['@clerum', '@evenfire']

/**
 * Authoritative trust level for an installed hook (§8.4 / registry gap #1).
 * `entries.trust_level` is publisher-influenced (trigger-computed from
 * author-supplied creator tags), so it is honored ONLY for a CURATED org; every
 * other org's hook is capped at `config.defaultHookTrustCap` — a self-published
 * hook can clear a `mid` floor but never reach `high` (and so can never unlock
 * the content+egress combination §8.4 reserves for `high`).
 *
 * Curated = the cluster's OWN org (`clusterOrgScope`, from resolvePublishScope) ∪
 * official evenfire (`@clerum`/`@evenfire`) ∪ the additive
 * `CONTROL_API_CURATED_HOOK_ORGS` allowlist (other third-party orgs). The first
 * two are trusted automatically — they are the operator's own org and the
 * platform — so the env is only consulted for orgs that are NEITHER.
 */
export function resolveHookTrustLevel(
  entry: Pick<RegistryEntry, 'name' | 'trust_level'>,
  clusterOrgScope: string | null
): string {
  const column = (entry.trust_level || 'low').toLowerCase()
  const org = hookOrgScope(entry.name)
  const curated =
    !!org &&
    (org === clusterOrgScope ||
      OFFICIAL_EVENFIRE_HOOK_ORGS.includes(org) ||
      config.curatedHookOrgs.includes(org))
  if (curated) return column
  const cap = config.defaultHookTrustCap
  return (HOOK_TRUST_ORDER[column] ?? 0) <= (HOOK_TRUST_ORDER[cap] ?? 1) ? column : cap
}

/**
 * Host-INDEPENDENT admissibility gates shared by install-hook AND upgrade-hook
 * (§8.4). resources.ts withholds raw create/update on `llmhooks` precisely so
 * these run on every install; upgrade-hook is the sanctioned update path and so
 * must clear the same gates or it becomes a bypass (a low-trust image hook could
 * "upgrade" to a content-bearing remote target and exfiltrate). Returns the
 * resolved trust level on success, or a typed rejection (HTTP status + body).
 * Per-Host gates (trust floor, capability ceiling) stay with the callers, which
 * hold the Host context.
 */
type HookAdmission =
  | { ok: true; trustLevel: string }
  | { ok: false; status: number; body: { error: string; reason?: string } }

function assertHookAdmissible(
  entry: Pick<RegistryEntry, 'name' | 'trust_level' | 'owner_type'>,
  hookMeta: HookMetaShape,
  clusterOrgScope: string | null
): HookAdmission {
  // Org-scoped only (§8.5).
  if (entry.owner_type && entry.owner_type !== 'org') {
    return { ok: false, status: 403, body: { error: 'hook_requires_org_scope' } }
  }
  // Authoritative trust level — never face-value for a self-published hook (§8.4).
  const trustLevel = resolveHookTrustLevel(entry, clusterOrgScope)
  // contentAccess: metadata is contradictory for an inherently content-bearing point.
  if (
    hookMeta.contentAccess === 'metadata' &&
    hookMeta.lifecyclePoints.some(p => INHERENTLY_CONTENT_POINTS.has(p))
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'content_access_conflict',
        reason:
          'contentAccess: metadata is not allowed for a hook using moderate/postCallSuccess/onError (§8.4)',
      },
    }
  }
  // Content/egress separation: content-bearing + (egress | remote) ⇒ high trust only.
  const hasEgress = Array.isArray(hookMeta.requiredEgress) && hookMeta.requiredEgress.length > 0
  const isRemote = !!hookMeta.target.remote
  if (
    contentEgressRequiresHighTrust({
      lifecyclePoints: hookMeta.lifecyclePoints,
      contentAccess: hookMeta.contentAccess,
      hasEgress,
      isRemote,
      trustLevel,
    })
  ) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'content_egress_requires_high_trust',
        reason:
          'a content-bearing hook (preCall/moderate/postCallSuccess/onError) with egress or a remote target requires trust_level high (§8.4)',
      },
    }
  }
  return { ok: true, trustLevel }
}

/** The declared target kind of a hook_meta / LlmHook spec (§8.5). */
function hookTargetKind(target: {
  image?: unknown
  service?: unknown
  remote?: unknown
}): 'image' | 'service' | 'remote' | 'unknown' {
  if (target.image) return 'image'
  if (target.service) return 'service'
  if (target.remote) return 'remote'
  return 'unknown'
}

const REGISTRY_SECRET_WRITE_OPTIONS = { capability: 'registryCredential' } as const

/**
 * Registry upgrades must either restore a credentials Secret exactly or refuse
 * before mutating anything. Silently stripping metadata during rollback can
 * remove ownership/reconciliation state from a Secret managed by another
 * controller.
 */
function nonRestorableSecretSnapshotReason(snapshot: SecretSnapshot): string | null {
  if (invalidSecretTypeReason(snapshot.type ?? 'Opaque')) {
    return 'existing credentials Secret type is not restorable under the registry write policy'
  }
  if (
    snapshot.labels?.['clerum.io/managed-by'] !== undefined &&
    snapshot.labels['clerum.io/managed-by'] !== 'control-api'
  ) {
    return 'existing credentials Secret is owned by another controller'
  }
  if (
    snapshot.labels?.['clerum.io/owner-recipe'] !== undefined ||
    snapshot.labels?.['clerum.io/recipe-secret'] !== undefined ||
    snapshot.labels?.['clerum.io/shared'] !== undefined
  ) {
    return 'existing credentials Secret is owned by a workflow recipe'
  }
  if (snapshot.ownerReferences?.length) {
    return 'existing credentials Secret has ownerReferences that the registry upgrade cannot restore'
  }
  if (snapshot.finalizers?.length) {
    return 'existing credentials Secret has finalizers that the registry upgrade cannot restore'
  }
  if (snapshot.immutable === true) {
    return 'existing credentials Secret is immutable'
  }
  if (!snapshot.uid || !snapshot.resourceVersion) {
    return 'existing credentials Secret has no complete Kubernetes identity for a safe rollback'
  }
  return null
}

function secretPreconditions(
  snapshot: Pick<SecretSnapshot, 'uid' | 'resourceVersion'>
): SecretPreconditions {
  if (!snapshot.uid || !snapshot.resourceVersion) {
    throw new RegistryInstallRollbackError()
  }
  return { uid: snapshot.uid, resourceVersion: snapshot.resourceVersion }
}

function resourcePreconditions(snapshot: Pick<RegistryResourceSnapshot, 'metadata'>): {
  uid: string
  resourceVersion: string
} {
  const uid = snapshot.metadata?.uid
  const resourceVersion = snapshot.metadata?.resourceVersion
  if (!uid || !resourceVersion) {
    throw new RegistryInstallRollbackError()
  }
  return { uid, resourceVersion }
}

type SafeRegistryErrorLogFields = {
  name: string
  status?: number
  code?: string
}

/** Return only bounded error identity fields; never place upstream messages in logs. */
export function registryErrorLogFields(err: unknown): SafeRegistryErrorLogFields {
  const candidate =
    err && typeof err === 'object'
      ? (err as {
          name?: unknown
          status?: unknown
          statusCode?: unknown
          code?: unknown
        })
      : undefined
  const rawName = err instanceof Error ? err.name : candidate?.name
  const name =
    typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
      ? rawName
      : 'UnknownError'
  const rawStatus = candidate?.status ?? candidate?.statusCode
  const status =
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : undefined
  const code =
    typeof candidate?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate.code)
      ? candidate.code
      : undefined
  return {
    name,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  }
}

type CredentialPayloadValidation =
  | { ok: true; secretData: Record<string, string> }
  | { ok: false; body: Record<string, unknown> }

function looksLikeCredentialPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  if (/^\$\{[a-z0-9_.-]+\}$/.test(normalized)) return true
  if (/^<[a-z0-9_. -]+>$/.test(normalized)) return true
  return new Set([
    'changeme',
    'change-me',
    'todo',
    'tbd',
    'placeholder',
    'dummy',
    'example',
    'your-api-key',
    'your-token',
  ]).has(normalized)
}

/**
 * Is a supplied credentials payload something other than a key→value object?
 * A string passes `typeof x === 'object'`? No — but it DOES survive
 * `Object.keys()`, which enumerates its character indices, so an unchecked
 * `credentials: "abc"` reads as three credential names. Both install paths gate
 * on this so they agree on what a payload is.
 */
export function isMalformedCredentialPayload(credentials: unknown): boolean {
  return typeof credentials !== 'object' || Array.isArray(credentials)
}

function validateProvidedCredentialPayload(
  schema: RegistryCredentialSchema,
  credentials: RegistryInstallRequest['credentials']
): CredentialPayloadValidation {
  const requiredKeys = schema.keys?.map(k => k.name) ?? []
  if (!schema.required || requiredKeys.length === 0) return { ok: true, secretData: {} }
  if (credentials === undefined || credentials === null) return { ok: true, secretData: {} }
  if (isMalformedCredentialPayload(credentials)) {
    return {
      ok: false,
      body: {
        error: 'credential.invalidPayload',
        message: 'Credentials must be an object keyed by credential name.',
        pendingAllowed: true,
      },
    }
  }

  const secretData: Record<string, string> = {}
  const missingKeys: string[] = []
  const invalidKeys: string[] = []
  for (const key of requiredKeys) {
    const raw = credentials[key]
    const value = raw === undefined || raw === null ? '' : String(raw)
    const trimmed = value.trim()
    if (!trimmed) {
      missingKeys.push(key)
      continue
    }
    if (looksLikeCredentialPlaceholder(trimmed)) invalidKeys.push(key)
    secretData[key] = value
  }

  if (Object.keys(secretData).length === 0) return { ok: true, secretData: {} }
  if (missingKeys.length > 0) {
    return {
      ok: false,
      body: {
        error: 'credential.incomplete',
        message: 'Complete all credential fields or clear them all to install pending.',
        missingKeys,
        pendingAllowed: true,
      },
    }
  }
  if (invalidKeys.length > 0) {
    return {
      ok: false,
      body: {
        error: 'credential.placeholderValue',
        message:
          'This value looks like a placeholder. Leave all credential fields empty to install pending, or enter the real credential value.',
        invalidKeys,
        pendingAllowed: true,
      },
    }
  }

  return { ok: true, secretData }
}

type PendingRegistryCredentialRef = {
  kind: 'mcpEnvSecret'
  secretName: string
  namespace: string
  keys: string[]
  field: 'spec.envSecret'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasMcpCredentialKey(secret: unknown, key: string): boolean {
  if (!isRecord(secret)) return false
  const data = isRecord(secret.data) ? secret.data : {}
  const stringData = isRecord(secret.stringData) ? secret.stringData : {}
  return (
    Object.prototype.hasOwnProperty.call(data, key) ||
    Object.prototype.hasOwnProperty.call(stringData, key)
  )
}

async function collectMissingMcpEnvSecretPendingCredentials(
  gateway: K8sGateway,
  secretName: string,
  namespace: string,
  credentialSchema: RegistryCredentialSchema
): Promise<PendingRegistryCredentialRef[]> {
  const keys = credentialSchema.keys.map(key => key.name)
  if (keys.length === 0) return []

  try {
    const existing = await gateway.getSecret(secretName, namespace)
    const missingKeys = keys.filter(key => !hasMcpCredentialKey(existing, key))
    if (missingKeys.length === 0) return []
    return [
      { kind: 'mcpEnvSecret', secretName, namespace, keys: missingKeys, field: 'spec.envSecret' },
    ]
  } catch (err) {
    const k8sErr = extractK8sError(err)
    if (k8sErr?.status === 404) {
      return [{ kind: 'mcpEnvSecret', secretName, namespace, keys, field: 'spec.envSecret' }]
    }
    throw err
  }
}

/** Validate credential schema structure from registry (finding #9). */
function isValidCredentialSchema(obj: unknown): obj is RegistryCredentialSchema {
  if (!obj || typeof obj !== 'object') return false
  const s = obj as Record<string, unknown>
  if (s.required !== undefined && typeof s.required !== 'boolean') return false
  if (s.authType !== undefined && typeof s.authType !== 'string') return false
  if (s.keys !== undefined) {
    if (!Array.isArray(s.keys)) return false
    if (
      !s.keys.every(
        (k: unknown) =>
          typeof k === 'object' &&
          k !== null &&
          typeof (k as Record<string, unknown>).name === 'string'
      )
    )
      return false
  }
  return true
}

function getEmbeddedCredentialSchema(entry: {
  mcp_server_meta?: Record<string, unknown> | null
}): RegistryCredentialSchema | null {
  const raw = (entry.mcp_server_meta as { credentialSchema?: unknown } | null)?.credentialSchema
  if (raw === undefined || raw === null) return NO_CREDENTIAL_SCHEMA
  return isValidCredentialSchema(raw) ? raw : null
}

async function loadRegistryCredentialSchema(entry: {
  name: string
  version: string
  mcp_server_meta?: Record<string, unknown> | null
}): Promise<RegistryCredentialSchema | null> {
  const embeddedCredentialSchema = getEmbeddedCredentialSchema(entry)
  try {
    const raw = await getCredentialSchema(entry.name, entry.version)
    return isValidCredentialSchema(raw) ? raw : null
  } catch {
    return embeddedCredentialSchema
  }
}

/** Audit log for security-sensitive operations (finding #10). */
function auditLog(action: string, details: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { timestamp: new Date().toISOString(), action, ...details }
  for (const k of ['credentials', 'clientSecret', 'stringData', 'password']) delete safe[k]
  log.info(safe, 'registry-audit')
}

/**
 * Validate an authHeaders template declared by a registry entry.
 *
 * Input comes from `entry.mcp_server_meta.authHeaders` — a registry-entry-
 * authored list of HTTP headers that nginx should inject when proxying to
 * the remote MCP server. Values MAY contain `${VAR}` placeholders which
 * nginx `envsubst` resolves at pod start from env vars mounted via
 * `spec.envSecret` (which in turn is backed by a K8s Secret created with
 * `body.credentials`). This function does NOT substitute placeholders —
 * that happens in nginx at runtime.
 *
 * Expected input shape:
 *   [{ header: "Authorization", valueTemplate: "Bearer ${SENTRY_AUTH_TOKEN}" }, ...]
 *
 * Validation mirrors the McpServer CRD OpenAPI schema (spec.remote.authHeaders
 * in `charts/clerum-crds/crds/mcpserver.yaml`):
 *   - header: `/^[A-Za-z0-9-]+$/`, length 1-128
 *   - valueTemplate: length 1-2048
 *   - maxItems: 20
 *
 * Matching these bounds up-front prevents the apiserver from rejecting the
 * CR after control-api has already committed side effects (created Secret,
 * labelled Context, etc.). On a bounds violation this throws a plain Error;
 * callers translate it into HTTP 400.
 *
 * Returns `undefined` when the entry declares no authHeaders (CRD minimal —
 * the `authHeaders` field is omitted rather than set to `[]`).
 *
 * NOTE: body.credentials is NOT consumed here — it lives in a separate K8s
 * Secret. The runtime linkage (CRD → nginx env → expanded header) happens
 * via envsubst, not via control-api substitution. This separation keeps
 * raw secret values out of the CRD spec (which is world-readable by any
 * identity with `get mcpservers` permission via etcd).
 */
export function validateAuthHeadersTemplate(
  template: unknown
): Array<{ header: string; valueTemplate: string }> | undefined {
  if (template === undefined || template === null) return undefined
  if (!Array.isArray(template)) {
    throw new Error('authHeaders: must be an array')
  }
  if (template.length === 0) return undefined
  if (template.length > 20) {
    throw new Error('authHeaders: too many entries (max 20)')
  }
  const headerPattern = /^[A-Za-z0-9-]+$/
  const result: Array<{ header: string; valueTemplate: string }> = []
  for (const entry of template) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('authHeaders: each entry must be an object with header+valueTemplate')
    }
    const { header, valueTemplate } = entry as { header?: unknown; valueTemplate?: unknown }
    if (typeof header !== 'string' || header.length < 1 || header.length > 128) {
      throw new Error(`authHeaders: invalid header name length (1-128 chars): "${String(header)}"`)
    }
    if (!headerPattern.test(header)) {
      throw new Error(`authHeaders: invalid header name "${header}" (must match /^[A-Za-z0-9-]+$/)`)
    }
    if (
      typeof valueTemplate !== 'string' ||
      valueTemplate.length < 1 ||
      valueTemplate.length > 2048
    ) {
      throw new Error(
        `authHeaders: invalid valueTemplate length (1-2048 chars) for header "${header}"`
      )
    }
    result.push({ header, valueTemplate })
  }
  return result
}

/** Validate remote URL is not an internal/private address (SSRF defense-in-depth). */
function validateRemoteUrl(url: string): void {
  // URL constructor throws on malformed or empty input — let it propagate.
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS remote URLs allowed')
  // Reject ALL IPv6 literals (hostname is bracketed by URL parser: "[::1]", "[::ffff:7f00:1]", "[fd00::1]", …).
  // IPv6 in many forms can alias loopback / private ranges (e.g. ::1, ::ffff:127.0.0.1),
  // so we require DNS hostnames only — mirror HCC sanitizeRemoteUrl behavior.
  if (hostname.startsWith('[') || hostname.includes(':')) {
    throw new Error('IPv6 addresses not allowed')
  }
  // Link-local 169.254.x covers AWS/GCP metadata endpoints (169.254.169.254).
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.)/.test(hostname)) {
    throw new Error('Private IP addresses not allowed')
  }
  if (hostname === 'localhost' || hostname === '[::1]') throw new Error('Localhost not allowed')
  // Cluster-internal: reject both long (.svc.cluster.local) and short (.svc) DNS suffixes,
  // plus kubernetes.default / kubernetes.default.svc variants.
  if (
    hostname.endsWith('.svc.cluster.local') ||
    hostname.endsWith('.svc') ||
    hostname.startsWith('kubernetes.') ||
    hostname === 'kubernetes'
  ) {
    throw new Error('Cluster-internal URLs not allowed')
  }
}

type RegistryEgressSummary = {
  domains?: unknown
  ports?: unknown
  wideCidr?: unknown
}

type RegistryEgressBinding = {
  egressClass?: 'exact-host' | 'public-web'
  dns?: string
  cidr?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
}

const MAX_REGISTRY_EGRESS_BINDINGS = 20

export function normalizeRegistryEgressSummary(raw: unknown):
  | {
      domains: string[]
      ports: number[]
      publicWeb: boolean
    }
  | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const summary = raw as RegistryEgressSummary
  const publicWeb = summary.wideCidr === true
  if (summary.domains !== undefined && !Array.isArray(summary.domains)) {
    throw new Error('egressSummary.domains must be an array')
  }
  const domains: string[] = []
  for (const domain of Array.isArray(summary.domains) ? summary.domains : []) {
    if (typeof domain !== 'string' || domain.trim() === '') {
      throw new Error('egressSummary.domains must contain non-empty hostnames')
    }
    domains.push(domain.trim().toLowerCase())
  }
  for (const domain of domains) validateRegistryExactHost(domain)
  if (summary.ports !== undefined && !Array.isArray(summary.ports)) {
    throw new Error('egressSummary.ports must be an array')
  }
  const rawPorts = Array.isArray(summary.ports) ? summary.ports : [443]
  const ports: number[] = []
  for (const port of rawPorts) {
    if (!Number.isInteger(port)) {
      throw new Error(`egressSummary.ports contains invalid port ${String(port)}`)
    }
    validateRegistryEgressPort(port)
    if (publicWeb && port !== 80 && port !== 443) {
      throw new Error('egressSummary.ports for public-web entries may only document TCP 80 or 443')
    }
    ports.push(port)
  }

  if (publicWeb) {
    // Registry wideCidr is only a compatibility signal. The CRD receives the
    // explicit public-web class, whose policy surface is always public TCP 80/443
    // with private/internal/special ranges excluded by PR #314 NetworkPolicies.
    return { domains, ports: [80, 443], publicWeb: true }
  }
  if (domains.length === 0) return undefined
  if (ports.length === 0) {
    throw new Error('egressSummary.ports must include at least one integer port')
  }
  const uniqueDomains = [...new Set(domains)]
  const uniquePorts = [...new Set(ports)]
  const bindingCount = uniqueDomains.length * uniquePorts.length
  if (bindingCount > MAX_REGISTRY_EGRESS_BINDINGS) {
    throw new Error(
      `egressSummary expands to ${bindingCount} egress bindings, but the CRD maximum is ${MAX_REGISTRY_EGRESS_BINDINGS}. Reduce domains/ports or explicitly select public-web.`
    )
  }
  return { domains: uniqueDomains, ports: uniquePorts, publicWeb: false }
}

function validateRegistryEgressPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`egressSummary.ports contains invalid port ${String(port)}`)
  }
}

function validateRegistryExactHost(hostname: string): void {
  if (hostname.includes('://') || hostname.includes('/')) {
    throw new Error(`egressSummary.domains must contain hostnames, not URLs: ${hostname}`)
  }
  if (hostname.includes('*')) {
    throw new Error(`egressSummary.domains must not contain wildcards: ${hostname}`)
  }
  if (hostname.includes(':') || isIP(hostname) !== 0) {
    throw new Error(`egressSummary.domains must not contain IP literals: ${hostname}`)
  }
  if (
    hostname === 'localhost' ||
    hostname === 'metadata.goog' ||
    hostname === 'kubernetes.default' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.svc') ||
    hostname.endsWith('.svc.cluster.local') ||
    hostname.endsWith('.cluster.local')
  ) {
    throw new Error(`egressSummary.domains must contain public DNS hostnames: ${hostname}`)
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      hostname
    )
  ) {
    throw new Error(`egressSummary.domains contains invalid hostname: ${hostname}`)
  }
}

function deriveRegistryEgressBindings(options: {
  meta: Record<string, unknown> | null
  isLocal: boolean
  remoteBaseUrl?: string
}): RegistryEgressBinding[] | undefined {
  if (options.remoteBaseUrl) {
    const parsed = new URL(options.remoteBaseUrl)
    return [
      {
        dns: parsed.hostname.toLowerCase(),
        port: parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443,
        protocol: 'TCP',
      },
    ]
  }

  if (!options.isLocal) return undefined

  const egressSummary = normalizeRegistryEgressSummary(options.meta?.egressSummary)
  if (egressSummary?.publicWeb) return [{ egressClass: 'public-web' }]
  if (!egressSummary) return undefined
  return egressSummary.domains.flatMap(dns =>
    egressSummary.ports.map(port => ({ dns, port, protocol: 'TCP' as const }))
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function updateResourceWithConflictRetry(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['updateResource']>[0],
  name: string,
  body: Parameters<K8sGateway['updateResource']>[2],
  namespace: string
): Promise<unknown> {
  let lastConflict: unknown

  const maxAttempts = body.metadata?.resourceVersion ? 1 : UPDATE_CONFLICT_RETRY_ATTEMPTS
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await gateway.updateResource(plural, name, body, namespace)
    } catch (err) {
      if (extractK8sError(err)?.status !== 409) throw err
      lastConflict = err
      if (attempt < UPDATE_CONFLICT_RETRY_ATTEMPTS) {
        await sleep(UPDATE_CONFLICT_RETRY_DELAY_MS * attempt)
      }
    }
  }

  throw lastConflict
}

type RegistryResourceMutationResult =
  | { outcome: 'committed'; value: unknown }
  | { outcome: 'not-committed' | 'ambiguous' | 'rejected'; error: unknown }

/**
 * Execute one identity-bound Registry CR mutation and classify a lost response.
 *
 * Every route that changes a Registry-owned CR uses the same protocol: the
 * request carries the read UID/RV, the desired state carries an operation
 * marker and spec digest, and an ambiguous response is fenced before a
 * readback is considered. A prior-state GET alone is never promoted to
 * not-committed because the original request may still be in flight.
 */
async function executeRegistryResourceMutation(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['updateResource']>[0],
  name: string,
  namespace: string,
  body: Parameters<K8sGateway['updateResource']>[2],
  before: RegistryResourceSnapshot,
  desired: {
    spec: Record<string, unknown>
    metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }
    specDigest: string
  },
  operationId: string
): Promise<RegistryResourceMutationResult> {
  try {
    return {
      outcome: 'committed',
      value: await updateResourceWithConflictRetry(gateway, plural, name, body, namespace),
    }
  } catch (error) {
    if (isDeterministicRegistryNoCommit(error)) {
      return { outcome: 'rejected', error }
    }

    const outcome = await readRegistryMutationOutcomeAfterFence(
      gateway,
      plural,
      name,
      namespace,
      before,
      desired,
      operationId
    )
    return outcome === 'committed' ? { outcome, value: undefined } : { outcome, error }
  }
}

function normalizeSecretSnapshot(
  raw: unknown,
  fallbackName: string,
  fallbackNamespace: string
): SecretSnapshot {
  return toSecretSnapshot(raw, fallbackName, fallbackNamespace)
}

async function fenceSecretAtSnapshot(
  gateway: K8sGateway,
  snapshot: SecretSnapshot
): Promise<'not-committed' | 'ambiguous'> {
  try {
    const fenced = normalizeSecretSnapshot(
      await gateway.updateSecret(
        {
          name: snapshot.name,
          namespace: snapshot.namespace,
          type: snapshot.type ?? 'Opaque',
          ...(snapshot.labels ? { labels: snapshot.labels } : {}),
          ...(snapshot.annotations ? { annotations: snapshot.annotations } : {}),
          ...(snapshot.data ? { data: snapshot.data } : {}),
          ...(snapshot.stringData ? { stringData: snapshot.stringData } : {}),
        },
        secretPreconditions(snapshot),
        REGISTRY_SECRET_WRITE_OPTIONS
      ),
      snapshot.name,
      snapshot.namespace
    )
    if (fenced.uid !== snapshot.uid || !fenced.resourceVersion) return 'ambiguous'
    // The successful CAS write consumed the exact prior UID/RV. An ambiguous
    // Registry write carrying that same precondition cannot commit afterwards.
    return 'not-committed'
  } catch {
    // A rejected fence proves only that the object changed or the fence itself
    // was uncertain. The prior GET state is never promoted to no-commit.
    return 'ambiguous'
  }
}

async function readSecretMutationOutcome(
  gateway: K8sGateway,
  snapshotBefore: SecretSnapshot | null
): Promise<{
  outcome: 'committed' | 'not-committed' | 'ambiguous'
  snapshot: SecretSnapshot | null
  identityProven: boolean
}> {
  if (snapshotBefore) {
    const fenceOutcome = await fenceSecretAtSnapshot(gateway, snapshotBefore)
    if (fenceOutcome === 'not-committed') {
      return { outcome: fenceOutcome, snapshot: null, identityProven: false }
    }
  }
  // A GET after a failed fence is never a receipt of this write. The observed
  // resourceVersion may belong to a same-UID writer that raced with us, so do
  // not adopt it as a compensation precondition. The caller must preserve the
  // state and surface repair_required.
  return { outcome: 'ambiguous', snapshot: null, identityProven: false }
}

export type CreatedSecretAfterDeleteFailure =
  | 'gone'
  | 'replaced'
  | 'modified-original'
  | 'unchanged-original'
  | 'identity-unavailable'

/** Classify what remains under a Secret name after an identity-bound delete failed. */
export function classifyCreatedSecretAfterDeleteFailure(
  created: Pick<SecretSnapshot, 'uid' | 'resourceVersion'>,
  current: unknown | null
): CreatedSecretAfterDeleteFailure {
  if (current === null) return 'gone'
  if (!created.uid || !created.resourceVersion) return 'identity-unavailable'
  const metadata = (current as { metadata?: { uid?: unknown; resourceVersion?: unknown } }).metadata
  if (typeof metadata?.uid !== 'string' || typeof metadata.resourceVersion !== 'string') {
    return 'identity-unavailable'
  }
  if (metadata.uid !== created.uid) return 'replaced'
  if (metadata.resourceVersion !== created.resourceVersion) return 'modified-original'
  return 'unchanged-original'
}

class RegistryInstallRollbackError extends Error {
  readonly code = 'registry_install_rollback_incomplete'
  readonly status = 500

  constructor() {
    super('registry install rollback could not be completed without risking another writer')
    this.name = 'RegistryInstallRollbackError'
  }
}

async function readSecretForRollback(
  gateway: K8sGateway,
  snapshot: SecretSnapshot
): Promise<unknown | null> {
  try {
    return await gateway.getSecret(snapshot.name, snapshot.namespace)
  } catch (err) {
    if (extractK8sError(err)?.status === 404) return null
    throw new RegistryInstallRollbackError()
  }
}

async function waitForSecretDeletionOrReplacement(
  gateway: K8sGateway,
  snapshot: SecretSnapshot,
  timeoutMs = DELETE_SETTLE_TIMEOUT_MS,
  pollMs = DELETE_SETTLE_POLL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const current = await readSecretForRollback(gateway, snapshot)
    const outcome = classifyCreatedSecretAfterDeleteFailure(snapshot, current)
    if (outcome === 'gone' || outcome === 'replaced') return
    if (outcome !== 'unchanged-original') throw new RegistryInstallRollbackError()
    await sleep(pollMs)
  }
  throw new RegistryInstallRollbackError()
}

type CreatedResourceAfterDeleteFailure =
  | 'gone'
  | 'replaced'
  | 'modified-original'
  | 'unchanged-original'
  | 'identity-unavailable'

function normalizeRegistryResourceSnapshot(
  raw: unknown,
  fallbackName: string,
  fallbackNamespace: string
): RegistryResourceSnapshot {
  const source = (raw ?? {}) as RegistryResourceSnapshot
  const metadata = source.metadata
  return {
    metadata: {
      ...(typeof metadata?.uid === 'string' ? { uid: metadata.uid } : {}),
      ...(typeof metadata?.resourceVersion === 'string'
        ? { resourceVersion: metadata.resourceVersion }
        : {}),
      ...(metadata?.labels ? { labels: metadata.labels } : {}),
      ...(metadata?.annotations ? { annotations: metadata.annotations } : {}),
      // Keep these fallbacks local to the rollback record. The gateway's
      // delete call receives only identity preconditions, never a caller name
      // that could be mistaken for identity.
      ...(fallbackName ? { name: fallbackName } : {}),
      ...(fallbackNamespace ? { namespace: fallbackNamespace } : {}),
    } as RegistryResourceSnapshot['metadata'],
    spec: source.spec ?? {},
  }
}

function classifyCreatedResourceAfterDeleteFailure(
  created: RegistryResourceSnapshot,
  current: RegistryResourceSnapshot | null
): CreatedResourceAfterDeleteFailure {
  if (current === null) return 'gone'
  const createdUid = created.metadata?.uid
  const createdResourceVersion = created.metadata?.resourceVersion
  const currentUid = current.metadata?.uid
  const currentResourceVersion = current.metadata?.resourceVersion
  if (
    typeof createdUid !== 'string' ||
    typeof createdResourceVersion !== 'string' ||
    typeof currentUid !== 'string' ||
    typeof currentResourceVersion !== 'string'
  ) {
    return 'identity-unavailable'
  }
  if (currentUid !== createdUid) return 'replaced'
  if (currentResourceVersion !== createdResourceVersion) return 'modified-original'
  return 'unchanged-original'
}

async function readResourceForRollback(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  snapshot: RegistryResourceSnapshot
): Promise<RegistryResourceSnapshot | null> {
  const name = (snapshot.metadata as { name?: string } | undefined)?.name
  const namespace = (snapshot.metadata as { namespace?: string } | undefined)?.namespace
  if (!name || !namespace) throw new RegistryInstallRollbackError()
  try {
    const current = await gateway.getResource(plural, name, namespace)
    return normalizeRegistryResourceSnapshot(current, name, namespace)
  } catch (err) {
    if (extractK8sError(err)?.status === 404) return null
    throw new RegistryInstallRollbackError()
  }
}

type CreatedResourceReadbackOutcome = {
  outcome: 'committed' | 'not-committed' | 'ambiguous'
  snapshot: RegistryResourceSnapshot | null
}

async function readCreatedResourceOutcome(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  name: string,
  namespace: string,
  desired: {
    spec: Record<string, unknown>
    metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }
    specDigest: string
  },
  operationId: string
): Promise<CreatedResourceReadbackOutcome> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const current = normalizeRegistryResourceSnapshot(
        await gateway.getResource(plural, name, namespace),
        name,
        namespace
      )
      if (
        classifyCreatedRegistryMutationReadback({ current, desired, operationId }) === 'committed'
      ) {
        return { outcome: 'committed', snapshot: current }
      }
    } catch {
      // A failed read cannot prove that a create did not commit. This includes
      // repeated 404s: the original request may still be in flight or the
      // read path may be stale, and a create has no pre-write UID/RV fence.
    }
    if (attempt < 3) await sleep(UPDATE_CONFLICT_RETRY_DELAY_MS * attempt)
  }
  return { outcome: 'ambiguous', snapshot: null }
}

async function fenceRegistryResourceAtSnapshot(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  name: string,
  namespace: string,
  snapshot: RegistryResourceSnapshot
): Promise<'not-committed' | 'ambiguous'> {
  const uid = snapshot.metadata?.uid
  const resourceVersion = snapshot.metadata?.resourceVersion
  if (!uid || !resourceVersion) return 'ambiguous'

  try {
    const fenced = normalizeRegistryResourceSnapshot(
      await gateway.updateResource(
        plural,
        name,
        {
          metadata: {
            uid,
            resourceVersion,
            ...(snapshot.metadata?.labels ? { labels: snapshot.metadata.labels } : {}),
            ...(snapshot.metadata?.annotations
              ? { annotations: snapshot.metadata.annotations }
              : {}),
          },
          spec: snapshot.spec ?? {},
        },
        namespace
      ),
      name,
      namespace
    )
    if (fenced.metadata?.uid !== uid || typeof fenced.metadata?.resourceVersion !== 'string') {
      return 'ambiguous'
    }
    // A successful replacement fenced the old UID/RV. Any in-flight Registry
    // write carrying that same precondition can no longer commit afterwards.
    return 'not-committed'
  } catch {
    // A rejected fence means the object changed, but does not identify whether
    // this operation or another writer won. The caller must read and classify
    // the current state; the prior state alone is never proof of no-commit.
    return 'ambiguous'
  }
}

async function readRegistryAssociationOutcome(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  name: string,
  namespace: string,
  before: RegistryResourceSnapshot,
  isCommitted: (spec: Record<string, unknown>) => boolean
): Promise<RegistryMutationOutcome> {
  const fenceOutcome = await fenceRegistryResourceAtSnapshot(
    gateway,
    plural,
    name,
    namespace,
    before
  )
  if (fenceOutcome === 'not-committed') return fenceOutcome

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const current = normalizeRegistryResourceSnapshot(
        await gateway.getResource(plural, name, namespace),
        name,
        namespace
      )
      const outcome = classifyRegistryAssociationReadback({ before, current, isCommitted })
      if (outcome === 'committed') return outcome
    } catch {
      // A failed read cannot prove either terminal state.
    }
    if (attempt < 3) await sleep(UPDATE_CONFLICT_RETRY_DELAY_MS * attempt)
  }
  // A prior-state read is only a candidate. Without a successful fence, it
  // cannot prove that the original request is no longer in flight.
  return 'ambiguous'
}

async function readRegistryMutationOutcomeAfterFence(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  name: string,
  namespace: string,
  before: RegistryResourceSnapshot,
  desired: {
    spec: Record<string, unknown>
    metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }
    specDigest: string
  },
  operationId: string
): Promise<RegistryMutationOutcome> {
  const fenceOutcome = await fenceRegistryResourceAtSnapshot(
    gateway,
    plural,
    name,
    namespace,
    before
  )
  if (fenceOutcome === 'not-committed') return fenceOutcome

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const current = normalizeRegistryResourceSnapshot(
        await gateway.getResource(plural, name, namespace),
        name,
        namespace
      )
      const outcome = classifyRegistryMutationReadback({
        before,
        desired,
        current,
        operationId,
      })
      if (outcome === 'committed') return outcome
    } catch {
      // A failed read cannot prove either terminal state.
    }
    if (attempt < 3) await sleep(UPDATE_CONFLICT_RETRY_DELAY_MS * attempt)
  }
  // Only the desired state proves this operation's commit after the fence
  // lost its race. A prior-state read is deliberately not promoted to
  // not-committed because the original request may still be in flight.
  return 'ambiguous'
}

function isDeterministicRegistryNoCommit(err: unknown): boolean {
  const status = extractK8sError(err)?.status
  // Only statuses whose Kubernetes API contract rejects the request before
  // admission are safe to treat as no-commit. Conflict, timeout, and throttling
  // responses can race with a live object or an already accepted request and
  // therefore must go through the identity fence/readback path.
  return typeof status === 'number' && DETERMINISTIC_REGISTRY_NO_COMMIT_STATUSES.has(status)
}

async function waitForResourceDeletionOrReplacement(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['getResource']>[0],
  snapshot: RegistryResourceSnapshot,
  label: string,
  timeoutMs = DELETE_SETTLE_TIMEOUT_MS,
  pollMs = DELETE_SETTLE_POLL_MS
): Promise<'gone' | 'replaced'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const current = await readResourceForRollback(gateway, plural, snapshot)
    const outcome = classifyCreatedResourceAfterDeleteFailure(snapshot, current)
    if (outcome === 'gone' || outcome === 'replaced') return outcome
    if (outcome !== 'unchanged-original') throw new RegistryInstallRollbackError()
    await sleep(pollMs)
  }
  throw new RegistryInstallRollbackError()
}

/** Delete only the CR created by this saga; never fall back to name-only delete. */
async function rollbackCreatedResource(
  gateway: K8sGateway,
  plural: Parameters<K8sGateway['deleteResource']>[0],
  snapshot: RegistryResourceSnapshot,
  label: string
): Promise<void> {
  const name = (snapshot.metadata as { name?: string } | undefined)?.name
  const namespace = (snapshot.metadata as { namespace?: string } | undefined)?.namespace
  if (!name || !namespace) throw new RegistryInstallRollbackError()

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await gateway.deleteResource(plural, name, namespace, resourcePreconditions(snapshot))
      const settled = await waitForResourceDeletionOrReplacement(gateway, plural, snapshot, label)
      if (settled === 'replaced') throw new RegistryInstallRollbackError()
      return
    } catch (err) {
      if (err instanceof RegistryInstallRollbackError) throw err
      const current = await readResourceForRollback(gateway, plural, snapshot)
      const outcome = classifyCreatedResourceAfterDeleteFailure(snapshot, current)
      if (outcome === 'gone') return
      if (outcome === 'replaced') throw new RegistryInstallRollbackError()
      if (outcome === 'unchanged-original' && attempt < 2) continue
      throw new RegistryInstallRollbackError()
    }
  }
  throw new RegistryInstallRollbackError()
}

/** Delete only the Secret object created by this saga; never fall back to name-only delete. */
async function rollbackCreatedSecret(gateway: K8sGateway, snapshot: SecretSnapshot): Promise<void> {
  // A Secret is a cross-resource dependency. If any live consumer is visible,
  // or the reference graph cannot be read completely, preserve it for repair;
  // a name-only compensation decision is not safe across independent CRDs.
  const referenceState = await findSecretReferenceState(gateway, snapshot.name, snapshot.namespace)
  if (referenceState !== 'not-referenced') throw new RegistryInstallRollbackError()

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await gateway.deleteSecret(snapshot.name, snapshot.namespace, secretPreconditions(snapshot))
      await waitForSecretDeletionOrReplacement(gateway, snapshot)
      return
    } catch (err) {
      if (err instanceof RegistryInstallRollbackError) throw err
      const current = await readSecretForRollback(gateway, snapshot)
      const outcome = classifyCreatedSecretAfterDeleteFailure(snapshot, current)
      if (outcome === 'gone' || outcome === 'replaced') return
      if (outcome === 'unchanged-original' && attempt < 2) continue
      throw new RegistryInstallRollbackError()
    }
  }
  throw new RegistryInstallRollbackError()
}

async function waitForDeletion(
  readCurrent: () => Promise<unknown>,
  label: string,
  timeoutMs = DELETE_SETTLE_TIMEOUT_MS,
  pollMs = DELETE_SETTLE_POLL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      await readCurrent()
    } catch (err) {
      if (extractK8sError(err)?.status === 404) return
      throw err
    }
    await sleep(pollMs)
  }
  throw new Error(`Timed out waiting for ${label} deletion`)
}

export interface RegistryInstallRequest {
  serverName?: string
  namespace?: string
  contextRef: string
  registryEntryName: string
  registryEntryVersion: string
  credentials?: Record<string, string>
  egressBindings?: RegistryEgressBinding[]
}

export async function getInstalledRegistryState(gateway?: K8sGateway): Promise<{
  catalogKeys: string[]
  serverNames: string[]
  recipeKeys: string[]
  hookKeys: string[]
}> {
  if (!gateway) return { catalogKeys: [], serverNames: [], recipeKeys: [], hookKeys: [] }

  const [servers, recipes, hooks] = await Promise.all([
    gateway.listResource('mcpservers', config.mcpServersNamespace),
    // Matches /admin/recipes and the WorkflowRecipe namespace invariant:
    // parent WorkflowRecipe CRDs live only in sandbox-recipes.
    gateway.listResource('workflowrecipes', config.sandboxNamespace),
    // Installed guardrail hooks (LlmHook CRs) live in the llm-hooks namespace
    // and carry the same catalog-id/version annotations the install-hook saga
    // stamps, so the marketplace can render them as installed (§8.5).
    gateway.listResource('llmhooks', config.llmHooksNamespace),
  ])
  const catalogKeys = new Set<string>()
  const serverNames = new Set<string>()
  const recipeKeys = new Set<string>()
  const hookKeys = new Set<string>()

  // catalog-id / catalog-version live in ANNOTATIONS (org-scoped names contain
  // '@' and '/', illegal as label values). Fall back to labels so resources
  // installed before this change (which carry them as labels) still read as
  // installed until they are reinstalled/reconciled.
  for (const server of servers as Array<{
    metadata?: {
      name?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
  }>) {
    const serverName = String(server.metadata?.name || '').trim()
    const catalogId = getCatalogId(server.metadata)
    const catalogVersion = getCatalogVersion(server.metadata)
    if (serverName) serverNames.add(serverName)
    if (catalogId && catalogVersion) catalogKeys.add(`${catalogId}@${catalogVersion}`)
  }

  for (const recipe of recipes as Array<{
    metadata?: {
      deletionTimestamp?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
  }>) {
    if (recipe.metadata?.deletionTimestamp) continue
    if (recipe.metadata?.labels?.['clerum.io/workflow-run-id']) continue
    const catalogId = getCatalogId(recipe.metadata)
    const catalogVersion = getCatalogVersion(recipe.metadata)
    if (catalogId && catalogVersion) recipeKeys.add(`${catalogId}@${catalogVersion}`)
  }

  for (const hook of hooks as Array<{
    metadata?: {
      deletionTimestamp?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
  }>) {
    if (hook.metadata?.deletionTimestamp) continue
    const catalogId = getCatalogId(hook.metadata)
    const catalogVersion = getCatalogVersion(hook.metadata)
    if (catalogId && catalogVersion) hookKeys.add(`${catalogId}@${catalogVersion}`)
  }

  return {
    catalogKeys: [...catalogKeys].sort((a, b) => a.localeCompare(b)),
    serverNames: [...serverNames].sort((a, b) => a.localeCompare(b)),
    recipeKeys: [...recipeKeys].sort((a, b) => a.localeCompare(b)),
    hookKeys: [...hookKeys].sort((a, b) => a.localeCompare(b)),
  }
}

const log = rootLogger.child({ module: 'admin-registry' })

export function createAdminRegistryRouter(gateway?: K8sGateway): Router {
  const router = Router()

  // GET /admin/registry/catalog — Catalog plus installed state for Control UI
  router.get(
    '/admin/registry/catalog',
    asyncHandler(async (req, res) => {
      const [entries, categories, installed] = await Promise.all([
        searchEntries({
          q: req.query.q as string | undefined,
          entryType: req.query.entryType as string | undefined,
          category: req.query.category as string | undefined,
          serverMode: req.query.serverMode as string | undefined,
          transport: req.query.transport as string | undefined,
          trustLevel: req.query.trustLevel as string | undefined,
          sort: req.query.sort as string | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        }),
        getCategories(),
        getInstalledRegistryState(gateway),
      ])
      res.json({
        ...entries,
        categories: Array.isArray(categories.data) ? categories.data : [],
        installed,
      })
    })
  )

  // GET /admin/registry/entries — Search registry catalog
  router.get('/admin/registry/entries', async (req, res, next) => {
    try {
      const result = await searchEntries({
        q: req.query.q as string | undefined,
        entryType: req.query.entryType as string | undefined,
        category: req.query.category as string | undefined,
        serverMode: req.query.serverMode as string | undefined,
        transport: req.query.transport as string | undefined,
        trustLevel: req.query.trustLevel as string | undefined,
        sort: req.query.sort as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // POST /admin/registry/entries — Publish a new entry to the registry
  router.post('/admin/registry/entries', async (req, res, next) => {
    try {
      // Org-bound (non-curator) clients must publish into their own org with a
      // scoped @<org>/<name>, or the registry 400s (scope_required). Curator
      // clients publish unscoped and the registry maps them to @clerum, so the
      // name is left untouched there.
      const scope = await resolvePublishScope()
      const scopedName = applyPublishScope(req.body?.name, scope)

      // Phase 2.5 parity: reject an evenfire-hosted local connector whose imageRef
      // repo != its scoped name AT PUBLISH, not only at install/upgrade (the same
      // check runs there — see registryImageRefIdentity). Otherwise the publish
      // succeeds but every install 422s later (cross-org pull would be denied),
      // which is exactly the surprise we want to surface up front.
      const mcp = req.body?.mcpServer as Record<string, unknown> | undefined
      const imageRefIdentity = checkEvenfireImageRefMatchesEntry({
        isLocal: req.body?.entryType === 'mcp-server' && mcp?.serverMode === 'local',
        entryName: scopedName,
        image: mcp?.imageRef,
        registryUrl: config.registryUrl,
      })
      if (!imageRefIdentity.ok) {
        res.status(422).json({
          error: `Registry entry imageRef repo "${imageRefIdentity.actual}" must equal the entry name "${imageRefIdentity.expected}" for evenfire-hosted plugins; cross-org pull would be denied.`,
        })
        return
      }

      const body = { ...req.body, name: scopedName }
      const result = await publishEntry(body)
      res.status(201).json(result)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/entries/:name — Get latest version
  router.get('/admin/registry/entries/:name', async (req, res, next) => {
    try {
      const entry = await getEntry(req.params.name)
      res.json(entry)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/entries/:name/versions/:version — Get specific version
  router.get('/admin/registry/entries/:name/versions/:version', async (req, res, next) => {
    try {
      const entry = await getEntryVersion(req.params.name, req.params.version)
      res.json(entry)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/entries/:name/versions/:version/credential-schema
  router.get(
    '/admin/registry/entries/:name/versions/:version/credential-schema',
    async (req, res, next) => {
      try {
        const schema = await getCredentialSchema(req.params.name, req.params.version)
        res.json(schema)
      } catch (err) {
        next(err)
      }
    }
  )

  // GET /admin/registry/categories — List categories
  router.get('/admin/registry/categories', async (_req, res, next) => {
    try {
      const categories = await getCategories()
      res.json(categories)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/publish-scope — Where this control-api's publishes land.
  // The publish UI reads this to show the target ({ curator, orgName, scope }):
  // org-bound clients publish into their own org; curator clients into @clerum.
  // publisherUiEnabled is merged in from static config (not part of
  // resolvePublishScope()/its cache) — it gates the Publisher sidebar entry
  // and /publisher route on control-ui.
  router.get('/admin/registry/publish-scope', async (_req, res, next) => {
    try {
      res.json({ ...(await resolvePublishScope()), publisherUiEnabled: config.publisherUiEnabled })
    } catch (err) {
      next(err)
    }
  })

  // POST /admin/registry/entries/:name/report-install — Report successful install
  router.post('/admin/registry/entries/:name/report-install', async (req, res, next) => {
    try {
      const { correlationId, version, clusterFingerprint } = req.body ?? {}
      if (!correlationId || !version) {
        res.status(400).json({ error: 'correlationId and version are required' })
        return
      }
      const result = await reportInstall(
        req.params.name,
        correlationId,
        version,
        clusterFingerprint
      )
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/entries/:name/versions/:version/bundle — Download manifest bundle
  router.get('/admin/registry/entries/:name/versions/:version/bundle', async (req, res, next) => {
    try {
      const buffer = await downloadBundle(req.params.name, req.params.version)
      res.setHeader('Content-Type', 'application/yaml')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${req.params.name}-${req.params.version}.yaml"`
      )
      res.send(buffer)
    } catch (err) {
      next(err)
    }
  })

  // GET /admin/registry/entries/:name/versions/:version/digest — Get bundle digest
  router.get('/admin/registry/entries/:name/versions/:version/digest', async (req, res, next) => {
    try {
      const result = await getDigest(req.params.name, req.params.version)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // POST /admin/registry/entries/:name/versions/:version/artifacts — Upload artifacts
  router.post(
    '/admin/registry/entries/:name/versions/:version/artifacts',
    async (req, res, next) => {
      try {
        const { soulMd, bundle } = req.body ?? {}
        if (!soulMd && !bundle) {
          res.status(400).json({ error: 'At least one of soulMd or bundle is required' })
          return
        }
        const result = await uploadArtifacts(req.params.name, req.params.version, {
          soulMd,
          bundle,
        })
        res.json(result)
      } catch (err) {
        next(err)
      }
    }
  )

  // PUT /admin/registry/entries/:name/versions/:version — Update version metadata
  router.put('/admin/registry/entries/:name/versions/:version', async (req, res, next) => {
    try {
      const { description, tags, visibility, mcpServer } = req.body ?? {}
      if (
        description === undefined &&
        tags === undefined &&
        visibility === undefined &&
        mcpServer === undefined
      ) {
        res.status(400).json({
          error: 'At least one of description, tags, visibility, or mcpServer is required',
        })
        return
      }
      const result = await updateVersionMetadata(req.params.name, req.params.version, {
        description,
        tags,
        visibility,
        mcpServer,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // DELETE /admin/registry/entries/:name/versions/:version — Soft-delete a version
  router.delete('/admin/registry/entries/:name/versions/:version', async (req, res, next) => {
    try {
      const result = await deleteVersion(req.params.name, req.params.version)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // POST /admin/registry/install — Server-side install saga with rollback
  if (gateway) {
    router.post(
      '/admin/registry/install',
      asyncHandler(async (req, res) => {
        const body = req.body as Partial<RegistryInstallRequest>

        // ── Validate required fields ──────────────────────────────────────
        if (body.serverName && !isValidK8sName(body.serverName.trim())) {
          res.status(400).json({
            error:
              'Invalid serverName: must be a valid K8s name (lowercase, alphanumeric, hyphens, max 253 chars)',
          })
          return
        }
        if (!body.contextRef || typeof body.contextRef !== 'string' || !body.contextRef.trim()) {
          res.status(400).json({ error: 'contextRef is required' })
          return
        }
        if (!body.registryEntryName || typeof body.registryEntryName !== 'string') {
          res.status(400).json({ error: 'registryEntryName is required' })
          return
        }
        if (!body.registryEntryVersion || typeof body.registryEntryVersion !== 'string') {
          res.status(400).json({ error: 'registryEntryVersion is required' })
          return
        }

        // Auto-generate name if not provided (spec §9.2.2 naming convention)
        const serverName =
          body.serverName?.trim() ||
          generateRegistryName(body.registryEntryName, body.registryEntryVersion)
        const targetNs = body.namespace || config.mcpServersNamespace
        const contextRef = body.contextRef.trim()

        // ── Step 1: Fetch entry metadata from registry ────────────────────
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)

        // ── Step 1b: Verify bundle digest (spec §9.2.1 step 6) ───────────
        if (entry.server_mode === 'local') {
          try {
            const digestResult = (await getDigest(
              body.registryEntryName,
              body.registryEntryVersion
            )) as { digest?: string }
            if (digestResult?.digest) {
              const bundleBuffer = await downloadBundle(
                body.registryEntryName,
                body.registryEntryVersion
              )
              const computed = createHash('sha256').update(bundleBuffer).digest('hex')
              const expected = digestResult.digest.replace(/^sha256:/, '')
              if (computed !== expected) {
                res.status(422).json({
                  error: 'Bundle digest mismatch — the artifact may have been tampered with',
                })
                return
              }
            }
          } catch {
            // Digest verification is best-effort; proceed if registry doesn't have a digest
          }
        }

        // ── Step 2: Fetch + validate credential schema (#9) ──────────────
        const credSchema = await loadRegistryCredentialSchema(entry)
        if (!credSchema) {
          res.status(502).json({ error: 'Registry returned invalid credential schema' })
          return
        }

        const credRequired = credSchema.required && (credSchema.keys?.length ?? 0) > 0

        const credentialPayload = validateProvidedCredentialPayload(credSchema, body.credentials)
        if (!credentialPayload.ok) {
          res.status(400).json(credentialPayload.body)
          return
        }

        // ── Build McpServer spec from entry metadata ──────────────────────
        const meta = entry.mcp_server_meta as Record<string, unknown> | null
        const isLocal = entry.server_mode === 'local'

        // Phase 2.5: for a scoped evenfire-hosted local plugin, the realm resolves
        // the pull grant from the OCI path as callerHasGrant("@<org>/<name>"), so the
        // imageRef repo must equal the entry name — else cross-org pull is silently
        // denied. Fail fast instead of shipping a workload that ImagePullBackOffs.
        const imageRefIdentity = checkEvenfireImageRefMatchesEntry({
          isLocal,
          entryName: entry.name,
          image: meta?.imageRef,
          registryUrl: config.registryUrl,
        })
        if (!imageRefIdentity.ok) {
          res.status(422).json({
            error: `Registry entry imageRef repo "${imageRefIdentity.actual}" must equal the entry name "${imageRefIdentity.expected}" for evenfire-hosted plugins; cross-org pull would be denied.`,
          })
          return
        }

        const transport = (entry.transport ?? 'streamableHttp') as
          | 'streamableHttp'
          | 'sse'
          | 'stdio'
        const port = (meta?.port as number | undefined) ?? 3000
        const secretName = `${serverName}-credentials`

        const transportSpec: { type: string; port?: number; url?: string } = { type: transport }
        if (transport !== 'stdio') transportSpec.port = port
        if (transport !== 'stdio' && isLocal) {
          transportSpec.url = `http://${serverName}.${targetNs}.svc.cluster.local:${port}/mcp`
        }

        let remoteBaseUrl: string | undefined
        const remoteEndpoints = meta?.remoteEndpoints as Array<{ url: string }> | undefined
        if (!isLocal && remoteEndpoints?.[0]?.url) {
          remoteBaseUrl = remoteEndpoints[0].url
          validateRemoteUrl(remoteBaseUrl) // SSRF defense-in-depth
          // Match the upstream's path so nginx's proxy_pass URI substitution
          // produces the same URI on both sides of the hop. Using a hardcoded
          // `/mcp` suffix breaks servers whose MCP endpoint is at `/`, `/sse`,
          // or any other non-`/mcp` path (e.g., Glassnode at `/`).
          const upstreamPath = new URL(remoteBaseUrl).pathname || '/'
          transportSpec.url = `http://${serverName}.${targetNs}.svc.cluster.local:${port}${upstreamPath}`
        }

        const mcpServerSpec: Record<string, unknown> = {
          image: isLocal ? ((meta?.imageRef as string) ?? '') : REMOTE_MCP_EGRESS_PROXY_IMAGE,
          contextRef,
          description: entry.description || undefined,
          enabled: true,
          managed: true,
          transport: transportSpec,
        }

        // Local plugins whose image lives on the evenfire registry pull with the
        // per-org `evenfire-registry-pull` secret. control-api self-provisions that
        // secret in self-hosted mode (see ensureRegistryPullSecret below); it may
        // also be pre-provisioned by an external operator. Attach the reference here;
        // HCC propagates it to the pod.
        const attachEvenfirePullSecret = shouldAttachEvenfirePullSecret({
          isLocal,
          image: mcpServerSpec.image,
          registryUrl: config.registryUrl,
        })
        if (attachEvenfirePullSecret) {
          mcpServerSpec.imagePullSecrets = [{ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME }]
        }

        // Local HTTP-mode MCP servers need env vars to select their transport
        // at startup (most images default to stdio). HCC reads envMapping and
        // injects MCP_TRANSPORT=http, PORT, HOST accordingly. Without this,
        // streamableHttp servers exit immediately (stdio mode completes with
        // code 0 → CrashLoopBackOff).
        if (isLocal && transport !== 'stdio') {
          mcpServerSpec.envMapping = {
            transport: 'MCP_TRANSPORT',
            httpPort: 'PORT',
            httpHost: 'HOST',
          }
        }

        if (credRequired) {
          mcpServerSpec.envSecret = {
            name: secretName,
            keys: credSchema.keys!.map(k => ({ secretKey: k.name, envVar: k.name })),
          }
        }

        // Stdio servers may need a custom command (e.g., "node /mcp-bin/build/index.js")
        const command = meta?.command as string[] | undefined
        if (command && Array.isArray(command) && command.length > 0) {
          mcpServerSpec.command = command
        }

        if (remoteBaseUrl) {
          // For remote MCP servers, HCC reconciles the CRD into an nginx egress
          // proxy Pod. The nginx config injects `proxy_set_header` directives
          // from spec.remote.authHeaders, with values like "Bearer ${TOKEN}"
          // where envsubst expands ${TOKEN} at pod start from env vars mounted
          // via envSecret (which is backed by a K8s Secret created below from
          // body.credentials). The registry entry AUTHORS the header template;
          // control-api just validates it against the CRD OpenAPI schema and
          // copies it verbatim into the spec. body.credentials never enters
          // the CRD — it lives only in the Secret.
          let authHeaders: Array<{ header: string; valueTemplate: string }> | undefined
          try {
            authHeaders = validateAuthHeadersTemplate(meta?.authHeaders)
          } catch (err) {
            res
              .status(400)
              .json({ error: err instanceof Error ? err.message : 'Invalid authHeaders template' })
            return
          }
          const remote: {
            baseUrl: string
            authHeaders?: Array<{ header: string; valueTemplate: string }>
          } = { baseUrl: remoteBaseUrl }
          if (authHeaders && authHeaders.length > 0) remote.authHeaders = authHeaders
          mcpServerSpec.remote = remote
        }

        try {
          const egressBindings =
            body.egressBindings ?? deriveRegistryEgressBindings({ meta, isLocal, remoteBaseUrl })
          if (egressBindings) mcpServerSpec.egressBindings = egressBindings
        } catch (err) {
          res
            .status(400)
            .json({ error: err instanceof Error ? err.message : 'Invalid egressSummary' })
          return
        }

        const preflightErrors = await validateMcpServerSpecPreflight(mcpServerSpec, {
          allowedImagePrefixes: config.allowedPluginImagePrefixes,
          enforceImageAllowlist: config.enforcePluginImageAllowlist,
        })
        if (preflightErrors.length > 0) {
          res.status(422).json({ errors: preflightErrors })
          return
        }

        // ── Ownership metadata (spec §9.2.2) ───────────────────────────────
        // catalog-id (and catalog-version, for reader uniformity) live in
        // ANNOTATIONS, not labels: org-scoped names like "@org/name" contain
        // '@' and '/', which are illegal K8s label VALUES and make the
        // apiserver reject the McpServer/Secret with a 422. managed-by /
        // server-mode stay as labels — they are valid, selectable values.
        const registryLabels: Record<string, string> = {
          'clerum.io/managed-by': 'control-api',
          'clerum.io/server-mode': isLocal ? 'local' : 'remote',
        }
        const resourceOperationId = crypto.randomUUID()
        const registryAnnotations: Record<string, string> = {
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          [REGISTRY_OPERATION_ID_ANNOTATION]: resourceOperationId,
          [REGISTRY_SPEC_DIGEST_ANNOTATION]: registrySpecDigest(mcpServerSpec),
        }
        const credentialOperationId = crypto.randomUUID()
        const credentialAnnotations = {
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          [REGISTRY_SECRET_OPERATION_ID_ANNOTATION]: credentialOperationId,
        }

        // ── Ensure the shared registry pull secret (self-hosted) ───────────
        // Must run when a private evenfire-hosted image is in play — independent of
        // whether the plugin needs credentials (a credential-less plugin still needs
        // to pull). Runs BEFORE the per-plugin credentials Secret so a failure leaves
        // nothing to roll back, and BEFORE the McpServer CRD that references it.
        // Namespace-shared, so it is NOT part of the per-plugin rollback below.
        if (attachEvenfirePullSecret) {
          try {
            await ensureRegistryPullSecret(gateway, targetNs)
          } catch (err) {
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        // ── Step 3: Create K8s Secret if credentials provided ─────────────
        let createdSecretSnapshot: SecretSnapshot | null = null
        let createdSecretIdentityProven = false
        if (credRequired) {
          const secretData = credentialPayload.secretData
          if (Object.keys(secretData).length > 0) {
            const secretReq: SecretUpsertRequest = {
              name: secretName,
              namespace: targetNs,
              type: 'Opaque',
              labels: registryLabels,
              annotations: credentialAnnotations,
              stringData: secretData,
            }
            try {
              createdSecretSnapshot = await gateway.createSecret(secretReq, {
                capability: 'registryCredential',
              })
              createdSecretIdentityProven = true
            } catch (err) {
              const k8sErr = extractK8sError(err)
              if (k8sErr && k8sErr.status < 500) {
                res
                  .status(k8sErr.status)
                  .json({ error: `Secret creation failed: ${k8sErr.message}` })
                return
              }
              const recovered = await readSecretMutationOutcome(gateway, null)
              if (recovered.outcome === 'not-committed') {
                res.status(503).json({
                  error: 'registry_secret_outcome_not_committed',
                  outcome: 'not_committed',
                })
                return
              }
              if (recovered.outcome !== 'committed' || !recovered.snapshot) {
                res.status(503).json({
                  error: 'registry_secret_outcome_ambiguous',
                  outcome: 'repair_required',
                })
                return
              }
              if (!recovered.identityProven) {
                // A create has no pre-write UID to compare against. The
                // readback may be a same-name replacement that copied the
                // operation marker, so it cannot be reported as this request's
                // commit or used as a compensation target.
                res.status(503).json({
                  error: 'registry_secret_outcome_ambiguous',
                  outcome: 'repair_required',
                })
                return
              }
              createdSecretSnapshot = recovered.snapshot
              createdSecretIdentityProven = recovered.identityProven
            }
            auditLog('secret_created', {
              secretName,
              namespace: targetNs,
              registryEntry: body.registryEntryName,
              credentialKeys: Object.keys(secretData),
            })
          }
        }

        // ── Step 4: Create McpServer CRD (rollback by UID on failure) ────
        let createdMcpServerSnapshot: RegistryResourceSnapshot | null = null
        const desiredMcpServerMutation = {
          spec: mcpServerSpec,
          metadata: { labels: registryLabels, annotations: registryAnnotations },
          specDigest: registrySpecDigest(mcpServerSpec),
        }
        try {
          const created = await gateway.createResource(
            'mcpservers',
            {
              metadata: {
                name: serverName,
                labels: registryLabels,
                annotations: registryAnnotations,
              },
              spec: mcpServerSpec,
            },
            targetNs
          )
          createdMcpServerSnapshot = normalizeRegistryResourceSnapshot(
            created,
            serverName,
            targetNs
          )
          if (
            !createdMcpServerSnapshot.metadata?.uid ||
            !createdMcpServerSnapshot.metadata.resourceVersion
          ) {
            throw new RegistryInstallRollbackError()
          }
        } catch (err) {
          const k8sErr = extractK8sError(err)
          const ambiguousCreate =
            err instanceof RegistryInstallRollbackError || !k8sErr || k8sErr.status >= 500
          if (ambiguousCreate) {
            const recovered = await readCreatedResourceOutcome(
              gateway,
              'mcpservers',
              serverName,
              targetNs,
              desiredMcpServerMutation,
              resourceOperationId
            )
            if (recovered.outcome === 'not-committed') {
              if (createdSecretSnapshot && !createdSecretIdentityProven) {
                res.status(503).json({
                  error: 'registry_install_outcome_ambiguous',
                  outcome: 'repair_required',
                })
                return
              }
              let rollbackFailed = false
              if (createdSecretSnapshot) {
                try {
                  await rollbackCreatedSecret(gateway, createdSecretSnapshot)
                } catch {
                  rollbackFailed = true
                }
              }
              if (rollbackFailed) {
                res.status(500).json({
                  error: 'registry_install_rollback_incomplete',
                  outcome: 'compensation_failed',
                })
                return
              }
              res.status(k8sErr?.status ?? 503).json({
                error: 'registry_resource_outcome_not_committed',
                outcome: 'not_committed',
              })
              return
            }
            if (recovered.outcome !== 'committed' || !recovered.snapshot) {
              res.status(503).json({
                error: 'registry_resource_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            // A create readback has no pre-write UID to compare with. Even a
            // perfect operation marker/spec match can belong to a same-name
            // replacement that copied the mutable intent. It is safe to leave
            // the observed object for repair, but not to report it as this
            // request's commit or to make it compensable.
            res.status(503).json({
              error: 'registry_resource_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          } else {
            // A conflict, timeout, or throttling response is not a proof that
            // the named CR is absent. It may identify a live CR or follow an
            // accepted create, so preserve the Secret for repair instead of
            // deleting a dependency we cannot disassociate atomically.
            if (!isDeterministicRegistryNoCommit(err)) {
              res.status(503).json({
                error: 'registry_resource_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }

            // A deterministic create rejection proves there is no CR to
            // compensate; only the earlier credential object needs rollback.
            if (createdSecretSnapshot && !createdSecretIdentityProven) {
              res.status(503).json({
                error: 'registry_install_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            let rollbackFailed = false
            if (createdSecretSnapshot) {
              try {
                await rollbackCreatedSecret(gateway, createdSecretSnapshot)
              } catch {
                rollbackFailed = true
              }
            }
            if (rollbackFailed) {
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            if (k8sErr) {
              res.status(k8sErr.status).json({ error: k8sErr.message })
              return
            }
            throw err
          }
        }

        // ── Step 5: Update Context allowlist ──────────────────────────────
        // The Context allowlist is authoritative for host discovery. If this
        // step fails, the McpServer exists but is unreachable, so the install
        // must roll back rather than return a false success.
        let contextBefore: RegistryResourceSnapshot | null = null
        try {
          const ctx = (await gateway.getResource('contexts', contextRef)) as {
            metadata?: { uid?: string; resourceVersion?: string }
            spec?: Record<string, unknown> & {
              contextId?: string
              description?: string
              mcpServers?: string[]
            }
          }
          contextBefore = normalizeRegistryResourceSnapshot(ctx, contextRef, targetNs)
          if (!contextBefore.metadata?.uid || !contextBefore.metadata.resourceVersion) {
            throw Object.assign(new Error('Context identity is unavailable'), {
              statusCode: 503,
              code: 'context_identity_unavailable',
            })
          }
          const existing: string[] = ctx.spec?.mcpServers ?? []
          if (!existing.includes(serverName)) {
            await gateway.updateResource('contexts', contextRef, {
              metadata: {
                uid: contextBefore.metadata.uid,
                ...(ctx.metadata?.resourceVersion
                  ? { resourceVersion: ctx.metadata.resourceVersion }
                  : {}),
              },
              spec: {
                ...ctx.spec,
                contextId: ctx.spec?.contextId ?? contextRef,
                mcpServers: [...existing, serverName],
              } as Record<string, unknown>,
            })
          }
        } catch (err) {
          let associationOutcome: RegistryMutationOutcome = isDeterministicRegistryNoCommit(err)
            ? 'not-committed'
            : 'ambiguous'
          if (contextBefore && associationOutcome === 'ambiguous') {
            associationOutcome = await readRegistryAssociationOutcome(
              gateway,
              'contexts',
              contextRef,
              targetNs,
              contextBefore,
              spec =>
                Array.isArray(spec.mcpServers) &&
                (spec.mcpServers as unknown[]).includes(serverName)
            )
          }
          if (contextBefore && associationOutcome === 'ambiguous') {
            res.status(503).json({
              error: 'registry_install_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }
          if (associationOutcome !== 'committed') {
            if (createdSecretSnapshot && !createdSecretIdentityProven) {
              res.status(503).json({
                error: 'registry_install_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            let resourceRollbackFailed = false
            try {
              await rollbackCreatedResource(
                gateway,
                'mcpservers',
                createdMcpServerSnapshot!,
                `McpServer/${serverName}`
              )
            } catch {
              resourceRollbackFailed = true
            }
            if (resourceRollbackFailed) {
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            if (createdSecretSnapshot) {
              // The CR was live during this saga. There is no Kubernetes
              // transaction that atomically proves its absence and deletes a
              // separately named Secret. Preserve the dependency for repair;
              // deleting it after the CR rollback would permit a replacement
              // CR to race into the same name and reference.
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            const k8sErr = extractK8sError(err)
            const message =
              k8sErr?.message ||
              (err instanceof Error ? err.message : 'Failed to update Context allowlist')
            res
              .status(k8sErr?.status ?? 500)
              .json({ error: `Context allowlist update failed: ${message}` })
            return
          }
        }

        // ── Step 6: Report install to registry (fire-and-forget) ──────────
        const correlationId = crypto.randomUUID()
        reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion).catch(
          () => {}
        )

        res.status(201).json({
          serverName,
          namespace: targetNs,
          contextRef,
          contextUpdated: true,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          correlationId,
          pendingCredentials:
            credRequired && Object.keys(credentialPayload.secretData).length === 0
              ? [
                  {
                    kind: 'mcpEnvSecret',
                    secretName,
                    namespace: targetNs,
                    keys: credSchema.keys!.map(k => k.name),
                    field: 'spec.envSecret',
                  },
                ]
              : [],
        })
      })
    )
  }

  // ── POST /admin/registry/install-recipe ─────────────────────────────────
  if (gateway) {
    router.post(
      '/admin/registry/install-recipe',
      asyncHandler(async (req, res) => {
        const body = req.body as {
          recipeName?: string
          registryEntryName?: string
          registryEntryVersion?: string
          recipeManifest?: string
          inputValues?: Record<string, unknown>
        }

        if (!body.registryEntryName || typeof body.registryEntryName !== 'string') {
          res.status(400).json({ error: 'registryEntryName is required' })
          return
        }
        if (!body.registryEntryVersion || typeof body.registryEntryVersion !== 'string') {
          res.status(400).json({ error: 'registryEntryVersion is required' })
          return
        }

        // Step 1: Fetch entry and verify it's a recipe
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)
        if (entry.entry_type !== 'recipe') {
          res.status(400).json({
            error: `Entry "${body.registryEntryName}" is not a recipe (got: ${entry.entry_type})`,
          })
          return
        }

        // Step 2: Extract recipe YAML from metadata
        const recipeMeta = entry.recipe_meta as { recipeYaml?: string } | null
        if (!recipeMeta?.recipeYaml) {
          res.status(422).json({ error: 'Registry entry has no recipe YAML content' })
          return
        }

        // Step 3: Parse recipe content (YAML preferred; JSON fallback for legacy)
        const recipeContent =
          typeof body.recipeManifest === 'string' && body.recipeManifest.trim().length > 0
            ? body.recipeManifest
            : recipeMeta.recipeYaml

        if (recipeContent.length > MAX_RECIPE_YAML_SIZE) {
          res
            .status(413)
            .json({ error: `Recipe YAML exceeds ${MAX_RECIPE_YAML_SIZE / 1024}KB limit` })
          return
        }
        let parsed: Record<string, unknown>
        try {
          // Try YAML first (the standard format used by the registry seed)
          parsed = parseYaml(recipeContent) as Record<string, unknown>
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('YAML parse returned non-object')
          }
        } catch {
          // Fallback to JSON for legacy entries
          try {
            parsed = JSON.parse(recipeContent)
          } catch {
            res
              .status(422)
              .json({ error: 'Failed to parse recipe content (neither valid YAML nor JSON)' })
            return
          }
        }

        const recipeName =
          body.recipeName?.trim() ||
          generateRegistryName(body.registryEntryName, body.registryEntryVersion).replace(
            /^mcp-/,
            'recipe-'
          )
        if (!isValidK8sName(recipeName)) {
          res.status(400).json({ error: 'Invalid recipeName: must be a valid K8s name' })
          return
        }

        const recipeSpec = (parsed.spec ?? parsed) as Record<string, unknown>
        const limitErrors = validateWorkflowRecipeLimits(recipeSpec)
        if (limitErrors.length > 0) {
          res.status(422).json({ errors: limitErrors })
          return
        }
        const egressErrors = await validateWorkflowRecipeEgressPreflight(recipeSpec)
        if (egressErrors.length > 0) {
          res.status(422).json({ errors: egressErrors })
          return
        }
        // Issue #637 — registry-installed recipes are the third-party path, so gate
        // cross-recipe Secret ownership here too (defense-in-depth; the WRC reconciler
        // is authoritative). install/upgrade previously skipped Secret validation.
        // Lazy import keeps the registry router free of recipes.ts's module-load
        // side effects (delegation-token PEM derivation) so registry routes that
        // never install a recipe (e.g. API-key management) don't require that config.
        const { validateWorkflowRecipeSecretsAndCollectPending } = await import('./recipes.js')
        const workflowSecretResult = await validateWorkflowRecipeSecretsAndCollectPending(
          { metadata: { name: recipeName }, spec: recipeSpec },
          gateway,
          { deferMissingWorkflowSecrets: true, includeOauthClientSecrets: true }
        )
        if (workflowSecretResult.errors) {
          res.status(422).json({ errors: workflowSecretResult.errors })
          return
        }
        const pendingCredentials = workflowSecretResult.pendingCredentials

        // Merge inputValues overrides into inputContract defaults (#8: type validation)
        if (body.inputValues && recipeSpec.inputContract) {
          const contract = recipeSpec.inputContract as {
            properties?: Record<string, { default?: unknown; type?: string }>
          }
          for (const [key, value] of Object.entries(body.inputValues)) {
            if (!contract.properties?.[key]) continue
            const expected = contract.properties[key].type
            if (expected) {
              const actual = typeof value
              if (expected === 'string' && actual !== 'string') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected string, got ${actual}` })
                return
              }
              if (expected === 'number' && actual !== 'number') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected number, got ${actual}` })
                return
              }
              if (expected === 'boolean' && actual !== 'boolean') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected boolean, got ${actual}` })
                return
              }
            }
            contract.properties[key].default = value
          }
        }

        // catalog-id / catalog-version move to annotations (org-scoped names
        // are illegal label values); managed-by stays a label.
        const registryLabels: Record<string, string> = {
          'clerum.io/managed-by': 'control-api',
        }
        const registryAnnotations: Record<string, string> = catalogAnnotations(
          body.registryEntryName,
          body.registryEntryVersion
        )

        // Ensure the platform pull credential before the CRD that will need it.
        //
        // Recipe workloads do NOT all land in the plugin namespace — they split by kind
        // (transport -> mcp-server, spec.ui.workloadRef -> sandbox-ui, rest ->
        // sandbox-recipes) — and WRC injects the pull-secret reference at reconcile time
        // for any workload whose image is ours. So provision the whole platform set: the
        // credential is per-org and the mint is rotate-on-call, so one pass covers every
        // namespace with a single mint (see registryPullSecretService).
        if (recipeReferencesPlatformImage(recipeSpec)) {
          try {
            await ensureRegistryPullSecrets(gateway, platformWorkloadNamespaces())
          } catch (err) {
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        // Step 4: Apply WorkflowRecipe CRD
        try {
          await gateway.createResource('workflowrecipes', {
            metadata: {
              name: recipeName,
              labels: registryLabels,
              annotations: registryAnnotations,
            },
            spec: recipeSpec,
          })
        } catch (err) {
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw err
        }

        // Step 5: Report install (fire-and-forget)
        const correlationId = crypto.randomUUID()
        reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion).catch(
          () => {}
        )

        res.status(201).json({
          recipeName,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          correlationId,
          pendingCredentials,
        })
      })
    )
  }

  // ── POST /admin/registry/install-hook — install an org-scoped guardrail hook (spec §8.5) ──
  if (gateway) {
    router.post(
      '/admin/registry/install-hook',
      asyncHandler(async (req, res) => {
        const body = req.body as {
          hostRef?: string
          registryEntryName?: string
          registryEntryVersion?: string
          hookName?: string
          capabilities?: string[]
          order?: number
          failMode?: 'open' | 'closed'
          credentials?: Record<string, string>
        }

        if (!body.registryEntryName || typeof body.registryEntryName !== 'string') {
          res.status(400).json({ error: 'registryEntryName is required' })
          return
        }
        if (!body.registryEntryVersion || typeof body.registryEntryVersion !== 'string') {
          res.status(400).json({ error: 'registryEntryVersion is required' })
          return
        }
        if (!body.hostRef || typeof body.hostRef !== 'string' || !isValidK8sName(body.hostRef)) {
          res.status(400).json({ error: 'hostRef is required (a valid Host name)' })
          return
        }

        // Step 1 — fetch entry; assert org-owned llm-hook with hook_meta (§8.5).
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)
        if (entry.entry_type !== 'llm-hook') {
          res.status(400).json({
            error: `Entry "${body.registryEntryName}" is not an llm-hook (got: ${entry.entry_type})`,
          })
          return
        }
        const hookMeta = entry.hook_meta as HookMetaShape | null
        if (
          !hookMeta?.target ||
          !Array.isArray(hookMeta.lifecyclePoints) ||
          hookMeta.lifecyclePoints.length === 0
        ) {
          res.status(422).json({ error: 'Registry entry has no hook_meta target/lifecyclePoints' })
          return
        }

        // Steps 1/2/5 — shared host-independent gates: org scope, authoritative
        // trust level, contentAccess conflict, and content/egress separation.
        // (The per-Host floor/ceiling gates below hold the Host context.) The
        // cluster's OWN org (this deployment's publish scope) and official
        // evenfire are auto-curated; other orgs are capped unless in the additive
        // CONTROL_API_CURATED_HOOK_ORGS allowlist.
        const clusterOrgScope = await resolvePublishScope()
          .then(s => s.scope)
          .catch(() => null)
        const admission = assertHookAdmissible(entry, hookMeta, clusterOrgScope)
        if (!admission.ok) {
          res.status(admission.status).json(admission.body)
          return
        }
        const trustLevel = admission.trustLevel

        // Step 3 — load target Host + its guardrails policy.
        let host: HostShape
        let hostBefore: RegistryResourceSnapshot | null = null
        try {
          host = (await gateway.getResource(
            'hosts',
            body.hostRef,
            config.hostsNamespace
          )) as HostShape
          hostBefore = normalizeRegistryResourceSnapshot(host, body.hostRef, config.hostsNamespace)
          if (!hostBefore.metadata?.uid || !hostBefore.metadata.resourceVersion) {
            res.status(503).json({
              error: 'registry_install_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }
        } catch (err) {
          const k8sErr = extractK8sError(err)
          res.status(k8sErr?.status ?? 404).json({ error: `Host "${body.hostRef}" not found` })
          return
        }
        const guardrails = host.spec?.guardrails ?? {}
        const floor = guardrails.minInstalledHookTrustLevel
        const ceiling = guardrails.capabilityCeiling ?? []

        // Step 4 — trust-floor gate (§8.4: a hook below the floor does not run at all).
        if (floor && (HOOK_TRUST_ORDER[trustLevel] ?? 0) < (HOOK_TRUST_ORDER[floor] ?? 0)) {
          res.status(403).json({
            error: 'hook_below_trust_floor',
            reason: `hook trust_level ${trustLevel} < Host minInstalledHookTrustLevel ${floor}`,
          })
          return
        }

        // Content/egress separation + the contentAccess-conflict check are
        // enforced by assertHookAdmissible above. hasEgress is still needed to
        // build the CR's egressBindings below.
        const hasEgress =
          Array.isArray(hookMeta.requiredEgress) && hookMeta.requiredEgress.length > 0

        // Step 6 — capability gate: requested ⊆ Host.capabilityCeiling; may_deny ⇒ fail closed.
        const capabilities = Array.isArray(body.capabilities) ? body.capabilities : []
        const outOfCeiling = capabilities.filter(c => !ceiling.includes(c))
        if (outOfCeiling.length > 0) {
          res.status(403).json({
            error: 'capability_exceeds_ceiling',
            reason: `capabilities not in Host capabilityCeiling: ${outOfCeiling.join(', ')}`,
          })
          return
        }
        const wantsDeny = capabilities.includes('may_deny')
        const failMode = body.failMode ?? (wantsDeny ? 'closed' : 'open')
        if (wantsDeny && failMode !== 'closed') {
          res.status(400).json({
            error: 'deny_requires_fail_closed',
            reason: 'a may_deny hook must fail closed (§8.6)',
          })
          return
        }

        // Step 7 — image preflight: digest-pinned (§8.2 resolution) + allowlist (§8.5).
        const image = hookMeta.target.image
        if (image) {
          if (!isDigestPinnedImageRef(image.ref)) {
            res.status(422).json({ error: 'image_ref_not_digest_pinned' })
            return
          }
          if (
            config.enforcePluginImageAllowlist &&
            !config.allowedPluginImagePrefixes.some(p => (image.ref ?? '').startsWith(p))
          ) {
            res.status(422).json({ error: 'image_not_allowlisted', reason: image.ref })
            return
          }
        }

        const targetNs = config.llmHooksNamespace
        const crName =
          body.hookName?.trim() ||
          generateRegistryName(body.registryEntryName, body.registryEntryVersion).replace(
            /^mcp-/,
            'hook-'
          )
        if (!isValidK8sName(crName)) {
          res.status(400).json({ error: 'Invalid hookName: must be a valid K8s name' })
          return
        }

        const registryLabels: Record<string, string> = { 'clerum.io/managed-by': 'control-api' }
        const resourceOperationId = crypto.randomUUID()
        const registryAnnotations: Record<string, string> = {
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          // §8.4 stamp — platform-assigned, author cannot set it.
          'clerum.io/trust-level': trustLevel,
          [REGISTRY_OPERATION_ID_ANNOTATION]: resourceOperationId,
        }
        const credentialOperationId = crypto.randomUUID()
        const credentialAnnotations = {
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          [REGISTRY_SECRET_OPERATION_ID_ANNOTATION]: credentialOperationId,
        }

        // Step 8 — credential Secret from the hook's credentialSchema.
        const credSchema = (await getCredentialSchema(
          body.registryEntryName,
          body.registryEntryVersion
        ).catch(() => null)) as RegistryCredentialSchema | null
        const credRequired = !!credSchema?.required
        // Reject a non-object payload before Object.keys() enumerates it. Unlike the
        // McpServer path this cannot lean on validateProvidedCredentialPayload: that
        // returns early when the schema is not `required`, so a malformed payload
        // would reach createSecret as stringData. Same error shape as that path.
        if (body.credentials !== undefined && body.credentials !== null) {
          if (isMalformedCredentialPayload(body.credentials)) {
            res.status(400).json({
              error: 'credential.invalidPayload',
              message: 'Credentials must be an object keyed by credential name.',
            })
            return
          }
        }
        const credentials = body.credentials ?? {}
        const secretName = `${crName}-creds`
        let secretCreated = false
        let createdSecretIdentityProven = false
        let createdSecretSnapshot: SecretSnapshot | null = null
        if (Object.keys(credentials).length > 0) {
          const schemaKeys = new Set((credSchema?.keys ?? []).map(k => k.name))
          const unknownKeys = Object.keys(credentials).filter(
            k => schemaKeys.size > 0 && !schemaKeys.has(k)
          )
          if (unknownKeys.length > 0) {
            res
              .status(400)
              .json({ error: 'unknown_credential_keys', reason: unknownKeys.join(', ') })
            return
          }
          try {
            createdSecretSnapshot = await gateway.createSecret(
              {
                name: secretName,
                namespace: targetNs,
                type: 'Opaque',
                labels: registryLabels,
                annotations: credentialAnnotations,
                stringData: credentials,
              },
              REGISTRY_SECRET_WRITE_OPTIONS
            )
            createdSecretIdentityProven = true
          } catch (err) {
            const k8sErr = extractK8sError(err)
            if (k8sErr && k8sErr.status < 500) {
              res.status(k8sErr.status).json({ error: `Secret creation failed: ${k8sErr.message}` })
              return
            }
            const recovered = await readSecretMutationOutcome(gateway, null)
            if (recovered.outcome === 'not-committed') {
              res.status(503).json({
                error: 'registry_secret_outcome_not_committed',
                outcome: 'not_committed',
              })
              return
            }
            if (recovered.outcome !== 'committed' || !recovered.snapshot) {
              res.status(503).json({
                error: 'registry_secret_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            if (!recovered.identityProven) {
              // A create readback cannot prove the UID was issued for this
              // request. Leave the object for repair rather than treating it
              // as a successful, compensable install.
              res.status(503).json({
                error: 'registry_secret_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            createdSecretSnapshot = recovered.snapshot
            createdSecretIdentityProven = recovered.identityProven
          }
          secretCreated = true
        }

        // Ensure the evenfire pull secret for a private platform-registry image,
        // before the CR references it (shared, not part of per-hook rollback).
        const attachPullSecret = shouldAttachEvenfirePullSecret({
          isLocal: true,
          image: image?.ref,
          registryUrl: config.registryUrl,
        })
        if (attachPullSecret) {
          try {
            await ensureRegistryPullSecret(gateway, targetNs)
          } catch (err) {
            if (secretCreated && !createdSecretIdentityProven) {
              res.status(503).json({
                error: 'registry_install_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            if (secretCreated && createdSecretSnapshot) {
              try {
                await rollbackCreatedSecret(gateway, createdSecretSnapshot)
              } catch {
                res.status(500).json({
                  error: 'registry_install_rollback_incomplete',
                  outcome: 'compensation_failed',
                })
                return
              }
            }
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        // Step 9 — build + create the LlmHook CR (rollback the Secret on failure).
        const targetSpec: Record<string, unknown> = {}
        if (image) {
          targetSpec.image = {
            ref: image.ref,
            port: image.port,
            ...(image.security ? { security: image.security } : {}),
            ...(secretCreated ? { envSecret: secretName } : {}),
            ...(hasEgress ? { egressBindings: hookMeta.requiredEgress } : {}),
            ...(attachPullSecret ? { imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME] } : {}),
          }
        } else if (hookMeta.target.service) {
          targetSpec.service = hookMeta.target.service
        } else if (hookMeta.target.remote) {
          targetSpec.remote = hookMeta.target.remote
        }
        const hookSpec: Record<string, unknown> = {
          target: targetSpec,
          path: hookMeta.path ?? '/',
          lifecyclePoints: hookMeta.lifecyclePoints,
          ...(hookMeta.contentAccess === 'metadata' || hookMeta.contentAccess === 'content'
            ? { contentAccess: hookMeta.contentAccess }
            : {}),
          order: typeof body.order === 'number' ? body.order : 100,
          failMode,
          ...(capabilities.length > 0 ? { capabilities } : {}),
          ...(hookMeta.defaultConfig ? { config: hookMeta.defaultConfig } : {}),
        }
        registryAnnotations[REGISTRY_SPEC_DIGEST_ANNOTATION] = registrySpecDigest(hookSpec)

        let createdHookSnapshot: RegistryResourceSnapshot | null = null
        const desiredHookMutation = {
          spec: hookSpec,
          metadata: { labels: registryLabels, annotations: registryAnnotations },
          specDigest: registrySpecDigest(hookSpec),
        }
        try {
          const created = await gateway.createResource(
            'llmhooks',
            {
              metadata: { name: crName, labels: registryLabels, annotations: registryAnnotations },
              spec: hookSpec,
            },
            targetNs
          )
          createdHookSnapshot = normalizeRegistryResourceSnapshot(created, crName, targetNs)
          if (!createdHookSnapshot.metadata?.uid || !createdHookSnapshot.metadata.resourceVersion) {
            throw new RegistryInstallRollbackError()
          }
        } catch (err) {
          const k8sErr = extractK8sError(err)
          const ambiguousCreate =
            err instanceof RegistryInstallRollbackError || !k8sErr || k8sErr.status >= 500
          if (ambiguousCreate) {
            const recovered = await readCreatedResourceOutcome(
              gateway,
              'llmhooks',
              crName,
              targetNs,
              desiredHookMutation,
              resourceOperationId
            )
            if (recovered.outcome === 'not-committed') {
              if (secretCreated && !createdSecretIdentityProven) {
                res.status(503).json({
                  error: 'registry_install_outcome_ambiguous',
                  outcome: 'repair_required',
                })
                return
              }
              let rollbackFailed = false
              if (secretCreated && createdSecretSnapshot) {
                try {
                  await rollbackCreatedSecret(gateway, createdSecretSnapshot)
                } catch {
                  rollbackFailed = true
                }
              }
              if (rollbackFailed) {
                res.status(500).json({
                  error: 'registry_install_rollback_incomplete',
                  outcome: 'compensation_failed',
                })
                return
              }
              res.status(k8sErr?.status ?? 503).json({
                error: 'registry_resource_outcome_not_committed',
                outcome: 'not_committed',
              })
              return
            }
            if (recovered.outcome !== 'committed' || !recovered.snapshot) {
              res.status(503).json({
                error: 'registry_resource_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            // A create readback cannot prove that the observed UID was issued
            // for this request. Do not turn a mutable marker/spec match into a
            // successful install or a later compensation target.
            res.status(503).json({
              error: 'registry_resource_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          } else {
            // A conflict, timeout, or throttling response is not a proof that
            // the named hook is absent. Preserve its Secret for repair because
            // no cross-resource transaction can prove dependency safety.
            if (!isDeterministicRegistryNoCommit(err)) {
              res.status(503).json({
                error: 'registry_resource_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }

            if (secretCreated && !createdSecretIdentityProven) {
              res.status(503).json({
                error: 'registry_install_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            let rollbackFailed = false
            if (secretCreated && createdSecretSnapshot) {
              try {
                await rollbackCreatedSecret(gateway, createdSecretSnapshot)
              } catch {
                rollbackFailed = true
              }
            }
            if (rollbackFailed) {
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            if (k8sErr) {
              res.status(k8sErr.status).json({ error: k8sErr.message })
              return
            }
            throw err
          }
        }

        // Step 10 — reference the hook from Host.spec.guardrails.hooks[phase] as
        // {id, digest}. If this fails the hook exists but no Host runs it, so roll
        // the CR (+ Secret) back rather than return a false success.
        const digest = imageRefDigest(image?.ref)
        try {
          // Atomic read→derive→write (shared with the uninstall/upgrade paths):
          // re-reads the Host, derives the hooks map from THAT read, and sends its
          // resourceVersion as the replace precondition. Deriving out here and
          // writing with a plain `updateResource` sends no precondition and replays
          // a stale map, so a concurrent install/uninstall on the same Host is
          // silently clobbered — leaving this CR installed but unreferenced, which
          // reads to the operator as an active guardrail that never runs
          // (fail-OPEN). Exhausted retries throw into the rollback below rather
          // than reporting a false success.
          await addHookRefToHost(
            gateway,
            body.hostRef,
            crName,
            hookMeta.lifecyclePoints,
            digest,
            config.hostsNamespace
          )
        } catch (err) {
          const associationOutcome = isDeterministicRegistryNoCommit(err)
            ? 'not-committed'
            : await readRegistryAssociationOutcome(
                gateway,
                'hosts',
                body.hostRef,
                config.hostsNamespace,
                hostBefore!,
                spec => {
                  const hooks = ((
                    spec.guardrails as { hooks?: Record<string, unknown> } | undefined
                  )?.hooks ?? {}) as Record<string, unknown>
                  return hookMeta.lifecyclePoints.every(phase => {
                    const refs = hooks[phase]
                    return (
                      Array.isArray(refs) &&
                      refs.some(ref => {
                        if (!ref || typeof ref !== 'object') return false
                        const candidate = ref as { id?: unknown; digest?: unknown }
                        return (
                          candidate.id === crName &&
                          (digest === undefined || candidate.digest === digest)
                        )
                      })
                    )
                  })
                }
              )
          if (associationOutcome === 'ambiguous') {
            res.status(503).json({
              error: 'registry_install_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }
          if (associationOutcome !== 'committed') {
            if (secretCreated && createdSecretSnapshot && !createdSecretIdentityProven) {
              res.status(503).json({
                error: 'registry_install_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }
            let resourceRollbackFailed = false
            try {
              await rollbackCreatedResource(
                gateway,
                'llmhooks',
                createdHookSnapshot!,
                `LlmHook/${crName}`
              )
            } catch {
              resourceRollbackFailed = true
            }
            if (resourceRollbackFailed) {
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            if (secretCreated && createdSecretSnapshot) {
              // As with MCP installs, the Host may acquire a same-name
              // replacement immediately after the LlmHook disappears. There
              // is no cross-resource CAS, so leave the Secret for repair.
              res.status(500).json({
                error: 'registry_install_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
            const k8sErr = extractK8sError(err)
            const message =
              k8sErr?.message ||
              (err instanceof Error ? err.message : 'Failed to update Host guardrails')
            res
              .status(k8sErr?.status ?? 500)
              .json({ error: `Host guardrails update failed: ${message}` })
            return
          }
        }

        // Step 11 — report install (fire-and-forget) + audit.
        const correlationId = crypto.randomUUID()
        reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion).catch(
          () => {}
        )
        auditLog('hook_installed', {
          hookName: crName,
          hostRef: body.hostRef,
          trustLevel,
          lifecyclePoints: hookMeta.lifecyclePoints,
          registryEntry: body.registryEntryName,
        })

        res.status(201).json({
          hookName: crName,
          namespace: targetNs,
          hostRef: body.hostRef,
          trustLevel,
          lifecyclePoints: hookMeta.lifecyclePoints,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          correlationId,
          pendingCredentials:
            credRequired && !secretCreated
              ? [
                  {
                    kind: 'hookEnvSecret',
                    secretName,
                    namespace: targetNs,
                    keys: (credSchema?.keys ?? []).map(k => k.name),
                    field: 'spec.target.image.envSecret',
                  },
                ]
              : [],
        })
      })
    )

    // ── POST /admin/registry/upgrade-hook — coordinated hook image upgrade (§8.2) ──
    // Bumps the LlmHook CR image AND every referencing Host's pinned digest in
    // lock-step, so the digest pin doesn't trip and quarantine the hook.
    router.post(
      '/admin/registry/upgrade-hook',
      asyncHandler(async (req, res) => {
        const body = req.body as {
          hookName?: string
          registryEntryName?: string
          registryEntryVersion?: string
        }
        if (!body.hookName || typeof body.hookName !== 'string' || !isValidK8sName(body.hookName)) {
          res.status(400).json({ error: 'hookName is required (the installed LlmHook CR name)' })
          return
        }
        if (!body.registryEntryName || !body.registryEntryVersion) {
          res.status(400).json({ error: 'registryEntryName and registryEntryVersion are required' })
          return
        }

        // New version's hook_meta.
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)
        if (entry.entry_type !== 'llm-hook') {
          res.status(400).json({ error: `Entry "${body.registryEntryName}" is not an llm-hook` })
          return
        }
        const hookMeta = entry.hook_meta as HookMetaShape | null
        if (
          !hookMeta?.target ||
          !Array.isArray(hookMeta.lifecyclePoints) ||
          hookMeta.lifecyclePoints.length === 0
        ) {
          res.status(422).json({ error: 'Registry entry has no hook_meta target/lifecyclePoints' })
          return
        }

        const llmHooksNs = config.llmHooksNamespace
        let current: {
          spec?: Record<string, unknown>
          metadata?: {
            uid?: string
            annotations?: Record<string, string>
            labels?: Record<string, string>
            resourceVersion?: string
          }
        }
        try {
          current = (await gateway.getResource('llmhooks', body.hookName, llmHooksNs)) as {
            spec?: Record<string, unknown>
            metadata?: {
              uid?: string
              annotations?: Record<string, string>
              labels?: Record<string, string>
              resourceVersion?: string
            }
          }
        } catch (err) {
          res.status(404).json({
            error: `LlmHook "${body.hookName}" not found: ${err instanceof Error ? err.message : 'not found'}`,
          })
          return
        }

        if (!current.metadata?.uid || !current.metadata.resourceVersion) {
          res.status(503).json({ error: 'registry_resource_identity_unavailable' })
          return
        }
        const beforeRegistrySnapshot = normalizeRegistryResourceSnapshot(
          current,
          body.hookName,
          llmHooksNs
        )

        // The CR must be an upgrade OF THIS ENTRY. The only other cross-check is
        // target KIND, so naming a different entry silently re-pointed the hook at
        // another image while it inherited this CR's envSecret, capabilities,
        // imagePullSecrets and egressBindings — and kept claiming the original
        // catalog-id. The caller is an admin and so already in the TCB; the point is
        // that changing a hook's identity should be an explicit uninstall+install,
        // not a silent side effect of a mistyped entry name.
        const installedCatalogId = getCatalogId(current.metadata)
        if (installedCatalogId && installedCatalogId !== body.registryEntryName) {
          res.status(409).json({
            error: 'hook_entry_identity_mismatch',
            reason: `LlmHook "${body.hookName}" was installed from "${installedCatalogId}", not "${body.registryEntryName}" — uninstall and install to change entry`,
          })
          return
        }

        // Preflight the new image (digest-pin + allowlist), mirroring install.
        const newImage = hookMeta.target.image
        let newDigest: string | undefined
        if (newImage) {
          if (!isDigestPinnedImageRef(newImage.ref)) {
            res.status(422).json({ error: 'image_ref_not_digest_pinned' })
            return
          }
          if (
            config.enforcePluginImageAllowlist &&
            !config.allowedPluginImagePrefixes.some(p => (newImage.ref ?? '').startsWith(p))
          ) {
            res.status(422).json({ error: 'image_not_allowlisted', reason: newImage.ref })
            return
          }
          newDigest = imageRefDigest(newImage.ref)
        }

        // Host-independent admissibility gates — upgrade-hook is the sanctioned
        // update path, so it MUST clear the same gates as install (resources.ts
        // withholds raw create/update for exactly this reason). Without this a
        // low-trust image hook could "upgrade" into a content-bearing remote/egress
        // target and exfiltrate.
        const clusterOrgScope = await resolvePublishScope()
          .then(s => s.scope)
          .catch(() => null)
        const admission = assertHookAdmissible(entry, hookMeta, clusterOrgScope)
        if (!admission.ok) {
          res.status(admission.status).json(admission.body)
          return
        }
        const trustLevel = admission.trustLevel

        // Target kind is immutable across an upgrade (§8.2 is an IMAGE bump, not a
        // re-target). Switching image↔service↔remote changes the security posture
        // AND, for a non-image target, drops the pinned digest binding on every
        // referencing Host (silently un-quarantining the hook).
        const curTargetKind = hookTargetKind(
          ((current.spec ?? {}).target ?? {}) as {
            image?: unknown
            service?: unknown
            remote?: unknown
          }
        )
        const newTargetKind = hookTargetKind(hookMeta.target)
        if (curTargetKind !== newTargetKind) {
          res.status(422).json({
            error: 'hook_target_kind_immutable',
            reason: `upgrade cannot change the hook target kind (installed: ${curTargetKind}, new: ${newTargetKind})`,
          })
          return
        }

        // Per-Host trust-floor gate (§8.4): refuse the whole upgrade if the new
        // trust level would drop any referencing Host's hook below its floor. Done
        // BEFORE touching the CR, so the refusal is atomic and fail-closed.
        const referencingHosts = (await listHostsReferencingHook(
          gateway,
          body.hookName,
          config.hostsNamespace
        )) as Array<{
          spec?: { guardrails?: HostGuardrailsShape }
          metadata?: { name?: string }
        }>
        const belowFloor = referencingHosts
          .filter(h => {
            const floor = h.spec?.guardrails?.minInstalledHookTrustLevel
            return !!floor && (HOOK_TRUST_ORDER[trustLevel] ?? 0) < (HOOK_TRUST_ORDER[floor] ?? 0)
          })
          .map(h => h.metadata?.name)
          .filter((n): n is string => !!n)
        if (belowFloor.length > 0) {
          res.status(403).json({
            error: 'hook_below_trust_floor',
            reason: `upgraded hook trust_level ${trustLevel} is below the trust floor on: ${belowFloor.join(', ')}`,
          })
          return
        }

        // Capability ceiling, re-checked on every referencing Host. Upgrade cannot
        // WIDEN capabilities (they are inherited from the CR), but a Host whose
        // capabilityCeiling was tightened after install would otherwise keep its
        // over-privileged hook through every subsequent upgrade — install is the
        // only other place the ceiling is ever enforced.
        const curCapabilities = Array.isArray((current.spec ?? {}).capabilities)
          ? ((current.spec ?? {}).capabilities as string[])
          : []
        if (curCapabilities.length > 0) {
          const overCeiling = referencingHosts
            .map(h => {
              const ceiling = h.spec?.guardrails?.capabilityCeiling ?? []
              const outside = curCapabilities.filter(c => !ceiling.includes(c))
              return outside.length > 0 ? { host: h.metadata?.name, outside } : null
            })
            .filter((x): x is { host: string | undefined; outside: string[] } => x !== null)
          if (overCeiling.length > 0) {
            res.status(403).json({
              error: 'capability_exceeds_ceiling',
              reason: `installed capabilities exceed the Host capabilityCeiling on: ${overCeiling
                .map(o => `${o.host} (${o.outside.join(', ')})`)
                .join('; ')}`,
            })
            return
          }
        }

        // An upgrade is exactly how a hook moves from a public image to a private
        // platform-registry one; without this the CR persists referencing a pull
        // secret that does not exist, the request returns 200, and the pod sits in
        // ImagePullBackOff while status.observedDigest never advances (so mcp-host
        // sees no digest mismatch and loads the descriptor anyway). Same guard the
        // recipe upgrade route already carries.
        const attachPullSecret = shouldAttachEvenfirePullSecret({
          isLocal: true,
          image: newImage?.ref,
          registryUrl: config.registryUrl,
        })
        if (attachPullSecret) {
          try {
            await ensureRegistryPullSecret(gateway, llmHooksNs)
          } catch (err) {
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        // Build the upgraded spec from the NEW hook_meta, the same way install does.
        //
        // Only `envSecret` and `imagePullSecrets` are genuinely install-time (they
        // name Secrets this saga mints). `security`, `egressBindings` and
        // `contentAccess` all come from the registry entry, so they are
        // VERSION-SHAPED and must move with the version — previously they were
        // inherited from the old CR while assertHookAdmissible above had already
        // judged the NEW values, so the gate and the object it guards could disagree:
        // a v2 that dropped requiredEgress was admitted as egress-free yet kept the
        // old NetworkPolicy, and a v2 moving contentAccess metadata→content was
        // admitted as content-bearing while the CR stayed `metadata`, leaving
        // mcp-host's projection to strip every body — a moderation hook upgraded
        // into a no-op, with a 200.
        const curSpec = (current.spec ?? {}) as Record<string, unknown>
        const curTarget = (curSpec.target ?? {}) as Record<string, unknown>
        const curImage = (curTarget.image ?? {}) as Record<string, unknown>
        const hasEgress =
          Array.isArray(hookMeta.requiredEgress) && hookMeta.requiredEgress.length > 0
        const target: Record<string, unknown> = newImage
          ? {
              image: {
                ref: newImage.ref,
                port: newImage.port,
                ...(newImage.security ? { security: newImage.security } : {}),
                ...(curImage.envSecret ? { envSecret: curImage.envSecret } : {}),
                ...(hasEgress ? { egressBindings: hookMeta.requiredEgress } : {}),
                ...(attachPullSecret
                  ? { imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME] }
                  : curImage.imagePullSecrets
                    ? { imagePullSecrets: curImage.imagePullSecrets }
                    : {}),
              },
            }
          : hookMeta.target.service
            ? { service: hookMeta.target.service }
            : { remote: hookMeta.target.remote }
        const { contentAccess: _staleContentAccess, ...curSpecSansContentAccess } = curSpec
        const upgradedSpec: Record<string, unknown> = {
          ...curSpecSansContentAccess,
          target,
          path: hookMeta.path ?? '/',
          lifecyclePoints: hookMeta.lifecyclePoints,
          ...(hookMeta.contentAccess === 'metadata' || hookMeta.contentAccess === 'content'
            ? { contentAccess: hookMeta.contentAccess }
            : {}),
        }

        // 1) Update the CR. 2) Move every referencing Host's ref (phases + pinned
        //    digest) in lock-step. If the Host sync fails after the CR update, the
        //    un-synced Hosts still pin the OLD digest → mcp-host quarantines the
        //    hook there (fail-CLOSED, safe) until retried — surface a 207, not a
        //    false success.
        // Restamp the catalog annotations. updateResource MERGES metadata.annotations
        // over current, so omitting metadata left catalog-version pinned at the old
        // version forever — getInstalledRegistryState builds its hookKeys from exactly
        // these, so the catalog kept reporting the pre-upgrade version and re-offering
        // the same upgrade — and left trust-level stale even though trustLevel was
        // just recomputed above. Both sibling upgrade routes already do this.
        const operationId = crypto.randomUUID()
        const desiredSpecDigest = registrySpecDigest(upgradedSpec)
        const upgradeAnnotations = {
          ...(current.metadata?.annotations ?? {}),
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          'clerum.io/trust-level': trustLevel,
          [REGISTRY_OPERATION_ID_ANNOTATION]: operationId,
          [REGISTRY_SPEC_DIGEST_ANNOTATION]: desiredSpecDigest,
        }
        const mutation = await executeRegistryResourceMutation(
          gateway,
          'llmhooks',
          body.hookName,
          llmHooksNs,
          {
            metadata: {
              ...(current.metadata?.labels ? { labels: current.metadata.labels } : {}),
              annotations: upgradeAnnotations,
              uid: current.metadata.uid,
              resourceVersion: current.metadata.resourceVersion,
            },
            spec: upgradedSpec,
          },
          beforeRegistrySnapshot,
          {
            spec: upgradedSpec,
            metadata: {
              labels: current.metadata.labels,
              annotations: upgradeAnnotations,
            },
            specDigest: desiredSpecDigest,
          },
          operationId
        )
        if (mutation.outcome === 'rejected') {
          const k8sErr = extractK8sError(mutation.error)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw mutation.error
        }
        if (mutation.outcome === 'not-committed') {
          res.status(503).json({
            error: 'registry_upgrade_outcome_not_committed',
            outcome: 'not_committed',
          })
          return
        }
        if (mutation.outcome === 'ambiguous') {
          log.error(
            { hookName: body.hookName, error: registryErrorLogFields(mutation.error) },
            'Registry hook upgrade outcome is ambiguous after identity fence'
          )
          res.status(503).json({
            error: 'registry_upgrade_outcome_ambiguous',
            outcome: 'repair_required',
          })
          return
        }
        let syncedHosts: string[]
        try {
          syncedHosts = await syncHookRefsInHosts(
            gateway,
            body.hookName,
            hookMeta.lifecyclePoints,
            newDigest,
            config.hostsNamespace
          )
        } catch (err) {
          log.error(
            { hookName: body.hookName, error: registryErrorLogFields(err) },
            'Registry upgrade Host reference sync failed'
          )
          res.status(207).json({
            hookName: body.hookName,
            digest: newDigest,
            registryEntry: body.registryEntryName,
            registryVersion: body.registryEntryVersion,
            // Only a may_deny hook denies on a digest mismatch; an advisory hook is
            // skipped-with-alert and contributes NOTHING, so a rewrite/redaction hook
            // silently stops applying on un-synced Hosts. Retrying is idempotent.
            warning:
              'CR upgraded but Host reference sync failed. Un-synced Hosts still pin the old digest: may_deny hooks fail closed there, advisory hooks are skipped and stop contributing. Retry this call.',
          })
          return
        }

        // Registry install accounting — install and both sibling upgrades report;
        // hook upgrades were invisible. Promise.resolve() rather than a bare .catch()
        // so reporting can never fail an upgrade that already succeeded.
        const correlationId = crypto.randomUUID()
        void Promise.resolve(
          reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion)
        ).catch(() => {})

        auditLog('upgrade-hook', {
          hookName: body.hookName,
          digest: newDigest,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          trustLevel,
          syncedHosts,
        })
        res.status(200).json({
          hookName: body.hookName,
          digest: newDigest,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          trustLevel,
          syncedHosts,
        })
      })
    )
  }

  // ── DELETE /admin/registry/uninstall — Uninstall MCP server OR recipe (spec §9.5) ──
  if (gateway) {
    router.delete(
      '/admin/registry/uninstall/:resourceName',
      asyncHandler(async (req, res) => {
        const resourceName = req.params.resourceName
        const resourceType = (req.query.type as string) || 'mcp-server' // "mcp-server" | "recipe"
        // Default namespace depends on the resource kind. Recipes are always
        // canonical to `sandbox-recipes`; McpServers are canonical to
        // `mcp-server`. Recipe deletes reject any explicit non-canonical
        // namespace because WorkflowRecipe-in-mcp-server is a design bug, not
        // a supported cleanup path.
        const defaultNs =
          resourceType === 'recipe' ? config.sandboxNamespace : config.mcpServersNamespace
        const namespace = (req.query.namespace as string) || defaultNs

        if (!resourceName || !isValidK8sName(resourceName)) {
          res.status(400).json({ error: 'Valid resourceName is required' })
          return
        }

        const deleted: string[] = []
        const warnings: string[] = []

        if (resourceType === 'recipe') {
          if (namespace !== config.sandboxNamespace) {
            res.status(422).json({
              error: `WorkflowRecipe resources always live in namespace "${config.sandboxNamespace}"`,
            })
            return
          }
          // Uninstall WorkflowRecipe
          try {
            const current = await readResourceForRollback(gateway, 'workflowrecipes', {
              metadata: { name: resourceName, namespace },
              spec: {},
            })
            if (!current) {
              warnings.push(`WorkflowRecipe/${resourceName}: not found`)
            } else {
              await gateway.deleteResource(
                'workflowrecipes',
                resourceName,
                namespace,
                resourcePreconditions(current)
              )
              await waitForDeletion(
                () => gateway.getResource('workflowrecipes', resourceName, namespace),
                `WorkflowRecipe/${resourceName}`
              )
              deleted.push(`WorkflowRecipe/${resourceName}`)
            }
          } catch (err) {
            res.status(503).json({
              error: 'registry_uninstall_outcome_ambiguous',
              outcome: 'repair_required',
              resourceName,
              resourceType,
              namespace,
              deleted,
              warnings: [
                ...warnings,
                `WorkflowRecipe/${resourceName}: ${err instanceof Error ? err.message : 'unable to verify deletion'}`,
              ],
            })
            return
          }
        } else {
          // Uninstall MCP Server
          let credentialSecretSnapshot: SecretSnapshot | null = null
          const credentialSecretName = `${resourceName}-credentials`

          // Capture the credential identity before deleting the parent CR. A
          // same-name Secret replacement can be created after the CR delete;
          // reading by name afterwards would make the cleanup delete a
          // different owner's object. The later delete is bound to this exact
          // UID/RV snapshot.
          try {
            credentialSecretSnapshot = normalizeSecretSnapshot(
              await gateway.getSecret(credentialSecretName, namespace),
              credentialSecretName,
              namespace
            )
          } catch (err) {
            if (extractK8sError(err)?.status !== 404) {
              res.status(503).json({
                error: 'registry_uninstall_outcome_ambiguous',
                outcome: 'repair_required',
                resourceName,
                resourceType,
                namespace,
                deleted,
                warnings: [
                  ...warnings,
                  `Secret/${credentialSecretName}: ${err instanceof Error ? err.message : 'unable to verify identity'}`,
                ],
              })
              return
            }
          }

          try {
            const current = await readResourceForRollback(gateway, 'mcpservers', {
              metadata: { name: resourceName, namespace },
              spec: {},
            })
            if (!current) {
              warnings.push(`McpServer/${resourceName}: not found`)
            } else {
              await gateway.deleteResource(
                'mcpservers',
                resourceName,
                namespace,
                resourcePreconditions(current)
              )
              await waitForDeletion(
                () => gateway.getResource('mcpservers', resourceName, namespace),
                `McpServer/${resourceName}`
              )
              deleted.push(`McpServer/${resourceName}`)
            }
          } catch (err) {
            res.status(503).json({
              error: 'registry_uninstall_outcome_ambiguous',
              outcome: 'repair_required',
              resourceName,
              resourceType,
              namespace,
              deleted,
              warnings: [
                ...warnings,
                `McpServer/${resourceName}: ${err instanceof Error ? err.message : 'unable to verify deletion'}`,
              ],
            })
            return
          }

          // Delete credential Secret
          try {
            if (credentialSecretSnapshot) {
              await gateway.deleteSecret(
                credentialSecretSnapshot.name,
                credentialSecretSnapshot.namespace,
                secretPreconditions(credentialSecretSnapshot)
              )
              await waitForDeletion(
                () =>
                  gateway.getSecret(
                    credentialSecretSnapshot!.name,
                    credentialSecretSnapshot!.namespace
                  ),
                `Secret/${credentialSecretSnapshot.name}`
              )
              deleted.push(`Secret/${credentialSecretSnapshot.name}`)
            }
          } catch (err) {
            if (extractK8sError(err)?.status !== 404) {
              res.status(503).json({
                error: 'registry_uninstall_outcome_ambiguous',
                outcome: 'repair_required',
                resourceName,
                resourceType,
                namespace,
                deleted,
                warnings: [
                  ...warnings,
                  `Secret/${credentialSecretName}: ${err instanceof Error ? err.message : 'unable to verify deletion'}`,
                ],
              })
              return
            }
            // Secret may not exist (no credentials)
          }

          // Remove from Context allowlists
          try {
            const ctxList = (await gateway.listResource('contexts', namespace)) as Array<{
              metadata?: { name?: string; uid?: string; resourceVersion?: string }
              spec?: Record<string, unknown> & {
                contextId?: string
                description?: string
                mcpServers?: string[]
              }
            }>
            for (const ctx of ctxList) {
              const name = ctx.metadata?.name
              const servers = ctx.spec?.mcpServers ?? []
              if (name && servers.includes(resourceName)) {
                const uid = ctx.metadata?.uid
                const resourceVersion = ctx.metadata?.resourceVersion
                if (!uid || !resourceVersion) {
                  throw new Error(`Context/${name} identity unavailable; refusing stale update`)
                }
                await gateway.updateResource(
                  'contexts',
                  name,
                  {
                    metadata: { uid, resourceVersion },
                    spec: {
                      ...ctx.spec,
                      contextId: ctx.spec?.contextId ?? name,
                      mcpServers: servers.filter(s => s !== resourceName),
                    } as Record<string, unknown>,
                  },
                  namespace
                )
                deleted.push(`Context/${name} (removed from allowlist)`)
              }
            }
          } catch (err) {
            res.status(503).json({
              error: 'registry_uninstall_partial',
              outcome: 'repair_required',
              resourceName,
              resourceType,
              namespace,
              deleted,
              warnings: [
                ...warnings,
                `Context allowlists: ${err instanceof Error ? err.message : 'unable to update safely'}`,
              ],
            })
            return
          }
        }

        auditLog('uninstall', { resourceName, resourceType, namespace, deleted, warnings })

        res.json({ resourceName, resourceType, namespace, deleted, warnings })
      })
    )
  }

  // ── POST /admin/registry/upgrade — Upgrade MCP server version (spec §9.4) ──
  if (gateway) {
    router.post(
      '/admin/registry/upgrade',
      asyncHandler(async (req, res) => {
        const body = req.body as {
          serverName: string
          registryEntryName: string
          registryEntryVersion: string // new version
          credentials?: Record<string, string>
          egressBindings?: RegistryEgressBinding[]
        }

        if (!body.serverName || !body.registryEntryName || !body.registryEntryVersion) {
          res
            .status(400)
            .json({ error: 'serverName, registryEntryName, and registryEntryVersion are required' })
          return
        }

        const namespace = config.mcpServersNamespace

        // 1. Verify existing server exists
        let existingServer: {
          metadata?: {
            uid?: string
            annotations?: Record<string, string>
            labels?: Record<string, string>
            resourceVersion?: string
          }
          spec?: Record<string, unknown>
        }
        try {
          existingServer = (await gateway.getResource(
            'mcpservers',
            body.serverName,
            namespace
          )) as typeof existingServer
        } catch {
          res.status(404).json({ error: `McpServer "${body.serverName}" not found` })
          return
        }

        if (!existingServer.metadata?.uid || !existingServer.metadata.resourceVersion) {
          res.status(503).json({ error: 'registry_resource_identity_unavailable' })
          return
        }
        const beforeRegistrySnapshot: RegistryResourceSnapshot = {
          metadata: {
            uid: existingServer.metadata.uid,
            resourceVersion: existingServer.metadata.resourceVersion,
            labels: existingServer.metadata.labels,
            annotations: existingServer.metadata.annotations,
          },
          spec: existingServer.spec ?? {},
        }

        const installedCatalogId = getCatalogId(existingServer.metadata)
        if (installedCatalogId && installedCatalogId !== body.registryEntryName) {
          res.status(409).json({
            error: 'mcp_server_entry_identity_mismatch',
            reason: `McpServer "${body.serverName}" was installed from "${installedCatalogId}", not "${body.registryEntryName}" — uninstall and install to change entry`,
          })
          return
        }

        // 2. Fetch new version metadata
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)
        const meta = entry.mcp_server_meta as Record<string, unknown> | null
        const isLocal = entry.server_mode === 'local'

        // Phase 2.5: same evenfire imageRef/name identity guard as install.
        const imageRefIdentity = checkEvenfireImageRefMatchesEntry({
          isLocal,
          entryName: entry.name,
          image: meta?.imageRef,
          registryUrl: config.registryUrl,
        })
        if (!imageRefIdentity.ok) {
          res.status(422).json({
            error: `Registry entry imageRef repo "${imageRefIdentity.actual}" must equal the entry name "${imageRefIdentity.expected}" for evenfire-hosted plugins; cross-org pull would be denied.`,
          })
          return
        }

        const credSchema = await loadRegistryCredentialSchema(entry)
        if (!credSchema) {
          res.status(502).json({ error: 'Registry returned invalid credential schema' })
          return
        }
        const credentialPayload = validateProvidedCredentialPayload(credSchema, body.credentials)
        if (!credentialPayload.ok) {
          res.status(400).json(credentialPayload.body)
          return
        }

        // 3. Build updated spec (preserve contextRef from existing)
        const existingSpec = existingServer.spec ?? {}
        const transport = (entry.transport ?? 'streamableHttp') as string
        const port = (meta?.port as number) ?? 3000
        let remoteBaseUrl: string | undefined
        if (!isLocal) {
          const remoteEndpoints = meta?.remoteEndpoints as Array<{ url: string }> | undefined
          if (!remoteEndpoints?.[0]?.url) {
            res
              .status(400)
              .json({ error: 'Remote registry entry must declare remoteEndpoints[0].url' })
            return
          }
          remoteBaseUrl = remoteEndpoints[0].url
          try {
            validateRemoteUrl(remoteBaseUrl)
          } catch (err) {
            res
              .status(400)
              .json({ error: err instanceof Error ? err.message : 'Invalid remote URL' })
            return
          }
        }

        const secretName = `${body.serverName}-credentials`
        const upgradeRequiresCredentials = credSchema.required && credSchema.keys.length > 0
        const existingTransport = (existingSpec.transport as Record<string, unknown>) ?? {}
        const transportSpec: Record<string, unknown> = {
          type: transport,
          ...(transport !== 'stdio' ? { port } : {}),
          url: existingTransport.url,
        }
        if (remoteBaseUrl) {
          const upstreamPath = new URL(remoteBaseUrl).pathname || '/'
          transportSpec.url = `http://${body.serverName}.${namespace}.svc.cluster.local:${port}${upstreamPath}`
        }

        const updatedSpec: Record<string, unknown> = {
          ...existingSpec,
          image: isLocal
            ? ((meta?.imageRef as string) ?? (existingSpec.image as string))
            : REMOTE_MCP_EGRESS_PROXY_IMAGE,
          transport: transportSpec,
        }
        if (upgradeRequiresCredentials) {
          updatedSpec.envSecret = {
            name: secretName,
            keys: credSchema.keys.map(k => ({ secretKey: k.name, envVar: k.name })),
          }
        } else {
          delete updatedSpec.envSecret
        }
        if (remoteBaseUrl) {
          let authHeaders: Array<{ header: string; valueTemplate: string }> | undefined
          try {
            authHeaders = validateAuthHeadersTemplate(meta?.authHeaders)
          } catch (err) {
            res
              .status(400)
              .json({ error: err instanceof Error ? err.message : 'Invalid authHeaders template' })
            return
          }
          updatedSpec.remote = {
            baseUrl: remoteBaseUrl,
            ...(authHeaders && authHeaders.length > 0 ? { authHeaders } : {}),
          }
        } else {
          delete updatedSpec.remote
        }
        try {
          const egressBindings =
            body.egressBindings ?? deriveRegistryEgressBindings({ meta, isLocal, remoteBaseUrl })
          if (egressBindings) updatedSpec.egressBindings = egressBindings
          else delete updatedSpec.egressBindings
        } catch (err) {
          res
            .status(400)
            .json({ error: err instanceof Error ? err.message : 'Invalid egressSummary' })
          return
        }

        // Recompute imagePullSecrets on every upgrade. The spread of ...existingSpec
        // above carries a prior ref forward, so we must set it when the new image is
        // evenfire-hosted and DELETE it otherwise (host change evenfire→GCP-AR, or
        // local→remote) to avoid a stale, unresolvable pull-secret reference.
        const attachEvenfirePullSecret = shouldAttachEvenfirePullSecret({
          isLocal,
          image: updatedSpec.image,
          registryUrl: config.registryUrl,
        })
        if (attachEvenfirePullSecret) {
          updatedSpec.imagePullSecrets = [{ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME }]
        } else {
          delete updatedSpec.imagePullSecrets
        }

        const preflightErrors = await validateMcpServerSpecPreflight(updatedSpec, {
          allowedImagePrefixes: config.allowedPluginImagePrefixes,
          enforceImageAllowlist: config.enforcePluginImageAllowlist,
        })
        if (preflightErrors.length > 0) {
          res.status(422).json({ errors: preflightErrors })
          return
        }

        // This identity is generated only after every validation/preflight and
        // before the first write side effect. It lets a later readback prove
        // this operation, not merely the same catalog version from an older run.
        const operationId = crypto.randomUUID()
        const desiredSpecDigest = registrySpecDigest(updatedSpec)

        // Read and validate the rollback target before any shared pull-secret
        // provisioning or credentials write. A legacy Secret with blocked
        // infrastructure metadata cannot be safely restored through the normal
        // constrained writer, so fail closed before creating side effects.
        let previousSecretSnapshot: SecretSnapshot | null = null
        let secretCreatedDuringUpgrade = false
        let mutatedSecretIdentityProven = false
        let mutatedSecretPreconditions: SecretPreconditions | null = null
        let mutatedSecretSnapshot: SecretSnapshot | null = null
        const hasCredentialUpdates = Object.keys(credentialPayload.secretData).length > 0
        if (hasCredentialUpdates) {
          try {
            previousSecretSnapshot = normalizeSecretSnapshot(
              await gateway.getSecret(secretName, namespace),
              secretName,
              namespace
            )
          } catch (err) {
            const k8sErr = extractK8sError(err)
            if (k8sErr?.status !== 404) {
              res.status(k8sErr?.status ?? 500).json({
                error: `Failed to read existing credentials: ${k8sErr?.message || (err instanceof Error ? err.message : 'unknown error')}`,
              })
              return
            }
          }

          if (previousSecretSnapshot) {
            const reason = nonRestorableSecretSnapshotReason(previousSecretSnapshot)
            if (reason) {
              res.status(409).json({
                error: 'credentials_secret_state_not_restorable',
                reason,
              })
              return
            }
          }
        }

        // Ensure the shared pull secret exists before the CRD update references it
        // (self-hosted self-provision; namespace-shared, idempotent, fail-loud). Runs
        // AFTER preflight — matching install — so a request that will 422 never mints a
        // rotate-on-call credential.
        if (attachEvenfirePullSecret) {
          try {
            await ensureRegistryPullSecret(gateway, namespace)
          } catch (err) {
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        // 4. Update credentials if provided
        if (hasCredentialUpdates) {
          const secretRequest: SecretUpsertRequest = {
            name: secretName,
            namespace,
            type: 'Opaque',
            labels: {
              ...(previousSecretSnapshot?.labels ?? {}),
              'clerum.io/managed-by': 'control-api',
            },
            annotations: {
              ...(previousSecretSnapshot?.annotations ?? {}),
              ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
              [REGISTRY_SECRET_OPERATION_ID_ANNOTATION]: operationId,
            },
            ...(previousSecretSnapshot?.data ? { data: previousSecretSnapshot.data } : {}),
            stringData: credentialPayload.secretData,
          }

          try {
            if (previousSecretSnapshot) {
              const updatedSecret = await gateway.updateSecret(
                secretRequest,
                secretPreconditions(previousSecretSnapshot),
                REGISTRY_SECRET_WRITE_OPTIONS
              )
              mutatedSecretSnapshot = updatedSecret
              mutatedSecretIdentityProven = true
              mutatedSecretPreconditions = secretPreconditions(updatedSecret)
              auditLog('secret_updated', {
                secretName,
                namespace,
                registryEntry: body.registryEntryName,
                version: body.registryEntryVersion,
              })
            } else {
              const created = await gateway.createSecret(
                secretRequest,
                REGISTRY_SECRET_WRITE_OPTIONS
              )
              mutatedSecretSnapshot = created
              mutatedSecretIdentityProven = true
              secretCreatedDuringUpgrade = true
              mutatedSecretPreconditions = secretPreconditions(created)
              auditLog('secret_created', {
                secretName,
                namespace,
                registryEntry: body.registryEntryName,
              })
            }
          } catch (err) {
            const k8sErr = extractK8sError(err)
            if (k8sErr && k8sErr.status < 500) {
              res.status(k8sErr.status).json({ error: k8sErr.message })
              return
            }

            const recovered = await readSecretMutationOutcome(gateway, previousSecretSnapshot)
            if (recovered.outcome === 'not-committed') {
              res.status(503).json({
                error: 'registry_secret_outcome_not_committed',
                outcome: 'not_committed',
              })
              return
            }
            if (recovered.outcome !== 'committed' || !recovered.snapshot) {
              log.error(
                {
                  serverName: body.serverName,
                  namespace,
                  secretName,
                  error: registryErrorLogFields(err),
                },
                'Registry credential write outcome is ambiguous'
              )
              res.status(503).json({
                error: 'registry_secret_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }

            if (!recovered.identityProven) {
              // `previousSecretSnapshot === null` means this was a create.
              // A post-error readback has no pre-write UID proof, so returning
              // success would allow an old/replaced object to masquerade as
              // this upgrade's credential commit.
              res.status(503).json({
                error: 'registry_secret_outcome_ambiguous',
                outcome: 'repair_required',
              })
              return
            }

            mutatedSecretSnapshot = recovered.snapshot
            mutatedSecretIdentityProven = recovered.identityProven
            secretCreatedDuringUpgrade = previousSecretSnapshot === null
            mutatedSecretPreconditions = secretPreconditions(recovered.snapshot)
            auditLog('secret_write_recovered_after_ambiguous_response', {
              secretName,
              namespace,
              registryEntry: body.registryEntryName,
            })
          }
        }

        // 5. Update McpServer CRD spec + ownership metadata. catalog-id /
        // catalog-version move to annotations so a version bump refreshes the
        // round-trip key (resourceService.updateResource merges body.metadata
        // .annotations over current). managed-by / server-mode stay labels.
        const upgradeLabels: Record<string, string> = {
          ...(existingServer.metadata?.labels ?? {}),
          'clerum.io/managed-by': 'control-api',
          'clerum.io/server-mode': isLocal ? 'local' : 'remote',
        }
        const upgradeAnnotations: Record<string, string> = {
          ...(existingServer.metadata?.annotations ?? {}),
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          [REGISTRY_OPERATION_ID_ANNOTATION]: operationId,
          [REGISTRY_SPEC_DIGEST_ANNOTATION]: desiredSpecDigest,
        }

        const mutation = await executeRegistryResourceMutation(
          gateway,
          'mcpservers',
          body.serverName,
          namespace,
          {
            metadata: {
              labels: upgradeLabels,
              annotations: upgradeAnnotations,
              ...(beforeRegistrySnapshot.metadata?.uid
                ? { uid: beforeRegistrySnapshot.metadata.uid }
                : {}),
              ...(existingServer.metadata?.resourceVersion
                ? { resourceVersion: existingServer.metadata.resourceVersion }
                : {}),
            },
            spec: updatedSpec,
          },
          beforeRegistrySnapshot,
          {
            spec: updatedSpec,
            metadata: { labels: upgradeLabels, annotations: upgradeAnnotations },
            specDigest: desiredSpecDigest,
          },
          operationId
        )
        if (mutation.outcome !== 'committed') {
          const err = mutation.error
          const k8sErr = extractK8sError(err)
          const outcomeIsAmbiguous = mutation.outcome !== 'rejected'
          const upgradeOutcome: RegistryMutationOutcome | null =
            mutation.outcome === 'rejected' ? null : mutation.outcome

          if (outcomeIsAmbiguous && upgradeOutcome === 'ambiguous') {
            log.error(
              {
                serverName: body.serverName,
                namespace,
                error: registryErrorLogFields(err),
              },
              'Registry upgrade outcome is ambiguous after readback'
            )
            res.status(503).json({
              error: 'registry_upgrade_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }

          // An ambiguous CR response is not made safe for cross-resource
          // compensation merely because the identity fence proves that the
          // requested CR replace did not commit. The live CR may still depend
          // on the Secret, and the failed request may have been accepted by a
          // different apiserver path. Preserve the credential state and make
          // repair explicit until the caller can reconcile both resources.
          if (upgradeOutcome === 'ambiguous' && hasCredentialUpdates) {
            res.status(503).json({
              error: 'registry_upgrade_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }

          if (hasCredentialUpdates && mutatedSecretSnapshot && !mutatedSecretIdentityProven) {
            res.status(503).json({
              error: 'registry_upgrade_outcome_ambiguous',
              outcome: 'repair_required',
            })
            return
          }

          if (upgradeOutcome !== 'ambiguous' && hasCredentialUpdates) {
            try {
              if (!mutatedSecretPreconditions) {
                throw Object.assign(new Error('mutated Secret identity unavailable'), {
                  code: 'secret_identity_unavailable',
                })
              }
              if (secretCreatedDuringUpgrade) {
                const createdSecret = mutatedSecretSnapshot
                if (!createdSecret) {
                  throw Object.assign(new Error('created Secret snapshot unavailable'), {
                    code: 'secret_identity_unavailable',
                  })
                }
                await rollbackCreatedSecret(gateway, createdSecret)
              } else if (previousSecretSnapshot) {
                await gateway.updateSecret(
                  {
                    name: previousSecretSnapshot.name,
                    namespace: previousSecretSnapshot.namespace,
                    type: previousSecretSnapshot.type ?? 'Opaque',
                    labels: previousSecretSnapshot.labels ?? {},
                    annotations: previousSecretSnapshot.annotations ?? {},
                    data: previousSecretSnapshot.data,
                    stringData: previousSecretSnapshot.stringData,
                  },
                  mutatedSecretPreconditions,
                  REGISTRY_SECRET_WRITE_OPTIONS
                )
              }
            } catch (rollbackErr) {
              log.error(
                {
                  serverName: body.serverName,
                  namespace,
                  secretName,
                  rollback: secretCreatedDuringUpgrade ? 'delete-created-secret' : 'restore-secret',
                  error: registryErrorLogFields(rollbackErr),
                },
                'Registry upgrade rollback failed'
              )
              res.status(500).json({
                error: 'registry_upgrade_rollback_incomplete',
                outcome: 'compensation_failed',
              })
              return
            }
          }

          if (upgradeOutcome === 'not-committed') {
            res.status(503).json({
              error: 'registry_upgrade_outcome_not_committed',
              outcome: 'not_committed',
            })
            return
          } else if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          } else {
            throw err
          }
        }
        auditLog('upgrade', {
          serverName: body.serverName,
          registryEntry: body.registryEntryName,
          newVersion: body.registryEntryVersion,
        })

        // 6. Report install for new version
        const correlationId = crypto.randomUUID()
        reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion).catch(
          () => {}
        )
        const pendingCredentials =
          upgradeRequiresCredentials && Object.keys(credentialPayload.secretData).length === 0
            ? await collectMissingMcpEnvSecretPendingCredentials(
                gateway,
                secretName,
                namespace,
                credSchema
              )
            : []

        res.json({
          serverName: body.serverName,
          namespace,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          correlationId,
          upgraded: true,
          labels: upgradeLabels,
          pendingCredentials,
        })
      })
    )
  }

  // ── POST /admin/registry/upgrade-recipe — Upgrade recipe version (spec §9.4) ──
  if (gateway) {
    router.post(
      '/admin/registry/upgrade-recipe',
      asyncHandler(async (req, res) => {
        const body = req.body as {
          recipeName: string
          registryEntryName: string
          registryEntryVersion: string
          inputValues?: Record<string, unknown>
        }

        if (!body.recipeName || !body.registryEntryName || !body.registryEntryVersion) {
          res
            .status(400)
            .json({ error: 'recipeName, registryEntryName, and registryEntryVersion are required' })
          return
        }

        // WorkflowRecipe upgrades target the canonical CRD namespace only.
        // A recipe found elsewhere is invalid placement and should be fixed by
        // recreating it in sandbox-recipes, not by preserving the ambiguity.
        const recipeNamespaces = [config.sandboxNamespace] as const
        let namespace: string | null = null
        let existingRecipe:
          | {
              metadata?: {
                uid?: string
                labels?: Record<string, string>
                annotations?: Record<string, string>
                resourceVersion?: string
              }
              spec?: Record<string, unknown>
            }
          | undefined
        for (const candidate of recipeNamespaces) {
          try {
            existingRecipe = (await gateway.getResource(
              'workflowrecipes',
              body.recipeName,
              candidate
            )) as {
              metadata?: {
                uid?: string
                labels?: Record<string, string>
                annotations?: Record<string, string>
                resourceVersion?: string
              }
              spec?: Record<string, unknown>
            }
            namespace = candidate
            break
          } catch {
            // try next namespace
          }
        }
        if (!namespace || !existingRecipe) {
          res.status(404).json({
            error: `WorkflowRecipe "${body.recipeName}" not found in any known recipe namespace (${recipeNamespaces.join(', ')})`,
          })
          return
        }
        if (!existingRecipe.metadata?.uid || !existingRecipe.metadata.resourceVersion) {
          res.status(503).json({ error: 'registry_resource_identity_unavailable' })
          return
        }
        const beforeRegistrySnapshot = normalizeRegistryResourceSnapshot(
          existingRecipe,
          body.recipeName,
          namespace
        )
        const installedCatalogId = getCatalogId(existingRecipe.metadata)
        if (installedCatalogId && installedCatalogId !== body.registryEntryName) {
          res.status(409).json({
            error: 'recipe_entry_identity_mismatch',
            reason: `WorkflowRecipe "${body.recipeName}" was installed from "${installedCatalogId}", not "${body.registryEntryName}" — uninstall and install to change entry`,
          })
          return
        }

        // 2. Fetch new version from registry
        const entry = await getEntryVersion(body.registryEntryName, body.registryEntryVersion)
        if (entry.entry_type !== 'recipe') {
          res.status(400).json({
            error: `Entry "${body.registryEntryName}" is not a recipe (got: ${entry.entry_type})`,
          })
          return
        }

        // 3. Extract and parse recipe YAML
        const recipeMeta = entry.recipe_meta as { recipeYaml?: string } | null
        if (!recipeMeta?.recipeYaml) {
          res.status(422).json({ error: 'Registry entry has no recipe YAML content' })
          return
        }

        if (recipeMeta.recipeYaml.length > MAX_RECIPE_YAML_SIZE) {
          res
            .status(413)
            .json({ error: `Recipe YAML exceeds ${MAX_RECIPE_YAML_SIZE / 1024}KB limit` })
          return
        }

        let parsed: Record<string, unknown>
        try {
          parsed = parseYaml(recipeMeta.recipeYaml) as Record<string, unknown>
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('YAML parse returned non-object')
          }
        } catch {
          try {
            parsed = JSON.parse(recipeMeta.recipeYaml)
          } catch {
            res
              .status(422)
              .json({ error: 'Failed to parse recipe content (neither valid YAML nor JSON)' })
            return
          }
        }

        const recipeSpec = (parsed.spec ?? parsed) as Record<string, unknown>
        const limitErrors = validateWorkflowRecipeLimits(recipeSpec)
        if (limitErrors.length > 0) {
          res.status(422).json({ errors: limitErrors })
          return
        }
        const egressErrors = await validateWorkflowRecipeEgressPreflight(recipeSpec)
        if (egressErrors.length > 0) {
          res.status(422).json({ errors: egressErrors })
          return
        }
        // Issue #637 — gate cross-recipe Secret ownership on upgrade too.
        const { validateWorkflowRecipeSecretsAndCollectPending } = await import('./recipes.js')
        const workflowSecretResult = await validateWorkflowRecipeSecretsAndCollectPending(
          { metadata: { name: body.recipeName }, spec: recipeSpec },
          gateway,
          { deferMissingWorkflowSecrets: true, includeOauthClientSecrets: true }
        )
        if (workflowSecretResult.errors) {
          res.status(422).json({ errors: workflowSecretResult.errors })
          return
        }
        const pendingCredentials = workflowSecretResult.pendingCredentials

        // 4. Merge inputValues overrides (same pattern as install-recipe)
        if (body.inputValues && recipeSpec.inputContract) {
          const contract = recipeSpec.inputContract as {
            properties?: Record<string, { default?: unknown; type?: string }>
          }
          for (const [key, value] of Object.entries(body.inputValues)) {
            if (!contract.properties?.[key]) continue
            const expected = contract.properties[key].type
            if (expected) {
              const actual = typeof value
              if (expected === 'string' && actual !== 'string') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected string, got ${actual}` })
                return
              }
              if (expected === 'number' && actual !== 'number') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected number, got ${actual}` })
                return
              }
              if (expected === 'boolean' && actual !== 'boolean') {
                res
                  .status(400)
                  .json({ error: `inputValues.${key}: expected boolean, got ${actual}` })
                return
              }
            }
            contract.properties[key].default = value
          }
        }

        // 5. Update WorkflowRecipe CRD. catalog-id / catalog-version move to
        // annotations (org-scoped names are illegal label values); managed-by
        // stays a label. Pass metadata so a version bump refreshes the
        // round-trip annotation (resourceService merges body.metadata).
        const upgradeLabels: Record<string, string> = {
          ...(existingRecipe.metadata?.labels ?? {}),
          'clerum.io/managed-by': 'control-api',
        }
        const upgradeAnnotations: Record<string, string> = {
          ...(existingRecipe.metadata?.annotations ?? {}),
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
        }
        const operationId = crypto.randomUUID()
        const desiredSpecDigest = registrySpecDigest(recipeSpec)
        upgradeAnnotations[REGISTRY_OPERATION_ID_ANNOTATION] = operationId
        upgradeAnnotations[REGISTRY_SPEC_DIGEST_ANNOTATION] = desiredSpecDigest

        // Ensure the platform pull credential before the CRD that will reference it.
        // Keyed on the INCOMING spec: an upgrade is exactly how a recipe moves from a
        // public image to a private one, and without this the new CRD persists and then
        // fails at pull time while the request returns 200.
        if (recipeReferencesPlatformImage(recipeSpec)) {
          try {
            await ensureRegistryPullSecrets(gateway, platformWorkloadNamespaces())
          } catch (err) {
            const mapped = pullSecretErrorResponse(err)
            res.status(mapped.status).json(mapped.body)
            return
          }
        }

        const mutation = await executeRegistryResourceMutation(
          gateway,
          'workflowrecipes',
          body.recipeName,
          namespace,
          {
            metadata: {
              labels: upgradeLabels,
              annotations: upgradeAnnotations,
              uid: existingRecipe.metadata.uid,
              resourceVersion: existingRecipe.metadata.resourceVersion,
            },
            spec: recipeSpec,
          },
          beforeRegistrySnapshot,
          {
            spec: recipeSpec,
            metadata: { labels: upgradeLabels, annotations: upgradeAnnotations },
            specDigest: desiredSpecDigest,
          },
          operationId
        )
        if (mutation.outcome === 'rejected') {
          const k8sErr = extractK8sError(mutation.error)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw mutation.error
        }
        if (mutation.outcome === 'not-committed') {
          res.status(503).json({
            error: 'registry_upgrade_outcome_not_committed',
            outcome: 'not_committed',
          })
          return
        }
        if (mutation.outcome === 'ambiguous') {
          log.error(
            { recipeName: body.recipeName, error: registryErrorLogFields(mutation.error) },
            'Registry recipe upgrade outcome is ambiguous after identity fence'
          )
          res.status(503).json({
            error: 'registry_upgrade_outcome_ambiguous',
            outcome: 'repair_required',
          })
          return
        }
        auditLog('upgrade-recipe', {
          recipeName: body.recipeName,
          registryEntry: body.registryEntryName,
          newVersion: body.registryEntryVersion,
        })

        // 6. Report install for new version
        const correlationId = crypto.randomUUID()
        reportInstall(body.registryEntryName, correlationId, body.registryEntryVersion).catch(
          () => {}
        )

        res.json({
          recipeName: body.recipeName,
          namespace,
          registryEntry: body.registryEntryName,
          registryVersion: body.registryEntryVersion,
          correlationId,
          upgraded: true,
          labels: upgradeLabels,
          pendingCredentials,
        })
      })
    )
  }

  // ── Org-scoped publish API keys (efrk_) — owner-gated, proxied to the registry ──
  const keysRateLimit = rateLimitMiddleware({
    bucketType: 'registry_org_keys',
    maxPerMinute: 30,
    getBucketKey: req => {
      const sub = (req as UiAuthedRequest).adminAuth?.sub
      return sub ? `orgkeys:${sub}` : null
    },
  })

  // Guards ⓪①② — returns null after sending an error response.
  async function prepareKeysRequest(
    req: Request,
    res: Response
  ): Promise<{ admin: AdminUserRecord; orgName: string } | null> {
    let authActive: boolean
    try {
      authActive = await isRegistryAuthActive()
    } catch (err) {
      log.error(
        {
          event: 'isRegistryAuthActive_failed',
          err: registryErrorLogFields(err),
        },
        'registry auth check failed'
      )
      res.status(502).json({ error: 'registry_integration_error' })
      return null
    }
    if (!authActive) {
      res.status(409).json({ error: 'registry_auth_disabled' })
      return null
    }
    if (config.registryConnectionMode === 'self-hosted' && config.registryUrl === '') {
      res.status(409).json({ error: 'registry_url_not_configured' })
      return null
    }
    const sub = (req as UiAuthedRequest).adminAuth?.sub
    const admin = sub ? await findAdminById(sub) : null
    if (!admin || admin.status !== 'active') {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    let orgName: string | null
    try {
      orgName = (await resolvePublishScope()).orgName
      if (!orgName) orgName = (await resolvePublishScope({ force: true })).orgName
    } catch (err) {
      log.error(
        {
          event: 'resolvePublishScope_failed',
          err: registryErrorLogFields(err),
        },
        'publish scope resolution failed'
      )
      res.status(502).json({ error: 'registry_integration_error' })
      return null
    }
    if (!orgName) {
      res.status(409).json({ error: 'no_org' })
      return null
    }
    return { admin, orgName }
  }

  // Maps a thrown RegistryStatusError to a response. 403 is augmented with org;
  // any error carrying a numeric status is responded directly (incl. 5xx, so a
  // 502 integration error is NOT collapsed to 500 by the global handler).
  function handleKeysError(err: unknown, res: Response, next: NextFunction, orgName: string): void {
    const status = (err as { status?: number }).status
    if (status === 403) {
      res.status(403).json({ error: 'forbidden', org: orgName })
      return
    }
    if (typeof status === 'number') {
      res.status(status).json({ error: err instanceof Error ? err.message : 'error' })
      return
    }
    next(err)
  }

  router.get('/admin/registry/keys', keysRateLimit, async (req, res, next) => {
    const ctx = await prepareKeysRequest(req, res)
    if (!ctx) return
    try {
      const { keys } = await listKeys(ctx.admin, ctx.orgName)
      res.json({ org: ctx.orgName, keys })
    } catch (err) {
      handleKeysError(err, res, next, ctx.orgName)
    }
  })

  // Org container images (+ tags) for the Marketplace images area. Same
  // owner-gated org resolution + error mapping as the keys read.
  router.get('/admin/registry/images', keysRateLimit, async (req, res, next) => {
    const ctx = await prepareKeysRequest(req, res)
    if (!ctx) return
    try {
      const { images } = await listImages(ctx.admin, ctx.orgName)
      res.json({ org: ctx.orgName, images })
    } catch (err) {
      handleKeysError(err, res, next, ctx.orgName)
    }
  })

  router.post('/admin/registry/keys', keysRateLimit, async (req, res, next) => {
    const ctx = await prepareKeysRequest(req, res)
    if (!ctx) return
    try {
      const created = await createKey(ctx.admin, ctx.orgName, {
        description: req.body?.description,
        scopes: req.body?.scopes,
        expiresInDays: req.body?.expiresInDays,
      })
      res.status(201).json(created)
    } catch (err) {
      handleKeysError(err, res, next, ctx.orgName)
    }
  })

  router.delete('/admin/registry/keys/:id', keysRateLimit, async (req, res, next) => {
    const ctx = await prepareKeysRequest(req, res)
    if (!ctx) return
    try {
      await revokeKey(ctx.admin, ctx.orgName, req.params.id)
      res.status(204).end()
    } catch (err) {
      handleKeysError(err, res, next, ctx.orgName)
    }
  })

  // ── Cross-org grants + owned entries (org self-service, machine-proxied) ──────
  // Owner-side: an org admin manages pull grants for their OWN published plugins
  // and lists their OWN published entries. Org is the machine client's own scope
  // (resolvePublishScope) — an admin can never act for another org. actingUserId
  // is audit-only (req.adminAuth.sub); it never lands in granted_by_user_id.
  const grantsRateLimit = rateLimitMiddleware({
    bucketType: 'registry_org_grants',
    maxPerMinute: 30,
    getBucketKey: req => {
      const sub = (req as UiAuthedRequest).adminAuth?.sub
      return sub ? `orggrants:${sub}` : null
    },
  })

  // Resolve the caller's own org for a self-service op, or send the terminal error
  // and return null. Guard order: auth-off → missing admin claim → curator/unbound.
  async function resolveSelfServiceOrg(
    req: Request,
    res: Response
  ): Promise<{ orgName: string; actingUserId: string } | null> {
    let authActive: boolean
    try {
      authActive = await isRegistryAuthActive()
    } catch (err) {
      log.error(
        {
          event: 'isRegistryAuthActive_failed',
          err: registryErrorLogFields(err),
        },
        'registry auth check failed'
      )
      res.status(502).json({ error: 'registry_integration_error' })
      return null
    }
    if (!authActive) {
      res.status(409).json({ error: 'registry_auth_disabled' })
      return null
    }
    if (config.registryConnectionMode === 'self-hosted' && config.registryUrl === '') {
      res.status(409).json({ error: 'registry_url_not_configured' })
      return null
    }
    const actingUserId = (req as UiAuthedRequest).adminAuth?.sub
    if (!actingUserId) {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    let scope
    try {
      scope = await resolvePublishScope()
      // A module-cached null org from a cold start (control-api booted before the
      // registry bound its client to an org) would otherwise 400 self-service forever;
      // force one refresh before failing closed, mirroring prepareKeysRequest.
      if (!scope.curator && !scope.orgName) {
        scope = await resolvePublishScope({ force: true })
      }
    } catch (err) {
      log.error(
        {
          event: 'resolvePublishScope_failed',
          err: registryErrorLogFields(err),
        },
        'publish scope resolution failed'
      )
      res.status(502).json({ error: 'registry_integration_error' })
      return null
    }
    // Curator / org-unbound deploys have no owner org — fail closed with a
    // deliberate 400 and never interpolate null into /org/:org/....
    if (scope.curator || !scope.orgName) {
      res.status(400).json({ error: 'registry_self_service_unavailable' })
      return null
    }
    return { orgName: scope.orgName, actingUserId }
  }

  // Forwards a RegistryProxyError verbatim (upstream status + {error:<code>} body)
  // so the UI can render typed codes inline; anything else bubbles to the global
  // handler. Same typed-error→status+body contract as
  // routes/admin/workflows/grants.routes.ts (which inlines it per-catch);
  // extracted here as a shared helper.
  function handleRegistryProxyError(err: unknown, res: Response, next: NextFunction): void {
    // RegistryProxyError carries the upstream status + { error:<code> } body verbatim so
    // the UI can render typed codes inline (a persistent upstream 401 is already remapped
    // to 502 at the transport in orgRegistryFetch). Anything else bubbles to the global handler.
    if (err instanceof RegistryProxyError) {
      res.status(err.status).json(err.body)
      return
    }
    next(err)
  }

  // Coerce a pagination query param to a finite number, or undefined for a
  // missing/non-numeric value (never forward NaN to the registry).
  const toPageNum = (v: unknown): number | undefined => {
    if (v == null || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }

  router.post('/admin/registry/grants', grantsRateLimit, async (req, res, next) => {
    const ctx = await resolveSelfServiceOrg(req, res)
    if (!ctx) return
    const pluginName = req.body?.pluginName
    const granteeOrg = req.body?.granteeOrg
    if (
      typeof pluginName !== 'string' ||
      !pluginName ||
      typeof granteeOrg !== 'string' ||
      !granteeOrg
    ) {
      res.status(400).json({ error: 'missing_fields' })
      return
    }
    try {
      const created = await createOrgGrant(ctx.orgName, {
        pluginName,
        granteeOrg,
        actingUserId: ctx.actingUserId,
      })
      res.status(201).json(created ?? {})
    } catch (err) {
      handleRegistryProxyError(err, res, next)
    }
  })

  // Registry returns { grants: OrgGrant[] } (sub-project-1 contract); forwarded
  // verbatim, coalesced to { grants: [] } on an (contract-violating) empty body
  // so control-ui's res.json() never sees an empty payload.
  router.get('/admin/registry/grants', grantsRateLimit, async (req, res, next) => {
    const ctx = await resolveSelfServiceOrg(req, res)
    if (!ctx) return
    try {
      // Guard against a registry contract violation: the documented list-GET
      // contract always returns a body, but coalesce undefined anyway so
      // res.json(undefined) never sends a body-less 200 control-ui can't parse.
      res.status(200).json((await listOrgGrants(ctx.orgName)) ?? { grants: [] })
    } catch (err) {
      handleRegistryProxyError(err, res, next)
    }
  })

  router.delete('/admin/registry/grants/:id', grantsRateLimit, async (req, res, next) => {
    const ctx = await resolveSelfServiceOrg(req, res)
    if (!ctx) return
    try {
      await revokeOrgGrant(ctx.orgName, req.params.id, ctx.actingUserId)
      res.status(204).end()
    } catch (err) {
      handleRegistryProxyError(err, res, next)
    }
  })

  // Registry returns { grants: GrantedToMeItem[] } (sub-project-1 contract);
  // forwarded verbatim, coalesced to { grants: [] } on an (contract-violating)
  // empty body so control-ui's res.json() never sees an empty payload.
  router.get('/admin/registry/granted-to-me', grantsRateLimit, async (req, res, next) => {
    const ctx = await resolveSelfServiceOrg(req, res)
    if (!ctx) return
    try {
      // See the /admin/registry/grants comment above: defensive coalescing
      // against a registry contract violation on this list-GET.
      res.status(200).json((await listGrantedToMe(ctx.orgName)) ?? { grants: [] })
    } catch (err) {
      handleRegistryProxyError(err, res, next)
    }
  })

  // Owner's OWN published entries. Mounted at /owned-entries (not /entries — that
  // path is the public catalog search above). The registry's /org/:org/entries
  // returns { entries: OwnedRegistryEntry[] } (its real wire shape), but every
  // control-ui consumer reads response.data. Normalize the list to { data } —
  // accepting either the registry's `entries` key or a `data` key — and coalesce
  // an empty/absent body to { data: [] }, so control-ui never receives an
  // undefined array (which crashes OwnedEntries on `entries.length`).
  router.get('/admin/registry/owned-entries', grantsRateLimit, async (req, res, next) => {
    const ctx = await resolveSelfServiceOrg(req, res)
    if (!ctx) return
    try {
      const limit = toPageNum(req.query.limit)
      const offset = toPageNum(req.query.offset)
      const raw = (await listOrgEntries(ctx.orgName, { limit, offset })) as
        | { data?: unknown[]; entries?: unknown[]; meta?: unknown }
        | null
        | undefined
      const data = raw?.data ?? raw?.entries ?? []
      res.status(200).json(raw?.meta !== undefined ? { data, meta: raw.meta } : { data })
    } catch (err) {
      handleRegistryProxyError(err, res, next)
    }
  })

  return router
}
