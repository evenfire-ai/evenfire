import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(raw: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (raw === undefined) {
    delete process.env.CONTEXT_MAPPER_RUNTIME_NAMESPACES
  } else {
    process.env.CONTEXT_MAPPER_RUNTIME_NAMESPACES = raw
  }
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CONTEXT_MAPPER_RUNTIME_NAMESPACES', () => {
  it('defaults to the four platform runtime namespaces', async () => {
    const { config } = await loadConfig(undefined)

    expect(config.runtimeNamespaces).toEqual([
      'mcp-server',
      'mcp-host',
      'sandbox-recipes',
      'rpc-proxy',
    ])
  })

  // N5 regression guard: listing llm-hooks here makes ensureInfrastructurePolicies
  // emit `allow-dns-egress-llm-hooks` with podSelector: {} (namespace-wide DNS)
  // and `allow-hcc-api-egress-llm-hooks` selecting clerum.io/managed-by, which
  // hook pod templates carry. Both reach a pure `/v1` responder that declared no
  // egressBindings, contradicting "no implicit DNS". The llm-hooks baseline is
  // static (deploy/base/llm-hooks/networkpolicies.yaml) precisely so HCC's
  // namespace-wide infra pass never selects those pods.
  it('omits llm-hooks so hook pods get no implicit DNS or HCC-gateway egress (N5)', async () => {
    const { config } = await loadConfig(undefined)

    expect(config.runtimeNamespaces).not.toContain('llm-hooks')
  })

  it('honours an explicit override', async () => {
    const { config } = await loadConfig('mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui')

    expect(config.runtimeNamespaces).toEqual([
      'mcp-server',
      'sandbox-recipes',
      'rpc-proxy',
      'sandbox-ui',
    ])
  })
})
