import { AsyncLocalStorage } from 'node:async_hooks'
import type { DbClient } from '../../db.js'
import { governedTraceQueryCount } from '../../observability/metrics.js'
import type { GovernedEventFamily } from './contracts.js'

type GovernedTraceQueryFamily = GovernedEventFamily | 'mixed'

type QueryMeterState = {
  count: number
  family: GovernedTraceQueryFamily
  source: string
}

const queryMeter = new AsyncLocalStorage<QueryMeterState>()

export function meterTracingDbClient(db: DbClient): DbClient {
  return {
    query: async (text, values) => {
      const state = queryMeter.getStore()
      if (state) state.count += 1
      return db.query(text, values)
    },
  }
}

export async function withTracingQueryMeter<T>(
  family: GovernedTraceQueryFamily,
  source: string,
  work: () => Promise<T>
): Promise<T> {
  const state: QueryMeterState = { count: 0, family, source }
  return queryMeter.run(state, async () => {
    try {
      return await work()
    } finally {
      governedTraceQueryCount.observe({ family: state.family, source: state.source }, state.count)
    }
  })
}
