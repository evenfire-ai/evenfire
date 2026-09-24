import { afterEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import {
  ExternalSessionBackendUnavailableError,
  externalSessionDatabaseFailure,
} from '../src/services/auth/sessionDatabaseFailure.js'

describe('external session database failure provenance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks a no-SQLSTATE transaction-acquire failure at the acquisition boundary', async () => {
    const acquireFailure = new Error('pg-pool acquisition failed')
    const connect = vi.spyOn(pool, 'connect').mockRejectedValueOnce(acquireFailure)

    await expect(
      withTransaction(async () => undefined, {
        onDatabaseFailure: externalSessionDatabaseFailure,
      })
    ).rejects.toMatchObject({
      name: 'ExternalSessionBackendUnavailableError',
      cause: acquireFailure,
    } satisfies Partial<ExternalSessionBackendUnavailableError>)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not classify a plain transaction callback error as a database outage', async () => {
    const applicationFailure = new Error('session policy invariant failed')
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const release = vi.fn()
    vi.spyOn(pool, 'connect').mockResolvedValueOnce({ query, release } as never)

    await expect(
      withTransaction(
        async () => {
          throw applicationFailure
        },
        { onDatabaseFailure: externalSessionDatabaseFailure }
      )
    ).rejects.toBe(applicationFailure)
    expect(query.mock.calls.map(([text]) => text)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(release).toHaveBeenCalledTimes(1)
  })
})
