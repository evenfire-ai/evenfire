import { describe, expect, it, vi } from 'vitest'
import { DevMcpServerProvider } from './k8sClient'
import type { McpServerCRD } from './types'

// k8sClient builds its API clients from the ambient kubeconfig at import time.
// Replace only that loading step with an inert loopback configuration.
vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>()
  return {
    ...actual,
    KubeConfig: class extends actual.KubeConfig {
      loadFromDefault(): void {
        this.loadFromOptions({
          clusters: [{ name: 'loopback', server: 'http://127.0.0.1:1', skipTLSVerify: true }],
          users: [{ name: 'anonymous' }],
          contexts: [{ name: 'loopback', cluster: 'loopback', user: 'anonymous' }],
          currentContext: 'loopback',
        })
      }
    },
  }
})

// McpServer CRs persisted before the field was dropped from the CRD still carry
// spec.contextRef until the apiserver prunes them, so the provider must ignore it.
function legacyServerWithContextRef(name: string, contextRef: string): McpServerCRD {
  return {
    name,
    namespace: 'dev',
    spec: {
      contextRef,
      image: `mcp/${name}:latest`,
      transport: { type: 'sse', url: `http://localhost:3001/sse`, port: 3001 },
      enabled: true,
    },
  } as unknown as McpServerCRD
}

describe('DevMcpServerProvider', () => {
  it('returns no servers for a context when CLERUM_CONTEXTS is not set, even if a server names it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new DevMcpServerProvider()
    provider.addServer(legacyServerWithContextRef('filesystem', 'dev-context'))

    await expect(provider.getServerInfosByContext('dev-context')).resolves.toEqual([])
  })

  it('does not project a legacy server-level contextRef into the curated server info', () => {
    const provider = new DevMcpServerProvider()
    provider.addServer(legacyServerWithContextRef('filesystem', 'dev-context'))

    const [info] = provider.getAllServerInfos()
    expect(info.name).toBe('filesystem')
    expect(info).not.toHaveProperty('contextRef')
  })
})
