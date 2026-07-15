import { execFileSync } from 'node:child_process'
import { E2E_TEST_EMAIL } from '../../../tests/e2e/testUser'

const ALLOWED_CONTEXTS = new Set(
  (process.env.E2E_ALLOWED_CONTEXTS || 'clerum-test,gke_your-gcp-project_us-central1-a_example-dev')
    .split(',')
    .map(context => context.trim())
    .filter(Boolean)
)
const DEV_CONTEXT = 'gke_your-gcp-project_us-central1-a_example-dev'
const PROD_CONTEXT = 'gke_your-gcp-project_us-central1-a_clerum'

function isLocalhost(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)
}

/** Matches branch.mk profiles: clerum-<branch-slug>-<sha7-8> (e.g. clerum-feat-plugin-workload-sdk-3de2a246). */
function isBranchProfileContext(context: string): boolean {
  return /^clerum-.+-[0-9a-f]{7,8}$/.test(context)
}

function isLocalPortForwardContext(context: string): boolean {
  return (
    context === 'clerum-test' ||
    /^clerum-(codex|detached)-.+-[0-9a-f]{8}$/.test(context) ||
    isBranchProfileContext(context)
  )
}

function parseBooleanEnv(value: string | undefined): boolean {
  // Keep this narrow on purpose so only the documented values ("1"/"true")
  // enable dev port-forward mode in CI/E2E runs.
  return value === '1' || value?.toLowerCase() === 'true'
}

function isBranchScopedLocalContext(context: string): boolean {
  return /^clerum-(codex|detached)-/.test(context) || isBranchProfileContext(context)
}

function urlPort(url: string): string {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

function assertNoSharedDefaultPorts(
  expectedContext: string,
  urls: Array<readonly [string, string]>
): void {
  if (!isBranchScopedLocalContext(expectedContext)) return
  const defaultPorts = new Map<string, string>([
    ['CONTROL_UI_BASE_URL', '3000'],
    ['CONTROL_API_BASE_URL', '8090'],
    ['EXTERNAL_REST_API_BASE_URL', '8091'],
    ['RPC_PROXY_BASE_URL', '8094'],
    ['WORKFLOW_APPROVAL_READER_BASE_URL', '8098'],
  ])
  for (const [name, url] of urls) {
    const defaultPort = defaultPorts.get(name)
    if (defaultPort && urlPort(url) === defaultPort) {
      throw new Error(
        `[E2E-GUARD] context=${expectedContext} must use random localhost port-forwards. ` +
          `${name}="${url}" uses shared default port ${defaultPort}, which can point at a stale clerum-test or example-dev forward.`
      )
    }
  }
}

type BaseUrlValidationInput = {
  expectedContext: string
  controlUiUrl?: string
  controlApiUrl: string
  externalRestUrl: string
  rpcProxyUrl: string
  workflowApprovalReaderUrl?: string
  allowDevPortForward: boolean
}

export function validateBaseUrls({
  expectedContext,
  controlUiUrl,
  controlApiUrl,
  externalRestUrl,
  rpcProxyUrl,
  workflowApprovalReaderUrl,
  allowDevPortForward,
}: BaseUrlValidationInput): void {
  const urls: Array<readonly [string, string]> = [
    ...(controlUiUrl ? ([['CONTROL_UI_BASE_URL', controlUiUrl]] as const) : []),
    ['CONTROL_API_BASE_URL', controlApiUrl],
    ['EXTERNAL_REST_API_BASE_URL', externalRestUrl],
    ['RPC_PROXY_BASE_URL', rpcProxyUrl],
  ]
  if (workflowApprovalReaderUrl) {
    urls.push(['WORKFLOW_APPROVAL_READER_BASE_URL', workflowApprovalReaderUrl])
  }

  if (isLocalPortForwardContext(expectedContext)) {
    for (const [name, url] of urls) {
      if (!isLocalhost(url)) {
        throw new Error(
          `[E2E-GUARD] local minikube context=${expectedContext} requires localhost URLs. ` +
            `${name}="${url}" is not localhost. Start port-forwards: make minikube-pf-desktop (or make e2e-desktop-app which wraps this).`
        )
      }
    }
    assertNoSharedDefaultPorts(expectedContext, urls)
    return
  }

  if (allowDevPortForward) {
    for (const [name, url] of urls) {
      if (!isLocalhost(url)) {
        throw new Error(
          `[E2E-GUARD] context=${expectedContext} with E2E_ALLOW_DEV_PORT_FORWARD=1 requires localhost URLs. ` +
            `${name}="${url}" is not localhost. Either use dev port-forwards or unset E2E_ALLOW_DEV_PORT_FORWARD.`
        )
      }
    }
    assertNoSharedDefaultPorts(expectedContext, urls)
    return
  }

  for (const [name, url] of urls) {
    if (isLocalhost(url)) {
      throw new Error(
        `[E2E-GUARD] context=${expectedContext} requires non-localhost URLs. ` +
          `${name}="${url}" looks like a stale minikube/dev port-forward. ` +
          `Set the real dev URL, or for example-dev local port-forwards set E2E_ALLOW_DEV_PORT_FORWARD=1.`
      )
    }
  }
}

function kubectlCurrentContext(): string {
  return execFileSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function kubectlUseContext(ctx: string): void {
  execFileSync('kubectl', ['config', 'use-context', ctx], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function assertHealth(baseUrl: string, label: string, path = '/health'): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`)
  } catch (err) {
    throw new Error(
      `[E2E-GUARD] ${label} health check failed at ${baseUrl}${path}: ${(err as Error).message}. Are port-forwards up?`
    )
  }
  if (response.status !== 200) {
    const body = await response.text().catch(() => '')
    throw new Error(`[E2E-GUARD] ${label} health returned HTTP ${response.status}: ${body}`)
  }
}

async function globalSetup(): Promise<void> {
  const expected = process.env.E2E_K8S_CONTEXT || 'clerum-test'

  if (expected === PROD_CONTEXT) {
    throw new Error(
      `[E2E-GUARD] Production context "${PROD_CONTEXT}" is hard-blocked. E2E against prod is never allowed.`
    )
  }
  if (!isLocalPortForwardContext(expected) && !ALLOWED_CONTEXTS.has(expected)) {
    throw new Error(
      `[E2E-GUARD] E2E_K8S_CONTEXT="${expected}" is not in the allow-list. ` +
        `Allowed: ${[...ALLOWED_CONTEXTS].join(', ')}.`
    )
  }

  let current: string
  try {
    current = kubectlCurrentContext()
  } catch (err) {
    throw new Error(`[E2E-GUARD] Failed to read kubectl current-context: ${(err as Error).message}`)
  }

  if (current === PROD_CONTEXT) {
    throw new Error(
      `[E2E-GUARD] kubectl current-context is production "${PROD_CONTEXT}". Refusing to run E2E.`
    )
  }

  if (current !== expected) {
    // eslint-disable-next-line no-console
    console.log(`[E2E-GUARD] Switching kubectl context "${current}" → "${expected}"`)
    try {
      kubectlUseContext(expected)
    } catch (err) {
      throw new Error(
        `[E2E-GUARD] Failed to switch context to "${expected}": ${(err as Error).message}. ` +
          `Is the context configured in ~/.kube/config?`
      )
    }
  }

  const controlApi = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
  const controlUi =
    process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || 'http://127.0.0.1:3000'
  const externalRest = process.env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091'
  const rpcProxy = process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094'
  const workflowApprovalReader =
    process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS === '1'
      ? process.env.WORKFLOW_APPROVAL_READER_BASE_URL || 'http://127.0.0.1:8098'
      : undefined
  const allowDevPortForward = parseBooleanEnv(process.env.E2E_ALLOW_DEV_PORT_FORWARD)

  validateBaseUrls({
    expectedContext: expected,
    controlUiUrl: controlUi,
    controlApiUrl: controlApi,
    externalRestUrl: externalRest,
    rpcProxyUrl: rpcProxy,
    workflowApprovalReaderUrl: workflowApprovalReader,
    allowDevPortForward,
  })

  await assertHealth(controlApi, 'control-api')
  await assertHealth(externalRest, 'external-rest-api')
  await assertHealth(rpcProxy, 'rpc-proxy')
  if (workflowApprovalReader) {
    await assertHealth(workflowApprovalReader, 'workflow-approval-request-reader')
  }

  const email = E2E_TEST_EMAIL
  const hostRef = process.env.E2E_HOST_REF || 'chatllm'
  const authPreflight = process.env.E2E_AUTH_PREFLIGHT || 'password'

  let loginResp: Response
  const loginPath = '/api/v1/auth/password-login'
  let loginBody: Record<string, string> = { email }
  try {
    if (authPreflight !== 'password') {
      throw new Error(
        `[E2E-GUARD] Unsupported E2E_AUTH_PREFLIGHT="${authPreflight}". Only "password" is supported.`
      )
    }
    const password =
      process.env.E2E_DESKTOP_PASSWORD ||
      process.env.E2E_TEST_PASSWORD ||
      process.env.ADMIN_PASSWORD ||
      'changeme123!'
    loginBody = { email, password }

    loginResp = await fetch(`${externalRest}${loginPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loginBody),
    })
  } catch (err) {
    throw new Error(
      `[E2E-GUARD] ${authPreflight} request to ${externalRest} failed: ${(err as Error).message}. Are port-forwards up?`
    )
  }
  if (loginResp.status !== 200) {
    throw new Error(
      `[E2E-GUARD] ${authPreflight} returned HTTP ${loginResp.status} for ${email} at ${externalRest}.`
    )
  }
  const loginJson = (await loginResp.json()) as { token?: string }
  const token = loginJson.token
  if (!token) {
    throw new Error(`[E2E-GUARD] ${authPreflight} response did not include token for ${email}.`)
  }

  const agentsResp = await fetch(`${externalRest}/api/v1/me/agents`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (agentsResp.status !== 200) {
    throw new Error(
      `[E2E-GUARD] GET /api/v1/me/agents returned HTTP ${agentsResp.status} for ${email}.`
    )
  }
  const agentsBody = (await agentsResp.json()) as { agentNames?: string[] }
  const agentNames = Array.isArray(agentsBody.agentNames) ? agentsBody.agentNames : []

  if (agentNames.length === 0) {
    const seedHint = isLocalPortForwardContext(expected)
      ? 'scripts/minikube/seed-test-data.sh'
      : 'the equivalent seed script for example-dev'
    throw new Error(
      `[E2E-GUARD] User ${email} has zero agents on context=${expected}. Seed is missing. Run: ${seedHint}`
    )
  }

  if (!agentNames.includes(hostRef)) {
    throw new Error(
      `[E2E-GUARD] E2E_HOST_REF="${hostRef}" not found among ${email}'s agents on context=${expected}. ` +
        `Available: [${agentNames.join(', ')}]. Fix E2E_HOST_REF in .env.e2e or seed the missing Host.`
    )
  }

  // eslint-disable-next-line no-console
  console.log(
    `[E2E-GUARD] ✓ context=${expected} · agents=${agentNames.length} · hostRef=${hostRef} · email=${email}`
  )
}

export default globalSetup
