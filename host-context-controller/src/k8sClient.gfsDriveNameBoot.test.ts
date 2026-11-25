import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServerProvider } from './k8sClient'

// The real provider factory runs at operator start. Only ambient kubeconfig
// loading and the process config are replaced, so the GFS factory config is
// read exactly as main.ts reads it.
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
vi.mock('./config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    channelsNamespace: 'channels',
    llmHooksNamespace: 'llm-hooks',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'rpc-proxy'],
    hostK8sRequestTimeoutMs: 30_000,
    k8sRequestTimeoutMs: 30_000,
    netPolPassHardLimitMs: 1_800_000,
    hostResyncIntervalSec: 0,
    netPolResyncIntervalSec: 0,
    netPolDefaultsResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    governedTracingEnabled: false,
  },
}))

describe('operator start validates the GFS drive name', () => {
  afterEach(() => {
    delete process.env.CONTEXT_MAPPER_GFS_DRIVE_NAME
  })

  // A lazy read would let the operator start and fail only inside a
  // GlobalFileSystem reconcile, far from where the value is configured.
  it('fails while creating the provider when the drive name is outside the alphabet', () => {
    process.env.CONTEXT_MAPPER_GFS_DRIVE_NAME = 'My_Drive'
    expect(() => createMcpServerProvider()).toThrow(/CONTEXT_MAPPER_GFS_DRIVE_NAME must match/)
  })

  it('creates the provider with a valid drive name', () => {
    process.env.CONTEXT_MAPPER_GFS_DRIVE_NAME = 'team-drive-2'
    expect(() => createMcpServerProvider()).not.toThrow()
  })
})
