import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initDb = vi.fn()
const poolEnd = vi.fn()
const resolveMigrationConnectionString = vi.fn()
const loggerInfo = vi.fn()
const loggerError = vi.fn()

vi.mock('../src/db.js', () => ({
  initDb,
  pool: {
    end: poolEnd,
  },
}))

vi.mock('../src/migrationConnection.js', () => ({ resolveMigrationConnectionString }))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    child: () => ({ info: loggerInfo, error: loggerError }),
  },
}))

describe('migrate entrypoint', () => {
  const originalExitCode = process.exitCode
  const originalConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.exitCode = undefined
    initDb.mockResolvedValue(undefined)
    poolEnd.mockResolvedValue(undefined)
    resolveMigrationConnectionString.mockReturnValue('postgresql://database.example/profiles')
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    if (originalConnectionString === undefined) {
      delete process.env.CONTROL_API_PG_CONNECTION_STRING
    } else {
      process.env.CONTROL_API_PG_CONNECTION_STRING = originalConnectionString
    }
  })

  it('runs initDb and closes the pool on success', async () => {
    await import('../src/migrate.js')
    await new Promise(resolve => setImmediate(resolve))

    expect(initDb).toHaveBeenCalledTimes(1)
    expect(resolveMigrationConnectionString).toHaveBeenCalledWith(process.env)
    expect(poolEnd).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBeUndefined()
    expect(loggerInfo).toHaveBeenCalledWith('Starting database migration')
    expect(loggerInfo).toHaveBeenCalledWith('Database migration complete')
    expect(loggerError).not.toHaveBeenCalled()
  })

  it('sets exitCode=1 and still closes the pool on failure', async () => {
    const fatal = new Error('boom')
    initDb.mockRejectedValue(fatal)
    await import('../src/migrate.js')
    await new Promise(resolve => setImmediate(resolve))

    expect(initDb).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
    expect(loggerError).toHaveBeenCalledWith({ err: fatal }, 'Database migration failed')
  })
})
