import { describe, expect, it } from 'vitest'
import { CATALOG_KEY_SQL } from '../src/services/access/catalogProducerSql.js'

describe('Sandbox catalog duplicate classification', () => {
  it('keeps both relationship arms refillable after a duplicate-saturated batch', () => {
    const sandboxSql = CATALOG_KEY_SQL.sandbox_app

    expect(sandboxSql.match(/\(SELECT COUNT\(\*\) FROM source_[01]\) >= \$4/g)).toHaveLength(2)
    expect(sandboxSql).not.toContain('FALSE AS source_saturated')
  })
})
