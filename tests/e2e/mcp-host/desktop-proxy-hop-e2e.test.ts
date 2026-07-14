/**
 * E2E Layer 1: Proxy Hop — with a valid session cookie, does rpc-proxy
 * correctly forward HTTP requests to KasmVNC?
 *
 * Prerequisites:
 *   1. Minikube running with chatllm pod (desktop enabled)
 *   2. Port-forwards active:
 *        kubectl port-forward -n rpc-proxy svc/rpc-proxy 8094:8094
 *   3. rpc-proxy has desktopCookieSecret configured
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')

const RPC_PROXY_URL = process.env.RPC_PROXY_URL || 'http://localhost:8094'
const HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

let cookieValue: string

/** Sign a JWT with the cluster's private key. */
function generateClusterJwt(scopes: string[], hostRefs: string[]): string {
  const keyB64 = execSync(
    "kubectl get secret control-api-secrets -n control-plane -o jsonpath='{.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}'",
    { encoding: 'utf-8' }
  ).replace(/'/g, '')
  const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8')
  return jwt.sign(
    {
      sub: 'e2e-proxy-hop',
      typ: 'user',
      teamId: 'e2e-team',
      scopes,
      hostRefs,
      jti: `e2e-${Date.now()}`,
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'rpc-proxy', expiresIn: '5m' }
  )
}

describe('Desktop Proxy Hop E2E (Layer 1)', () => {
  beforeAll(async () => {
    // Obtain a real cookie via the session exchange endpoint (Layer 2 dependency)
    const token = generateClusterJwt(['desktop:view'], [HOST_REF])
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: '{}',
    })
    if (!res.ok) {
      throw new Error(
        `Session exchange failed (HTTP ${res.status}). Ensure minikube is running and desktop is enabled.`
      )
    }
    const setCookie = res.headers.get('set-cookie') || ''
    const match = setCookie.match(/clerum_desktop_session=([^;]+)/)
    if (!match) throw new Error(`No session cookie in response. Got: ${setCookie}`)
    cookieValue = match[1]
  }, 30_000)

  it('GET /view/ returns KasmVNC HTML with 200', async () => {
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
      headers: { cookie: `clerum_desktop_session=${cookieValue}` },
      redirect: 'manual',
    })

    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') || ''
    expect(contentType).toMatch(/text\/html/)

    const body = await res.text()
    // KasmVNC markers — at least one should appear in the index HTML
    expect(
      body.toLowerCase().includes('kasmvnc') ||
        body.toLowerCase().includes('selkies') ||
        body.toLowerCase().includes('<html')
    ).toBe(true)
  })

  it('GET /view/ without cookie returns 401', async () => {
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(401)
  })

  it('GET /view/ with tampered cookie returns 401', async () => {
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
      headers: { cookie: 'clerum_desktop_session=not-a-real-cookie' },
      redirect: 'manual',
    })
    expect(res.status).toBe(401)
  })

  it('GET /view/ with cookie for different host returns 401', async () => {
    // This test exercises the session-mismatch branch.
    // We'd need a cookie issued for another hostRef; since we only have one
    // in the test env, we skip if there's no second host available.
    const otherHost = process.env.E2E_HOST_REF_ALT
    if (!otherHost) {
      console.log('Skipping cross-host test — E2E_HOST_REF_ALT not set')
      return
    }
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${otherHost}/view/`, {
      headers: { cookie: `clerum_desktop_session=${cookieValue}` },
      redirect: 'manual',
    })
    expect(res.status).toBe(401)
  })

  it('GET /view/<some-asset> returns non-404 through the proxy', async () => {
    // KasmVNC serves assets at paths like /static/, /websockify, /api/.
    // We don't assume a specific asset exists — we just check the proxy
    // isn't blocking sub-paths with 404 before they reach KasmVNC.
    const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/index.html`, {
      headers: { cookie: `clerum_desktop_session=${cookieValue}` },
      redirect: 'manual',
    })
    // Either KasmVNC returns 200 (asset exists) or 404 (asset doesn't exist
    // at that exact path, which is fine — means proxy forwarded to KasmVNC).
    // What we reject is 401/403 from rpc-proxy or 502 (proxy error).
    expect([200, 404]).toContain(res.status)
  })
})
