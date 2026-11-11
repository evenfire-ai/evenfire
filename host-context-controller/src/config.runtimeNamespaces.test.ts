import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(raw: string | undefined, minimalInfra?: string) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (raw === undefined) {
    delete process.env.CONTEXT_MAPPER_RUNTIME_NAMESPACES
  } else {
    process.env.CONTEXT_MAPPER_RUNTIME_NAMESPACES = raw
  }
  if (minimalInfra === undefined) {
    delete process.env.CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES
  } else {
    process.env.CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES = minimalInfra
  }
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CONTEXT_MAPPER_RUNTIME_NAMESPACES', () => {
  it('defaults to the deploy/base runtime namespaces, without mcp-host', async () => {
    const { config } = await loadConfig(undefined)

    expect(config.runtimeNamespaces).toEqual([
      'mcp-server',
      'sandbox-recipes',
      'rpc-proxy',
      'sandbox-ui',
    ])
    // An HCC deny-all in mcp-host blocks LLM egress; its policies are static.
    expect(config.runtimeNamespaces).not.toContain('mcp-host')
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
    const { config } = await loadConfig('mcp-server,rpc-proxy')

    expect(config.runtimeNamespaces).toEqual(['mcp-server', 'rpc-proxy'])
  })
})

describe('CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES', () => {
  it('defaults to sandbox-ui, matching deploy/base, and honours an explicit empty list', async () => {
    const unset = await loadConfig(undefined)
    expect(unset.config.minimalInfraNamespaces).toEqual(['sandbox-ui'])

    // Witness: the key is read; an explicit empty value opts every namespace out.
    const empty = await loadConfig(undefined, '')
    expect(empty.config.minimalInfraNamespaces).toEqual([])
  })
})
