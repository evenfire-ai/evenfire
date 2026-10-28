import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { type DbTransactionClient, withTransaction } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import { PasswordAdmissionError, PasswordMutationInternalError } from './passwordAdmissionError.js'
import { PASSWORD_ADMISSION_POLICY } from './passwordAdmissionState.js'

export type PasswordCommitMode = 'standard' | 'one_use_recovery'
export interface PasswordMutationLease {
  commitWith<T>(
    work: (db: DbTransactionClient) => Promise<T>,
    options: { mode: PasswordCommitMode }
  ): Promise<T>
}
export interface PasswordWorkLease {
  release(): Promise<void>
}
// Preserve the directory/admin lease name while keeping it mutation-only.
export type MemberPasswordWorkLease = PasswordMutationLease

const logger = rootLogger.child({ module: 'password-admission' })
let ownerInstance: string | undefined
let loggedOwnerInstance = false
const reservations = new WeakMap<object, PasswordMutationLease>()
const verificationLeases = new WeakMap<object, ReturnType<typeof passwordWorkOwnerIdentity>>()
const releasedVerificationLeases = new WeakSet<object>()

/** Stable process incarnation recorded beside running admission operations. */
export function passwordWorkOwnerIdentity() {
  const identity = {
    instance: (ownerInstance ??= randomUUID()),
    host: hostname(),
    pid: process.pid,
  }
  if (!loggedOwnerInstance) {
    logger.info(
      {
        event: 'password_work_process_incarnation',
        ownerInstance: identity.instance,
        ownerHost: identity.host,
        ownerPid: identity.pid,
      },
      'password work process incarnation established'
    )
    loggedOwnerInstance = true
  }
  return identity
}

export function passwordWorkLeaseIdentity(lease: PasswordWorkLease) {
  return verificationLeases.get(lease as object) ?? null
}

export async function releasePasswordWork(lease: PasswordWorkLease): Promise<void> {
  await lease.release()
  releasedVerificationLeases.add(lease as object)
}

export function passwordWorkReleaseConfirmed(lease: PasswordWorkLease): boolean {
  return releasedVerificationLeases.has(lease as object)
}

function authorityFailure() {
  return new PasswordAdmissionError(503, 2, 'authority_failure')
}
function warn(event: string, message: string) {
  logger.warn({ event }, message)
}
function sanitize(error: unknown): never {
  if (error instanceof PasswordAdmissionError || error instanceof PasswordMutationInternalError) {
    throw error
  }
  warn('password_authority_unavailable', 'password authority unavailable')
  throw authorityFailure()
}

async function reservePasswordWork() {
  const owner = passwordWorkOwnerIdentity().instance
  const operation = randomUUID()
  const admitted = await withTransaction(async db => {
    await db.query('SET LOCAL synchronous_commit = on')
    await db.query("SELECT set_config('app.password_admission_protocol', 'v2', true)")
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
    await db.query("SELECT set_config('app.password_admission_protocol', 'v2', true)")
    const result = await db.query(
      `DELETE FROM password_verification_work
       WHERE singleton AND operation_id = $1 AND owner_instance = $2 RETURNING singleton`,
      [operation, owner]
    )
    if (result.rows.length !== 1) throw new Error('password work ownership lost')
  }
  let state: 'reserved' | 'running' | 'terminal' = 'reserved'
  let released: Promise<void> | undefined
  let releaseConfirmed = false
  let terminalOperation: Promise<unknown> | undefined
  const release = () => {
    if (releaseConfirmed) return Promise.resolve()
    released ??= withTransaction(async db => {
      await releaseOwned(db)
    })
    return released
  }

  const mutation: PasswordMutationLease = {
    commitWith<T>(
      work: (db: DbTransactionClient) => Promise<T>,
      options: { mode: PasswordCommitMode }
    ) {
      // Must happen before the first await, including before borrowing a client.
      if (state !== 'reserved') return Promise.reject(authorityFailure())
      state = 'running'
      const result = (async () => {
        let acknowledged = false
        let unknown = false
        let outcome!: T
        try {
          return await withTransaction(
            async db => {
              // The owner reservation and its terminal state are acknowledged as durable.
              // Keep any credential/lifecycle mutation in this transaction under the same
              // durability contract before invoking its producer callback.
              await db.query('SET LOCAL synchronous_commit = on')
              const queryFailures = new Set<unknown>()
              const mutationDb: DbTransactionClient = {
                ...db,
                query: async (text, values) => {
                  try {
                    return await db.query(text, values)
                  } catch (error) {
                    queryFailures.add(error)
                    throw error
                  }
                },
              } as DbTransactionClient
              try {
                outcome = await work(mutationDb)
              } catch (error) {
                if (error instanceof PasswordAdmissionError || queryFailures.has(error)) {
                  throw error
                }
                throw new PasswordMutationInternalError(error)
              }
              await releaseOwned(db)
              return outcome
            },
            undefined,
            {
              onCommitAcknowledged: () => {
                acknowledged = true
                releaseConfirmed = true
              },
              onCommitOutcomeUnknown: () => {
                unknown = true
              },
            }
          )
        } catch (error) {
          if (unknown && options.mode === 'one_use_recovery') {
            warn(
              'password_recovery_commit_outcome_unknown',
              'password recovery commit outcome is unknown'
            )
            throw new PasswordAdmissionError(
              503,
              2,
              'authority_failure',
              'recovery_outcome_unknown'
            )
          }
          if (acknowledged) {
            warn(
              'password_post_commit_cleanup_failed',
              'password transaction committed; connection cleanup failed'
            )
            return outcome
          }
          throw error
        } finally {
          try {
            if (!acknowledged) {
              try {
                await release()
              } catch (error) {
                if (!unknown) throw error
                warn(
                  'password_owner_release_after_unknown_commit_failed',
                  'password owner release after unknown commit failed'
                )
              }
            }
          } finally {
            // Cleanup has been attempted, even if its disposition is unconfirmed.
            // The outer reservation wrapper must never repeat this protocol.
            state = 'terminal'
          }
        }
      })().catch(sanitize)
      terminalOperation = result
      return result
    },
  }
  const raw: PasswordWorkLease = {
    release: () => {
      state = 'terminal'
      return release()
    },
  }
  reservations.set(mutation, mutation)
  return {
    raw,
    mutation,
    finish: async () => {
      if (state === 'running') {
        // Even an internal caller that forgot to await must settle its operation.
        await terminalOperation
      } else if (state === 'reserved') {
        state = 'terminal'
        try {
          await release()
        } catch (error) {
          sanitize(error)
        }
      }
    },
  }
}

/** Raw verifier view: release after bcrypt, before credential-state completion. */
export async function acquirePasswordWork(): Promise<PasswordWorkLease | null> {
  const reservation = await reservePasswordWork()
  if (!reservation) return null
  verificationLeases.set(reservation.raw as object, passwordWorkOwnerIdentity())
  return reservation.raw
}

async function acquireMutationReservation() {
  try {
    const reservation = await reservePasswordWork()
    if (!reservation) {
      throw new PasswordAdmissionError(
        429,
        Math.ceil(PASSWORD_ADMISSION_POLICY.paceMs / 1000),
        'verification_busy'
      )
    }
    return reservation
  } catch (error) {
    if (error instanceof PasswordAdmissionError) throw error
    throw authorityFailure()
  }
}

/** Reserve before earlier admin side effects, then consume once for member work. */
export async function withPasswordWorkLease<T>(
  work: (lease: PasswordMutationLease) => Promise<T>
): Promise<T> {
  const reservation = await acquireMutationReservation()
  try {
    return await work(reservation.mutation)
  } finally {
    await reservation.finish()
  }
}

export async function runPasswordMutation<T>(
  work: (db: DbTransactionClient) => Promise<T>,
  options: { mode: PasswordCommitMode; lease?: MemberPasswordWorkLease }
): Promise<T> {
  if (options.lease) {
    const mutation = reservations.get(options.lease)
    if (!mutation) throw authorityFailure()
    return mutation.commitWith(work, options)
  }
  return withPasswordWorkLease(lease => lease.commitWith(work, options))
}
