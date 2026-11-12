import { describe, expect, it } from 'vitest'
import { isTransportNoise, withTransportRetry } from '../e2e-playwright/gfsTransportRetry'

/**
 * The GFS journeys reach the cluster through one `kubectl exec` per call, and
 * that stream can end early. The retry must absorb exactly that — and nothing
 * else, or a real failure would be retried into a false pass.
 */
describe('GFS E2E transport retry', () => {
  describe('isTransportNoise', () => {
    it('recognises a dropped exec stream', () => {
      expect(isTransportNoise(new Error('Command failed: kubectl ...\nerror: EOF'))).toBe(true)
    })

    it('recognises a dropped stream nested in an AggregateError', () => {
      // The shared harness reports a failed cleanup this way: the AggregateError
      // message does NOT carry the cause.
      const aggregate = new AggregateError(
        [new Error('Command failed: kubectl exec\nerror: EOF')],
        'failed to fully clean GFS fixture e2e-gfs-dnd-file-abc'
      )
      expect(isTransportNoise(aggregate)).toBe(true)
    })

    it('does not treat a real failure as transport noise', () => {
      expect(isTransportNoise(new Error('share_revocation_rejected'))).toBe(false)
      expect(isTransportNoise(new Error('fixture e2e-gfs-dnd-file-abc leaked'))).toBe(false)
      expect(isTransportNoise(new AggregateError([new Error('not_empty')], 'cleanup failed'))).toBe(
        false
      )
    })
  })

  describe('withTransportRetry', () => {
    it('returns the first successful result', async () => {
      await expect(withTransportRetry('probe', () => 'ok', 1)).resolves.toBe('ok')
    })

    it('retries once on a dropped stream and succeeds', async () => {
      let attempts = 0
      const result = await withTransportRetry(
        'probe',
        () => {
          attempts += 1
          if (attempts === 1) throw new Error('error: EOF')
          return 'ok'
        },
        1
      )
      expect(result).toBe('ok')
      expect(attempts).toBe(2)
    })

    it('propagates a real failure without retrying it', async () => {
      let attempts = 0
      await expect(
        withTransportRetry(
          'probe',
          () => {
            attempts += 1
            throw new Error('share_revocation_rejected')
          },
          1
        )
      ).rejects.toThrow(/share_revocation_rejected/)
      expect(attempts).toBe(1)
    })

    it('propagates a second dropped stream', async () => {
      let attempts = 0
      await expect(
        withTransportRetry(
          'probe',
          () => {
            attempts += 1
            throw new Error('error: EOF')
          },
          1
        )
      ).rejects.toThrow(/EOF/)
      expect(attempts).toBe(2)
    })
  })
})
