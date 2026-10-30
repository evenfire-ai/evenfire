import { describe, expect, it } from 'vitest'
import {
  CatalogQueryObservation,
  classifyMeasuredCatalogStatement,
} from './accessCatalogQueryObservation.js'

describe('catalog query observation', () => {
  it('excludes only exact access transaction setup statements', () => {
    expect(
      classifyMeasuredCatalogStatement(
        ' SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY '
      ).classification
    ).toBe('transaction_setup')
    expect(
      classifyMeasuredCatalogStatement("SELECT set_config('statement_timeout', $1, true)")
        .classification
    ).toBe('transaction_setup')
  })

  it('counts work containing a former regex token and surfaces unknown statements', () => {
    const observation = new CatalogQueryObservation()
    expect(observation.observe("SELECT set_config('statement_timeout', $1, true); SELECT 1")).toBe(
      true
    )
    expect(observation.observe('SET TRANSACTION READ ONLY')).toBe(true)
    expect(observation.workCount).toBe(2)
    expect(observation.unexpected.map(statement => statement.text)).toEqual([
      'SET TRANSACTION READ ONLY',
    ])
  })
})
