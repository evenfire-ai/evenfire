import { vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { pool } from '../../src/db.js'

export type TripwireQueryResult = Readonly<{ rows: unknown[]; rowCount: number }>

export type TripwireStatementHandler = (
  text: string,
  values: readonly unknown[]
) => TripwireQueryResult | Promise<TripwireQueryResult>

export type AccessTransactionTripwire = Readonly<{
  /** connect, BEGIN, COMMIT, ROLLBACK, release, autocommit and call:<label>, in order. */
  events: string[]
  /** Every external call that checked the tripwire, in order. */
  externalCalls: string[]
  openTransactions: () => number
  /** Throws when any client of the test pool is between BEGIN and its end. */
  assertOutsideTransaction: (label: string) => void
}>

const EMPTY: TripwireQueryResult = Object.freeze({ rows: [], rowCount: 0 })

/**
 * Test-only tripwire around the exported `pool` of db.ts, the default pool of
 * both `withTransaction` and `withAccessDatabaseTransaction`. Statements other
 * than BEGIN/COMMIT/ROLLBACK go to `handler`; autocommit `pool.query` calls go
 * there too. Fakes of Kubernetes and checkpoint HTTP clients call
 * `assertOutsideTransaction` so a network call made while a transaction is open
 * fails the test. Restore with `vi.restoreAllMocks()`.
 */
export function installAccessTransactionTripwire(
  handler: TripwireStatementHandler
): AccessTransactionTripwire {
  let open = 0
  const events: string[] = []
  const externalCalls: string[] = []
  vi.spyOn(pool, 'connect').mockImplementation((async () => {
    let inTransaction = false
    let released = false
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (released) throw new Error('tripwire_query_after_release')
        const statement = text.trim()
        if (statement === 'BEGIN') {
          if (inTransaction) throw new Error('tripwire_nested_begin')
          inTransaction = true
          open += 1
          events.push('BEGIN')
          return EMPTY
        }
        if (statement === 'COMMIT' || statement === 'ROLLBACK') {
          if (!inTransaction) throw new Error(`tripwire_${statement.toLowerCase()}_without_begin`)
          inTransaction = false
          open -= 1
          events.push(statement)
          return EMPTY
        }
        return handler(text, values)
      },
      release: () => {
        if (released) throw new Error('tripwire_double_release')
        released = true
        if (inTransaction) {
          inTransaction = false
          open -= 1
        }
        events.push('release')
      },
    })
    events.push('connect')
    return client
  }) as never)
  vi.spyOn(pool, 'query').mockImplementation((async (text: string, values?: unknown[]) => {
    events.push('autocommit')
    return handler(text, values ?? [])
  }) as never)
  return {
    events,
    externalCalls,
    openTransactions: () => open,
    assertOutsideTransaction: label => {
      externalCalls.push(label)
      events.push(`call:${label}`)
      if (open > 0) {
        throw new Error(`tripwire: ${label} called inside an open Postgres transaction`)
      }
    },
  }
}
