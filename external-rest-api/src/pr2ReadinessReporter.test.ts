import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPr2ReadinessReporter } from './pr2ReadinessReporter.js'

vi.mock('./config.js', () => ({
  config: {
    controlApiBaseUrl: 'http://control-api.test/api/v1',
    controlApiServiceToken: 'service-token',
  },
}))

const SOURCE = 'a'.repeat(40)

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

  it('reports only its two owned hops over the authenticated v2 internal route', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const stop = startPr2ReadinessReporter(fetchImpl)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    stop()

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([, init]) => JSON.parse(String(init.body)).hop).sort()).toEqual([
      'external_rest_delegation_transport',
      'workflow_service_edge',
    ])
    for (const [url, init] of calls) {
      expect(url).toBe('http://control-api.test/api/v1/internal/pr2-readiness/runtime-evidence')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer service-token')
      expect(new Headers(init.headers).get('x-service-token')).toBe('external-rest-api')
    }
  })
})
