import type { NormalizedGcpBillingRow } from './contracts.js'
import { parseNormalizedGcpBillingRows } from './normalizedGcpBillingRows.js'

export function adaptNormalizedGcpBillingFixture(input: {
  enabled: boolean
  rows: readonly unknown[]
}): NormalizedGcpBillingRow[] {
  if (!input.enabled) return []
  return parseNormalizedGcpBillingRows({
    rows: input.rows,
    source: 'normalized GCP billing fixture',
  })
}
