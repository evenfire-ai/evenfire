import { describe, expect, it, vi } from 'vitest'
import { readMcpHostPodDriftStateIfExists } from './pluginWorkloadSdkPodDrift'

const POD_NAME = 'demo-mcp-host'
const NAMESPACE = 'sandbox-recipes'

describe('readMcpHostPodDriftStateIfExists', () => {
  it('reads the mcp-host container image by name instead of by position', async () => {
    const coreApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        metadata: {},
        spec: {
          containers: [
            { name: 'sidecar', image: 'registry.example/sidecar:old' },
            { name: 'mcp-host', image: 'registry.example/mcp-host:current' },
          ],
        },
      }),
    }

    await expect(
      readMcpHostPodDriftStateIfExists(coreApi as never, POD_NAME, NAMESPACE)
    ).resolves.toEqual({
      image: 'registry.example/mcp-host:current',
      deleting: false,
    })
  })

  it('marks a terminating pod as deleting', async () => {
    const coreApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        metadata: { deletionTimestamp: '2026-06-19T18:00:00Z' },
        spec: { containers: [{ name: 'mcp-host', image: 'registry.example/mcp-host:current' }] },
      }),
    }

    await expect(
      readMcpHostPodDriftStateIfExists(coreApi as never, POD_NAME, NAMESPACE)
    ).resolves.toEqual({
      image: 'registry.example/mcp-host:current',
      deleting: true,
    })
  })

  it('reads the runtime contract hash used for same-image migrations', async () => {
    const coreApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        metadata: {
          annotations: {
            'clerum.io/plugin-workload-sdk-runtime-contract-hash': 'hash-v2',
          },
        },
        spec: { containers: [{ name: 'mcp-host', image: 'registry.example/mcp-host:current' }] },
      }),
    }

    await expect(
      readMcpHostPodDriftStateIfExists(coreApi as never, POD_NAME, NAMESPACE)
    ).resolves.toEqual({
      image: 'registry.example/mcp-host:current',
      runtimeContractHash: 'hash-v2',
      deleting: false,
    })
  })

  it('returns undefined when the pod disappeared before the drift read', async () => {
    const coreApi = {
      readNamespacedPod: vi.fn().mockRejectedValue({ code: 404 }),
    }

    await expect(
      readMcpHostPodDriftStateIfExists(coreApi as never, POD_NAME, NAMESPACE)
    ).resolves.toBeUndefined()
  })

  it('propagates non-404 Kubernetes read errors', async () => {
    const error = { code: 500, message: 'api unavailable' }
    const coreApi = {
      readNamespacedPod: vi.fn().mockRejectedValue(error),
    }

    await expect(
      readMcpHostPodDriftStateIfExists(coreApi as never, POD_NAME, NAMESPACE)
    ).rejects.toBe(error)
  })
})
