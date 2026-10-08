import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { type DbTransactionClient, withTransaction } from '../../db.js'

// Process-incarnation identity is distinct from reusable host/PID diagnostics.
let ownerInstance: string | undefined

/** Null means immediately busy. A persistence error propagates for sanitized fail-closed handling. */
export async function acquirePasswordWork(): Promise<{
  release: () => Promise<void>
  releaseWithin: (db: Pick<DbTransactionClient, 'query'>) => Promise<void>
} | null> {
  const owner = (ownerInstance ??= randomUUID())
  const operation = randomUUID()
  const admitted = await withTransaction(async db => {
    // This must survive a database/process crash; never use the disposable limiter pool.
    await db.query('SET LOCAL synchronous_commit = on')
    const result = await db.query(
      `INSERT INTO password_verification_work
        (singleton, operation_id, owner_instance, owner_host, owner_pid)
       VALUES (TRUE, $1, $2, $3, $4) ON CONFLICT (singleton) DO NOTHING
       RETURNING singleton`,
      [operation, owner, hostname(), process.pid]
    )
    return result.rows.length === 1
  })
  if (!admitted) return null
  const releaseOwned = async (db: Pick<DbTransactionClient, 'query'>) => {
    await db.query('SET LOCAL synchronous_commit = on')
    const result = await db.query(
      `DELETE FROM password_verification_work
       WHERE singleton AND operation_id = $1 AND owner_instance = $2 RETURNING singleton`,
      [operation, owner]
    )
    if (result.rows.length !== 1) throw new Error('password work ownership lost')
  }
  let released: Promise<void> | undefined
  return {
    // Password credential updates can release the durable owner in the same
    // transaction as their commit. If that transaction rolls back, callers
    // must fall back to release() so the persisted owner does not linger.
    releaseWithin: releaseOwned,
    release: () => {
      released ??= withTransaction(async db => {
        await releaseOwned(db)
      })
      return released
    },
  }
}
