'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DataTable } from '@clerum/frontend-components'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { Button, SelectInput, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { getGovernedTraceEvents } from '@lib/governedTrace'
import type { GovernedTraceEvent, GovernedTracePage } from '@lib/governedTrace'
import { InfrastructureCostQueryView } from './InfrastructureCostQueryView'
import { InfrastructureOperationalSnapshot } from './InfrastructureOperationalSnapshot'
import { displayTraceValue as display, formatTraceTimestamp as formatTimestamp } from './formatters'
import type { GovernedTraceSurfaceProps, TraceDetailHrefInput } from './types'

const TRACE_COLUMNS: TableHeaderColumn[] = [
  { key: 'occurred', label: 'Occurred', minWidth: '10rem' },
  { key: 'event', label: 'Event', minWidth: '12rem' },
  { key: 'outcome', label: 'Outcome', minWidth: '7rem' },
  { key: 'provenance', label: 'Provenance', minWidth: '13rem' },
  { key: 'target', label: 'Target', minWidth: '12rem' },
]

function traceDetailHref({
  correlationRef,
  eventFamily,
  eventId,
  hostRef,
  recipeName,
  recipeNamespace,
}: TraceDetailHrefInput) {
  if (eventFamily === 'administrative') {
    return CONTROL_ROUTES.traces.administrativeEvent(eventId)
  }
  if (eventFamily === 'infrastructure_telemetry') {
    return CONTROL_ROUTES.traces.infrastructureEvent(eventId)
  }
  if (!correlationRef) return null
  if (recipeNamespace && recipeName) {
    return CONTROL_ROUTES.traces.workflowRun(recipeNamespace, recipeName, correlationRef)
  }
  if (hostRef) {
    return CONTROL_ROUTES.traces.hostRun(hostRef, correlationRef)
  }
  return null
}

type TraceTimeWindow = '24h' | '7d' | '30d'

const TRACE_TIME_WINDOWS = new Set<TraceTimeWindow>(['24h', '7d', '30d'])

function readTraceTimeWindow(searchParams: Pick<URLSearchParams, 'get'>): TraceTimeWindow {
  const value = searchParams.get('window')
  return TRACE_TIME_WINDOWS.has(value as TraceTimeWindow) ? (value as TraceTimeWindow) : '24h'
}

function buildTraceWindowUrl(
  pathname: string,
  searchParams: Pick<URLSearchParams, 'toString'>,
  window: TraceTimeWindow
): string {
  const params = new URLSearchParams(searchParams.toString())
  params.set('window', window)
  return `${pathname}?${params.toString()}`
}

function traceWindowBounds(window: TraceTimeWindow): { occurredFrom: string; occurredTo: string } {
  const occurredTo = new Date()
  const durationHours = window === '24h' ? 24 : window === '7d' ? 7 * 24 : 30 * 24
  const occurredFrom = new Date(occurredTo.getTime() - durationHours * 60 * 60 * 1000)
  return { occurredFrom: occurredFrom.toISOString(), occurredTo: occurredTo.toISOString() }
}

function traceWindowLabel(window: TraceTimeWindow): string {
  return window === '24h' ? 'Last 24 hours' : window === '7d' ? 'Last 7 days' : 'Last 30 days'
}

function isVisibleInFilter(event: GovernedTraceEvent, filter: string): boolean {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) return true
  return [
    event.correlationRef,
    event.eventType,
    event.outcome,
    event.actorSub,
    event.serviceOrAgentSub,
    event.initiatingHumanSub,
    event.sessionId,
    event.decisionActorSub,
    event.actingAgentSub,
    event.resourceAud,
    event.authorizationDecision,
    event.tokenExchangeId,
    ...event.effectiveScopes,
    event.targetRef,
    event.hostRef,
    event.recipeName,
  ].some(value => value?.toLowerCase().includes(normalized))
}

function Timeline({ events }: { events: readonly GovernedTraceEvent[] }) {
  return (
    <ol className="cu-trace-timeline" aria-label="Ordered governed events">
      {events.map(event => (
        <li className="cu-trace-timeline__item" key={`${event.eventFamily}:${event.eventId}`}>
          <div className="cu-trace-timeline__time">{formatTimestamp(event.occurredAt)}</div>
          <div className="cu-trace-timeline__content">
            <strong>{event.eventType}</strong>
            <span>{display(event.outcome)}</span>
            {event.serviceOrAgentSub ? <span>{event.serviceOrAgentSub}</span> : null}
            <dl className="cu-trace-timeline__facts">
              {event.actorSub ? (
                <div>
                  <dt>Actor</dt>
                  <dd>{event.actorSub}</dd>
                </div>
              ) : null}
              {event.eventFamily === 'agent_run' ? (
                <div>
                  <dt>Human user</dt>
                  <dd>
                    {event.initiatingHumanSub ??
                      'No authoritative human binding was persisted for this legacy run'}
                  </dd>
                </div>
              ) : null}
              {event.hostRef ? (
                <div>
                  <dt>MCP host</dt>
                  <dd>{event.hostRef}</dd>
                </div>
              ) : null}
              {event.sessionId ? (
                <div>
                  <dt>Session ID</dt>
                  <dd>{event.sessionId}</dd>
                </div>
              ) : null}
              {event.authorizationDecision && event.authorizationDecision !== 'not_applicable' ? (
                <>
                  <div>
                    <dt>Authorization decision</dt>
                    <dd>{event.authorizationDecision}</dd>
                  </div>
                  <div>
                    <dt>Decision actor</dt>
                    <dd>
                      {event.decisionActorSub ??
                        (event.authorizationDecision === 'require_approval'
                          ? 'Awaiting human decision'
                          : 'Not captured by legacy producer')}
                    </dd>
                  </div>
                </>
              ) : null}
              {event.eventFamily === 'agent_run' ? (
                <div>
                  <dt>Acting agent</dt>
                  <dd>{event.actingAgentSub ?? 'Agent identity not captured'}</dd>
                </div>
              ) : null}
              {event.resourceAud ? (
                <div>
                  <dt>Protected resource</dt>
                  <dd>{event.resourceAud}</dd>
                </div>
              ) : null}
              {event.effectiveScopes.length ? (
                <div>
                  <dt>Effective scopes</dt>
                  <dd>{event.effectiveScopes.join(', ')}</dd>
                </div>
              ) : null}
              {event.tokenExchangeId ? (
                <div>
                  <dt>Token exchange</dt>
                  <dd>{event.tokenExchangeId}</dd>
                </div>
              ) : null}
              {event.targetRef ? (
                <div>
                  <dt>Target</dt>
                  <dd>{event.targetRef}</dd>
                </div>
              ) : null}
              <div>
                <dt>Payload</dt>
                <dd>{Object.keys(event.payload).length ? 'Released fields only' : 'Redacted'}</dd>
              </div>
            </dl>
          </div>
        </li>
      ))}
    </ol>
  )
}

function TraceSummary({
  detail,
  events,
  matchingCount,
  windowLabel,
}: {
  detail: boolean
  events: readonly GovernedTraceEvent[]
  matchingCount: number
  windowLabel: string
}) {
  const terminal = [...events].reverse().find(event => event.eventType === 'run_end')
  const started = events.find(event => event.eventType === 'run_start')
  const approvals = events.filter(event => event.eventType.includes('approval')).length
  const needsReview = events.filter(event =>
    /failed|denied|rejected|error/i.test(event.outcome ?? '')
  ).length
  const durationMs =
    started && terminal
      ? new Date(terminal.occurredAt).getTime() - new Date(started.occurredAt).getTime()
      : Number.NaN
  const metrics = detail
    ? [
        ['Loaded events', String(events.length)],
        ['Terminal outcome', display(terminal?.outcome)],
        ['Approval events', String(approvals)],
        [
          'Observed duration',
          Number.isFinite(durationMs) && durationMs >= 0
            ? `${(durationMs / 1000).toFixed(1)}s`
            : 'Open',
        ],
      ]
    : [
        ['Loaded events', String(events.length)],
        ['Matching filter', String(matchingCount)],
        ['Adverse outcomes', String(needsReview)],
        ['Time window', windowLabel],
      ]

  return (
    <dl aria-label="Loaded trace summary" className="cu-trace-summary" role="group">
      {metrics.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function GovernedTraceSurface({
  family,
  title,
  subtitle,
  readPath,
  detail = false,
  detailAddon,
}: GovernedTraceSurfaceProps) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchParamsValue = searchParams.toString()
  const [page, setPage] = useState<GovernedTracePage | null>(null)
  const [events, setEvents] = useState<GovernedTraceEvent[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [timeWindow, setTimeWindow] = useState<TraceTimeWindow>(() =>
    readTraceTimeWindow(searchParams)
  )
  const windowBounds = useRef(traceWindowBounds(timeWindow))

  const visibleEvents = useMemo(
    () => events.filter(event => isVisibleInFilter(event, filter)),
    [events, filter]
  )

  async function readPage(cursor?: string, append = false) {
    setError(null)
    append ? setLoadingMore(true) : setLoading(true)
    try {
      const next = await getGovernedTraceEvents(readPath, {
        cursor,
        families: detail ? ['agent_run'] : [family],
        order: detail ? 'oldest' : 'latest',
        ...(detail ? {} : windowBounds.current),
      })
      setPage(next)
      setEvents(current => (append ? [...current, ...next.events] : next.events))
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to read governed events.')
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }

  useEffect(() => {
    const nextWindow = readTraceTimeWindow(new URLSearchParams(searchParamsValue))
    setTimeWindow(current => (current === nextWindow ? current : nextWindow))
  }, [searchParamsValue])

  useEffect(() => {
    windowBounds.current = traceWindowBounds(timeWindow)
    void readPage()
  }, [readPath, family, detail, timeWindow])

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={title}
          subtitle={subtitle}
          secondaryActions={
            !detail ? (
              <SelectInput
                aria-label="Trace time window"
                compact
                onChange={event => {
                  const nextWindow = event.target.value as TraceTimeWindow
                  setTimeWindow(nextWindow)
                  router.replace(
                    buildTraceWindowUrl(
                      pathname,
                      new URLSearchParams(searchParamsValue),
                      nextWindow
                    ),
                    { scroll: false }
                  )
                }}
                value={timeWindow}
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </SelectInput>
            ) : undefined
          }
          refreshAction={
            <button
              aria-label={loading ? 'Refreshing governed events' : 'Refresh governed events'}
              className="cu-trace-refresh"
              disabled={loading || loadingMore}
              onClick={() => {
                if (!detail) windowBounds.current = traceWindowBounds(timeWindow)
                void readPage()
              }}
              title="Refresh"
              type="button"
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} height={18} width={18} />
            </button>
          }
          search={
            !detail ? (
              <TextInput
                aria-label="Filter loaded governed events"
                className="cu-section-search"
                onChange={event => setFilter(event.target.value)}
                placeholder="Filter loaded events"
                value={filter}
              />
            ) : undefined
          }
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="cu-empty">Loading governed events…</div>
        ) : detail ? (
          <>
            {visibleEvents.length ? (
              <>
                <TraceSummary
                  detail
                  events={events}
                  matchingCount={visibleEvents.length}
                  windowLabel="Full run"
                />
                <Timeline events={visibleEvents} />
              </>
            ) : (
              <div className="cu-empty">
                No governed agent-run events are available for this run.
              </div>
            )}
            {detailAddon}
          </>
        ) : (
          <>
            <TraceSummary
              detail={false}
              events={events}
              matchingCount={visibleEvents.length}
              windowLabel={traceWindowLabel(timeWindow)}
            />
            <div className="eft-table-viewport cu-table-wrap cu-table-wrap--sticky-header">
              <DataTable className="eft-table cu-table cu-table--header-band">
                <thead>
                  <TableHeaderRow columns={TRACE_COLUMNS} />
                </thead>
                <tbody>
                  {visibleEvents.map(event => {
                    const href = traceDetailHref(event)
                    return (
                      <tr key={`${event.eventFamily}:${event.eventId}`}>
                        <td>{formatTimestamp(event.occurredAt)}</td>
                        <td>
                          {href ? (
                            <Link className="cu-trace-link" href={href}>
                              {event.eventType}
                            </Link>
                          ) : (
                            event.eventType
                          )}
                          <div className="cu-table__cell-muted">{event.eventFamily}</div>
                        </td>
                        <td>{display(event.outcome)}</td>
                        <td>
                          <div>{display(event.actorSub)}</div>
                          <div className="cu-table__cell-muted">
                            {display(event.serviceOrAgentSub)}
                          </div>
                        </td>
                        <td>
                          <div>{display(event.targetRef)}</div>
                          <div className="cu-table__cell-muted">
                            {event.payload && Object.keys(event.payload).length
                              ? 'Released fields only'
                              : 'Redacted'}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {!visibleEvents.length ? (
                    <tr>
                      <td className="cu-empty" colSpan={TRACE_COLUMNS.length}>
                        No governed events match the loaded page.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </DataTable>
            </div>
          </>
        )}
        {family === 'infrastructure_telemetry' && !loading ? (
          <InfrastructureOperationalSnapshot events={visibleEvents} />
        ) : null}
        {family === 'infrastructure_telemetry' ? <InfrastructureCostQueryView /> : null}
        {page?.nextCursor ? (
          <div className="cu-trace-pagination">
            <Button
              disabled={loadingMore}
              onClick={() => void readPage(page.nextCursor, true)}
              size="sm"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
