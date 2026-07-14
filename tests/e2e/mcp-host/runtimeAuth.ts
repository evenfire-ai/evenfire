import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { MCP_HOST_URL, fetchJson, kubectl } from '../helpers.js'
import { E2E_TEST_EMAIL, getE2ETestCandidateEmails } from '../testUser.js'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')
const EXTERNAL_REST_API_URL = process.env.EXTERNAL_REST_API_URL || 'http://localhost:8091'
const RPC_PROXY_URL = process.env.RPC_PROXY_URL || 'http://localhost:8094'
const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT || process.env.CONTEXT || 'clerum-test'
const E2E_TEST_PASSWORD =
  process.env.E2E_DESKTOP_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme123!'

function kubectlWithContext(args: string[]): string {
  return execFileSync('kubectl', ['--context', KUBECTL_CONTEXT, ...args], {
    encoding: 'utf-8',
  }).trim()
}

function normalizePem(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function readRpcProxyPublicKey(): string {
  const encoded = kubectlWithContext([
    'get',
    'secret',
    'rpc-proxy-secrets',
    '-n',
    'rpc-proxy',
    '-o',
    'jsonpath={.data.RPC_PROXY_JWT_PUBLIC_KEY}',
  ]).replace(/'/g, '')
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function readMcpHostPublicKey(): string {
  return kubectlWithContext([
    'get',
    'configmap',
    'mcp-host-config',
    '-n',
    'mcp-host',
    '-o',
    'jsonpath={.data.CLERUM_AUTH_JWT_PUBLIC_KEY}',
  ])
}

/**
 * Cluster-backed mcp-host E2E relies on the real auth path:
 * control-api signs RPC tokens -> rpc-proxy forwards them -> mcp-host verifies them.
 *
 * If mcp-host has a stale public key, tests fail later with opaque 401/500s.
 * Fail early here with the exact operational fix instead.
 */
export function assertRpcAuthChainReady(): void {
  try {
    const rpcProxyKey = normalizePem(readRpcProxyPublicKey())
    const mcpHostKey = normalizePem(readMcpHostPublicKey())

    if (rpcProxyKey !== mcpHostKey) {
      throw new Error(
        [
          `E2E auth preflight failed for context "${KUBECTL_CONTEXT}".`,
          'rpc-proxy and control-api are using a different JWT public key than mcp-host.',
          "This causes rpc-proxy -> mcp-host calls to fail with 'Invalid token'.",
          '',
          'Fix:',
          '  1. make minikube-sync-auth-key',
          `  2. CONTEXT=${KUBECTL_CONTEXT} E2E_DEV_LOGIN_EMAIL=${E2E_TEST_EMAIL} scripts/minikube/seed-test-data.sh`,
        ].join('\n')
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('E2E auth preflight failed')) {
      throw error
    }
    throw new Error(
      [
        `Unable to verify the cluster auth chain for context "${KUBECTL_CONTEXT}".`,
        'Cluster-backed mcp-host E2E requires live access to rpc-proxy-secrets and mcp-host-config.',
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n')
    )
  }
}

export function generateClusterJwt(
  scopes: string[],
  hostRefs: string[],
  subject = 'e2e-runtime-test'
): string {
  const keyB64 = kubectlWithContext([
    'get',
    'secret',
    'control-api-secrets',
    '-n',
    'control-plane',
    '-o',
    'jsonpath={.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}',
  ]).replace(/'/g, '')
  const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8')

  return jwt.sign(
    {
      sub: subject,
      typ: 'user',
      teamId: 'e2e-team',
      scopes,
      hostRefs,
      jti: `${subject}-${Date.now()}`,
    },
    privateKey,
    {
      algorithm: 'RS256',
      issuer: 'control-api',
      audience: 'rpc-proxy',
      expiresIn: '1h',
    }
  )
}

export async function issueRealRpcToken(scopes: string[], hostRefs: string[]): Promise<string> {
  assertRpcAuthChainReady()
  const candidateEmails = getE2ETestCandidateEmails()

  const validationHostRef = hostRefs[0] ?? 'chatllm'
  const canValidateHostStatus = scopes.includes('host:status:read')
  const failures: string[] = []

  for (const email of candidateEmails) {
    const loginRes = await fetchJson(`${EXTERNAL_REST_API_URL}/api/v1/auth/password-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: E2E_TEST_PASSWORD,
      }),
    })
    const loginData = loginRes.data as { token?: string }

    if (loginRes.status !== 200 || !loginData.token) {
      failures.push(`password-login ${email} -> ${loginRes.status}`)
      continue
    }

    const rpcRes = await fetchJson(`${EXTERNAL_REST_API_URL}/api/v1/rpc/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ scopes, hostRefs }),
    })
    const rpcData = rpcRes.data as { token?: string }

    if (rpcRes.status !== 200 || !rpcData.token) {
      failures.push(`rpc-token ${email} -> ${rpcRes.status}`)
      continue
    }

    if (!canValidateHostStatus) {
      return rpcData.token
    }

    const statusRes = await authedFetchJson(
      rpcData.token,
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(validationHostRef)}/status`
    )
    if (statusRes.status === 200) {
      return rpcData.token
    }

    failures.push(`host-status ${email} -> ${statusRes.status}`)
  }

  throw new Error(
    [
      `No authorized E2E user found for host access in context "${KUBECTL_CONTEXT}".`,
      `Canonical seeded user: ${E2E_TEST_EMAIL}`,
      `Seed command: CONTEXT=${KUBECTL_CONTEXT} E2E_DEV_LOGIN_EMAIL=${E2E_TEST_EMAIL} scripts/minikube/seed-test-data.sh`,
      `Failures: ${failures.join('; ')}`,
    ].join('\n')
  )
}

export async function authedFetchJson(
  token: string,
  url: string,
  opts?: RequestInit
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...((opts?.headers as Record<string, string> | undefined) ?? {}),
  }
  return fetchJson(url, { ...opts, headers })
}

export async function sendAuthedMessage(
  token: string,
  content: string,
  opts?: {
    hostRef?: string
    channelId?: string
    userId?: string
    channelType?: string
    async?: boolean
  }
): Promise<{ status: number; data: any }> {
  const sender = opts?.userId ?? 'test-user'
  return authedFetchJson(token, `${MCP_HOST_URL}/v1/runtime/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      hostRef: opts?.hostRef ?? 'chatllm',
      channelId: opts?.channelId ?? 'test-channel',
      sender,
      channelType: opts?.channelType ?? 'telegram',
      timestamp: new Date().toISOString(),
      messageId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      async: opts?.async,
    }),
  })
}

export async function sendRpcHostMessage(
  token: string,
  content: string,
  opts?: {
    hostRef?: string
    channelId?: string
    userId?: string
    channelType?: string
    async?: boolean
  }
): Promise<{ status: number; data: any }> {
  const hostRef = opts?.hostRef ?? 'chatllm'
  const sender = opts?.userId ?? 'test-user'
  const search = opts?.async ? '?async=true' : ''
  return authedFetchJson(
    token,
    `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/messages${search}`,
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        hostRef,
        channelId: opts?.channelId ?? 'test-channel',
        sender,
        channelType: opts?.channelType ?? 'telegram',
        timestamp: new Date().toISOString(),
        messageId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    }
  )
}

export async function getAuthedStatus(token: string): Promise<any> {
  const { data } = await authedFetchJson(token, `${MCP_HOST_URL}/v1/runtime/status`)
  return data
}

export async function getRpcHostStatus(token: string, hostRef = 'chatllm'): Promise<any> {
  const { data } = await authedFetchJson(
    token,
    `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/status`
  )
  return data
}

export async function waitForAuthedIdle(token: string, timeoutMs = 30_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getAuthedStatus(token)
    if (status.agent?.state === 'idle') return status
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Agent did not return to idle within timeout')
}

export async function waitForRpcHostIdle(
  token: string,
  timeoutMs = 30_000,
  hostRef = 'chatllm'
): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getRpcHostStatus(token, hostRef)
    if (status.agent?.state === 'idle') return status
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('RPC host did not return to idle within timeout')
}

export async function getRpcTaskResult(
  token: string,
  taskId: string,
  timeoutMs = 60_000,
  hostRef = 'chatllm'
): Promise<{ status: number; data: any }> {
  const url = `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/tasks/${encodeURIComponent(taskId)}/result`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await authedFetchJson(token, url)
    if (res.data?.status === 'completed' || res.data?.response) {
      return res
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return authedFetchJson(token, url)
}

export function kubectlExecInChatllm(cmd: string): string {
  return kubectl(`exec -n mcp-host deploy/chatllm -- sh -c "${cmd.replace(/"/g, '\\"')}"`)
}
