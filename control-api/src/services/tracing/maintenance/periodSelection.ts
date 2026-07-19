import { canonicalSha256 } from './canonical.js'
import type { PeriodCostSelection, PersistedDailyCostVersion } from './contracts.js'
import { Decimal9, sumDecimals } from './decimal.js'

export function selectPeriodCosts(
  period: PeriodCostSelection['period'],
  periodStartUtc: string,
  periodEndUtc: string,
  versions: readonly PersistedDailyCostVersion[]
): PeriodCostSelection {
  const selected = versions
    .filter(version => version.key.utcDay >= periodStartUtc && version.key.utcDay < periodEndUtc)
    .sort((left, right) => left.key.utcDay.localeCompare(right.key.utcDay))
  if (selected.length === 0) throw new Error('period cost selection requires daily versions')
  const dimensions = JSON.stringify({
    ...selected[0]!.key,
    utcDay: undefined,
    currency: selected[0]!.key.currency,
  })
  if (
    selected.some(
      version =>
        JSON.stringify({ ...version.key, utcDay: undefined, currency: version.key.currency }) !==
        dimensions
    )
  ) {
    throw new Error('period cost selection cannot mix dimensions')
  }
  const components = selected.flatMap(version => version.components)
  const bucket = (name: string) =>
    sumDecimals(
      components
        .filter(component => component.allocationBucket === name)
        .map(component => Decimal9.parse(component.netAmount))
    ).toString()
  const vector = selected.map(version => ({
    utcDay: version.key.utcDay,
    id: version.id,
    rollupVersion: version.rollupVersion,
  }))
  return {
    period,
    periodStartUtc,
    periodEndUtc,
    dailyVersionVector: vector,
    sourceDailyVersionHash: canonicalSha256(vector),
    publicationState: selected.every(version => version.publicationState === 'finalized')
      ? 'finalized'
      : 'provisional',
    completenessStatus: selected.every(version => version.completenessStatus === 'complete')
      ? 'complete'
      : 'partial',
    grossAmount: sumDecimals(
      selected.map(version => Decimal9.parse(version.grossAmount))
    ).toString(),
    creditsAmount: sumDecimals(
      selected.map(version => Decimal9.parse(version.creditsAmount))
    ).toString(),
    netAmount: sumDecimals(selected.map(version => Decimal9.parse(version.netAmount))).toString(),
    overheadAmount: bucket('kube:system-overhead'),
    unallocatedAmount: bucket('kube:unallocated'),
    unsupportedAmount: bucket('unsupported'),
  }
}
