import { afterEach, describe, expect, it, vi } from 'vitest'

// Every other suite injects hostResources, so none of them sees the default a
// Host gets when CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY is unset, as in
// deploy/base and the minikube overlay.

const originalEnv = process.env

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

async function defaultHostResources() {
  vi.resetModules()
  process.env = { ...originalEnv }
  delete process.env.CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY
  delete process.env.CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_MEMORY
  const { config } = await import('../config')
  return config.hostResources
}

describe('default Host container resources', () => {
  it('limits Host memory at 2Gi, room for the document reader beside the Host', async () => {
    // mcp-host's clerum__document_read admits a reader only when the Host's
    // cgroup leaves its working set plus 433 MiB of reserves plus at least
    // 128 MiB (documentRead/documentMemory.ts). An idle Host's working set is
    // 135-165 MiB, so 512Mi refused every read. 2Gi is the hosted value.
    const resources = await defaultHostResources()
    expect(resources.limits.memory).toBe('2Gi')
    // The request stays small: the limit does not reserve node memory.
    expect(resources.requests.memory).toBe('128Mi')
  })

  it('still lets an operator set the Host memory limit', async () => {
    vi.resetModules()
    process.env = { ...originalEnv, CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY: '3Gi' }
    const { config } = await import('../config')
    expect(config.hostResources.limits.memory).toBe('3Gi')
  })
})
