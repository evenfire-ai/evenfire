import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const originalEnv = new Map<string, string | undefined>()
const envKeys = [
  'CLERUM_ENABLE_AUTH',
  'CLERUM_AUTH_JWT_PUBLIC_KEY',
  'CLERUM_AUTH_JWT_ISSUER',
  'CLERUM_AUTH_JWT_AUDIENCE',
  'CLERUM_HOST_NAME',
  'CLERUM_HOST_NAMESPACE',
  'MCP_HOST_RPC_PROXY_EDGE_TOKEN',
]
let privateKey = ''
let publicKey = ''

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKey = pair.privateKey
  publicKey = pair.publicKey
  for (const key of envKeys) originalEnv.set(key, process.env[key])
})

afterAll(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

function legacyToken(sub: string, hostRefs: string[] = ['chatllm']): string {
  return jwt.sign({ sub, typ: 'user', scopes: ['host:session:read'], hostRefs }, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: 'rpc-proxy',
    expiresIn: '5m',
  })
}

async function withServer(
  run: (baseUrl: string, search: ReturnType<typeof vi.fn>) => Promise<void>
) {
  process.env.CLERUM_ENABLE_AUTH = 'true'
  process.env.CLERUM_AUTH_JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n')
  process.env.CLERUM_AUTH_JWT_ISSUER = 'control-api'
  process.env.CLERUM_AUTH_JWT_AUDIENCE = 'rpc-proxy'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_HOST_NAMESPACE = 'mcp-host'
  process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = 'r34-test-only-edge-token'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  const search = vi.fn(async ({ userSub }: { userSub: string }) => ({
    results: [
      {
        snippet: userSub,
        session_id: 'session-1',
        timestamp: '2026-10-05T00:00:00Z',
        channel: 'rpc',
        role: 'user',
      },
    ],
    total: 1,
  }))
  server.onSessionSearch(search)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, search)
  } finally {
    await server.stop()
    vi.resetModules()
  }
}

describe('mounted session-search authority', () => {
  it('rejects unsigned legacy actor assertions before querying', async () => {
    await withServer(async (baseUrl, search) => {
      const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: {
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-user-id': 'victim-user',
        },
      })
      expect(response.status).toBe(401)
      expect(search).not.toHaveBeenCalled()
    })
  })

  it('uses the signed legacy subject and ignores a forged actor header', async () => {
    await withServer(async (baseUrl, search) => {
      const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: {
          authorization: `Bearer ${legacyToken('alice-user')}`,
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-user-id': 'victim-user',
        },
      })
      expect(response.status).toBe(200)
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ userSub: 'alice-user' }))
      expect(await response.json()).toMatchObject({ results: [{ snippet: 'alice-user' }] })
    })
  })

  it('rejects a signed legacy token bounded to a different Host', async () => {
    await withServer(async (baseUrl, search) => {
      const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: { authorization: `Bearer ${legacyToken('alice-user', ['other-host'])}` },
      })
      expect(response.status).toBe(403)
      expect(search).not.toHaveBeenCalled()
    })
  })

  it('does not downgrade a declared but unauthenticated V2 request to signed legacy', async () => {
    await withServer(async (baseUrl, search) => {
      const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: {
          authorization: `Bearer ${legacyToken('alice-user')}`,
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-user-id': 'alice-user',
          'x-clerum-edge-action-context': 'malformed-v2-envelope',
          'x-service-token': 'rpc-proxy',
        },
      })
      expect(response.status).toBe(401)
      expect(search).not.toHaveBeenCalled()
    })
  })
})
