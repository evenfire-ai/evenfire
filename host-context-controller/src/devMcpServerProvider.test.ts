import { describe, expect, it, vi } from 'vitest'
import { DevMcpServerProvider } from './k8sClient'
import type { McpServerCRD } from './types'

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
