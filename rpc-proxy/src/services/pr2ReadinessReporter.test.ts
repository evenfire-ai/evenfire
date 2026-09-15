import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPr2ReadinessReporter } from './pr2ReadinessReporter.js'

vi.mock('../config.js', () => ({
  config: {
    controlApiBaseUrl: 'http://control-api.test/api/v1',
    controlApiServiceToken: 'service-token',
  },
}))

const SOURCE = 'b'.repeat(40)

describe('PR2 readiness reporter', () => {
  beforeEach(() => {
    process.env.EVENFIRE_SOURCE_REVISION = SOURCE
    process.env.EVENFIRE_SERVICE_VERSION = '1.2.3'
    process.env.EVENFIRE_DEPLOYMENT_REVISION = 'deploy-a'
    process.env.EVENFIRE_IMAGE_REVISION = SOURCE
    process.env.PR2_READINESS_ENVIRONMENT_ID = 'test.cluster'
    process.env.PR2_READINESS_REPORT_INTERVAL_MS = '60000'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.EVENFIRE_SOURCE_REVISION
    delete process.env.EVENFIRE_SERVICE_VERSION
    delete process.env.EVENFIRE_DEPLOYMENT_REVISION
    delete process.env.EVENFIRE_IMAGE_REVISION
    delete process.env.PR2_READINESS_ENVIRONMENT_ID
    delete process.env.PR2_READINESS_REPORT_INTERVAL_MS
  })

  it('reports only rpc-proxy-owned hops with its service identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const stop = startPr2ReadinessReporter(fetchImpl)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4))
    stop()

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([, init]) => JSON.parse(String(init.body)).hop).sort()).toEqual([
      'oauth_exact_target',
      'remote_desktop_derived_view',
      'rpc_proxy_trusted_edge',
      'sandbox_derived_view',
    ])
    for (const [url, init] of calls) {
      expect(url).toBe('http://control-api.test/api/v1/internal/pr2-readiness/runtime-evidence')
      expect(new Headers(init.headers).get('x-service-token')).toBe('rpc-proxy')
    }
  })
})
