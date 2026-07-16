import { afterEach, describe, expect, it, vi } from 'vitest'

describe('config.k8sApiCidrs', () => {
  afterEach(() => {
    vi.resetModules()
    delete process.env.CONTEXT_MAPPER_K8S_API_CIDRS
  })

  it('is [] when CONTEXT_MAPPER_K8S_API_CIDRS is unset', async () => {
    delete process.env.CONTEXT_MAPPER_K8S_API_CIDRS
    const { config } = await import('../src/config')
    expect(config.k8sApiCidrs).toEqual([])
  })

  it('parses a comma-separated value', async () => {
    process.env.CONTEXT_MAPPER_K8S_API_CIDRS = '203.0.113.1/32,10.128.0.2/32'
    const { config } = await import('../src/config')
    expect(config.k8sApiCidrs).toEqual(['203.0.113.1/32', '10.128.0.2/32'])
  })

  it('crashes module load on an over-broad value (fail-closed)', async () => {
    process.env.CONTEXT_MAPPER_K8S_API_CIDRS = '0.0.0.0/0'
    await expect(import('../src/config')).rejects.toThrow(/over-broad/)
  })
})
