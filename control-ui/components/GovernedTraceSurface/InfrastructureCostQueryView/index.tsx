'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { IconAlertTriangle, IconInfoCircle } from '@components/icons'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import {
  getInfrastructureCostScopes,
  getInfrastructureTraceCosts,
  isTraceCostsUnavailable,
} from '@lib/governedTrace'
import type {
  InfrastructureCostQuery,
  InfrastructureCostResponse,
  InfrastructureCostScope,
  InfrastructureCostScopeCatalog,
} from '@lib/governedTrace'
import { InfrastructureCostResults } from './InfrastructureCostResults'
import type { CostQueryControls } from './types'
import {
  buildInfrastructureCostUrl,
  infrastructureCostScopeRef,
  readInfrastructureCostUrlState,
} from './urlState'

const GCP_ALLOCATION_EXPECTED_LAG_HOURS = 72

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function supportsValuation(
  scope: InfrastructureCostScope,
  valuation: CostQueryControls['valuation']
): boolean {
  if (valuation === 'variance') {
    return (
      scope.availableValuations.includes('estimated') &&
      scope.availableValuations.includes('billed')
    )
  }
  return scope.availableValuations.includes(valuation)
}

function defaultValuation(scope: InfrastructureCostScope): CostQueryControls['valuation'] {
  return scope.availableValuations.includes('estimated') ? 'estimated' : 'billed'
}

function scopeLabel(scope: InfrastructureCostScope): string {
  const { dimensions } = scope
  return `${dimensions.namespace}/${dimensions.workloadRef} · ${dimensions.workloadKind} · ${dimensions.environment}/${dimensions.clusterName} · ${dimensions.cloudProjectId} · ${dimensions.currency}`
}

function scopeKey(scope: InfrastructureCostScope): string {
  return infrastructureCostScopeRef(scope)
}

function costQuery(
  controls: CostQueryControls,
  scope: InfrastructureCostScope
): InfrastructureCostQuery {
  return { ...controls, ...scope.dimensions }
}

function billingStatus(scope: InfrastructureCostScope): string {
  if (!scope.billingExportWatermark) return 'Unavailable'
  if (scope.billingLagHours === null) return 'GCP export · freshness unavailable'
  const lag = Math.round(scope.billingLagHours * 10) / 10
  return `GCP export · ${lag}h lag`
}

function CostEvidenceLimitations({ scope }: { scope: InfrastructureCostScope }) {
  const hasEstimated = scope.availableValuations.includes('estimated')
  const hasBilled = scope.availableValuations.includes('billed')
  const limitations: string[] = []

  if (!hasEstimated) {
    limitations.push(
      'Provisioned-cost estimates are unavailable because no approved price-backed daily version is persisted.'
    )
  }
  if (!hasBilled) {
    limitations.push(
      'GCP billed costs and variance are unavailable because no accepted normalized Billing Export evidence is persisted.'
    )
  } else if (
    scope.billingLagHours !== null &&
    scope.billingLagHours > GCP_ALLOCATION_EXPECTED_LAG_HOURS
  ) {
    limitations.push(
      `GCP billed evidence is delayed by ${Math.round(scope.billingLagHours)} hours; review export freshness before using it for decisions.`
    )
  }
  limitations.push(
    'Provisioned forecasts use observed replica/runtime patterns and resource requests. They do not claim measured CPU or memory utilization until a metrics source is connected.'
  )

  return (
    <div className="cu-trace-cost-limitations" role="status">
      <IconAlertTriangle aria-hidden height={18} width={18} />
      <div>
        <strong>Cost evidence limitations</strong>
        <ul>
          {limitations.map(limitation => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function GcpBillingHelp() {
  return (
    <details className="cu-trace-cost-help">
      <summary>
        <IconInfoCircle aria-hidden height={18} width={18} />
        Connect GCP billing evidence
      </summary>
      <ol>
        <li>
          Enable{' '}
          <a
            href="https://cloud.google.com/kubernetes-engine/docs/how-to/cost-allocations"
            rel="noreferrer"
            target="_blank"
          >
            GKE cost allocation
          </a>{' '}
          for the target cluster.
        </li>
        <li>
          Ask a billing administrator to enable Pricing data export and Detailed Usage Cost export
          in a FinOps BigQuery dataset using the{' '}
          <a
            href="https://cloud.google.com/billing/docs/how-to/export-data-bigquery-setup"
            rel="noreferrer"
            target="_blank"
          >
            Cloud Billing export setup
          </a>
          . Those setup privileges stay outside the Evenfire runtime.
        </li>
        <li>
          Publish an approved view that uses the latest daily Pricing Export account rate for
          forward estimates and Detailed Usage Cost <code>price.effective_price</code> as the
          observed cross-check or fallback. Keep the selected source, consumption model, tier and
          pricing timestamp in the normalized source reference.
        </li>
        <li>
          Grant the maintenance workload only BigQuery job creation plus read access to that view
          through Workload Identity. Configure its query project, view and location in the reviewed
          deployment overlay, then enable cost import. Do not grant Billing Account Viewer or
          Billing Account Administrator to the runtime. Initial allocation data can take up to three
          days to appear.
        </li>
        <li>
          The public Cloud Billing Catalog/Pricing API needs no billing-account IAM permission and
          can provide a fresher list-price reference, but it requires a restricted API key and does
          not include negotiated account pricing. Evenfire therefore uses the account Pricing Export
          for promoted estimates and does not require that API key in this integration.
        </li>
      </ol>
      <p>Do not upload or store a service-account JSON key in Clerum.</p>
    </details>
  )
}

export function InfrastructureCostQueryView() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchParamsValue = searchParams.toString()
  const [controls, setControls] = useState<CostQueryControls>(
    () => readInfrastructureCostUrlState(searchParams, todayUtcDate()).controls
  )
  const [catalog, setCatalog] = useState<InfrastructureCostScopeCatalog | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [selectedScopeIndex, setSelectedScopeIndex] = useState('')
  const [response, setResponse] = useState<InfrastructureCostResponse | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getInfrastructureCostScopes()
      .then(nextCatalog => {
        if (!active) return
        setCatalog(nextCatalog)
        setCatalogStatus('loaded')
      })
      .catch(() => {
        if (active) setCatalogStatus('error')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (catalogStatus !== 'loaded' || !catalog?.scopes.length) return

    const urlState = readInfrastructureCostUrlState(
      new URLSearchParams(searchParamsValue),
      todayUtcDate()
    )
    const requestedIndex = urlState.scopeRef
      ? catalog.scopes.findIndex(scope => scopeKey(scope) === urlState.scopeRef)
      : -1
    const selectedIndex = requestedIndex >= 0 ? requestedIndex : 0
    const scope = catalog.scopes[selectedIndex]!
    const valuation = supportsValuation(scope, urlState.controls.valuation)
      ? urlState.controls.valuation
      : defaultValuation(scope)
    const nextControls: CostQueryControls = {
      ...urlState.controls,
      valuation,
      basis: valuation === 'billed' ? 'gcp_request_allocation' : 'requested_capacity',
    }
    const nextUrl = buildInfrastructureCostUrl({
      pathname,
      searchParams: new URLSearchParams(searchParamsValue),
      controls: nextControls,
      scope,
    })
    const currentUrl = searchParamsValue ? `${pathname}?${searchParamsValue}` : pathname

    setSelectedScopeIndex(String(selectedIndex))
    setControls(nextControls)
    setResponse(null)
    setStatus('idle')
    setError(null)
    if (nextUrl !== currentUrl) router.replace(nextUrl, { scroll: false })
  }, [catalog, catalogStatus, pathname, router, searchParamsValue])

  const selectedScope =
    selectedScopeIndex === '' ? null : (catalog?.scopes[Number(selectedScopeIndex)] ?? null)
  const ready = selectedScope !== null && supportsValuation(selectedScope, controls.valuation)

  function resetResult() {
    setResponse(null)
    setStatus('idle')
    setError(null)
  }

  function synchronizeUrl(nextControls: CostQueryControls, scope: InfrastructureCostScope) {
    router.replace(
      buildInfrastructureCostUrl({
        pathname,
        searchParams,
        controls: nextControls,
        scope,
      }),
      { scroll: false }
    )
  }

  function updateControl(key: keyof CostQueryControls, value: string) {
    const nextControls =
      key === 'valuation'
        ? {
            ...controls,
            valuation: value as CostQueryControls['valuation'],
            basis:
              value === 'billed'
                ? ('gcp_request_allocation' as const)
                : ('requested_capacity' as const),
          }
        : ({ ...controls, [key]: value } as CostQueryControls)
    setControls(nextControls)
    if (selectedScope) synchronizeUrl(nextControls, selectedScope)
    resetResult()
  }

  function selectScope(index: string) {
    setSelectedScopeIndex(index)
    const scope = catalog?.scopes[Number(index)]
    let nextControls = controls
    if (scope && !supportsValuation(scope, controls.valuation)) {
      const valuation = defaultValuation(scope)
      nextControls = {
        ...controls,
        valuation,
        basis: valuation === 'billed' ? 'gcp_request_allocation' : 'requested_capacity',
      }
      setControls(nextControls)
    }
    if (scope) synchronizeUrl(nextControls, scope)
    resetResult()
  }

  async function runCostQuery(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!ready || !selectedScope) return
    setStatus('loading')
    setError(null)
    try {
      setResponse(await getInfrastructureTraceCosts(costQuery(controls, selectedScope)))
      setStatus('loaded')
    } catch (readError) {
      setResponse(null)
      setError(
        isTraceCostsUnavailable(readError)
          ? 'Infrastructure cost read support is unavailable in this Control API.'
          : readError instanceof Error
            ? readError.message
            : 'Unable to read infrastructure costs.'
      )
      setStatus('error')
    }
  }

  const empty =
    status === 'loaded' && !response?.requestedCapacity && !response?.gcpRequestAllocation
  const hasEstimated = selectedScope?.availableValuations.includes('estimated') ?? false
  const hasBilled = selectedScope?.availableValuations.includes('billed') ?? false

  return (
    <section className="cu-trace-cost-panel" aria-label="Infrastructure cost query">
      <form
        aria-label="Infrastructure cost filters"
        className="cu-trace-cost-query"
        onSubmit={event => void runCostQuery(event)}
      >
        <Field htmlFor="cost-workload" label="Workload" required>
          <SelectInput
            compact
            disabled={catalogStatus !== 'loaded' || !catalog?.scopes.length}
            id="cost-workload"
            onChange={event => selectScope(event.target.value)}
            value={selectedScopeIndex}
          >
            {catalogStatus === 'loading' ? <option value="">Loading workloads…</option> : null}
            {catalogStatus === 'error' ? <option value="">Catalog unavailable</option> : null}
            {catalogStatus === 'loaded' && catalog?.scopes.length === 0 ? (
              <option value="">No persisted cost data</option>
            ) : null}
            {catalog?.scopes.map((scope, index) => (
              <option key={scopeKey(scope)} value={String(index)}>
                {scopeLabel(scope)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field htmlFor="cost-period" label="Time range" required>
          <SelectInput
            compact
            id="cost-period"
            onChange={event => updateControl('period', event.target.value)}
            value={controls.period}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </SelectInput>
        </Field>
        <Field htmlFor="cost-anchor-date" label="Date" required>
          <TextInput
            compact
            id="cost-anchor-date"
            onChange={event => updateControl('anchorDate', event.target.value)}
            type="date"
            value={controls.anchorDate}
          />
        </Field>
        <Field htmlFor="cost-valuation" label="Cost view" required>
          <SelectInput
            compact
            disabled={!selectedScope}
            id="cost-valuation"
            onChange={event => updateControl('valuation', event.target.value)}
            value={controls.valuation}
          >
            <option disabled={!hasEstimated} value="estimated">
              Estimated
            </option>
            <option disabled={!hasBilled} value="billed">
              GCP billed
            </option>
            <option disabled={!hasEstimated || !hasBilled} value="variance">
              Variance
            </option>
          </SelectInput>
        </Field>
        <div className="cu-trace-cost-query__actions">
          <Button
            disabled={!ready || status === 'loading'}
            size="sm"
            type="submit"
            variant="primary"
          >
            {status === 'loading' ? 'Loading costs…' : 'View costs'}
          </Button>
        </div>
      </form>

      {selectedScope ? (
        <>
          <dl className="cu-trace-cost-scope" aria-label="Selected workload metadata" role="group">
            <div>
              <dt>Cluster</dt>
              <dd>{selectedScope.dimensions.clusterName}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{selectedScope.dimensions.clusterLocation}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{selectedScope.dimensions.cloudProjectId}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{selectedScope.dimensions.environment}</dd>
            </div>
            <div>
              <dt>Namespace</dt>
              <dd>{selectedScope.dimensions.namespace}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{selectedScope.dimensions.currency}</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>
                {selectedScope.firstUtcDay} – {selectedScope.lastUtcDay}
              </dd>
            </div>
            <div>
              <dt>Billed data</dt>
              <dd>{billingStatus(selectedScope)}</dd>
            </div>
          </dl>
          <CostEvidenceLimitations scope={selectedScope} />
          <GcpBillingHelp />
        </>
      ) : null}

      {catalogStatus === 'error' ? (
        <div className="cu-banner cu-banner--error" role="alert">
          Unable to load persisted infrastructure cost scopes.
        </div>
      ) : null}
      {catalogStatus === 'loaded' && catalog?.scopes.length === 0 ? (
        <>
          <div className="cu-empty cu-empty--compact">
            No persisted infrastructure cost data is available. Estimates require approved price
            snapshots; GCP billed data requires Billing Export activation.
          </div>
          <GcpBillingHelp />
        </>
      ) : null}
      {catalog?.truncated ? (
        <div className="cu-banner cu-banner--warning" role="status">
          Showing the first 200 recent workload cost scopes.
        </div>
      ) : null}
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {empty ? (
        <div className="cu-empty cu-empty--compact">
          No persisted cost selection matched this workload and period.
        </div>
      ) : null}
      {response ? <InfrastructureCostResults response={response} /> : null}
    </section>
  )
}
