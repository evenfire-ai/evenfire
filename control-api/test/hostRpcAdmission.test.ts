import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'

const limiter = vi.hoisted(() => ({ checkAndIncrementStrict: vi.fn() }))
vi.mock('../src/services/rateLimiterService.js', () => limiter)

const { admitHostRpc, hostRpcAdmissionBucketKey, requiresHostRpcAdmission } =
  await import('../src/services/hostRpcAdmission.js')

function admittedResult(count: number, limit = config.hostRpcAdmissionRlPerMin) {
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetMs: Date.now() + 30_000,
    windowStartMs: Date.now(),
    count,
    backendAvailable: true,
  }
}

describe('Spec 65 Host-RPC admission authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses only the verified subject in one shared bucket', async () => {
    limiter.checkAndIncrementStrict.mockResolvedValue(admittedResult(1))
    expect(hostRpcAdmissionBucketKey('subject-a')).toBe('host-rpc-admission:subject-a')
    expect(await admitHostRpc('subject-a')).toMatchObject({ status: 'allowed' })
    expect(limiter.checkAndIncrementStrict).toHaveBeenCalledWith(
      'host-rpc-admission:subject-a',
      300
    )
  })

  it('keeps message, artifact, and unrelated checkpoint operations outside this budget', () => {
    expect(requiresHostRpcAdmission('chat.message.invoke')).toBe(false)
    expect(requiresHostRpcAdmission('workflow.artifact.read')).toBe(false)
    expect(requiresHostRpcAdmission('remote_desktop.open')).toBe(false)
    expect(requiresHostRpcAdmission('host.wake')).toBe(true)
  })

  it('allows N and denies N+1 with the configured positive ceiling', async () => {
    const mutableConfig = config as typeof config & { hostRpcAdmissionRlPerMin: number }
    const original = mutableConfig.hostRpcAdmissionRlPerMin
    mutableConfig.hostRpcAdmissionRlPerMin = 3
    limiter.checkAndIncrementStrict.mockImplementation(async (_key: string, limit: number) => {
      const count = limiter.checkAndIncrementStrict.mock.calls.length
      return admittedResult(count, limit)
    })
    try {
      expect((await admitHostRpc('subject-a')).status).toBe('allowed')
      expect((await admitHostRpc('subject-a')).status).toBe('allowed')
      expect((await admitHostRpc('subject-a')).status).toBe('allowed')
      expect((await admitHostRpc('subject-a')).status).toBe('limited')
    } finally {
      mutableConfig.hostRpcAdmissionRlPerMin = original
    }
  })

  it('fails closed on thrown, missing, backend-unavailable, or inconsistent store state', async () => {
    limiter.checkAndIncrementStrict.mockRejectedValueOnce(new Error('db unavailable'))
    expect(await admitHostRpc('subject-a')).toEqual({ status: 'unavailable' })

    limiter.checkAndIncrementStrict.mockResolvedValueOnce(undefined)
    expect(await admitHostRpc('subject-a')).toEqual({ status: 'unavailable' })

    limiter.checkAndIncrementStrict.mockResolvedValueOnce({
      ...admittedResult(1),
      backendAvailable: false,
    })
    expect(await admitHostRpc('subject-a')).toEqual({ status: 'unavailable' })

    limiter.checkAndIncrementStrict.mockResolvedValueOnce({
      ...admittedResult(1),
      allowed: false,
    })
    expect(await admitHostRpc('subject-a')).toEqual({ status: 'unavailable' })
  })
})
