/**
 * E2E Layer 2: Auth Flow — does the full JWT → session → cookie chain work?
 *
 * Prerequisites:
 *   1. Minikube running
 *   2. Port-forwards: rpc-proxy:8094, host-context-controller:8081
 *   3. Host CRD chatllm has spec.desktop enabled
 */
import { describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')

const RPC_PROXY_URL = process.env.RPC_PROXY_URL || 'http://localhost:8094'
const HCC_URL = process.env.HCC_URL || 'http://localhost:8081'
const HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

function generateClusterJwt(scopes: string[], hostRefs: string[]): string {
  const keyB64 = execSync(
    "kubectl get secret control-api-secrets -n control-plane -o jsonpath='{.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}'",
    { encoding: 'utf-8' }
  ).replace(/'/g, '')
  const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8')
  return jwt.sign(
    {
      sub: 'e2e-auth',
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

describe('Desktop Auth Flow E2E (Layer 2)', () => {
  describe('Happy path', () => {
    it('JWT → session → cookie → view chain succeeds', async () => {
      const token = generateClusterJwt(['desktop:view'], [HOST_REF])

      // Step 1: Status check
      const statusRes = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      // (Note: status route on rpc-proxy may or may not exist; HCC owns this.
      // Layer 2 proves the session flow works.)

      // Step 2: Session exchange
      const sessionRes = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/session`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      expect(sessionRes.status).toBe(200)
      const sessionBody = await sessionRes.json()
      expect(sessionBody.ok).toBe(true)
      expect(sessionBody.hostRef).toBe(HOST_REF)

      const setCookie = sessionRes.headers.get('set-cookie') || ''
      const match = setCookie.match(/clerum_desktop_session=([^;]+)/)
      expect(match).not.toBeNull()
      const cookieValue = match![1]

      // Step 3: View with cookie succeeds
      const viewRes = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
        headers: { cookie: `clerum_desktop_session=${cookieValue}` },
      })
      expect(viewRes.status).toBe(200)
    }, 30_000)
  })

  describe('Negative cases', () => {
    it('returns 401 when no JWT on session request', async () => {
      const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(401)
    })

    it('returns 403 when JWT lacks desktop:view scope', async () => {
      const token = generateClusterJwt(['host:status:read'], [HOST_REF])
      const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/session`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      expect(res.status).toBe(403)
    })

    it('returns 403 when hostRef not in JWT hostRefs', async () => {
      const token = generateClusterJwt(['desktop:view'], ['other-host'])
      const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/session`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      expect(res.status).toBe(403)
    })

    it('returns 401 when no cookie on view request', async () => {
      const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
        redirect: 'manual',
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when tampered cookie on view request', async () => {
      const res = await fetch(`${RPC_PROXY_URL}/api/v1/desktop/${HOST_REF}/view/`, {
        headers: { cookie: 'clerum_desktop_session=garbage' },
        redirect: 'manual',
      })
      expect(res.status).toBe(401)
    })
  })
})
