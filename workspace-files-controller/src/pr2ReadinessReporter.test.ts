import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPr2ReadinessReporter } from './pr2ReadinessReporter'

const SOURCE = 'f'.repeat(40)

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

  it('uses the WFC identity for only the WFC checkpoint hop', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const stop = startPr2ReadinessReporter({
      baseUrl: 'http://control-api.test',
      serviceToken: 'wfc-token',
      fetchImpl,
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    stop()

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://control-api.test/api/v1/internal/pr2-readiness/runtime-evidence')
    expect(new Headers(init.headers).get('x-service-token')).toBe('workspace-files-controller')
    expect(JSON.parse(String(init.body)).hop).toBe('workspace_files_controller_checkpoint')
  })
})
