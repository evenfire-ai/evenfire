import { afterEach, describe, expect, it, vi } from 'vitest'

// The production verifier needs real key material; this suite is about the
// namespace settings, so the parser returns a fixed public key.
vi.mock('@clerum/jwt-key-policy', async importOriginal => ({
  ...(await importOriginal<typeof import('@clerum/jwt-key-policy')>()),
  parseVerifierMaterial: () => ({ publicPem: 'test-public-pem' }),
}))

const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  CLERUM_DEV_MODE: 'false',
  RPC_PROXY_JWT_PUBLIC_KEY: 'test-verifier-material',
  RPC_PROXY_CORS_ORIGIN: 'https://ui.example.test',
  RPC_PROXY_JWT_ISSUER: 'control-api',
  RPC_PROXY_JWT_AUDIENCE: 'rpc-proxy',
  RPC_PROXY_CONTROL_API_BASE_URL: 'http://control-api.example.test/api/v1',
  RPC_PROXY_CONTROL_API_SERVICE_TOKEN: 'test-service-token-value',
  RPC_PROXY_HCC_BASE_URL: 'http://hcc.example.test:8081',
  RPC_PROXY_HOST_NAMESPACE: 'mcp-host',
  RPC_PROXY_DESKTOP_COOKIE_SECRET: 'test-desktop-cookie-secret-32-chars',
  RPC_PROXY_SANDBOX_UI_COOKIE_SECRET: 'test-sandbox-ui-cookie-secret-32-chars',
  RPC_PROXY_OAUTH_CALLBACK_BASE_URL: 'https://oauth.example.test',
}

async function loadProductionConfig(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules()
  for (const [key, value] of Object.entries({ ...PRODUCTION_ENV, ...overrides })) {
    vi.stubEnv(key, value as string)
  }
  return (await import('../config.js')).config
}

describe('rpc-proxy production boot: MCP server namespace (A13 B-10)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('boots without RPC_PROXY_MCP_SERVER_NAMESPACE and uses mcp-server', async () => {
    const config = await loadProductionConfig({ RPC_PROXY_MCP_SERVER_NAMESPACE: '' })
    expect(config.mcpServerNamespace).toBe('mcp-server')
  })

  it('uses an explicit RPC_PROXY_MCP_SERVER_NAMESPACE', async () => {
    const config = await loadProductionConfig({ RPC_PROXY_MCP_SERVER_NAMESPACE: 'custom-mcp' })
    expect(config.mcpServerNamespace).toBe('custom-mcp')
  })

  // Liveness witness: the module really loads in production mode, where a
  // required setting that is missing still stops the boot.
  it('still refuses to boot without RPC_PROXY_HOST_NAMESPACE', async () => {
    await expect(
      loadProductionConfig({ RPC_PROXY_MCP_SERVER_NAMESPACE: '', RPC_PROXY_HOST_NAMESPACE: '' })
    ).rejects.toThrow('Missing required environment variable: RPC_PROXY_HOST_NAMESPACE')
  })
})
