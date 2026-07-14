import { describe, expect, it, vi } from 'vitest'
import {
  isAllowedRuntimeHttpEgressCidr,
  resolveRuntimeHttpEgressCidrs,
} from '../../../src/workflow/runtimeEgressResolver'

describe('runtime egress resolver', () => {
  it('resolves declared HTTP egress hosts to stable /32 CIDRs', async () => {
    const resolve4 = vi.fn(async (host: string) => {
      if (host === 'api.example.com') return ['93.184.216.34']
      if (host === 'cdn.example.com') return ['93.184.216.35', '93.184.216.36']
      return []
    })

    await expect(
      resolveRuntimeHttpEgressCidrs(['cdn.example.com', 'api.example.com'], resolve4)
    ).resolves.toEqual(['93.184.216.34/32', '93.184.216.35/32', '93.184.216.36/32'])
  })

  it('deduplicates hosts and resolved addresses', async () => {
    const resolve4 = vi.fn(async () => ['93.184.216.34', '93.184.216.34'])

    await expect(
      resolveRuntimeHttpEgressCidrs(['api.example.com', 'api.example.com'], resolve4)
    ).resolves.toEqual(['93.184.216.34/32'])
    expect(resolve4).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a declared host cannot resolve', async () => {
    const resolve4 = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })

    await expect(resolveRuntimeHttpEgressCidrs(['api.example.com'], resolve4)).rejects.toThrow(
      'failed to resolve runtime HTTP egress host "api.example.com"'
    )
  })

  it('fails closed when a declared public hostname resolves to metadata or private ranges', async () => {
    const resolve4 = vi.fn(async () => ['169.254.169.254'])

    await expect(resolveRuntimeHttpEgressCidrs(['metadata.example.com'], resolve4)).rejects.toThrow(
      'resolved disallowed address "169.254.169.254"'
    )
  })

  it('fails closed for mixed public/private answers and does not return partial CIDRs', async () => {
    const resolve4 = vi.fn(async (host: string) =>
      host === 'mixed.example.com' ? ['104.18.1.1', '10.0.0.5'] : ['8.8.8.8']
    )

    await expect(
      resolveRuntimeHttpEgressCidrs(['safe.example.com', 'mixed.example.com'], resolve4)
    ).rejects.toThrow(/mixed\.example\.com.*disallowed address "10\.0\.0\.5"/)
  })

  it('reports every unresolved host from the bounded concurrent resolution batch', async () => {
    const resolve4 = vi.fn(async (host: string) => {
      if (host === 'down-a.example.com' || host === 'down-b.example.com') {
        throw new Error(`${host} NXDOMAIN`)
      }
      return ['8.8.8.8']
    })

    await expect(
      resolveRuntimeHttpEgressCidrs(
        ['safe.example.com', 'down-a.example.com', 'down-b.example.com'],
        resolve4
      )
    ).rejects.toThrow(/down-a\.example\.com.*down-b\.example\.com/)
  })

  it('accepts only public /32 runtime HTTP egress CIDRs', () => {
    expect(isAllowedRuntimeHttpEgressCidr('93.184.216.34/32')).toBe(true)
    expect(isAllowedRuntimeHttpEgressCidr('93.184.216.0/24')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('10.0.0.10/32')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('169.254.169.254/32')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('192.0.0.8/32')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('192.88.99.1/32')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('0.0.0.0/0')).toBe(false)
    expect(isAllowedRuntimeHttpEgressCidr('not-a-cidr')).toBe(false)
  })
})
