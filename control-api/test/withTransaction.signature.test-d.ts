import { expectTypeOf, test } from 'vitest'
import type { Pool } from 'pg'
import { withTransaction } from '../src/db.js'

test('withTransaction accepts a pool, rather than options, as its second argument', () => {
  expectTypeOf<Parameters<typeof withTransaction>[1]>().toEqualTypeOf<Pool | undefined>()
})
