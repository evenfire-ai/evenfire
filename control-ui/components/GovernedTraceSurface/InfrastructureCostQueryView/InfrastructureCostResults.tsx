import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import type { InfrastructureCostResponse, InfrastructureCostSelection } from '@lib/governedTrace'
import {
  displayTraceValue as display,
  formatTraceTimestamp as formatTimestamp,
} from '../formatters'

const COST_COMPONENT_COLUMNS: TableHeaderColumn[] = [
  { key: 'component', label: 'Component', minWidth: '12rem' },
  { key: 'allocation', label: 'Allocation', minWidth: '10rem' },
  { key: 'source', label: 'Source', minWidth: '12rem' },
  { key: 'amounts', label: 'Amounts', minWidth: '12rem', align: 'right' },
]

function formatMoney(value: string | null | undefined, currency: string): string {
  if (!value) return 'Unavailable'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  try {
    return new Intl.NumberFormat(undefined, {
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 4,
      minimumFractionDigits: 2,
      style: 'currency',
    }).format(parsed)
  } catch {
    return `${currency} ${parsed.toFixed(4)}`
  }
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable'
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    signDisplay: 'always',
    style: 'percent',
  }).format(value)
}

function coverageLabel(selection: InfrastructureCostSelection): string {
  const startTime = Date.parse(`${selection.periodStartUtc}T00:00:00.000Z`)
  const endTime = Date.parse(`${selection.periodEndUtc}T00:00:00.000Z`)
  const expectedDays =
    Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime
      ? Math.round((endTime - startTime) / 86_400_000)
      : 0
  const observedDays = new Set(selection.dailyVersionVector.map(version => version.utcDay)).size
  return expectedDays ? `${observedDays} / ${expectedDays} days` : `${observedDays} days`
}

function varianceRate(response: InfrastructureCostResponse): number | null {
  if (!response.variance || !response.requestedCapacity) return null
  const estimate = Number(response.requestedCapacity.netAmount)
  const difference = Number(response.variance.netAmount)
  if (!Number.isFinite(estimate) || !Number.isFinite(difference) || estimate === 0) return null
  return difference / Math.abs(estimate)
}

function observedDayCount(selection: InfrastructureCostSelection): number {
  return new Set(selection.dailyVersionVector.map(version => version.utcDay)).size
}

function forecastConfidence(selection: InfrastructureCostSelection): 'Low' | 'Medium' | 'High' {
  const days = observedDayCount(selection)
  if (
    selection.publicationState !== 'finalized' ||
    selection.completenessStatus !== 'complete' ||
    (selection.valuationKind === 'billed' && selection.billingFreshnessStatus !== 'fresh') ||
    days < 7
  ) {
    return 'Low'
  }
  return days >= 28 ? 'High' : 'Medium'
}

function runRate(
  selection: InfrastructureCostSelection,
  days: number
): { daily: number; projected: number } | null {
  const observedDays = observedDayCount(selection)
  const netAmount = Number(selection.netAmount)
  if (observedDays === 0 || !Number.isFinite(netAmount)) return null
  const daily = netAmount / observedDays
  return { daily, projected: daily * days }
}

function CostRunRateForecast({ response }: { response: InfrastructureCostResponse }) {
  const inputs = [
    {
      label: 'Provisioned pattern',
      selection: response.requestedCapacity,
    },
    {
      label: 'GCP billed pattern',
      selection: response.gcpRequestAllocation,
    },
  ].filter(
    (entry): entry is { label: string; selection: InfrastructureCostSelection } =>
      entry.selection !== null &&
      (entry.selection.valuationKind !== 'billed' ||
        entry.selection.billingFreshnessStatus === 'fresh')
  )
  const forecasts = inputs.flatMap(entry => {
    const sevenDay = runRate(entry.selection, 7)
    const thirtyDay = runRate(entry.selection, 30)
    if (!sevenDay || !thirtyDay) return []
    return [
      {
        ...entry,
        observedDays: observedDayCount(entry.selection),
        daily: sevenDay.daily,
        sevenDay: sevenDay.projected,
        thirtyDay: thirtyDay.projected,
        confidence: forecastConfidence(entry.selection),
      },
    ]
  })
  if (forecasts.length === 0) return null

  return (
    <section aria-label="Historical cost run-rate forecast" className="cu-trace-cost-forecast">
      <div className="cu-trace-cost-card__head">
        <span className="cu-trace-cost-section-title">Historical run-rate forecast</span>
        <span className="cu-trace-cost-chip">Directional</span>
      </div>
      <div className="cu-table-wrap">
        <table className="cu-table cu-table--header-band">
          <thead>
            <tr>
              <th scope="col">Evidence basis</th>
              <th scope="col">Observed days</th>
              <th scope="col">Confidence</th>
              <th className="cu-table__cell-numeric" scope="col">
                Daily average
              </th>
              <th className="cu-table__cell-numeric" scope="col">
                7-day projection
              </th>
              <th className="cu-table__cell-numeric" scope="col">
                30-day projection
              </th>
            </tr>
          </thead>
          <tbody>
            {forecasts.map(forecast => (
              <tr key={forecast.selection.selectedBasis}>
                <td>
                  <div>{forecast.label}</div>
                  <div className="cu-table__cell-muted">{forecast.selection.selectedBasis}</div>
                </td>
                <td>{forecast.observedDays}</td>
                <td>
                  <span className="cu-trace-cost-chip">{forecast.confidence}</span>
                </td>
                <td className="cu-table__cell-numeric">
                  {formatMoney(String(forecast.daily), response.dimensions.currency)}
                </td>
                <td className="cu-table__cell-numeric">
                  {formatMoney(String(forecast.sevenDay), response.dimensions.currency)}
                </td>
                <td className="cu-table__cell-numeric">
                  {formatMoney(String(forecast.thirtyDay), response.dimensions.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cu-trace-cost-forecast__warning" role="status">
        This extrapolates persisted daily patterns. Provisioned estimates capture replica/runtime
        changes and resource requests, not measured CPU or memory utilization. GCP billed patterns
        remain subject to export lag, credits, adjustments, scaling, and future price changes.
      </div>
    </section>
  )
}

function CostNetComparisonChart({ response }: { response: InfrastructureCostResponse }) {
  if (!response.requestedCapacity || !response.gcpRequestAllocation) return null
  if (response.gcpRequestAllocation.billingFreshnessStatus !== 'fresh') return null
  const estimate = Number(response.requestedCapacity.netAmount)
  const billed = Number(response.gcpRequestAllocation.netAmount)
  if (!Number.isFinite(estimate) || !Number.isFinite(billed)) return null
  const data = [
    { billed: null, estimate, label: 'Requested' },
    { billed, estimate: null, label: 'GCP billed' },
  ]

  return (
    <div
      aria-label={`Net cost comparison. Requested capacity ${formatMoney(String(estimate), response.dimensions.currency)}; GCP billed ${formatMoney(String(billed), response.dimensions.currency)}.`}
      className="cu-trace-cost-comparison"
      role="img"
    >
      <ResponsiveContainer height="100%" width="100%">
        <BarChart data={data} layout="vertical" margin={{ bottom: 0, left: 0, right: 12, top: 0 }}>
          <CartesianGrid horizontal={false} stroke="var(--cu-border-subtle)" />
          <XAxis
            domain={[0, 'auto']}
            fontSize={10}
            stroke="var(--cu-text-muted)"
            tickFormatter={value => formatMoney(String(value), response.dimensions.currency)}
            type="number"
          />
          <YAxis
            dataKey="label"
            fontSize={11}
            stroke="var(--cu-text-muted)"
            type="category"
            width={72}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--cu-bg-elevated)',
              border: '1px solid var(--cu-border-subtle)',
              fontSize: 12,
            }}
            formatter={(value: number) => [
              formatMoney(String(value), response.dimensions.currency),
              'Net cost',
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="estimate"
            fill="var(--cu-accent)"
            name="Requested capacity"
            radius={[0, 3, 3, 0]}
          />
          <Bar dataKey="billed" fill="var(--cu-warning)" name="GCP billed" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function BasisCard({
  currency,
  missingMessage,
  selection,
  title,
}: {
  currency: string
  missingMessage: string
  selection: InfrastructureCostSelection | null
  title: string
}) {
  if (!selection) {
    return (
      <section className="cu-trace-cost-card">
        <div className="cu-trace-cost-card__head">
          <span className="cu-trace-cost-card__title">{title}</span>
          <span className="cu-trace-cost-chip">No data</span>
        </div>
        <div className="cu-empty cu-empty--compact">{missingMessage}</div>
      </section>
    )
  }

  const freshness =
    selection.valuationKind === 'billed' && selection.billingFreshnessStatus !== 'fresh'
      ? ` / ${selection.billingFreshnessStatus} import`
      : ''
  const status = `${selection.publicationState === 'finalized' ? 'Final' : 'Provisional'} / ${selection.completenessStatus}${freshness}`
  const hash = selection.sourceDailyVersionHash
    ? `${selection.sourceDailyVersionHash.slice(0, 12)}…${selection.sourceDailyVersionHash.slice(-8)}`
    : 'Unavailable'

  return (
    <section aria-label={`${title} cost summary`} className="cu-trace-cost-card">
      <div className="cu-trace-cost-card__head">
        <span className="cu-trace-cost-card__title">{title}</span>
        <span className="cu-trace-cost-chip">{status}</span>
      </div>
      <dl className="cu-trace-cost-metrics">
        <div className="cu-trace-cost-metric--primary">
          <dt>Net cost</dt>
          <dd>{formatMoney(selection.netAmount, currency)}</dd>
        </div>
        <div>
          <dt>Gross</dt>
          <dd>{formatMoney(selection.grossAmount, currency)}</dd>
        </div>
        <div>
          <dt>Credits</dt>
          <dd>{formatMoney(selection.creditsAmount, currency)}</dd>
        </div>
        <div>
          <dt>Overhead</dt>
          <dd>{formatMoney(selection.overheadAmount, currency)}</dd>
        </div>
        <div>
          <dt>Unallocated</dt>
          <dd>{formatMoney(selection.unallocatedAmount, currency)}</dd>
        </div>
        <div>
          <dt>Unsupported</dt>
          <dd>{formatMoney(selection.unsupportedAmount, currency)}</dd>
        </div>
      </dl>
      <dl className="cu-trace-cost-meta">
        <div>
          <dt>Basis</dt>
          <dd>{selection.selectedBasis}</dd>
        </div>
        <div>
          <dt>Period coverage</dt>
          <dd>{coverageLabel(selection)}</dd>
        </div>
        <div>
          <dt>Vector hash</dt>
          <dd>{hash}</dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>{formatTimestamp(selection.asOfUtc)}</dd>
        </div>
        <div>
          <dt>Billing lag</dt>
          <dd>
            {selection.billingLagHours === null
              ? 'Not billed data'
              : `${selection.billingLagHours}h`}
          </dd>
        </div>
        <div>
          <dt>Billing watermark</dt>
          <dd>
            {selection.billingExportWatermark
              ? formatTimestamp(selection.billingExportWatermark)
              : 'Unavailable'}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function ComponentsTable({
  currency,
  selection,
  title,
}: {
  currency: string
  selection: InfrastructureCostSelection | null
  title: string
}) {
  const components = selection?.components ?? []
  return (
    <section className="cu-trace-cost-components">
      <span className="cu-trace-cost-section-title">{title}</span>
      {components.length ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={COST_COMPONENT_COLUMNS} />
            </thead>
            <tbody>
              {components.map(component => (
                <tr key={component.componentKey}>
                  <td>
                    <div>{component.componentKey}</div>
                    <div className="cu-table__cell-muted">{component.resourceClass}</div>
                  </td>
                  <td>{display(component.allocationBucket)}</td>
                  <td>
                    <div>{display(component.providerService || component.priceSourceRef)}</div>
                    <div className="cu-table__cell-muted">
                      {component.priceUnitPrice && component.priceEffectiveFrom
                        ? `${component.priceUnitPrice} per ${priceUnitLabel(component.resourceClass)} · effective ${formatTimestamp(component.priceEffectiveFrom)}`
                        : display(component.providerSku || component.billingViewVersion)}
                    </div>
                  </td>
                  <td className="cu-table__cell-numeric">
                    <div>{formatMoney(component.netAmount, currency)}</div>
                    <div className="cu-table__cell-muted">
                      gross {formatMoney(component.grossAmount, currency)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cu-empty cu-empty--compact">No component rows returned for this basis.</div>
      )}
    </section>
  )
}

function priceUnitLabel(resourceClass: string): string {
  if (resourceClass === 'cpu') return 'vCPU hour'
  if (resourceClass === 'memory') return 'GiB hour'
  return 'resource unit'
}

export function InfrastructureCostResults({ response }: { response: InfrastructureCostResponse }) {
  return (
    <div aria-label="Infrastructure cost results" className="cu-trace-cost-results" role="region">
      <div className="cu-trace-cost-period">
        <span>
          {response.period} window: {response.periodStartUtc} to {response.periodEndUtc}
        </span>
        <span>
          {response.dimensions.namespace}/{response.dimensions.workloadRef} ·{' '}
          {response.dimensions.currency}
        </span>
      </div>
      <div className="cu-trace-cost-cards">
        <BasisCard
          currency={response.dimensions.currency}
          missingMessage="No approved price-backed requested-capacity versions matched this workload and period."
          selection={response.requestedCapacity}
          title="Estimated requested capacity"
        />
        <BasisCard
          currency={response.dimensions.currency}
          missingMessage="No accepted normalized GCP Billing Export versions matched this workload and period."
          selection={response.gcpRequestAllocation}
          title="GCP billed"
        />
        <section className="cu-trace-cost-card">
          <div className="cu-trace-cost-card__head">
            <span className="cu-trace-cost-card__title">Variance</span>
            <span className="cu-trace-cost-chip">Billed minus estimate</span>
          </div>
          <CostNetComparisonChart response={response} />
          {response.variance ? (
            <dl className="cu-trace-cost-metrics">
              <div>
                <dt>Net difference</dt>
                <dd>{formatMoney(response.variance.netAmount, response.dimensions.currency)}</dd>
              </div>
              <div>
                <dt>Variance rate</dt>
                <dd>{formatSignedPercent(varianceRate(response))}</dd>
              </div>
            </dl>
          ) : (
            <div className="cu-empty cu-empty--compact">
              Variance is available only when requested capacity and GCP billed coverage are
              complete for the same period.
            </div>
          )}
        </section>
      </div>
      <CostRunRateForecast response={response} />
      <ComponentsTable
        currency={response.dimensions.currency}
        selection={response.requestedCapacity}
        title="Estimated requested capacity components"
      />
      <ComponentsTable
        currency={response.dimensions.currency}
        selection={response.gcpRequestAllocation}
        title="GCP billed components"
      />
    </div>
  )
}
