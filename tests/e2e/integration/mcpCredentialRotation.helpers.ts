/**
 * Shared helpers for the connector credential-rotation E2E suites
 * (issue #223, Fase 4 of the plan).
 *
 * These suites exercise the REAL `PUT /api/v1/admin/mcp-secrets/:name`
 * endpoint against a live minikube cluster and observe the HCC's reaction
 * through kubectl and the real `GET /api/v1/admin/mcp-servers/:name` — never
 * the other way around (writing the Secret with kubectl, or asserting on the
 * PUT's 200 alone, are the "atajos prohibidos" the plan calls out).
 *
 * See: .ralph/plans/2026-07-31-issue-223-mcp-connector-credential-rotation.md
 *      Fase 4 ("Contrato E2E de la rotación") and section 6 ("Tests de
 *      composición").
 *
 * Fail-loud contract:
 *   - `requireControlApiUp()` throws if control-api is unreachable, unless
 *     E2E_SKIP_IF_CLUSTER_UNREACHABLE=1 is set explicitly (mirrors the
 *     opt-in-only skip already used by integration/channel-reader-via-api.test.ts).
 *   - `waitFor()` never returns a "probably fine" result: it throws with a
 *     kubectl diagnostic dump on timeout.
 *   - Cleanup in `afterAll` blocks is the one place best-effort kubectl
 *     deletes are allowed to swallow errors — that mirrors existing
 *     convention and never masks a test's own assertions.
 */
import { execFileSync, execSync, spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import {
  CONTROL_API_URL,
  deleteJson,
  fetchJson,
  isServiceUp,
  postJson,
  putJson,
} from './helpers.integration.js'

export { CONTROL_API_URL, deleteJson, fetchJson, isServiceUp, postJson, putJson }

// ─── Configuration ──────────────────────────────────────────────────────────

// These test-config env vars flow into the kubectl command line built by
// `kubectl()` (which shells out via execSync). A k8s context/namespace/ref name
// is DNS-ish — letters, digits, dot, dash, underscore — so anything outside that
// set is either a misconfiguration or a shell-injection attempt. Validate at the
// source: this is the single choke point where external input reaches the
// command line, so one guard here removes the injection vector for every caller
// (CodeQL #827/#828, "indirect uncontrolled command line").
function requireSafeName(envName: string, value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(
      `Unsafe ${envName}=${JSON.stringify(value)}: only [A-Za-z0-9_.-] is allowed ` +
        '(a kubectl context/namespace/ref name), to keep it off the shell command line.'
    )
  }
  return value
}

export const KUBECTL_CONTEXT = requireSafeName(
  'KUBECTL_CONTEXT',
  process.env.KUBECTL_CONTEXT ?? 'clerum-test'
)
export const MCP_SERVERS_NAMESPACE = requireSafeName(
  'TEST_MCP_SERVERS_NAMESPACE',
  process.env.TEST_MCP_SERVERS_NAMESPACE ?? 'mcp-server'
)
export const TEST_CONTEXT_REF = requireSafeName(
  'TEST_CONTEXT_REF',
  process.env.TEST_CONTEXT_REF ?? 'context1'
)
export const MOCK_MCP_IMAGE = process.env.TEST_MOCK_MCP_IMAGE ?? 'clerum/mock-mcp-server:test'

// Must match the identically-named constants in
// tests/e2e/fixtures/mock-mcp-server/src/index.ts. Duplicated across the two
// build artifacts on purpose — a test-fixture container image can't import
// from the vitest project — and cross-referenced by comment on both sides so
// drift is visible in review. Same pattern as RECIPE_SECRET_LABEL_KEY in
// control-api/src/routes/admin/secrets.ts (module-scope constant, reused by
// every consumer instead of a duplicated literal).
export const ROTATION_CREDENTIAL_ENV_VAR = 'E2E_ROTATION_API_KEY'
export const ROTATION_INVALID_SENTINEL = '__E2E_INVALID_CREDENTIAL__'

// Generation-aware readiness budget is 24 attempts x 5s = 120s
// (host-context-controller/src/reconciler.ts pollReadiness). Happy-path
// rollouts converge much faster in practice; the failure path (E2) must run
// the budget all the way out before it is provably stuck, so it gets a
// larger ceiling.
export const ROLLOUT_TIMEOUT_MS = 90_000
export const ROLLOUT_FAILURE_TIMEOUT_MS = 150_000

export const SKIP_IF_UNREACHABLE = process.env.E2E_SKIP_IF_CLUSTER_UNREACHABLE === '1'

export function randomSuffix(): string {
  return randomBytes(3).toString('hex')
}

// ─── kubectl ────────────────────────────────────────────────────────────────

export function kubectl(args: string): string {
  // KUBECTL_CONTEXT is validated at the source (requireSafeName) so it carries no
  // shell metacharacters; `args` is composed by callers from literals, hex
  // suffixes (randomBytes) and the validated namespace — no raw external input
  // reaches this command line. Kept as execSync because callers pass a single
  // pre-joined arg string (with quoted jsonpath); the injection source, the env
  // vars, is what CodeQL #827 flags and what the source guard neutralizes.
  return execSync(`kubectl --context=${KUBECTL_CONTEXT} ${args}`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function kubectlSafe(args: string): string | null {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

export function kubectlApply(yaml: string): string {
  // execFileSync (no shell): the YAML goes in via stdin and the context via an
  // argv element, so nothing is interpolated into a command line at all.
  // Closes CodeQL #828.
  return execFileSync('kubectl', ['--context', KUBECTL_CONTEXT, 'apply', '-f', '-'], {
    encoding: 'utf-8',
    input: yaml,
  }).trim()
}

export function kubectlJson<T>(args: string): T {
  return JSON.parse(kubectl(`${args} -o json`)) as T
}

/** Best-effort diagnostic dump embedded in timeout errors — never throws itself. */
export function clusterDiagnostics(namespace: string, extra: string[] = []): string {
  const commands = [
    `get mcpservers -n ${namespace} -o wide`,
    `get deployments -n ${namespace} -o wide`,
    `get pods -n ${namespace} -o wide`,
    ...extra,
  ]
  return commands
    .map(cmd => `$ kubectl ${cmd}\n${kubectlSafe(cmd) ?? '(command failed — see stderr above)'}`)
    .join('\n\n')
}

// ─── waitFor ────────────────────────────────────────────────────────────────

export async function waitFor<T>(
  description: string,
  predicate: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  opts: { intervalMs?: number; diagnostics?: () => string } = {}
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 1_500
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await predicate()
      if (result !== null && result !== undefined && result !== '' && result !== false) {
        return result as T
      }
    } catch (err) {
      lastErr = err
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  const diag = opts.diagnostics ? `\n\n--- diagnostics ---\n${opts.diagnostics()}` : ''
  throw new Error(
    `Timed out waiting for: ${description} (${timeoutMs}ms). Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }${diag}`
  )
}

// ─── control-api admin auth ─────────────────────────────────────────────────

/** Cookie name control-api's admin session lives in — must match
 * control-api/src/middleware/controlUIAuth.ts (readCookie) and the
 * Set-Cookie written by control-api/src/routes/admin/auth.ts. */
export const ADMIN_SESSION_COOKIE = 'control_ui_admin_session'

/**
 * Cookie header for authenticated /admin requests.
 *
 * control-api's admin auth is cookie-only by design: the login handler
 * (control-api/src/routes/admin/auth.ts) puts the signed JWT EXCLUSIVELY in
 * an httpOnly `control_ui_admin_session` Set-Cookie — the response body
 * carries no token — and `requireAuthForControlUI`
 * (control-api/src/middleware/controlUIAuth.ts) reads it EXCLUSIVELY from
 * that cookie; `Authorization: Bearer` is never consulted. So the suites
 * authenticate the same way a browser would: replay the cookie value.
 * (The cookie's `Secure` flag only constrains browsers — an explicit Cookie
 * header sent over plain HTTP by the test client is delivered unchanged.)
 */
export function adminSessionHeader(session: string): Record<string, string> {
  return { Cookie: `${ADMIN_SESSION_COOKIE}=${session}` }
}

/**
 * Logs in as the admin and returns the session JWT extracted from the
 * login response's Set-Cookie header. Uses `fetch` directly (not postJson)
 * because the shared fetchJson helper deliberately exposes only
 * { status, data } — and the credential ONLY exists in a response header.
 */
export async function adminLogin(): Promise<string> {
  const adminUsername = process.env.TEST_ADMIN_USERNAME ?? 'admin'
  const adminPassword = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
  const res = await fetch(`${CONTROL_API_URL}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  })
  if (res.status !== 200) {
    throw new Error(
      `admin login failed (status=${res.status}, body=${await res.text()}). Override with ` +
        `TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD if the cluster's defaults differ.`
    )
  }
  const setCookies = res.headers.getSetCookie()
  for (const cookie of setCookies) {
    const match = cookie.match(new RegExp(`^${ADMIN_SESSION_COOKIE}=([^;]+)`))
    if (match) return match[1]
  }
  throw new Error(
    `admin login returned 200 but no "${ADMIN_SESSION_COOKIE}" Set-Cookie header. ` +
      `Set-Cookie headers received: ${JSON.stringify(setCookies)}. The control-api auth ` +
      `contract (httpOnly session cookie) may have changed — see control-api/src/routes/admin/auth.ts.`
  )
}

/**
 * Fail-loud cluster reachability check. Returns `false` ONLY when the
 * explicit opt-out env var is set — the caller then must skip the whole
 * suite by returning early from every `it()`, matching the established
 * `if (!controlApiUp) return` convention in this directory. Never a silent
 * default skip.
 */
export async function requireControlApiUp(suiteName: string): Promise<boolean> {
  const up = await isServiceUp(CONTROL_API_URL)
  if (up) return true
  const msg = `[${suiteName}] control-api not reachable at ${CONTROL_API_URL}`
  if (SKIP_IF_UNREACHABLE) {
    console.log(`${msg} — tests will be skipped (E2E_SKIP_IF_CLUSTER_UNREACHABLE=1)`)
    return false
  }
  throw new Error(
    `${msg}. This E2E suite requires control-api to be reachable. Run ` +
      '`make minikube-pf-control-ui` first, or set E2E_SKIP_IF_CLUSTER_UNREACHABLE=1 to skip.'
  )
}

// ─── mcp-secrets / mcp-servers HTTP contract ────────────────────────────────

export interface McpServerCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason: string
  message: string
  lastTransitionTime: string
}

export interface McpServerResource {
  metadata: {
    name: string
    namespace: string
    resourceVersion?: string
    generation?: number
  }
  spec: Record<string, unknown>
  status?: { conditions?: McpServerCondition[] }
}

export interface McpSecretPutResponse {
  name: string
  namespace: string
  keys: string[]
  affectedConnectors: string[]
}

export async function putMcpSecret(
  name: string,
  data: Record<string, string>,
  session?: string
): Promise<{ status: number; data: McpSecretPutResponse | { error: string } }> {
  return putJson(
    `${CONTROL_API_URL}/api/v1/admin/mcp-secrets/${encodeURIComponent(name)}`,
    { data },
    session ? adminSessionHeader(session) : {}
  )
}

export async function getMcpServerResource(
  name: string,
  session: string
): Promise<McpServerResource> {
  const { status, data } = await fetchJson<McpServerResource>(
    `${CONTROL_API_URL}/api/v1/admin/mcp-servers/${encodeURIComponent(name)}`,
    { headers: adminSessionHeader(session) }
  )
  if (status !== 200) {
    throw new Error(
      `GET /admin/mcp-servers/${name} failed: status=${status} body=${JSON.stringify(data)}`
    )
  }
  return data
}

export function deploymentReadyCondition(
  resource: McpServerResource
): McpServerCondition | undefined {
  return resource.status?.conditions?.find(c => c.type === 'DeploymentReady')
}

/**
 * Poll GET /admin/mcp-servers/:name until DeploymentReady reaches
 * `expectStatus` with a `lastTransitionTime` strictly after `sinceMs`.
 *
 * The `sinceMs` correlation is load-bearing (plan Fase 3, requisito 6 /
 * hallazgo 1): without it, a condition left over from a PREVIOUS deploy would
 * satisfy the predicate instantly, before the rollout under test even began.
 */
export async function waitForRolloutCondition(
  name: string,
  token: string,
  opts: { expectStatus: 'True' | 'False'; sinceMs: number; timeoutMs: number }
): Promise<McpServerCondition> {
  return waitFor(
    `McpServer "${name}" DeploymentReady=${opts.expectStatus} with lastTransitionTime after ${new Date(
      opts.sinceMs
    ).toISOString()}`,
    async () => {
      const resource = await getMcpServerResource(name, token)
      const cond = deploymentReadyCondition(resource)
      if (!cond) return null
      const transitionMs = Date.parse(cond.lastTransitionTime)
      if (Number.isNaN(transitionMs) || transitionMs < opts.sinceMs) return null
      if (cond.status !== opts.expectStatus) return null
      return cond
    },
    opts.timeoutMs,
    {
      diagnostics: () =>
        clusterDiagnostics(MCP_SERVERS_NAMESPACE, [
          `get mcpserver ${name} -n ${MCP_SERVERS_NAMESPACE} -o yaml`,
          `describe deployment ${name} -n ${MCP_SERVERS_NAMESPACE}`,
        ]),
    }
  )
}

/**
 * E2's guardian: poll until the rollout reaches a TERMINAL failure
 * (`DeploymentReady=False`, `reason=RolloutIncomplete`) after `sinceMs`. If a
 * `True` transition after `sinceMs` is observed first, throws IMMEDIATELY —
 * that is the false-positive rollout this scenario exists to catch, and the
 * whole point is that the test must fail loudly on it, not eventually time
 * out on a stale expectation.
 */
export async function assertRolloutNeverSucceeds(
  name: string,
  token: string,
  sinceMs: number,
  timeoutMs: number
): Promise<McpServerCondition> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const resource = await getMcpServerResource(name, token)
    const cond = deploymentReadyCondition(resource)
    if (cond) {
      const transitionMs = Date.parse(cond.lastTransitionTime)
      if (!Number.isNaN(transitionMs) && transitionMs >= sinceMs) {
        if (cond.status === 'True') {
          throw new Error(
            `McpServer "${name}" reported DeploymentReady=True after rotating to a credential ` +
              `that must crash-loop the pod (${ROTATION_INVALID_SENTINEL}). This IS the false-positive ` +
              `rollout scenario E2 exists to catch — the system reported success on a broken rotation. ` +
              `Condition: ${JSON.stringify(cond)}`
          )
        }
        if (cond.reason === 'RolloutIncomplete') {
          return cond
        }
      }
    }
    await new Promise(r => setTimeout(r, 3_000))
  }
  throw new Error(
    `Timed out (${timeoutMs}ms) waiting for McpServer "${name}" to reach a terminal ` +
      `RolloutIncomplete failure after rotating to an invalid credential. Either the readiness ` +
      `poll never wrote a terminal condition to the CRD (composition bug — plan section 6, C1), or ` +
      `the rollout budget needs to be re-measured against this cluster.\n\n${clusterDiagnostics(
        MCP_SERVERS_NAMESPACE,
        [
          `get mcpserver ${name} -n ${MCP_SERVERS_NAMESPACE} -o yaml`,
          `describe deployment ${name} -n ${MCP_SERVERS_NAMESPACE}`,
          `get pods -l app=${name} -n ${MCP_SERVERS_NAMESPACE} -o wide`,
        ]
      )}`
  )
}

// ─── Secret content hash (C4) ───────────────────────────────────────────────

/**
 * Mirrors host-context-controller/src/utils.ts canonicalStringify EXACTLY:
 * sorted keys, JSON.stringify of [key, value] pairs. Any drift here would
 * silently defeat the C4 check (plan section 6): "no basta con que la
 * anotación cambió — hay que compararla con el hash real del Secret".
 */
export function canonicalStringify(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort()
  return JSON.stringify(sorted.map(k => [k, obj[k]]))
}

/** sha256(canonicalStringify(secret.data)) — secret.data is base64, exactly as kubectl -o json returns it. */
export function secretDataHash(namespace: string, name: string): string {
  const secret = kubectlJson<{ data?: Record<string, string> }>(
    `get secret ${name} -n ${namespace}`
  )
  return createHash('sha256')
    .update(canonicalStringify(secret.data ?? {}))
    .digest('hex')
}

/**
 * Blocks until the Deployment's rollout completes (all updated replicas
 * available) or the timeout fires, via `kubectl rollout status`. This is a fact
 * of the Deployment object — independent of how any given HCC version writes
 * McpServer CRD status conditions. Use it when a test only needs the workload to
 * be settled (e.g. before snapshotting its generation), not the CRD condition:
 * a PRE-#204 baseline reconciler with startup-fleet coupling may take far longer
 * to publish DeploymentReady=True on the CRD than the pod takes to become
 * Available, so asserting the CRD condition there is both slow and brittle.
 * Throws (fail-loud) if the rollout does not complete within the timeout.
 */
export function waitForDeploymentRolloutComplete(
  namespace: string,
  deploymentName: string,
  timeoutSec = 120
): void {
  kubectl(`rollout status deployment/${deploymentName} -n ${namespace} --timeout=${timeoutSec}s`)
}

export function deploymentCredentialsRevisionAnnotation(
  namespace: string,
  deploymentName: string
): string | null {
  const value = kubectlSafe(
    `get deployment ${deploymentName} -n ${namespace} -o jsonpath='{.spec.template.metadata.annotations.clerum\\.io/credentials-revision}'`
  )
  // `kubectl -o jsonpath` of an ABSENT annotation prints an empty string, not an
  // error — so kubectlSafe returns "". An absent annotation is semantically
  // null (the revision was never written), which is what callers checking
  // "baseline never wrote it" assert against. A present annotation is always a
  // non-empty sha256, so this normalization never masks a real value.
  return value === '' ? null : value
}

// ─── CRD / Secret fixture builders ──────────────────────────────────────────

export function secretYaml(name: string, namespace: string, data: Record<string, string>): string {
  const stringDataLines = Object.entries(data)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n')
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
stringData:
${stringDataLines}
`
}

export function localMcpServerYaml(opts: {
  name: string
  namespace?: string
  image?: string
  envSecretName: string
  keys: Array<{ secretKey: string; envVar: string }>
}): string {
  const {
    name,
    namespace = MCP_SERVERS_NAMESPACE,
    image = MOCK_MCP_IMAGE,
    envSecretName,
    keys,
  } = opts
  const keyLines = keys
    .map(k => `      - secretKey: ${k.secretKey}\n        envVar: ${k.envVar}`)
    .join('\n')
  return `apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  contextRef: ${TEST_CONTEXT_REF}
  description: "issue #223 credential-rotation E2E fixture"
  image: ${image}
  transport:
    type: streamableHttp
    url: http://${name}.${namespace}.svc.cluster.local:3000/mcp
    port: 3000
  healthCheck:
    port: 3001
  envSecret:
    name: ${envSecretName}
    keys:
${keyLines}
  enabled: true
`
}

export function remoteMcpServerYaml(opts: {
  name: string
  namespace?: string
  baseUrl: string
  envSecretName: string
  keys: Array<{ secretKey: string; envVar: string }>
  authHeaders: Array<{ header: string; valueTemplate: string }>
  transportPort?: number
}): string {
  const {
    name,
    namespace = MCP_SERVERS_NAMESPACE,
    baseUrl,
    envSecretName,
    keys,
    authHeaders,
    transportPort = 3000,
  } = opts
  const keyLines = keys
    .map(k => `      - secretKey: ${k.secretKey}\n        envVar: ${k.envVar}`)
    .join('\n')
  const authHeaderLines = authHeaders
    .map(
      h => `      - header: ${h.header}\n        valueTemplate: ${JSON.stringify(h.valueTemplate)}`
    )
    .join('\n')
  // The CRD requires every remote McpServer to declare at least one
  // egressBinding (mcpserver.yaml CEL rule: "Remote servers must declare at
  // least one egressBinding for egress NetworkPolicy"). Without it, admission
  // rejects the object before the HCC ever sees it. Derive the binding from the
  // real baseUrl so the generated NetworkPolicy actually permits the egress the
  // rotation test exercises, rather than hardcoding an unrelated host.
  const egressUrl = new URL(baseUrl)
  const egressDns = egressUrl.hostname
  const egressPort = Number(egressUrl.port) || (egressUrl.protocol === 'https:' ? 443 : 80)
  return `apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  contextRef: ${TEST_CONTEXT_REF}
  description: "issue #223 remote connector credential-rotation E2E fixture"
  image: placeholder-canonicalized-by-hcc
  transport:
    type: streamableHttp
    url: http://${name}.${namespace}.svc.cluster.local:${transportPort}/mcp
    port: ${transportPort}
  remote:
    baseUrl: ${baseUrl}
    authHeaders:
${authHeaderLines}
  egressBindings:
    - dns: ${egressDns}
      port: ${egressPort}
      protocol: TCP
  envSecret:
    name: ${envSecretName}
    keys:
${keyLines}
  enabled: true
`
}

// ─── Transient Service port-forward (E6) ────────────────────────────────────

/**
 * Opens a port-forward to `svc/<service>:<remotePort>` for the duration of
 * `fn`, then tears it down. Used to make a REAL HTTP request through a
 * connector's own Service — e.g. a remote connector's nginx egress proxy —
 * without adding it to the shared pf-all-stack.sh set. Fails loud (throws)
 * if the port-forward process exits before becoming ready, or never becomes
 * ready within `readyTimeoutMs`.
 */
export async function withServicePortForward<T>(
  namespace: string,
  service: string,
  remotePort: number,
  fn: (baseUrl: string) => Promise<T>,
  readyTimeoutMs = 20_000,
  // A connector's Service only publishes the transport port. To reach a port
  // the pod listens on but the Service does not expose — e.g. the mock's health
  // server on 3001 that serves /whoami-credential — forward to the Deployment
  // (which lands on the pod directly) instead of the Service.
  target: 'svc' | 'deploy' = 'svc'
): Promise<T> {
  const targetRef = `${target}/${service}`
  const localPort = 20_000 + Math.floor(Math.random() * 10_000)
  const child = spawn(
    'kubectl',
    [
      '--context',
      KUBECTL_CONTEXT,
      '-n',
      namespace,
      'port-forward',
      targetRef,
      `${localPort}:${remotePort}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  let ready = false
  let stderrBuf = ''
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.stdout?.on('data', d => {
    if (d.toString().includes('Forwarding from')) ready = true
  })
  child.stderr?.on('data', d => {
    stderrBuf += d.toString()
  })
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  try {
    await waitFor(
      `port-forward ${targetRef}:${remotePort} in ${namespace} to become ready`,
      () => {
        if (exited) {
          const e = exited as { code: number | null; signal: NodeJS.Signals | null }
          throw new Error(
            `port-forward exited early (code=${e.code}, signal=${e.signal}): ${stderrBuf}`
          )
        }
        return ready ? 'ready' : null
      },
      readyTimeoutMs,
      { intervalMs: 250 }
    )
    return await fn(`http://127.0.0.1:${localPort}`)
  } finally {
    child.kill('SIGTERM')
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** Best-effort teardown. Deliberately swallows errors — cleanup, not assertion. */
export function deleteMcpServerFixture(
  name: string,
  secretName: string,
  namespace = MCP_SERVERS_NAMESPACE
): void {
  kubectlSafe(`delete mcpserver ${name} -n ${namespace} --ignore-not-found --timeout=20s`)
  kubectlSafe(`delete secret ${secretName} -n ${namespace} --ignore-not-found --timeout=10s`)
}
