/**
 * Integration: platform image-pull credential — runtime acceptance
 *
 * This is the acceptance gate for PR #243 §13.5
 * (`docs/architecture/registry-pull-secret-recipe-workloads.md`). Everything else covering
 * this feature is unit- or route-level against a `MockGateway`, which by construction
 * cannot detect a namespace mistake, a rollout that never happens, or a kubelet that
 * rejects the blob. This suite runs the whole chain against a LIVE cluster and a LIVE
 * private registry:
 *
 *   control-api mint  ->  Secret in every platform workload namespace
 *                     ->  WRC / control-api inject the reference
 *                     ->  McpServer CRD -> HCC -> Deployment
 *                     ->  Pod Ready
 *                     ->  a real `docker pull` of a private image using that credential
 *
 * What each block proves, and why it is here:
 *
 *  1. `Secret placement` — the Secret exists in EVERY platform workload namespace, is
 *     `kubernetes.io/dockerconfigjson` (the only two types a kubelet honours for pulls),
 *     is labelled ours, is keyed on OUR registry host, and — the load-bearing one — every
 *     copy carries the SAME fingerprint. The registry's `mintPullKey` is rotate-on-call
 *     with at most one active pull key per org, so three separate mints would leave the
 *     first two namespaces holding revoked credentials while reporting success. One
 *     fingerprint across all copies is the observable form of "one mint, fanned out"
 *     (spec §6.3 / R1). It also asserts the Secret is NOT labelled `clerum.io/shared` or
 *     `clerum.io/owner-recipe` — labelling it either way would make it readable by any
 *     recipe's `envSecret` and turn a pull-only credential into an exfiltration primitive
 *     (spec §5.1 / R4).
 *
 *  2. `Materialization` — WRC renders the recipe workload's PodTemplate with
 *     `imagePullSecrets: [evenfire-registry-pull]`, while the WorkflowRecipe CRD itself
 *     never declares it. That gap is the whole design: a declared name would be classified
 *     by the Issue #637 ownership gate and stripped, so the reference has to be injected
 *     after the filter (spec §6.1). For the MCP-server path the same assertion runs one
 *     hop further out — control-api writes it onto the McpServer CRD and HCC materializes
 *     it verbatim onto the Deployment it owns.
 *
 *  3. `Pod readiness + a REAL private pull` — the image is evicted from the node's docker
 *     cache first. Without that the kubelet reuses the cached layers under
 *     `imagePullPolicy: IfNotPresent`, no credential is ever exercised, and the assertion
 *     passes vacuously. The two outcomes are distinguishable in the `Pulled` event: a
 *     genuine pull logs `Successfully pulled image ... in Xs. Image size: N bytes.`, a
 *     cache hit logs `Container image ... already present on machine`. This asserts the
 *     former and explicitly rejects the latter.
 *
 *  4. `Pre-persistence failure` — a provisioning failure must fail the install BEFORE the
 *     CRD is written. The alternative is the exact silent `ImagePullBackOff` this whole
 *     mechanism exists to remove: a 201 on the API call and a workload that can never
 *     pull.
 *
 * Deliberately NOT covered here — see the docs for why:
 *  - The periodic reconcile cron (§13.1). Its interval is
 *    `REGISTRY_PULL_SECRET_RECONCILE_INTERVAL_MS` (default 600_000) and shortening it
 *    needs a redeploy, so a committed E2E cannot wait for a tick. Verified out-of-band.
 *  - Managed-cluster behaviour (§9.1). control-api writes nothing there by design, so
 *    there is no runtime outcome for this suite to observe.
 *
 * Requires (each guarded — the suite SKIPS rather than fails when unavailable):
 *   - minikube cluster `clerum-test` running, kubectl context reachable
 *   - control-api port-forwarded on :8090   (make minikube-pf-control-ui)
 *   - admin credentials via TEST_ADMIN_PASSWORD (or ADMIN_PASSWORD)
 *   - REGISTRY_CONNECTION_MODE=self-hosted with a connected registry org
 *   - the private registry entries named below installable by this deployment
 *
 * Everything this suite creates is prefixed `e2e-pullsecret-` and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { KUBE_CONTEXT, kubectl, sleep } from '../helpers.js'
import { CONTROL_API_URL, fetchJson, isServiceUp } from './helpers.integration.js'

// ─── Contract constants (must match the shipped implementation) ──────────────

/** `EVENFIRE_REGISTRY_PULL_SECRET_NAME` in packages/workflow-runtime-core. */
const PULL_SECRET = 'evenfire-registry-pull'
const MANAGED_BY_LABEL = 'clerum.io/managed-by'
const MANAGED_BY_VALUE = 'control-api'
const FINGERPRINT_ANNOTATION = 'clerum.io/pull-key-fingerprint'
const DOCKERCONFIG_TYPE = 'kubernetes.io/dockerconfigjson'
const DOCKERCONFIG_KEY = '.dockerconfigjson'

// ─── Cluster shape ──────────────────────────────────────────────────────────

const MCP_SERVERS_NS = safeToken(process.env.E2E_MCP_SERVERS_NAMESPACE ?? 'mcp-server', 'ns')
const SANDBOX_NS = safeToken(process.env.E2E_SANDBOX_NAMESPACE ?? 'sandbox-recipes', 'ns')
const SANDBOX_UI_NS = safeToken(process.env.E2E_SANDBOX_UI_NAMESPACE ?? 'sandbox-ui', 'ns')
const CONTROL_PLANE_NS = safeToken(process.env.E2E_CONTROL_PLANE_NAMESPACE ?? 'control-plane', 'ns')
/** `platformWorkloadNamespaces()` in control-api/src/services/registryPullSecretService.ts. */
const PLATFORM_NAMESPACES = [...new Set([MCP_SERVERS_NS, SANDBOX_NS, SANDBOX_UI_NS])]

const MINIKUBE_PROFILE = safeToken(process.env.MINIKUBE_PROFILE ?? KUBE_CONTEXT, 'MINIKUBE_PROFILE')

// ─── Fixtures (private, platform-registry-hosted) ───────────────────────────

// Sanitized even though these currently reach only HTTP bodies: the charset already covers
// scoped entry names and semver, so it costs nothing and stops a future use site from
// quietly reopening the taint path into a command line.
const RECIPE_ENTRY = safeToken(
  process.env.E2E_PRIVATE_RECIPE_ENTRY ?? '@josete-pr243/pr243-registry-recipe',
  'E2E_PRIVATE_RECIPE_ENTRY'
)
const RECIPE_ENTRY_VERSION = safeToken(
  process.env.E2E_PRIVATE_RECIPE_VERSION ?? '1.0.0',
  'E2E_PRIVATE_RECIPE_VERSION'
)
const MCP_ENTRY = safeToken(
  process.env.E2E_PRIVATE_MCP_ENTRY ?? '@josete-pr243/test-docgen',
  'E2E_PRIVATE_MCP_ENTRY'
)
const MCP_ENTRY_VERSION = safeToken(
  process.env.E2E_PRIVATE_MCP_VERSION ?? '1.0.5',
  'E2E_PRIVATE_MCP_VERSION'
)
const CONTEXT_REF = safeToken(process.env.E2E_CONTEXT_ID ?? 'context1', 'E2E_CONTEXT_ID')

const RUN_ID = Date.now().toString(36)
const RECIPE_NAME = `e2e-pullsecret-recipe-${RUN_ID}`
const MCP_NAME = `e2e-pullsecret-mcp-${RUN_ID}`
const PREPERSIST_RECIPE_NAME = `e2e-pullsecret-prepersist-${RUN_ID}`

// ─── State resolved in beforeAll ────────────────────────────────────────────

let controlApiUp = false
let clusterUp = false
let adminCookie = ''
/** Image host of the configured registry, e.g. `registry.evenfire.ai`. */
let registryHost = ''
let selfHosted = false
/** Both private fixtures are present in this deployment's catalog. */
let fixturesAvailable = false
/** Set once the recipe install returns 201, so downstream blocks can bail cleanly. */
let recipeInstalled = false
let mcpInstalled = false
/** Image of the MCP-server fixture, read from the catalog entry (not string-built). */
let mcpImage = ''
/** True only when the node's docker cache was actually made cold before the MCP install. */
let nodeWasCold = false

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Reject anything that is not a plain Kubernetes/OCI-shaped token before it reaches a
 * command line.
 *
 * Every interpolated value here comes from either `process.env` or the registry catalog —
 * both untrusted as far as CodeQL (and a careful reader) is concerned, since a crafted
 * image ref or namespace would otherwise be able to inject shell. The charset is the union
 * of what DNS-1123 names, namespaces and image references legitimately need; anything else
 * is a bug or an attack, and throwing is correct for both.
 */
function safeToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new Error(
      `[pull-secret-runtime] refusing to use ${label}=${JSON.stringify(value)} in a command: ` +
        'only [A-Za-z0-9._@:/-] is allowed'
    )
  }
  return value
}

/** kubectl that returns null instead of throwing (for existence probes). */
function kubectlOrNull(args: string): string | null {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

function kubectlJson<T = Record<string, unknown>>(args: string): T | null {
  const out = kubectlOrNull(`${args} -o json`)
  if (!out) return null
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

/**
 * Run a command inside the minikube node VM. Returns null on failure.
 *
 * `execFileSync` with an argv array, NOT `execSync` with a template string: there is no
 * local shell to inject into, so the profile name and the command cannot break out of
 * their argument positions. The command itself is still interpreted by the node's shell
 * over ssh, which is why every value interpolated into it passes `safeToken` first.
 */
function nodeExec(command: string): string | null {
  try {
    return execFileSync(
      'minikube',
      ['-p', safeToken(MINIKUBE_PROFILE, 'MINIKUBE_PROFILE'), 'ssh', '--', command],
      { encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    return null
  }
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 3_000
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  let last: T | null = null
  while (Date.now() < deadline) {
    last = await probe()
    if (predicate(last)) return last
    await sleep(intervalMs)
  }
  return predicate(last as T) ? last : null
}

type K8sSecret = {
  type?: string
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
  data?: Record<string, string>
}

function readPullSecret(namespace: string): K8sSecret | null {
  return kubectlJson<K8sSecret>(`get secret ${PULL_SECRET} -n ${namespace}`)
}

/** Hosts the dockerconfigjson blob carries credentials for. */
function authHosts(secret: K8sSecret): string[] {
  const blob = secret.data?.[DOCKERCONFIG_KEY]
  if (!blob) return []
  try {
    const parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
      auths?: Record<string, unknown>
    }
    return Object.keys(parsed.auths ?? {})
  } catch {
    return []
  }
}

type PodTemplateHolder = {
  spec?: {
    template?: {
      spec?: {
        imagePullSecrets?: Array<{ name?: string }>
        containers?: Array<{ image?: string }>
      }
    }
  }
  metadata?: { labels?: Record<string, string> }
}

function pullSecretNamesOnDeployment(name: string, namespace: string): string[] | null {
  const dep = kubectlJson<PodTemplateHolder>(`get deployment ${name} -n ${namespace}`)
  if (!dep) return null
  return (dep.spec?.template?.spec?.imagePullSecrets ?? []).map(r => r.name ?? '')
}

/** POST/DELETE against control-api with the admin session cookie. */
async function adminRequest<T = Record<string, unknown>>(
  method: 'POST' | 'DELETE' | 'GET',
  path: string,
  body?: unknown
): Promise<{ status: number; data: T }> {
  return fetchJson<T>(`${CONTROL_API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(adminCookie ? { Cookie: adminCookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Admin login. The session is delivered as a `Secure` HttpOnly cookie, not a bearer
 * token, so the cookie pair has to be captured and replayed explicitly — `Secure` is
 * advisory on the wire and the port-forward is plain HTTP.
 */
async function login(): Promise<string> {
  const username = process.env.TEST_ADMIN_USERNAME ?? 'admin'
  const password = process.env.TEST_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? ''
  if (!password) return ''
  try {
    const res = await fetch(`${CONTROL_API_URL}/api/v1/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status !== 200) return ''
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? '']
    return raw
      .filter(Boolean)
      .map(c => c.split(';')[0].trim())
      .join('; ')
  } catch {
    return ''
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Find the `Pulled` event for `pod` that mentions `image`. */
function pulledEventMessage(pod: string, namespace: string, image: string): string | null {
  const events = kubectlJson<{ items?: Array<{ message?: string }> }>(
    `get events -n ${namespace} --field-selector involvedObject.name=${pod},reason=Pulled`
  )
  const match = (events?.items ?? []).find(e => (e.message ?? '').includes(image))
  return match?.message ?? null
}

function podsFor(
  labelSelector: string,
  namespace: string
): Array<{
  name: string
  ready: boolean
  phase: string
  images: string[]
}> {
  const list = kubectlJson<{
    items?: Array<{
      metadata?: { name?: string }
      spec?: { containers?: Array<{ image?: string }> }
      status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> }
    }>
  }>(`get pods -n ${namespace} -l ${labelSelector}`)
  return (list?.items ?? []).map(p => ({
    name: p.metadata?.name ?? '',
    phase: p.status?.phase ?? 'Unknown',
    ready:
      (p.status?.containerStatuses ?? []).length > 0 &&
      (p.status?.containerStatuses ?? []).every(c => c.ready === true),
    // The image the kubelet was actually told to run. Readiness alone cannot tell a pod
    // running the PRIVATE image from one running a public or stale one, so a suite that
    // asserts only Ready can go green without the pull credential ever mattering.
    images: (p.spec?.containers ?? []).map(c => c.image ?? ''),
  }))
}

// ─── Precondition handling: skip locally, FAIL in CI ────────────────────────

/**
 * Set by CI (and by anyone who wants the strict behaviour locally).
 *
 * This suite exists because green unit tests could not detect namespace, rollout or
 * kubelet failures. A suite that silently skips has exactly that defect in a worse form:
 * it reports "14 passed" in 250ms while proving nothing, and the wall of ticks looks like
 * evidence. Observed for real twice while validating this file — once with
 * TEST_ADMIN_PASSWORD unset, once with the port-forward down.
 *
 * So: locally an unwired harness is a normal state and skipping is right. Under
 * E2E_REQUIRE_CLUSTER=1 (or CI=true) it is a hard failure.
 */
const REQUIRE_CLUSTER = process.env.E2E_REQUIRE_CLUSTER === '1' || process.env.CI === 'true'

/**
 * A precondition that means the HARNESS is not wired up (no control-api, no cluster, no
 * credentials, no fixtures). Recoverable by configuring the environment, so it is fatal
 * when the environment claims to be able to run this.
 */
function unmet(reason: string): void {
  const msg = `[pull-secret-runtime] ${reason}`
  if (REQUIRE_CLUSTER) {
    throw new Error(
      `${msg}. Refusing to skip: E2E_REQUIRE_CLUSTER/CI is set, and a silent skip here ` +
        `would report success while asserting nothing. Fix the environment or unset the flag.`
    )
  }
  console.log(`${msg} — suite will be skipped`)
}

/**
 * A precondition that means the feature legitimately has no runtime outcome to assert
 * HERE (a managed cluster, where control-api provisions nothing by design). Not a
 * misconfiguration, so this skips even under REQUIRE_CLUSTER — failing would be wrong.
 */
function notApplicable(reason: string): void {
  console.log(`[pull-secret-runtime] ${reason} — not applicable on this cluster, skipping`)
}

/**
 * The harness is fine and the test CAN run — but the specific thing it exists to prove is
 * not provable in this state. Concretely: the node still holds the image, so `IfNotPresent`
 * short-circuits and the kubelet never presents a credential to the registry.
 *
 * This is the subtler sibling of `unmet`, and the more dangerous one. An unwired harness at
 * least fails visibly at the first assertion; a warm cache lets every assertion pass while
 * the single claim this suite exists to make — "a private image pulled with the credential
 * we provisioned" — is quietly not made. A run that stops making it must not be reported as
 * one that did, so under REQUIRE_CLUSTER this is a failure, not a downgrade.
 *
 * Locally it stays a warning: a developer re-running the suite against a warm node is a
 * normal state, and the log line says plainly that this run proves less.
 */
function unprovable(reason: string): void {
  const msg = `[pull-secret-runtime] ${reason}`
  if (REQUIRE_CLUSTER) {
    throw new Error(
      `${msg}. Refusing to pass: E2E_REQUIRE_CLUSTER/CI is set, and this run would otherwise ` +
        `report success without ever exercising the pull credential.`
    )
  }
  console.log(`${msg} — this run does NOT prove the private pull`)
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  controlApiUp = await isServiceUp(CONTROL_API_URL)
  if (!controlApiUp) {
    unmet(`control-api not reachable at ${CONTROL_API_URL}`)
    return
  }

  clusterUp = kubectlOrNull('get ns default -o name') !== null
  if (!clusterUp) {
    unmet(`kube context "${KUBE_CONTEXT}" unreachable`)
    return
  }

  adminCookie = await login()
  if (!adminCookie) {
    unmet('admin login failed (set TEST_ADMIN_PASSWORD)')
    return
  }

  // The provisioner is mode-gated: on a managed cluster control-api writes nothing and
  // there is no runtime outcome to assert. Read the deployed config rather than assuming.
  const mode = kubectlOrNull(
    `get configmap control-api-config -n ${CONTROL_PLANE_NS} -o jsonpath={.data.REGISTRY_CONNECTION_MODE}`
  )
  const registryUrl = kubectlOrNull(
    `get configmap control-api-config -n ${CONTROL_PLANE_NS} -o jsonpath={.data.CLERUM_REGISTRY_URL}`
  )
  selfHosted = mode === 'self-hosted'
  registryHost = hostFromUrl(registryUrl ?? '')
  if (!selfHosted || !registryHost) {
    notApplicable(
      `REGISTRY_CONNECTION_MODE=${mode ?? 'unset'} / registry=${registryUrl ?? 'unset'}`
    )
    return
  }

  // The fixtures are private entries owned by the connected org, so they exist only on a
  // deployment that has published them. Without this probe an environment that simply
  // lacks them would FAIL on a 404 install instead of skipping, which is not a signal
  // about the feature.
  const { status, data } = await adminRequest<{ data?: RegistryEntry[] }>(
    'GET',
    '/api/v1/admin/registry/entries?limit=200'
  )
  const catalog = status === 200 ? (data.data ?? []) : []
  const recipeEntry = catalog.find(
    e => e.name === RECIPE_ENTRY && e.version === RECIPE_ENTRY_VERSION
  )
  const mcpEntry = catalog.find(e => e.name === MCP_ENTRY && e.version === MCP_ENTRY_VERSION)
  // The image ref arrives from the registry catalog — remote data that later reaches a
  // `docker` command on the node. Validate the shape here, at the point it enters the
  // suite, rather than trusting it at each use site.
  const rawImage = mcpEntry?.mcp_server_meta?.imageRef ?? ''
  mcpImage = rawImage === '' ? '' : safeToken(rawImage, 'catalog imageRef')
  fixturesAvailable = Boolean(recipeEntry) && Boolean(mcpEntry) && mcpImage.startsWith(registryHost)
  if (!fixturesAvailable) {
    // Fatal under REQUIRE_CLUSTER: without private fixtures every runtime assertion in
    // this file is unreachable, so the suite would go green having proved nothing —
    // which is precisely the failure mode it was written to rule out.
    unmet(
      `private fixtures unavailable (recipe=${Boolean(recipeEntry)}, mcp=${Boolean(
        mcpEntry
      )}, image=${mcpImage || 'unset'}). ` +
        'Set E2E_PRIVATE_RECIPE_ENTRY / E2E_PRIVATE_MCP_ENTRY to point at private ' +
        'platform-registry entries this deployment can install'
    )
  }
}, 120_000)

/** Only the catalog fields this suite reads. */
type RegistryEntry = {
  name?: string
  version?: string
  mcp_server_meta?: { imageRef?: string } | null
}

/** Every block's precondition: a live self-hosted cluster with the private fixtures. */
function ready(): boolean {
  return controlApiUp && clusterUp && Boolean(adminCookie) && selfHosted && fixturesAvailable
}

afterAll(async () => {
  if (!adminCookie) return

  // Unconditional: a leaked foreign Secret would 409 every subsequent private install
  // into that namespace and read as a product bug.
  await restoreSandboxUiPullSecret()

  if (recipeInstalled) {
    await adminRequest('DELETE', `/api/v1/admin/registry/uninstall/${RECIPE_NAME}?type=recipe`)
  }
  if (mcpInstalled) {
    await adminRequest('DELETE', `/api/v1/admin/registry/uninstall/${MCP_NAME}?type=mcp-server`)
  }
  // Belt and braces — the uninstall route is best-effort and returns warnings, not errors.
  kubectlOrNull(`delete workflowrecipe ${RECIPE_NAME} -n ${SANDBOX_NS} --ignore-not-found=true`)
  kubectlOrNull(
    `delete workflowrecipe ${PREPERSIST_RECIPE_NAME} -n ${SANDBOX_NS} --ignore-not-found=true`
  )
  kubectlOrNull(`delete mcpserver ${MCP_NAME} -n ${MCP_SERVERS_NS} --ignore-not-found=true`)
}, 300_000)

// ─── Sandbox-ui Secret backup/restore, used by the pre-persistence block ─────

let sandboxUiBackup: string | null = null

/**
 * Replace the sandbox-ui copy with an externally-owned Secret the kubelet cannot use
 * (no `clerum.io/managed-by` label, wrong type). `classify()` reads that as
 * `foreign` + `unusable`, which is a pure classification outcome — it does NOT depend on
 * whether a mint is needed, so it cannot accidentally rotate the org's live credential.
 */
function plantForeignSandboxUiPullSecret(): boolean {
  sandboxUiBackup = kubectlOrNull(`get secret ${PULL_SECRET} -n ${SANDBOX_UI_NS} -o json`)
  if (
    kubectlOrNull(`delete secret ${PULL_SECRET} -n ${SANDBOX_UI_NS} --ignore-not-found=true`) ===
    null
  ) {
    return false
  }
  return (
    kubectlOrNull(
      `create secret generic ${PULL_SECRET} -n ${SANDBOX_UI_NS} --from-literal=note=e2e-foreign-fixture`
    ) !== null
  )
}

/**
 * Remove the foreign fixture and put `sandbox-ui` back into a state control-api considers
 * correct. Runs unconditionally: a leaked foreign copy would 409 every later private
 * install into that namespace and read as a product bug.
 *
 * The backup is only replayed when it is still CURRENT. An `install-recipe` that runs while
 * the fixture is planted can legitimately mint (an *unusable* foreign copy does not block
 * the mint — only a usable one does), which rotates the org key and leaves the captured
 * bytes holding a revoked credential. Restoring that would be worse than restoring nothing:
 * the copy would look valid, and its fingerprint would silently disagree with the other
 * namespaces. So when the backup is stale we delete instead — absent is a state the next
 * provisioning pass (any install, or the reconcile cron) repairs by design, converging every
 * namespace onto one fresh mint.
 */
async function restoreSandboxUiPullSecret(): Promise<void> {
  const current = kubectlJson<K8sSecret>(`get secret ${PULL_SECRET} -n ${SANDBOX_UI_NS}`)
  const isOurs = current?.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
  if (isOurs) {
    sandboxUiBackup = null
    return
  }
  if (current) {
    kubectlOrNull(`delete secret ${PULL_SECRET} -n ${SANDBOX_UI_NS} --ignore-not-found=true`)
  }
  const backup = sandboxUiBackup
  sandboxUiBackup = null
  if (!backup) return

  let backupFingerprint: string | undefined
  try {
    backupFingerprint = (JSON.parse(backup) as K8sSecret).metadata?.annotations?.[
      FINGERPRINT_ANNOTATION
    ]
  } catch {
    backupFingerprint = undefined
  }
  const liveFingerprint =
    readPullSecret(MCP_SERVERS_NS)?.metadata?.annotations?.[FINGERPRINT_ANNOTATION]
  if (!backupFingerprint || backupFingerprint !== liveFingerprint) {
    console.log(
      `[pull-secret-runtime] the captured ${SANDBOX_UI_NS} credential was rotated during the run ` +
        `(${backupFingerprint ?? 'none'} vs ${liveFingerprint ?? 'none'}); leaving it absent so the ` +
        'next provisioning pass re-mints and converges rather than restoring a revoked key'
    )
    return
  }

  try {
    // argv array, no shell — the context name cannot break out of its argument position.
    execFileSync(
      'kubectl',
      ['--context', safeToken(KUBE_CONTEXT, 'KUBE_CONTEXT'), 'apply', '-f', '-'],
      {
        input: backup,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
  } catch {
    // Nothing more we can do here; the reconcile cron re-provisions it on its next tick.
  }
}

// ─── 1. Secret placement ────────────────────────────────────────────────────

describe('registry pull secret — placement after a private-image recipe install', () => {
  it('installs the private recipe plugin', async () => {
    if (!ready()) return

    const { status, data } = await adminRequest('POST', '/api/v1/admin/registry/install-recipe', {
      recipeName: RECIPE_NAME,
      registryEntryName: RECIPE_ENTRY,
      registryEntryVersion: RECIPE_ENTRY_VERSION,
    })

    expect(status, `install-recipe failed: ${JSON.stringify(data)}`).toBe(201)
    recipeInstalled = true
  }, 120_000)

  it('provisions the Secret in EVERY platform workload namespace', () => {
    if (!recipeInstalled) return

    for (const ns of PLATFORM_NAMESPACES) {
      const secret = readPullSecret(ns)
      expect(secret, `${PULL_SECRET} missing in namespace ${ns}`).not.toBeNull()
      // Only dockerconfigjson/dockercfg are honoured by the kubelet for image pulls; an
      // Opaque Secret is accepted by the API server and then silently ignored at pull time.
      expect(secret!.type, `wrong Secret type in ${ns}`).toBe(DOCKERCONFIG_TYPE)
      expect(secret!.data?.[DOCKERCONFIG_KEY], `no ${DOCKERCONFIG_KEY} in ${ns}`).toBeTruthy()
      expect(secret!.metadata?.labels?.[MANAGED_BY_LABEL], `unowned Secret in ${ns}`).toBe(
        MANAGED_BY_VALUE
      )
      // The blob must be keyed on OUR image host, not the registry's token issuer —
      // otherwise the kubelet never selects this credential for the image being pulled.
      expect(
        authHosts(secret!),
        `dockerconfigjson in ${ns} not keyed on ${registryHost}`
      ).toContain(registryHost)
    }
  })

  it('all copies share ONE fingerprint — a single mint fanned out, not three mints', () => {
    if (!recipeInstalled) return

    const fingerprints = new Map<string, string>()
    for (const ns of PLATFORM_NAMESPACES) {
      const secret = readPullSecret(ns)
      const fp = secret?.metadata?.annotations?.[FINGERPRINT_ANNOTATION]
      expect(fp, `no ${FINGERPRINT_ANNOTATION} on the copy in ${ns}`).toBeTruthy()
      fingerprints.set(ns, fp!)
    }

    // The registry's mintPullKey is rotate-on-call with <=1 active pull key per org, so
    // per-namespace minting would leave earlier namespaces holding revoked credentials
    // while every Secret still looks present and well-formed. Divergent fingerprints are
    // the only cluster-visible symptom.
    const distinct = new Set(fingerprints.values())
    expect(
      distinct.size,
      `pull credential diverged across namespaces: ${JSON.stringify(Object.fromEntries(fingerprints))}`
    ).toBe(1)
  })

  it('is NOT recipe-accessible — no `shared` or `owner-recipe` label', () => {
    if (!recipeInstalled) return

    // spec §5.1 / R4: `isSecretAccessibleByRecipe` is the SAME predicate for envSecret and
    // imagePullSecrets. Either label would let any recipe on the cluster mount the org's
    // registry credential into its own environment.
    for (const ns of PLATFORM_NAMESPACES) {
      const labels = readPullSecret(ns)?.metadata?.labels ?? {}
      expect(labels['clerum.io/shared'], `${PULL_SECRET} is shared in ${ns}`).toBeUndefined()
      expect(
        labels['clerum.io/owner-recipe'],
        `${PULL_SECRET} is recipe-owned in ${ns}`
      ).toBeUndefined()
    }
  })
})

// ─── 2. Materialization onto the recipe workload ────────────────────────────

describe('registry pull secret — WRC materialization onto a recipe workload', () => {
  let deploymentName = ''

  it('WRC renders the workload Deployment with the injected reference', async () => {
    if (!recipeInstalled) return

    const dep = await waitFor(
      () =>
        kubectlJson<{ items?: Array<{ metadata?: { name?: string } }> }>(
          `get deployments -n ${SANDBOX_NS} -l clerum.io/recipe=${RECIPE_NAME}`
        ),
      v => (v?.items?.length ?? 0) > 0,
      120_000
    )
    expect(dep, `WRC never rendered a Deployment for recipe ${RECIPE_NAME}`).not.toBeNull()

    deploymentName = dep!.items![0].metadata!.name!
    const names = pullSecretNamesOnDeployment(deploymentName, SANDBOX_NS)
    expect(names, `Deployment ${deploymentName} disappeared`).not.toBeNull()
    expect(names, `no imagePullSecrets on ${deploymentName}`).toContain(PULL_SECRET)
  }, 150_000)

  it('the reference is INJECTED, not declared by the recipe', () => {
    if (!recipeInstalled || !deploymentName) return

    // If the recipe declared the name, the Issue #637 ownership gate would classify it
    // `denied` (the Secret is deliberately unlabelled to that model) and tear the whole
    // workload down. The reference on the Pod spec above must therefore come from WRC's
    // post-filter injection, which is only true if the CRD does not carry it.
    const recipe = kubectlJson<{
      spec?: { workloads?: Array<{ imagePullSecrets?: string[] }> }
    }>(`get workflowrecipe ${RECIPE_NAME} -n ${SANDBOX_NS}`)
    expect(recipe, `WorkflowRecipe ${RECIPE_NAME} not found`).not.toBeNull()

    for (const workload of recipe!.spec?.workloads ?? []) {
      expect(
        workload.imagePullSecrets ?? [],
        'the recipe CRD declares the platform Secret; injection is no longer being proven'
      ).not.toContain(PULL_SECRET)
    }
  })

  it('the workload Pod reaches Ready', async () => {
    if (!recipeInstalled) return

    const pods = await waitFor(
      () => podsFor(`clerum.io/recipe=${RECIPE_NAME}`, SANDBOX_NS),
      list => list.length > 0 && list.some(p => p.ready),
      240_000
    )
    expect(
      pods,
      `no Ready Pod for recipe ${RECIPE_NAME}; last seen ${JSON.stringify(
        podsFor(`clerum.io/recipe=${RECIPE_NAME}`, SANDBOX_NS)
      )}`
    ).not.toBeNull()
  }, 300_000)
})

// ─── 3. McpServer -> HCC -> Deployment, and a real private pull ─────────────

describe('registry pull secret — McpServer delegation, HCC materialization, real pull', () => {
  let deploymentName = ''
  let podName = ''

  it('evicts the private image from the node so the pull cannot be served from cache', async () => {
    if (!ready()) return

    // docker refuses to remove an image a running container still uses, so a workload on
    // the same image makes a cold node impossible. Wait a little first — a container from an
    // earlier block that is still terminating clears on its own — then give up honestly
    // rather than deleting nothing and "proving" a pull that never happened.
    // `null` means the node command itself failed, which is NOT the same as "no container";
    // only an empty result proves the image is free, so a broken `minikube ssh` times out
    // here and skips rather than being read as a green light to evict.
    const free = await waitFor(
      () => nodeExec(`docker ps --filter ancestor=${mcpImage} --format '{{.ID}}'`),
      inUse => inUse === '',
      60_000,
      5_000
    )
    if (free === null) {
      unprovable(
        `${mcpImage} is still held by a running container (or the node is unreachable) — cannot cold-start the node`
      )
      return
    }

    nodeExec(`docker rmi -f ${mcpImage}`)
    const remaining = nodeExec(`docker images -q ${mcpImage}`)
    nodeWasCold = !remaining
    if (!nodeWasCold) {
      unprovable(`failed to evict ${mcpImage} from the node docker cache`)
    }
  }, 120_000)

  it('installs the private MCP-server plugin', async () => {
    if (!ready()) return

    const { status, data } = await adminRequest('POST', '/api/v1/admin/registry/install', {
      serverName: MCP_NAME,
      contextRef: CONTEXT_REF,
      registryEntryName: MCP_ENTRY,
      registryEntryVersion: MCP_ENTRY_VERSION,
    })
    expect(status, `install failed: ${JSON.stringify(data)}`).toBe(201)
    mcpInstalled = true
  }, 120_000)

  it('the McpServer CRD carries the pull-secret reference', () => {
    if (!mcpInstalled) return

    const server = kubectlJson<{
      spec?: { image?: string; imagePullSecrets?: Array<{ name?: string }> }
    }>(`get mcpserver ${MCP_NAME} -n ${MCP_SERVERS_NS}`)
    expect(server, `McpServer ${MCP_NAME} not found`).not.toBeNull()
    expect(server!.spec?.image, 'fixture is not a platform-registry image').toContain(registryHost)
    expect(
      (server!.spec?.imagePullSecrets ?? []).map(r => r.name),
      'control-api did not attach the pull-secret reference to the McpServer CRD'
    ).toContain(PULL_SECRET)
  })

  it('HCC materializes the reference onto the Deployment it owns', async () => {
    if (!mcpInstalled) return

    // HCC copies the McpServer spec verbatim onto a Deployment it owns; this is the hop a
    // MockGateway cannot exercise. The managed-by label is asserted so the test cannot pass
    // on some other controller's Deployment that happens to share the name.
    const dep = await waitFor(
      () => kubectlJson<PodTemplateHolder>(`get deployment ${MCP_NAME} -n ${MCP_SERVERS_NS}`),
      v => v !== null,
      180_000
    )
    expect(dep, `HCC never created a Deployment for McpServer ${MCP_NAME}`).not.toBeNull()
    deploymentName = MCP_NAME

    expect(dep!.metadata?.labels?.[MANAGED_BY_LABEL]).toBe('host-context-controller')
    expect(
      (dep!.spec?.template?.spec?.imagePullSecrets ?? []).map(r => r.name),
      'HCC dropped the pull-secret reference'
    ).toContain(PULL_SECRET)
    // The reference is only meaningful if the workload it rides on is actually the private
    // image. Without this, a Deployment carrying the pull secret but running some public or
    // stale image would satisfy every other assertion in this block.
    expect(
      (dep!.spec?.template?.spec?.containers ?? []).map(c => c.image),
      `HCC materialized a Deployment that does not run the private image ${mcpImage}`
    ).toContain(mcpImage)
  }, 200_000)

  it('the Pod reaches Ready, running the private registry image', async () => {
    if (!mcpInstalled || !deploymentName) return

    const pods = await waitFor(
      () => podsFor(`app=${MCP_NAME}`, MCP_SERVERS_NS),
      list => list.length > 0 && list.some(p => p.ready),
      240_000
    )
    // Record the Pod name even when readiness fails, so the pull assertion below reports its
    // OWN failure ("no Pulled event …") instead of chain-skipping. A missing credential
    // should surface as two independent failures, not one plus a silent skip.
    const observed = pods ?? podsFor(`app=${MCP_NAME}`, MCP_SERVERS_NS)
    const readyPod = observed.find(p => p.ready) ?? observed[0]
    podName = readyPod?.name ?? ''
    expect(
      pods,
      `no Ready Pod for McpServer ${MCP_NAME}; last seen ${JSON.stringify(observed)}`
    ).not.toBeNull()
    // Ready is not the claim — "Ready ON THE PRIVATE IMAGE" is. A pod that came up on a
    // public or cached image proves the plumbing and nothing about the credential.
    expect(
      readyPod?.images ?? [],
      `the Ready Pod is not running ${mcpImage}; it runs ${JSON.stringify(readyPod?.images ?? [])}`
    ).toContain(mcpImage)
    expect(mcpImage.startsWith(registryHost), `${mcpImage} is not on the private registry`).toBe(
      true
    )
  }, 300_000)

  it('the kubelet performed a REAL authenticated pull, not a cache hit', () => {
    if (!mcpInstalled || !podName) return
    if (!nodeWasCold) {
      // Asserting a genuine pull against a warm node proves nothing: `IfNotPresent` would
      // short-circuit and the credential would never be exercised. Under REQUIRE_CLUSTER
      // that is a failure — this is the assertion the whole suite is built around, and a
      // run that skips it must not be counted as one that made it.
      unprovable('node was not cold, so the kubelet never had to present a credential')
      return
    }

    const message = pulledEventMessage(podName, MCP_SERVERS_NS, mcpImage)
    expect(message, `no Pulled event for ${mcpImage} on pod ${podName}`).not.toBeNull()

    // A cache hit and a genuine pull are distinguishable only in this message.
    expect(
      message,
      'kubelet served the image from cache — the credential was never used'
    ).not.toContain('already present on machine')
    expect(message).toContain('Successfully pulled image')
    expect(message, 'pull event carries no transferred byte count').toMatch(/Image size: \d+ bytes/)
  })
})

// ─── 4. Pre-persistence failure ─────────────────────────────────────────────

describe('registry pull secret — a provisioning failure is pre-persistence', () => {
  it('fails the install and persists NO WorkflowRecipe', async () => {
    if (!ready()) return

    let planted = false
    try {
      planted = plantForeignSandboxUiPullSecret()
      if (!planted) {
        console.log('[pull-secret-runtime] could not plant the foreign Secret — skipping')
        return
      }

      const { status, data } = await adminRequest('POST', '/api/v1/admin/registry/install-recipe', {
        recipeName: PREPERSIST_RECIPE_NAME,
        registryEntryName: RECIPE_ENTRY,
        registryEntryVersion: RECIPE_ENTRY_VERSION,
      })

      expect(status, `expected the install to be refused, got ${JSON.stringify(data)}`).toBe(409)
      const body = data as { error?: string; reason?: string }
      expect(body.error).toBe('registry_pull_secret_provision_failed')
      expect(body.reason).toBe('foreign_secret_unusable')

      // The whole point: the credential could not be provisioned, so the CRD that would
      // reference it must never have been written. A 4xx with a persisted recipe behind it
      // is the silent ImagePullBackOff this mechanism exists to remove.
      // `2>/dev/null` because NotFound is the expected, passing outcome here — without it
      // kubectl's error line lands in the run log and reads like a failure.
      const persisted = kubectlOrNull(
        `get workflowrecipe ${PREPERSIST_RECIPE_NAME} -n ${SANDBOX_NS} -o name 2>/dev/null`
      )
      expect(persisted, 'the failed install left a WorkflowRecipe behind').toBeNull()
    } finally {
      // Unconditional — a leaked foreign Secret 409s every later private install here.
      await restoreSandboxUiPullSecret()
    }
  }, 180_000)
})
