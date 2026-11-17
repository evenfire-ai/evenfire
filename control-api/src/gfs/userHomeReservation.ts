import type { DbTransactionClient } from '../db.js'

/** Reserve on the locked row; a collision must not abort the surrounding transaction. */
export async function reserveUserHomeName(
  db: DbTransactionClient,
  userId: string,
  drive: string,
  candidates: string[]
): Promise<string> {
  for (const candidate of candidates) {
    await db.query('SAVEPOINT user_home_name_reservation')
    try {
      await db.query(
        'UPDATE gfs_user_homes SET drive = $2, storage_username = $3, updated_at = now() WHERE user_id = $1::uuid',
        [userId, drive, candidate]
      )
      await db.query('RELEASE SAVEPOINT user_home_name_reservation')
      return candidate
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT user_home_name_reservation')
      await db.query('RELEASE SAVEPOINT user_home_name_reservation')
      const isNameCollision =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'gfs_user_homes_name_uniq'
      if (!isNameCollision) throw error
    }
  }
  throw new Error('Unable to reserve a user home name')
}
