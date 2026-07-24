import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedServerConnection } from '../../types.js'
// vi.mock is hoisted above imports, so the static import resolves the mock.
import { probeHostReadyViaHealth } from '../wakeAndHold.js'

// The wake-and-hold readiness probe must use mcp-host's UNAUTHENTICATED
// /v1/runtime/health endpoint (Issue #791 §11.3), which comes up before MCP
// background init and is the same signal the Pod readiness probe uses — not
// /v1/runtime/status (edge-guarded). We mock the REST module so the probe's
// dependency is observable.
const restMock = vi.hoisted(() => ({
  forwardHostHealth: vi.fn(),
  forwardHostStatus: vi.fn(),
}))

vi.mock('../mcpHostRestService.js', () => restMock)

const HOST: ResolvedServerConnection = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: {},
}

beforeEach(() => {
  restMock.forwardHostHealth.mockReset()
  restMock.forwardHostStatus.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeHostReadyViaHealth', () => {
  it('probes /v1/runtime/health (not /v1/runtime/status) and returns true on a healthy answer', async () => {
    restMock.forwardHostHealth.mockResolvedValue({
      hostRef: 'chatllm',
      status: 'ok',
      observedAt: new Date().toISOString(),
    })

    const ready = await probeHostReadyViaHealth(HOST)

    expect(ready).toBe(true)
    expect(restMock.forwardHostHealth).toHaveBeenCalledTimes(1)
    expect(restMock.forwardHostHealth).toHaveBeenCalledWith(HOST)
    expect(restMock.forwardHostStatus).not.toHaveBeenCalled()
  })

  it('returns false when the health endpoint times out (AbortError)', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    restMock.forwardHostHealth.mockRejectedValue(abort)

    expect(await probeHostReadyViaHealth(HOST)).toBe(false)
  })

  it('returns false when the connection is refused (pod still suspended)', async () => {
    restMock.forwardHostHealth.mockRejectedValue(new TypeError('fetch failed'))

    expect(await probeHostReadyViaHealth(HOST)).toBe(false)
  })

  it('returns false when the health endpoint answers non-2xx (throws UpstreamHostError)', async () => {
    const upstream = Object.assign(new Error('Upstream host returned 503'), {
      name: 'UpstreamHostError',
      status: 503,
      bodySnippet: '',
    })
    restMock.forwardHostHealth.mockRejectedValue(upstream)

    expect(await probeHostReadyViaHealth(HOST)).toBe(false)
  })
})
