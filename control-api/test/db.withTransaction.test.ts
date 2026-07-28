import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return {
    connect: mockConnect,
    query: vi.fn(),
  }
})

vi.mock('pg', () => ({
  Pool: mockPoolCtor,
}))

describe('db.withTransaction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('commits successful work and releases the client for reuse', async () => {
    const { withTransaction } = await import('../src/db.js')

    await expect(withTransaction(async () => 'result')).resolves.toBe('result')

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(clientRelease).toHaveBeenCalledOnce()
    expect(clientRelease).toHaveBeenCalledWith(undefined)
  })

  it('rolls back failed work, preserves its error, and releases the client for reuse', async () => {
    const workError = new Error('work failed')
    const { withTransaction } = await import('../src/db.js')

    await expect(
      withTransaction(async () => {
        throw workError
      })
    ).rejects.toBe(workError)

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(clientRelease).toHaveBeenCalledOnce()
    expect(clientRelease).toHaveBeenCalledWith(undefined)
  })

  it('destroys the client when BEGIN fails before work can run', async () => {
    const beginError = new Error('begin failed')
    const work = vi.fn()
    clientQuery.mockRejectedValueOnce(beginError)
    const { withTransaction } = await import('../src/db.js')

    await expect(withTransaction(work)).rejects.toBe(beginError)

    expect(work).not.toHaveBeenCalled()
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN'])
    expect(clientRelease).toHaveBeenCalledOnce()
    expect(clientRelease).toHaveBeenCalledWith(beginError)
  })

  it('destroys the client when rollback fails while preserving the work error', async () => {
    const workError = new Error('work failed')
    const rollbackError = new Error('rollback response failed')
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackError
      return { rows: [], rowCount: 0 }
    })
    const { withTransaction } = await import('../src/db.js')

    await expect(
      withTransaction(async () => {
        throw workError
      })
    ).rejects.toBe(workError)

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(clientRelease).toHaveBeenCalledOnce()
    expect(clientRelease).toHaveBeenCalledWith(rollbackError)
  })

  it('destroys the client and does not roll back when the commit response fails', async () => {
    const commitError = new Error('commit response failed')
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw commitError
      return { rows: [], rowCount: 0 }
    })
    const { withTransaction } = await import('../src/db.js')

    await expect(withTransaction(async () => 'result')).rejects.toBe(commitError)

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(clientRelease).toHaveBeenCalledOnce()
    expect(clientRelease).toHaveBeenCalledWith(commitError)
  })
})
