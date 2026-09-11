import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContextLogger } from './logger'

describe('HostContextLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flattens Error fields so { err } is not empty', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = new HostContextLogger({ module: 'readiness' })
    log.error('readiness detail check failed', { err: new Error('detail unavailable') })

    expect(errorLog).toHaveBeenCalled()
    const payload = JSON.parse(String(errorLog.mock.calls[0][0])) as {
      msg: string
      err: { name: string; message: string }
    }
    expect(payload.msg).toBe('readiness detail check failed')
    expect(payload.err).toEqual({ name: 'Error', message: 'detail unavailable' })
    expect(payload).not.toHaveProperty('stack')
  })
})
