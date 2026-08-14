import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type {
  FetchHttp,
  FetchResult,
  ProviderFetcher,
} from '../src/services/providerNetblocks/fetcherTypes.js'
import { githubFetcher } from '../src/services/providerNetblocks/githubFetcher.js'
import { resolveProviderNetblocksCronConfig } from '../src/services/providerNetblocks/providerNetblocksConfig.js'
import type { ProviderNetblocksCmStore } from '../src/services/providerNetblocks/providerNetblocksConfigMap.js'
import {
  type TickMetrics,
  runProviderNetblocksTick,
} from '../src/services/providerNetblocks/providerNetblocksService.js'

const noopMetrics = (): TickMetrics => ({
  tick: vi.fn(),
  fetchOutcome: vi.fn(),
  fetchFailure: vi.fn(),
  lastSuccess: vi.fn(),
  cidrs: vi.fn(),
})

function fakePoolHandle(opts: { acquired?: boolean; unlockError?: Error } = {}) {
  const { acquired = true, unlockError } = opts
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] }
      if (sql.includes('pg_advisory_unlock') && unlockError) throw unlockError
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, client }
}

function fakePool(acquired = true): Pool {
  return fakePoolHandle({ acquired }).pool
}

function fakeCmStore(
  initial: { data: Record<string, string>; annotations: Record<string, string> } | null = null
) {
  let state = initial
  const write = vi.fn(async (data: Record<string, string>, hash: string) => {
    state = { data, annotations: { 'clerum.io/content-hash': hash } }
  })
  const store: ProviderNetblocksCmStore = {
    read: async () => state,
    write,
  }
  return {
    store,
    write,
    get state() {
      return state
    },
  }
}

const API_24 = [
  '192.30.252.0/22',
  '185.199.108.0/22',
  '140.82.112.0/20',
  '143.55.64.0/20',
  '20.201.28.148/32',
  '20.205.243.168/32',
  '20.87.245.6/32',
  '4.237.22.34/32',
  '4.228.31.149/32',
  '20.207.73.85/32',
  '20.27.177.116/32',
  '20.200.245.245/32',
  '20.175.192.149/32',
  '20.233.83.146/32',
  '20.29.134.17/32',
  '20.199.39.228/32',
  '20.217.135.0/32',
  '4.225.11.201/32',
  '4.208.26.200/32',
  '20.26.156.210/32',
  '172.182.252.137/32',
  '4.249.131.166/32',
  '48.202.248.39/32',
  '48.204.201.2/32',
]

// A synthetic provider-blind fetcher (source 'github' so providerBounds applies).
const syntheticFetcher = (result: FetchResult): ProviderFetcher => ({
  source: 'github',
  fetch: async () => result,
})

const okResult = (categories: Record<string, string[]>): FetchResult => ({
  kind: 'ok',
  categories,
  meta: { sourceUrl: 'https://example.test', etag: '"e1"' },
})

describe('githubFetcher', () => {
  const http = (res: {
    status: number
    headers?: Record<string, string>
    bodyText?: string
  }): FetchHttp => ({
    get: vi.fn(async () => ({
      status: res.status,
      headers: res.headers ?? {},
      bodyText: res.bodyText ?? '',
    })),
  })

  it('CA-1: parses the 5 include-listed categories and EXCLUDES actions', async () => {
    const body = JSON.stringify({
      api: ['140.82.112.0/20'],
      web: ['140.82.112.0/20'],
      git: ['140.82.112.0/20'],
      packages: ['140.82.112.0/20'],
      pages: ['185.199.108.0/22'],
      actions: ['1.2.3.4/32', '5.6.7.8/32'],
    })
    const res = await githubFetcher.fetch(
      { http: http({ status: 200, headers: { etag: '"abc"' }, bodyText: body }), log: () => {} },
      null
    )
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(Object.keys(res.categories).sort()).toEqual(['api', 'git', 'packages', 'pages', 'web'])
      expect(res.categories).not.toHaveProperty('actions')
      expect(res.meta.etag).toBe('"abc"')
    }
  })

  it('CA-2: a 304 is unchanged and the request carried If-None-Match', async () => {
    const client = http({ status: 304 })
    const res = await githubFetcher.fetch(
      { http: client, log: () => {} },
      {
        etag: '"prev"',
        categoryCounts: {},
      }
    )
    expect(res.kind).toBe('unchanged')
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls[0][1]['If-None-Match']).toBe(
      '"prev"'
    )
  })

  it('CA-3: a missing category is a loud error', async () => {
    const body = JSON.stringify({ api: ['140.82.112.0/20'], web: [], git: [], packages: [] }) // no pages
    const res = await githubFetcher.fetch(
      { http: http({ status: 200, bodyText: body }), log: () => {} },
      null
    )
    expect(res).toEqual({ kind: 'error', reason: 'github /meta missing category "pages"' })
  })
})

describe('runProviderNetblocksTick', () => {
  const http: FetchHttp = { get: async () => ({ status: 200, headers: {}, bodyText: '' }) }

  it('CA-7: single-writer — a held advisory lock skips the tick with zero fetches', async () => {
    const cm = fakeCmStore()
    const fetcher = syntheticFetcher(okResult({ api: API_24 }))
    const spy = vi.spyOn(fetcher, 'fetch')
    const result = await runProviderNetblocksTick({
      fetchers: [fetcher],
      cmStore: cm.store,
      pool: fakePool(false),
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(result).toBe('skipped_lock')
    expect(spy).not.toHaveBeenCalled()
    expect(cm.write).not.toHaveBeenCalled()
  })

  it('CA-4: no-op-on-unchanged — a second identical tick writes ZERO times', async () => {
    const cm = fakeCmStore()
    const deps = () => ({
      fetchers: [syntheticFetcher(okResult({ api: API_24 }))],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(await runProviderNetblocksTick(deps())).toBe('written')
    expect(cm.write).toHaveBeenCalledTimes(1)
    // Second run: same fetch output → same content hash → NO write.
    expect(await runProviderNetblocksTick(deps())).toBe('unchanged')
    expect(cm.write).toHaveBeenCalledTimes(1)
  })

  it('CA-5: failure isolation — a throwing fetcher never writes and the tick RESOLVES', async () => {
    const cm = fakeCmStore()
    const throwing: ProviderFetcher = {
      source: 'github',
      fetch: async () => {
        throw new Error('timeout')
      },
    }
    const result = await runProviderNetblocksTick({
      fetchers: [throwing],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(result).toBe('nothing_staged') // caught, fail-static, nothing to write
    expect(cm.write).not.toHaveBeenCalled()
  })

  it('CA-9: validation reject — a blocked CIDR rejects the source, LKG untouched', async () => {
    const cm = fakeCmStore()
    const metrics = noopMetrics()
    const result = await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: ['10.1.0.0/16'] }))], // overlaps blocked 10.0.0.0/8
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics,
    })
    expect(result).toBe('nothing_staged')
    expect(cm.write).not.toHaveBeenCalled()
    expect(metrics.fetchFailure).toHaveBeenCalledWith('github', 'validation')
  })

  it('CA-6: empty-category is rejected fail-static', async () => {
    const cm = fakeCmStore()
    const metrics = noopMetrics()
    await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: [] }))],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics,
    })
    expect(cm.write).not.toHaveBeenCalled()
    expect(metrics.fetchFailure).toHaveBeenCalledWith('github', 'empty-category')
  })

  it('CA-6b: a >50% shrink is rejected without the operator ack, accepted with it', async () => {
    const initialData = {
      'github.api.ipv4': API_24.join('\n'),
      _meta: JSON.stringify({ sources: { github: {} } }),
    }
    // Without ack: shrink to 10 ranges (< 12 = 50% of 24) is rejected fail-static.
    const cm1 = fakeCmStore({ data: initialData, annotations: { 'clerum.io/content-hash': 'H0' } })
    const m1 = noopMetrics()
    await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: API_24.slice(0, 10) }))],
      cmStore: cm1.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics: m1,
    })
    expect(cm1.write).not.toHaveBeenCalled()
    expect(m1.fetchFailure).toHaveBeenCalledWith('github', 'shrink-exceeds-50pct')

    // With ack === current content-hash: the shrink is accepted and written.
    const cm2 = fakeCmStore({
      data: initialData,
      annotations: { 'clerum.io/content-hash': 'H0', 'clerum.io/netblocks-accept-shrink': 'H0' },
    })
    await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: API_24.slice(0, 10) }))],
      cmStore: cm2.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(cm2.write).toHaveBeenCalledTimes(1)
  })

  it('CA-1b: a successful tick materializes the family-keyed CM data', async () => {
    const cm = fakeCmStore()
    await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: [...API_24, '2a0a:a440::/29'] }))],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    const data = cm.state?.data ?? {}
    expect(data['github.api.ipv4'].split('\n')).toHaveLength(24)
    expect(data['github.api.ipv6']).toBe('2a0a:a440::/29')
    expect(data['_meta']).toContain('contentHash')
  })

  it('CA-10 (M1): the unchanged steady-state exit bumps per-source lastSuccess', async () => {
    const cm = fakeCmStore()
    const deps = (metrics: TickMetrics, now: number) => ({
      fetchers: [syntheticFetcher(okResult({ api: API_24 }))],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now,
      metrics,
    })
    expect(await runProviderNetblocksTick(deps(noopMetrics(), 1000))).toBe('written')
    // Second run: identical content hash → 'unchanged' — a perfectly healthy
    // steady state. The freshness gauge MUST still advance for the source, or
    // clerum_provider_netblocks_last_success_timestamp_seconds goes stale and
    // the staleness alert fires falsely.
    const metrics = noopMetrics()
    expect(await runProviderNetblocksTick(deps(metrics, 2000))).toBe('unchanged')
    expect(metrics.lastSuccess).toHaveBeenCalledWith('github', 2000)
  })

  it('CA-11 (M1): a 304 nothing_staged exit bumps the 304 source but NEVER failed/rejected sources', async () => {
    const cm = fakeCmStore()
    const notModified: ProviderFetcher = {
      source: 'github',
      fetch: async () => ({ kind: 'unchanged' as const }),
    }
    const failing: ProviderFetcher = {
      source: 'flaky',
      fetch: async () => {
        throw new Error('timeout')
      },
    }
    const rejected: ProviderFetcher = {
      source: 'rogue',
      fetch: async () => okResult({ api: ['10.1.0.0/16'] }), // overlaps blocked 10.0.0.0/8 → rejected
    }
    const metrics = noopMetrics()
    const result = await runProviderNetblocksTick({
      fetchers: [notModified, failing, rejected],
      cmStore: cm.store,
      pool: fakePool(),
      http,
      now: 3000,
      metrics,
    })
    // nothing_staged is a MIXED bucket: all-304 (healthy) AND all-failed land
    // here. The bump must be PER-SOURCE — exactly the 304 source, nothing else.
    expect(result).toBe('nothing_staged')
    expect(cm.write).not.toHaveBeenCalled()
    expect(metrics.lastSuccess).toHaveBeenCalledTimes(1)
    expect(metrics.lastSuccess).toHaveBeenCalledWith('github', 3000)
  })

  it('OPS-9a: an advisory-unlock failure DESTROYS the pooled session — release(err), never release()', async () => {
    // pg-pool only destroys a connection on release(err) with a truthy arg. A
    // session whose pg_advisory_unlock failed still HOLDS the session-scoped lock;
    // returning it to the pool healthy wedges every replica on 'skipped_lock'.
    const cm = fakeCmStore()
    const { pool, client } = fakePoolHandle({ unlockError: new Error('unlock query failed') })
    const result = await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: API_24 }))],
      cmStore: cm.store,
      pool,
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(result).toBe('written') // the unlock failure never changes the tick outcome (§4)
    expect(client.release).toHaveBeenCalledTimes(1)
    const releaseArg = client.release.mock.calls[0][0]
    expect(releaseArg).toBeInstanceOf(Error)
  })

  it('OPS-9b: happy path — release() is called with NO error (connection returns to the pool)', async () => {
    const cm = fakeCmStore()
    const { pool, client } = fakePoolHandle()
    const result = await runProviderNetblocksTick({
      fetchers: [syntheticFetcher(okResult({ api: API_24 }))],
      cmStore: cm.store,
      pool,
      http,
      now: 1000,
      metrics: noopMetrics(),
    })
    expect(result).toBe('written')
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith() // zero args — pooled connection kept alive
  })
})

describe('resolveProviderNetblocksCronConfig (CA-8)', () => {
  it('falls back to defaults on a malformed numeric env (no NaN hot-loop)', () => {
    const warn = vi.fn()
    const cfg = resolveProviderNetblocksCronConfig(
      { PROVIDER_NETBLOCKS_REFRESH_INTERVAL_MS: 'not-a-number' },
      warn
    )
    expect(cfg.intervalMs).toBe(21_600_000)
    expect(Number.isInteger(cfg.intervalMs)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('honors a valid override and the kill switch', () => {
    const cfg = resolveProviderNetblocksCronConfig(
      { PROVIDER_NETBLOCKS_FETCHER_ENABLED: 'false', PROVIDER_NETBLOCKS_FETCH_TIMEOUT_MS: '5000' },
      vi.fn()
    )
    expect(cfg.enabled).toBe(false)
    expect(cfg.timeoutMs).toBe(5000)
    expect(cfg.intervalMs).toBe(21_600_000)
  })
})
