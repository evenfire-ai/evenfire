import type { InfrastructureCostQuery } from '@lib/governedTrace'

export type CostQueryControls = Pick<
  InfrastructureCostQuery,
  'period' | 'anchorDate' | 'valuation' | 'basis'
>
