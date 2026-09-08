import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { startActiveViewLease } from './activeViewLease.js'

const authorized = {} as AuthorizedActionV2

describe('active derived-view lease', () => {
  it('fails closed at the first denied live checkpoint', async () => {
    vi.useFakeTimers()
    try {
      const onDenied = vi.fn()
      const authorize = vi.fn(async () => {
        throw new Error('revoked')
      })
      const lease = startActiveViewLease(authorized, { onDenied, authorize })

      await vi.advanceTimersByTimeAsync(10_000)

      expect(authorize).toHaveBeenCalledWith(authorized.claims, authorized.bound)
      expect(onDenied).toHaveBeenCalledTimes(1)
      lease.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a connection when a checkpoint cannot settle within the hard bound', async () => {
    vi.useFakeTimers()
    try {
      const onDenied = vi.fn()
      const authorize = vi.fn(() => new Promise<AuthorizedActionV2>(() => undefined))
      const lease = startActiveViewLease(authorized, { onDenied, authorize })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(onDenied).toHaveBeenCalledTimes(1)
      lease.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
