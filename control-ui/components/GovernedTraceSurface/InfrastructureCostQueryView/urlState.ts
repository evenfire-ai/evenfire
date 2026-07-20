import type { InfrastructureCostScope } from '@lib/governedTrace'
import type { CostQueryControls } from './types'

const PARAMS = {
  scope: 'costScope',
  period: 'costPeriod',
  anchorDate: 'costDate',
  valuation: 'costValuation',
} as const

const PERIODS = new Set<CostQueryControls['period']>(['day', 'week', 'month'])
const VALUATIONS = new Set<CostQueryControls['valuation']>(['estimated', 'billed', 'variance'])
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/

type SearchParamsReader = Pick<URLSearchParams, 'get' | 'toString'>

export function infrastructureCostScopeRef(scope: InfrastructureCostScope): string {
  const dimensions = scope.dimensions
  return JSON.stringify({
    cloudProvider: dimensions.cloudProvider,
    cloudProjectId: dimensions.cloudProjectId,
    clusterLocation: dimensions.clusterLocation,
    clusterName: dimensions.clusterName,
    environment: dimensions.environment,
    namespace: dimensions.namespace,
    workloadKind: dimensions.workloadKind,
    workloadRef: dimensions.workloadRef,
    currency: dimensions.currency,
  })
}

export function readInfrastructureCostUrlState(
  searchParams: SearchParamsReader,
  fallbackDate: string
): { controls: CostQueryControls; scopeRef: string | null } {
  const periodValue = searchParams.get(PARAMS.period)
  const valuationValue = searchParams.get(PARAMS.valuation)
  const anchorDateValue = searchParams.get(PARAMS.anchorDate)
  const period = PERIODS.has(periodValue as CostQueryControls['period'])
    ? (periodValue as CostQueryControls['period'])
    : 'day'
  const valuation = VALUATIONS.has(valuationValue as CostQueryControls['valuation'])
    ? (valuationValue as CostQueryControls['valuation'])
    : 'estimated'
  const anchorDate =
    anchorDateValue && UTC_DAY.test(anchorDateValue) ? anchorDateValue : fallbackDate

  return {
    controls: {
      period,
      anchorDate,
      valuation,
      basis: valuation === 'billed' ? 'gcp_request_allocation' : 'requested_capacity',
    },
    scopeRef: searchParams.get(PARAMS.scope),
  }
}

export function buildInfrastructureCostUrl(input: {
  pathname: string
  searchParams: SearchParamsReader
  controls: CostQueryControls
  scope: InfrastructureCostScope
}): string {
  const params = new URLSearchParams(input.searchParams.toString())
  params.set(PARAMS.scope, infrastructureCostScopeRef(input.scope))
  params.set(PARAMS.period, input.controls.period)
  params.set(PARAMS.anchorDate, input.controls.anchorDate)
  params.set(PARAMS.valuation, input.controls.valuation)
  return `${input.pathname}?${params.toString()}`
}
