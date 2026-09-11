// R4-M7 (PR #605): CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS is parsed fail-closed at
// startup. A malformed entry (missing prefix, IPv6, non-canonical network) would
// otherwise count toward the fail-closed guard while the IPv4-only LAN classifier
// silently ignores it — leaving cluster space undenied. The parser must throw so
// the process never starts with a half-open guard.
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env
const KNOB = 'CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS'

async function loadConfig(value: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  delete process.env[KNOB]
  if (value !== undefined) process.env[KNOB] = value
  return import('../config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS parsing (R4-M7)', () => {
  it('accepts a canonical IPv4 CIDR list', async () => {
    const { config } = await loadConfig('10.244.0.0/16,10.96.0.0/12')
    expect(config.clusterInternalEgressCidrs).toEqual(['10.244.0.0/16', '10.96.0.0/12'])
  })

  it('defaults to an empty list when unset', async () => {
    const { config } = await loadConfig(undefined)
    expect(config.clusterInternalEgressCidrs).toEqual([])
  })

  it('rejects a CIDR missing its prefix, naming the env var', async () => {
    await expect(loadConfig('10.96.0.0')).rejects.toThrow(/CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS/)
  })

  it('rejects an IPv6 entry (the classifier is IPv4-only)', async () => {
    await expect(loadConfig('10.96.0.0/12,fd00::/108')).rejects.toThrow(/IPv6/)
  })

  it('rejects a non-canonical network address', async () => {
    await expect(loadConfig('10.96.0.5/12')).rejects.toThrow(/non-canonical/)
  })

  it('rejects an over-broad /0', async () => {
    await expect(loadConfig('0.0.0.0/0')).rejects.toThrow(/over-broad/)
  })
})
