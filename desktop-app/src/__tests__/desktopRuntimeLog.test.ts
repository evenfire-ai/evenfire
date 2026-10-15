import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopRuntimeLog } from '../desktopRuntimeLog.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Desktop structured runtime logging', () => {
  it('records level and safe error identity without serializing credential-bearing data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = Object.assign(new Error('fixture-private-session-token'), {
      code: 'EMFILE',
      status: 503,
      token: 'fixture-private-session-token',
      url: 'https://fixture-private.invalid',
    })
    desktopRuntimeLog.warn('Credential inspection failed', error)
    expect(warn).toHaveBeenCalledTimes(1)
    const output = warn.mock.calls[0][0] as string
    expect(JSON.parse(output)).toEqual({
      level: 'warn',
      service: 'desktop-app',
      message: 'Credential inspection failed',
      err: { name: 'Error', code: 'EMFILE', status: 503 },
    })
    expect(output).not.toContain('fixture-private')
    expect(output).not.toContain('stack')
  })

  it('filters levels and cannot throw into authentication when the sink fails', () => {
    vi.stubEnv('LOG_LEVEL', 'error')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('fixture-sink-error')
    })
    desktopRuntimeLog.warn('Suppressed')
    expect(warn).not.toHaveBeenCalled()
    expect(() => desktopRuntimeLog.error('Reported')).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('tolerates unknown level settings and hostile error accessors', () => {
    vi.stubEnv('LOG_LEVEL', 'constructor')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    desktopRuntimeLog.warn('Reported')
    expect(warn).toHaveBeenCalledTimes(1)
    const error = {
      get name() {
        throw new Error('fixture-accessor-failure')
      },
    }
    expect(() => desktopRuntimeLog.warn('Safe boundary', error)).not.toThrow()
  })
})
