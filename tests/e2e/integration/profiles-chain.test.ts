/**
 * Integration: Profiles chain
 * external-rest-api → (auth) → control-api → rpc-proxy → mcp-host
 *
 * Requires: minikube cluster with all 4 services running and port-forwarded.
 *   make minikube-pf-desktop   (external-rest-api :8091, rpc-proxy :8094)
 *   make minikube-pf-control-ui (control-api :8090)
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CONTROL_API_URL,
  EXTERNAL_REST_API_URL,
  RPC_PROXY_URL,
  bearer,
  fetchJson,
  isServiceUp,
  postJson,
} from './helpers.integration.js'

const TEST_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL || 'test@clerum.io'
const TEST_PASSWORD = process.env.E2E_DESKTOP_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme123!'

let sessionToken = ''
let clusterAvailable = false

beforeAll(async () => {
  const [extUp, controlUp] = await Promise.all([
    isServiceUp(EXTERNAL_REST_API_URL),
    isServiceUp(CONTROL_API_URL),
  ])
  clusterAvailable = extUp && controlUp

  if (!clusterAvailable) {
    console.log('[profiles-chain] Cluster not available — tests will be skipped')
    return
  }

  // Password login (requires the test user to be seeded WITH a password — see scripts/e2e/seed-e2e-data.sh)
  const { status, data } = await postJson<{ token?: string }>(
    `${EXTERNAL_REST_API_URL}/api/v1/auth/password-login`,
    { email: TEST_EMAIL, password: TEST_PASSWORD }
  )
  if (status === 200 && data.token) {
    sessionToken = data.token
  }
})

describe('Profiles chain — external-rest-api /health', () => {
  it('responds with status ok', async () => {
    if (!clusterAvailable) return

    const { status, data } = await fetchJson<{ status: string }>(`${EXTERNAL_REST_API_URL}/health`)
    expect(status).toBe(200)
    expect(data.status).toBe('ok')
  })
})

describe('Profiles chain — password login flow', () => {
  it('issues a session token on password login', async () => {
    if (!clusterAvailable) return

    expect(sessionToken).toBeTruthy()
    expect(typeof sessionToken).toBe('string')
  })

  it('GET /api/v1/me returns user profile with valid token', async () => {
    if (!clusterAvailable || !sessionToken) return

    const { status, data } = await fetchJson<{ email: string }>(
      `${EXTERNAL_REST_API_URL}/api/v1/me`,
      { headers: bearer(sessionToken) }
    )
    expect(status).toBe(200)
    expect(data.email).toBe(TEST_EMAIL)
  })

  it('GET /api/v1/me returns 401 without token', async () => {
    if (!clusterAvailable) return

    const { status } = await fetchJson(`${EXTERNAL_REST_API_URL}/api/v1/me`)
    expect(status).toBe(401)
  })
})

describe('Profiles chain — control-api health', () => {
  it('control-api responds with 200 on /health', async () => {
    if (!clusterAvailable) return

    const { status } = await fetchJson(`${CONTROL_API_URL}/health`)
    expect(status).toBe(200)
  })
})

describe('Profiles chain — rpc-proxy reachability', () => {
  it('rpc-proxy /health responds when up', async () => {
    const rpcUp = await isServiceUp(RPC_PROXY_URL)
    if (!rpcUp) return

    const { status } = await fetchJson(`${RPC_PROXY_URL}/health`)
    expect(status).toBe(200)
  })

  it('rpc-proxy /api/v1/rpc/servers returns 401 without token', async () => {
    const rpcUp = await isServiceUp(RPC_PROXY_URL)
    if (!rpcUp) return

    const { status } = await fetchJson(`${RPC_PROXY_URL}/api/v1/rpc/servers`)
    expect(status).toBe(401)
  })
})
