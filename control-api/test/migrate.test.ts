import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initDb = vi.fn()
const poolEnd = vi.fn()

vi.mock('../src/db.js', () => ({
  initDb,
  pool: {
    end: poolEnd,
  },
}))

describe('migrate entrypoint', () => {
  const originalExitCode = process.exitCode

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.exitCode = undefined
    initDb.mockResolvedValue(undefined)
    poolEnd.mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('runs initDb and closes the pool on success', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('../src/migrate.js')
    await new Promise(resolve => setImmediate(resolve))

    expect(initDb).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBeUndefined()
    expect(infoSpy).toHaveBeenCalledWith('[ControlAPI:Migrate] Starting DB migration')
    expect(infoSpy).toHaveBeenCalledWith('[ControlAPI:Migrate] DB migration complete')
    expect(errorSpy).not.toHaveBeenCalled()

    infoSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('sets exitCode=1 and still closes the pool on failure', async () => {
    const fatal = new Error('boom')
    initDb.mockRejectedValue(fatal)
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('../src/migrate.js')
    await new Promise(resolve => setImmediate(resolve))

    expect(initDb).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('[ControlAPI:Migrate] Fatal error:', fatal)

    infoSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
