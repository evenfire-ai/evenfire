import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FqdnLookup,
  type FqdnLookupResult,
  defaultFqdnLookup,
  resolveExternalEgress,
} from './fqdnResolver'

const { resolve4Mock, resolve6Mock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolve6Mock: vi.fn(),
}))
vi.mock('node:dns/promises', () => ({
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}))

function dnsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`query ${code}`) as NodeJS.ErrnoException
  err.code = code
  return err
}

function fakeLookup(map: Record<string, FqdnLookupResult>): FqdnLookup {
  return vi.fn(async host => map[host] ?? { kind: 'error', error: 'unknown host' })
}

describe('resolveExternalEgress', () => {
  it('expands a fqdn entry into one /32 per A record', async () => {
    const lookup = fakeLookup({
      'api.stripe.com': {
        kind: 'ok',
        ipv4: ['93.184.216.10', '93.184.216.11'],
        ipv6: [],
        ttlSeconds: 300,
      },
    })
    const result = await resolveExternalEgress(
      [{ fqdn: 'api.stripe.com', port: 443, reason: 'Charge cards' }],
      lookup
    )
    expect(result.resolved).toEqual([
      {
        cidr: '93.184.216.10/32',
        port: 443,
        reason: 'Charge cards',
        source: { kind: 'fqdn', fqdn: 'api.stripe.com' },
        ttlSeconds: 300,
      },
      {
        cidr: '93.184.216.11/32',
        port: 443,
        reason: 'Charge cards',
        source: { kind: 'fqdn', fqdn: 'api.stripe.com' },
        ttlSeconds: 300,
      },
    ])
  })

  // AAAA records are intentionally dropped — all current deployment targets are
  // IPv4-only clusters and a /128 ipBlock would be inert. The resolver gates
  // emission so the policy builder never sees a /128 it can't enforce.
  it('drops AAAA records and emits only A-record /32 entries', async () => {
    const lookup = fakeLookup({
      'api.anthropic.com': {
        kind: 'ok',
        ipv4: ['160.79.104.10'],
        ipv6: ['2607:6bc0::10'],
        ttlSeconds: 300,
      },
    })
    const result = await resolveExternalEgress([{ fqdn: 'api.anthropic.com', port: 443 }], lookup)
    expect(result.resolved).toEqual([
      {
        cidr: '160.79.104.10/32',
        port: 443,
        reason: undefined,
        source: { kind: 'fqdn', fqdn: 'api.anthropic.com' },
        ttlSeconds: 300,
      },
    ])
    expect(result.failures).toEqual([])
  })

  it('preserves fqdn ordering across multiple entries', async () => {
    const lookup = fakeLookup({
      'api.stripe.com': { kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 },
      'ingest.sentry.io': { kind: 'ok', ipv4: ['93.184.216.20'], ipv6: [], ttlSeconds: 300 },
    })
    const result = await resolveExternalEgress(
      [
        { fqdn: 'api.stripe.com', port: 443 },
        { fqdn: 'ingest.sentry.io', port: 443 },
      ],
      lookup
    )
    expect(result.resolved.map(r => r.cidr)).toEqual(['93.184.216.10/32', '93.184.216.20/32'])
  })

  it('records a failure when fqdn resolution errors and continues with the rest', async () => {
    const lookup = fakeLookup({
      'good.example.com': { kind: 'ok', ipv4: ['93.184.216.5'], ipv6: [], ttlSeconds: 300 },
      'bad.example.com': { kind: 'error', error: 'NXDOMAIN' },
    })
    const result = await resolveExternalEgress(
      [
        { fqdn: 'good.example.com', port: 443 },
        { fqdn: 'bad.example.com', port: 443 },
      ],
      lookup
    )
    expect(result.resolved.map(r => r.cidr)).toEqual(['93.184.216.5/32'])
    expect(result.failures).toEqual([
      { fqdn: 'bad.example.com', error: 'NXDOMAIN', retryable: false },
    ])
  })

  it('treats an empty A-record set as no expansion (no entries, no failure)', async () => {
    const lookup = fakeLookup({
      'empty.example.com': { kind: 'ok', ipv4: [], ipv6: [], ttlSeconds: 0 },
    })
    const result = await resolveExternalEgress([{ fqdn: 'empty.example.com', port: 443 }], lookup)
    expect(result.resolved).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('fails closed for a hostname with any blocked A record and emits no public siblings', async () => {
    const lookup = fakeLookup({
      'mixed.example.com': {
        kind: 'ok',
        ipv4: ['93.184.216.34', '169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      },
    })
    const result = await resolveExternalEgress([{ fqdn: 'mixed.example.com', port: 443 }], lookup)
    expect(result.resolved).toEqual([])
    expect(result.failures).toEqual([
      {
        fqdn: 'mixed.example.com',
        error: 'resolved to blocked IPv4 address(es): 169.254.169.254',
        retryable: false,
      },
    ])
  })

  it('returns an empty result for an empty input', async () => {
    const result = await resolveExternalEgress([], fakeLookup({}))
    expect(result.resolved).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('propagates a retryable lookup error onto the failure entry', async () => {
    const lookup = fakeLookup({
      'flaky.example.com': { kind: 'error', error: 'DNS timeout (ETIMEOUT)', retryable: true },
    })
    const result = await resolveExternalEgress([{ fqdn: 'flaky.example.com', port: 443 }], lookup)
    expect(result.resolved).toEqual([])
    expect(result.failures).toEqual([
      { fqdn: 'flaky.example.com', error: 'DNS timeout (ETIMEOUT)', retryable: true },
    ])
  })
})

describe('defaultFqdnLookup classification', () => {
  afterEach(() => {
    resolve4Mock.mockReset()
    resolve6Mock.mockReset()
  })

  it('returns ok with A records even when AAAA has none', async () => {
    resolve4Mock.mockResolvedValue([{ address: '160.79.104.10', ttl: 300 }])
    resolve6Mock.mockRejectedValue(dnsError('ENODATA'))
    const result = await defaultFqdnLookup('api.anthropic.com')
    expect(result).toEqual({ kind: 'ok', ipv4: ['160.79.104.10'], ipv6: [], ttlSeconds: 300 })
  })

  it('B2 (H1): a TRANSIENT A-query failure with a resolving AAAA is a retryable error, not ok-empty', async () => {
    // Dual-stack host: the A query rate-limits/times out (transient) while AAAA
    // answers. IPv4 is the only rendered family, so a successful AAAA must NOT
    // mask the transient A outage into an ok-empty "name drained" answer — that
    // would age the /32 window out (silent IPv4 egress loss) instead of freezing
    // it (issue #299 H1). Pre-fix this returned { kind:'ok', ipv4:[] }.
    resolve4Mock.mockRejectedValue(dnsError('ETIMEOUT'))
    resolve6Mock.mockResolvedValue(['2607:6bc0::10'])
    const result = await defaultFqdnLookup('dual.example.com')
    expect(result).toMatchObject({ kind: 'error', retryable: true })
    expect((result as { error: string }).error).toContain('ETIMEOUT')
  })

  it('a PERMANENT A failure with a resolving AAAA stays ok (genuine AAAA-only host)', async () => {
    // Contrast with B2: a permanent A failure (NXDOMAIN/ENODATA) + AAAA present is
    // a real AAAA-only host, not a transient outage — it must stay ok (ipv4 empty).
    resolve4Mock.mockRejectedValue(dnsError('ENODATA'))
    resolve6Mock.mockResolvedValue(['2607:6bc0::10'])
    const result = await defaultFqdnLookup('v6only.example.com')
    expect(result).toMatchObject({ kind: 'ok', ipv4: [] })
  })

  it('classifies SERVFAIL as a retryable error and surfaces the code', async () => {
    resolve4Mock.mockRejectedValue(dnsError('ESERVFAIL'))
    resolve6Mock.mockRejectedValue(dnsError('ESERVFAIL'))
    const result = await defaultFqdnLookup('huggingface.co')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('expected error')
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('ESERVFAIL')
    expect(result.error).toContain('huggingface.co')
  })

  it('classifies a timeout as retryable', async () => {
    resolve4Mock.mockRejectedValue(dnsError('ETIMEOUT'))
    resolve6Mock.mockRejectedValue(dnsError('ETIMEOUT'))
    const result = await defaultFqdnLookup('api.anthropic.com')
    expect(result).toMatchObject({ kind: 'error', retryable: true })
  })

  it.each(['EFORMERR', 'ENOTIMP', 'EOF', 'ENOMEM', 'EDESTRUCTION', 'ENOTINITIALIZED'])(
    'classifies operational DNS failure %s as retryable instead of no-records',
    async code => {
      resolve4Mock.mockRejectedValue(dnsError(code))
      resolve6Mock.mockRejectedValue(dnsError(code))
      const result = await defaultFqdnLookup('resolver-broken.example.com')
      expect(result).toMatchObject({ kind: 'error', retryable: true })
      if (result.kind !== 'error') throw new Error('expected error')
      expect(result.error).toContain(code)
    }
  )

  it('treats a genuine no-records answer (ENODATA) as permanent', async () => {
    resolve4Mock.mockRejectedValue(dnsError('ENODATA'))
    resolve6Mock.mockRejectedValue(dnsError('ENODATA'))
    const result = await defaultFqdnLookup('no-records.example.com')
    expect(result).toEqual({ kind: 'error', error: 'no A or AAAA records' })
  })

  it('treats NXDOMAIN (ENOTFOUND) as permanent', async () => {
    resolve4Mock.mockRejectedValue(dnsError('ENOTFOUND'))
    resolve6Mock.mockRejectedValue(dnsError('ENOTFOUND'))
    const result = await defaultFqdnLookup('does-not-exist.example.com')
    expect(result).toEqual({ kind: 'error', error: 'no A or AAAA records' })
    expect((result as { retryable?: boolean }).retryable).toBeFalsy()
  })

  it('is retryable when any family hits a transient code even if the other is empty', async () => {
    resolve4Mock.mockRejectedValue(dnsError('ECONNREFUSED'))
    resolve6Mock.mockRejectedValue(dnsError('ENODATA'))
    const result = await defaultFqdnLookup('partial.example.com')
    expect(result).toMatchObject({ kind: 'error', retryable: true })
  })
})

// ─── issue #299: TTL propagation (feeds the sliding-window accumulator) ─────
describe('defaultFqdnLookup TTL propagation (issue #299)', () => {
  afterEach(() => {
    resolve4Mock.mockReset()
    resolve6Mock.mockReset()
  })

  it('requests per-record TTLs via resolve4({ ttl: true })', async () => {
    resolve4Mock.mockResolvedValue([{ address: '140.82.112.3', ttl: 18 }])
    resolve6Mock.mockRejectedValue(dnsError('ENODATA'))
    await defaultFqdnLookup('api.github.com')
    expect(resolve4Mock).toHaveBeenCalledWith('api.github.com', { ttl: true })
  })

  it('reports the MINIMUM TTL across A records (the whole fqdn window)', async () => {
    resolve4Mock.mockResolvedValue([
      { address: '140.82.112.3', ttl: 18 },
      { address: '140.82.112.4', ttl: 12 },
    ])
    resolve6Mock.mockRejectedValue(dnsError('ENODATA'))
    const result = await defaultFqdnLookup('api.github.com')
    expect(result).toEqual({
      kind: 'ok',
      ipv4: ['140.82.112.3', '140.82.112.4'],
      ipv6: [],
      ttlSeconds: 12,
    })
  })
})

describe('resolveExternalEgress TTL propagation (issue #299)', () => {
  it('stamps the fqdn TTL onto every resolved /32 entry', async () => {
    const lookup = fakeLookup({
      'api.github.com': {
        kind: 'ok',
        ipv4: ['140.82.112.3', '140.82.112.4'],
        ipv6: [],
        ttlSeconds: 15,
      },
    })
    const result = await resolveExternalEgress([{ fqdn: 'api.github.com', port: 443 }], lookup)
    expect(result.resolved).toEqual([
      {
        cidr: '140.82.112.3/32',
        port: 443,
        reason: undefined,
        source: { kind: 'fqdn', fqdn: 'api.github.com' },
        ttlSeconds: 15,
      },
      {
        cidr: '140.82.112.4/32',
        port: 443,
        reason: undefined,
        source: { kind: 'fqdn', fqdn: 'api.github.com' },
        ttlSeconds: 15,
      },
    ])
  })
})
