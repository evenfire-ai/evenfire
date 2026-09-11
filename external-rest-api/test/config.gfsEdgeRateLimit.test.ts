import { afterEach, describe, expect, it, vi } from 'vitest'

const AGGREGATE_ENV = 'EXTERNAL_REST_API_GFS_EDGE_AGGREGATE_RL_PER_MIN'
const CLIENT_IP_ENV = 'EXTERNAL_REST_API_GFS_EDGE_AUTHENTICATED_IP_RL_PER_MIN'
const TOKEN_IP_ENV = 'EXTERNAL_REST_API_GFS_EDGE_TOKEN_IP_RL_PER_MIN'

type RawGfsEdgeLimits = {
  aggregate: string
  clientIp: string
  tokenIp: string
}

async function loadConfigWithLimits(limits: RawGfsEdgeLimits) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv(AGGREGATE_ENV, limits.aggregate)
  vi.stubEnv(CLIENT_IP_ENV, limits.clientIp)
  vi.stubEnv(TOKEN_IP_ENV, limits.tokenIp)
  return import('../src/config.js')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('external REST GFS edge rate-limit config', () => {
  it('accepts positive ordered safe integers at startup parse', async () => {
    const { config } = await loadConfigWithLimits({
      aggregate: '3',
      clientIp: '2',
      tokenIp: '1',
    })

    expect(config.externalGfsEdgeAggregateRlPerMin).toBe(3)
    expect(config.externalGfsEdgeAuthenticatedIpRlPerMin).toBe(2)
    expect(config.externalGfsEdgeTokenIpRlPerMin).toBe(1)
  })

  it.each([
    ['invalid aggregate', { aggregate: 'invalid', clientIp: '2', tokenIp: '1' }],
    ['zero aggregate', { aggregate: '0', clientIp: '2', tokenIp: '1' }],
    ['fractional client IP', { aggregate: '3', clientIp: '1.5', tokenIp: '1' }],
    ['NaN token IP', { aggregate: '3', clientIp: '2', tokenIp: 'NaN' }],
    ['unsafe token IP', { aggregate: '3', clientIp: '2', tokenIp: '9007199254740992' }],
    ['aggregate above upper bound', { aggregate: '1000001', clientIp: '2', tokenIp: '1' }],
  ] satisfies Array<[string, RawGfsEdgeLimits]>)('rejects %s', async (_label, limits) => {
    await expect(loadConfigWithLimits(limits)).rejects.toThrow(/must be (a positive integer|<=)/)
  })

  it.each([
    ['token above client IP', { aggregate: '4', clientIp: '2', tokenIp: '3' }],
    ['client IP equal to aggregate', { aggregate: '3', clientIp: '3', tokenIp: '1' }],
    ['client IP above aggregate', { aggregate: '2', clientIp: '3', tokenIp: '1' }],
  ] satisfies Array<[string, RawGfsEdgeLimits]>)(
    'rejects inverted order: %s',
    async (_label, limits) => {
      await expect(loadConfigWithLimits(limits)).rejects.toThrow(/GFS edge rate limits/)
    }
  )
})
