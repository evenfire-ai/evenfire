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
import { type AdminUserRecord, findAdminById } from '../../services/adminAuthService.js'
import { listHostsReferencingHook, syncHookRefsInHosts } from '../../services/hostGuardrailRefs.js'
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
  ensureRegistryPullSecret,
  ensureRegistryPullSecrets,
  platformWorkloadNamespaces,
} from '../../services/registryPullSecretService.js'
import {
  validateWorkflowRecipeEgressPreflight,
  validateWorkflowRecipeLimits,
} from '../../services/workflowRecipeLimits.js'
import { SecretUpsertRequest } from '../../types.js'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  shouldAttachEvenfirePullSecret,
} from './registryImagePullSecret.js'
import { checkEvenfireImageRefMatchesEntry } from './registryImageRefIdentity.js'
import {
  pullSecretErrorResponse,
  recipeReferencesPlatformImage,
} from './registryPullSecretProvisioning.js'

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
const INHERENTLY_CONTENT_POINTS = new Set(['moderate', 'postCallSuccess', 'onError'])

/**
 * §8.4/§8.7 — does this hook receive message/response CONTENT at any of its
 * lifecycle points? moderate/postCallSuccess/onError always do; preCall does
 * unless it explicitly declared `contentAccess: metadata` (mcp-host's projection
 * enforces the same rule, so the gate and the runtime agree — the two land
 * together, §12.4). Absent contentAccess ⇒ content-bearing (conservative).
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
type HostShape = { spec?: { guardrails?: HostGuardrailsShape } & Record<string, unknown> }

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

type SecretSnapshot = {
  name: string
  namespace: string
  type?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  data?: Record<string, string>
  stringData?: Record<string, string>
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

function validateProvidedCredentialPayload(
  schema: RegistryCredentialSchema,
  credentials: RegistryInstallRequest['credentials']
): CredentialPayloadValidation {
  const requiredKeys = schema.keys?.map(k => k.name) ?? []
  if (!schema.required || requiredKeys.length === 0) return { ok: true, secretData: {} }
  if (credentials === undefined || credentials === null) return { ok: true, secretData: {} }
  if (typeof credentials !== 'object' || Array.isArray(credentials)) {
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
  console.log(`[AUDIT] ${JSON.stringify(safe)}`)
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

  for (let attempt = 1; attempt <= UPDATE_CONFLICT_RETRY_ATTEMPTS; attempt += 1) {
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

function normalizeSecretSnapshot(
  raw: unknown,
  fallbackName: string,
  fallbackNamespace: string
): SecretSnapshot {
  const obj = (raw ?? {}) as {
    metadata?: {
      name?: string
      namespace?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
    type?: unknown
    data?: unknown
    stringData?: unknown
  }

  return {
    name:
      typeof obj.metadata?.name === 'string' && obj.metadata.name.trim()
        ? obj.metadata.name
        : fallbackName,
    namespace:
      typeof obj.metadata?.namespace === 'string' && obj.metadata.namespace.trim()
        ? obj.metadata.namespace
        : fallbackNamespace,
    ...(typeof obj.type === 'string' ? { type: obj.type } : {}),
    ...(obj.metadata?.labels && typeof obj.metadata.labels === 'object'
      ? { labels: obj.metadata.labels }
      : {}),
    ...(obj.metadata?.annotations && typeof obj.metadata.annotations === 'object'
      ? { annotations: obj.metadata.annotations }
      : {}),
    ...(obj.data && typeof obj.data === 'object'
      ? { data: obj.data as Record<string, string> }
      : {}),
    ...(obj.stringData && typeof obj.stringData === 'object'
      ? { stringData: obj.stringData as Record<string, string> }
      : {}),
  }
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
        const registryAnnotations: Record<string, string> = catalogAnnotations(
          body.registryEntryName,
          body.registryEntryVersion
        )

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
        let secretCreated = false
        if (credRequired) {
          const secretData = credentialPayload.secretData
          if (Object.keys(secretData).length > 0) {
            const secretReq: SecretUpsertRequest = {
              name: secretName,
              namespace: targetNs,
              type: 'Opaque',
              labels: registryLabels,
              annotations: registryAnnotations,
              stringData: secretData,
            }
            try {
              await gateway.createSecret(secretReq)
            } catch (err) {
              const k8sErr = extractK8sError(err)
              if (k8sErr) {
                res
                  .status(k8sErr.status)
                  .json({ error: `Secret creation failed: ${k8sErr.message}` })
                return
              }
              throw err
            }
            secretCreated = true
            auditLog('secret_created', {
              secretName,
              namespace: targetNs,
              registryEntry: body.registryEntryName,
              credentialKeys: Object.keys(secretData),
            })
          }
        }

        // ── Step 4: Create McpServer CRD (rollback Secret on failure) ─────
        try {
          await gateway.createResource(
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
        } catch (err) {
          // Rollback: delete the Secret if we created one
          if (secretCreated) {
            try {
              await gateway.deleteSecret(secretName, targetNs)
            } catch {
              // Best-effort rollback; log but do not mask the original error
            }
          }
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw err
        }

        // ── Step 5: Update Context allowlist ──────────────────────────────
        // The Context allowlist is authoritative for host discovery. If this
        // step fails, the McpServer exists but is unreachable, so the install
        // must roll back rather than return a false success.
        try {
          const ctx = (await gateway.getResource('contexts', contextRef)) as {
            spec?: Record<string, unknown> & {
              contextId?: string
              description?: string
              mcpServers?: string[]
            }
          }
          const existing: string[] = ctx.spec?.mcpServers ?? []
          if (!existing.includes(serverName)) {
            await gateway.updateResource('contexts', contextRef, {
              spec: {
                ...ctx.spec,
                contextId: ctx.spec?.contextId ?? contextRef,
                mcpServers: [...existing, serverName],
              } as Record<string, unknown>,
            })
          }
        } catch (err) {
          try {
            await gateway.deleteResource('mcpservers', serverName, targetNs)
            await waitForDeletion(
              () => gateway.getResource('mcpservers', serverName, targetNs),
              `McpServer/${serverName}`
            )
          } catch {
            // Best-effort rollback; preserve the original context-update error.
          }
          if (secretCreated) {
            try {
              await gateway.deleteSecret(secretName, targetNs)
              await waitForDeletion(
                () => gateway.getSecret(secretName, targetNs),
                `Secret/${secretName}`
              )
            } catch {
              // Best-effort rollback; preserve the original context-update error.
            }
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
        try {
          host = (await gateway.getResource(
            'hosts',
            body.hostRef,
            config.hostsNamespace
          )) as HostShape
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
          if (!/@sha256:[0-9a-f]{64}$/.test(image.ref ?? '')) {
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
        const registryAnnotations: Record<string, string> = {
          ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
          // §8.4 stamp — platform-assigned, author cannot set it.
          'clerum.io/trust-level': trustLevel,
        }

        // Step 8 — credential Secret from the hook's credentialSchema.
        const credSchema = (await getCredentialSchema(
          body.registryEntryName,
          body.registryEntryVersion
        ).catch(() => null)) as RegistryCredentialSchema | null
        const credRequired = !!credSchema?.required
        const credentials = body.credentials ?? {}
        const secretName = `${crName}-creds`
        let secretCreated = false
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
            await gateway.createSecret({
              name: secretName,
              namespace: targetNs,
              type: 'Opaque',
              labels: registryLabels,
              annotations: registryAnnotations,
              stringData: credentials,
            })
          } catch (err) {
            const k8sErr = extractK8sError(err)
            if (k8sErr) {
              res.status(k8sErr.status).json({ error: `Secret creation failed: ${k8sErr.message}` })
              return
            }
            throw err
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
            if (secretCreated) {
              await gateway.deleteSecret(secretName, targetNs).catch(() => {})
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

        try {
          await gateway.createResource(
            'llmhooks',
            {
              metadata: { name: crName, labels: registryLabels, annotations: registryAnnotations },
              spec: hookSpec,
            },
            targetNs
          )
        } catch (err) {
          if (secretCreated) {
            await gateway.deleteSecret(secretName, targetNs).catch(() => {})
          }
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw err
        }

        // Step 10 — reference the hook from Host.spec.guardrails.hooks[phase] as
        // {id, digest}. If this fails the hook exists but no Host runs it, so roll
        // the CR (+ Secret) back rather than return a false success.
        const digest = image?.ref?.includes('@') ? image.ref.split('@')[1] : undefined
        try {
          const freshHost = (await gateway.getResource(
            'hosts',
            body.hostRef,
            config.hostsNamespace
          )) as HostShape
          const g: HostGuardrailsShape = { ...(freshHost.spec?.guardrails ?? {}) }
          const hooks: Record<string, Array<{ id: string; digest?: string }>> = {
            ...(g.hooks ?? {}),
          }
          for (const phase of hookMeta.lifecyclePoints) {
            const arr = hooks[phase] ? [...hooks[phase]] : []
            if (!arr.some(h => h.id === crName)) {
              arr.push({ id: crName, ...(digest ? { digest } : {}) })
            }
            hooks[phase] = arr
          }
          g.hooks = hooks
          await gateway.updateResource(
            'hosts',
            body.hostRef,
            { spec: { ...freshHost.spec, guardrails: g } },
            config.hostsNamespace
          )
        } catch (err) {
          try {
            await gateway.deleteResource('llmhooks', crName, targetNs)
            await waitForDeletion(
              () => gateway.getResource('llmhooks', crName, targetNs),
              `LlmHook/${crName}`
            )
          } catch {
            // Best-effort rollback; preserve the original Host-update error.
          }
          if (secretCreated) {
            try {
              await gateway.deleteSecret(secretName, targetNs)
              await waitForDeletion(
                () => gateway.getSecret(secretName, targetNs),
                `Secret/${secretName}`
              )
            } catch {
              // Best-effort rollback; preserve the original Host-update error.
            }
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
          metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> }
        }
        try {
          current = (await gateway.getResource('llmhooks', body.hookName, llmHooksNs)) as {
            spec?: Record<string, unknown>
            metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> }
          }
        } catch (err) {
          res.status(404).json({
            error: `LlmHook "${body.hookName}" not found: ${err instanceof Error ? err.message : 'not found'}`,
          })
          return
        }

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
          // Anchored, and take the LAST @-segment: an unanchored test plus
          // split('@')[1] pinned "bar" for a ref like `repo@bar@sha256:…`.
          if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(newImage.ref ?? '')) {
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
          newDigest = newImage.ref?.includes('@') ? newImage.ref.split('@').pop() : undefined
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
        try {
          await updateResourceWithConflictRetry(
            gateway,
            'llmhooks',
            body.hookName,
            {
              metadata: {
                annotations: {
                  ...catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
                  'clerum.io/trust-level': trustLevel,
                },
              },
              spec: upgradedSpec,
            },
            llmHooksNs
          )
        } catch (err) {
          // A CEL rejection (e.g. a contentAccess/lifecyclePoint conflict) surfaced
          // as an unmapped 500; install maps these.
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw err
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
          console.error(`[Admin] upgrade-hook "${body.hookName}": Host ref sync failed:`, err)
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
            await gateway.deleteResource('workflowrecipes', resourceName, namespace)
            await waitForDeletion(
              () => gateway.getResource('workflowrecipes', resourceName, namespace),
              `WorkflowRecipe/${resourceName}`
            )
            deleted.push(`WorkflowRecipe/${resourceName}`)
          } catch (err) {
            warnings.push(
              `WorkflowRecipe/${resourceName}: ${err instanceof Error ? err.message : 'not found'}`
            )
          }
        } else {
          // Uninstall MCP Server
          try {
            await gateway.deleteResource('mcpservers', resourceName, namespace)
            await waitForDeletion(
              () => gateway.getResource('mcpservers', resourceName, namespace),
              `McpServer/${resourceName}`
            )
            deleted.push(`McpServer/${resourceName}`)
          } catch (err) {
            warnings.push(
              `McpServer/${resourceName}: ${err instanceof Error ? err.message : 'not found'}`
            )
          }

          // Delete credential Secret
          try {
            await gateway.deleteSecret(`${resourceName}-credentials`, namespace)
            await waitForDeletion(
              () => gateway.getSecret(`${resourceName}-credentials`, namespace),
              `Secret/${resourceName}-credentials`
            )
            deleted.push(`Secret/${resourceName}-credentials`)
          } catch {
            // Secret may not exist (no credentials)
          }

          // Remove from Context allowlists
          try {
            const ctxList = (await gateway.listResource('contexts', namespace)) as Array<{
              metadata?: { name?: string }
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
                await gateway.updateResource(
                  'contexts',
                  name,
                  {
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
          } catch {
            warnings.push('Failed to update Context allowlists')
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
        let existingServer: Record<string, unknown>
        try {
          existingServer = (await gateway.getResource(
            'mcpservers',
            body.serverName,
            namespace
          )) as Record<string, unknown>
        } catch {
          res.status(404).json({ error: `McpServer "${body.serverName}" not found` })
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
        const existingSpec = (existingServer as { spec?: Record<string, unknown> }).spec ?? {}
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
        let previousSecretSnapshot: SecretSnapshot | null = null
        let secretCreatedDuringUpgrade = false
        if (Object.keys(credentialPayload.secretData).length > 0) {
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

          const secretRequest: SecretUpsertRequest = {
            name: secretName,
            namespace,
            type: 'Opaque',
            labels: {
              'clerum.io/managed-by': 'control-api',
            },
            annotations: catalogAnnotations(body.registryEntryName, body.registryEntryVersion),
            stringData: credentialPayload.secretData,
          }

          if (previousSecretSnapshot) {
            await gateway.updateSecret(secretRequest)
            auditLog('secret_updated', {
              secretName,
              namespace,
              registryEntry: body.registryEntryName,
              version: body.registryEntryVersion,
            })
          } else {
            await gateway.createSecret(secretRequest)
            secretCreatedDuringUpgrade = true
            auditLog('secret_created', {
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
          'clerum.io/managed-by': 'control-api',
          'clerum.io/server-mode': isLocal ? 'local' : 'remote',
        }
        const upgradeAnnotations: Record<string, string> = catalogAnnotations(
          body.registryEntryName,
          body.registryEntryVersion
        )

        try {
          await updateResourceWithConflictRetry(
            gateway,
            'mcpservers',
            body.serverName,
            {
              metadata: { labels: upgradeLabels, annotations: upgradeAnnotations },
              spec: updatedSpec,
            },
            namespace
          )
        } catch (err) {
          if (body.credentials && Object.keys(body.credentials).length > 0) {
            try {
              if (secretCreatedDuringUpgrade) {
                await gateway.deleteSecret(secretName, namespace)
                await waitForDeletion(
                  () => gateway.getSecret(secretName, namespace),
                  `Secret/${secretName}`
                )
              } else if (previousSecretSnapshot) {
                await gateway.updateSecret({
                  name: previousSecretSnapshot.name,
                  namespace: previousSecretSnapshot.namespace,
                  type: previousSecretSnapshot.type || 'Opaque',
                  labels: previousSecretSnapshot.labels,
                  annotations: previousSecretSnapshot.annotations,
                  data: previousSecretSnapshot.data,
                  stringData: previousSecretSnapshot.stringData,
                })
              }
            } catch {
              // Best-effort rollback; preserve the original upgrade error.
            }
          }
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: k8sErr.message })
            return
          }
          throw err
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
        for (const candidate of recipeNamespaces) {
          try {
            await gateway.getResource('workflowrecipes', body.recipeName, candidate)
            namespace = candidate
            break
          } catch {
            // try next namespace
          }
        }
        if (!namespace) {
          res.status(404).json({
            error: `WorkflowRecipe "${body.recipeName}" not found in any known recipe namespace (${recipeNamespaces.join(', ')})`,
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
          'clerum.io/managed-by': 'control-api',
        }
        const upgradeAnnotations: Record<string, string> = catalogAnnotations(
          body.registryEntryName,
          body.registryEntryVersion
        )

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

        await updateResourceWithConflictRetry(
          gateway,
          'workflowrecipes',
          body.recipeName,
          {
            metadata: { labels: upgradeLabels, annotations: upgradeAnnotations },
            spec: recipeSpec,
          },
          namespace
        )
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
