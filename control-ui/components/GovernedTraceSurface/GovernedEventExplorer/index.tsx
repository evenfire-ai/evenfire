'use client'

import { useEffect, useMemo, useState } from 'react'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { Button } from '@components/ui'
import { getGovernedTraceEvents } from '@lib/governedTrace'
import type { GovernedTraceEvent, GovernedTracePage } from '@lib/governedTrace'
import { traceActiveFilterCount, traceWindowLabel } from '@lib/governedTraceFilters'
import { InfrastructureCostQueryView } from '../InfrastructureCostQueryView'
import { InfrastructureOperationalSnapshot } from '../InfrastructureOperationalSnapshot'
import {
  TRACE_ALL_FILTERS_ID,
  TraceFilterHeaderLabel,
  TraceFilters,
  TraceTimeWindowControl,
} from '../TraceFilters'
import { ADMINISTRATIVE_FILTERS, INFRASTRUCTURE_FILTERS } from '../TraceFilters/constants'
import { useTraceExplorationState } from '../TraceFilters/useTraceExplorationState'
import { GovernedEventRow } from './EventRow'
import { ADMINISTRATIVE_COLUMN_LAYOUT, INFRASTRUCTURE_COLUMN_LAYOUT } from './constants'
import type { GovernedEventExplorerProps } from './types'

export function GovernedEventExplorer({ family, subtitle, title }: GovernedEventExplorerProps) {
  const explorationFamily = family === 'administrative' ? 'administrative' : 'infrastructure'
  const definitions = family === 'administrative' ? ADMINISTRATIVE_FILTERS : INFRASTRUCTURE_FILTERS
  const columnLayout =
    family === 'administrative' ? ADMINISTRATIVE_COLUMN_LAYOUT : INFRASTRUCTURE_COLUMN_LAYOUT
  const [boundaryEpoch, setBoundaryEpoch] = useState(0)
  const { apiQuery, invalidRange, state, stateKey, updateState } = useTraceExplorationState(
    explorationFamily,
    boundaryEpoch
  )
  const [page, setPage] = useState<GovernedTracePage | null>(null)
  const [events, setEvents] = useState<GovernedTraceEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [openFilterId, setOpenFilterId] = useState<string | null>(null)

  const columns = useMemo<TableHeaderColumn[]>(
    () =>
      columnLayout.map(column => {
        const definition = definitions.find(item => item.id === column.key)
        const activeCount =
          definition?.fields.filter(field => state.filters[field.key]?.length).length ?? 0
        return {
          ...column,
          label: definition ? (
            <TraceFilterHeaderLabel
              activeCount={activeCount}
              label={column.label}
              onOpen={() => setOpenFilterId(definition.id)}
            />
          ) : (
            column.label
          ),
        }
      }),
    [columnLayout, definitions, state.filters]
  )

  useEffect(() => {
    setPage(null)
    setEvents([])
    setError(null)
    if (!apiQuery) return
    const controller = new AbortController()
    setLoading(true)
    void getGovernedTraceEvents(
      '/api/v1/admin/tracing/events',
      { ...apiQuery, families: [family], order: 'latest' },
      controller.signal
    )
      .then(next => {
        setPage(next)
        setEvents(next.events)
      })
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(
            readError instanceof Error ? readError.message : 'Unable to read governed events.'
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [apiQuery, boundaryEpoch, family, stateKey])

  async function loadMore() {
    if (!apiQuery || !page?.nextCursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const next = await getGovernedTraceEvents('/api/v1/admin/tracing/events', {
        ...apiQuery,
        cursor: page.nextCursor,
        families: [family],
        order: 'latest',
      })
      setPage(next)
      setEvents(current => [...current, ...next.events])
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to load more events.')
    } finally {
      setLoadingMore(false)
    }
  }

  const adverseOutcomes = events.filter(event =>
    /failed|denied|rejected|error/i.test(event.outcome ?? '')
  ).length
  const sourceCount = new Set(
    events.map(event => event.sourceService || event.serviceOrAgentSub).filter(Boolean)
  ).size
  const permissionChanges = events.filter(
    event => event.eventType === 'permission_grant' || event.eventType === 'permission_revoke'
  ).length
  const targetUserCount = new Set(events.map(event => event.targetUserId).filter(Boolean)).size
  const activeFilterCount = traceActiveFilterCount(state)

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          actions={
            <>
              <TraceTimeWindowControl onChange={updateState} state={state} />
              <button
                aria-label={loading ? 'Refreshing governed events' : 'Refresh governed events'}
                className="cu-trace-refresh"
                disabled={loading || loadingMore}
                onClick={() => setBoundaryEpoch(current => current + 1)}
                title="Refresh"
                type="button"
              >
                <IconRefresh className={loading ? 'cu-spin' : undefined} height={18} width={18} />
              </button>
            </>
          }
          subtitle={subtitle}
          title={title}
        />
        <TraceFilters
          definitions={definitions}
          invalidRange={invalidRange}
          onChange={updateState}
          onClose={() => setOpenFilterId(null)}
          onOpenAll={() => setOpenFilterId(TRACE_ALL_FILTERS_ID)}
          openFilterId={openFilterId}
          state={state}
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        <dl aria-label="Loaded governed event summary" className="cu-trace-summary" role="group">
          <div>
            <dt>Loaded events</dt>
            <dd>{events.length}</dd>
          </div>
          <div>
            <dt>{family === 'administrative' ? 'Permission / approval changes' : 'Sources'}</dt>
            <dd>{family === 'administrative' ? permissionChanges : sourceCount}</dd>
          </div>
          <div>
            <dt>{family === 'administrative' ? 'Target users' : 'Adverse outcomes'}</dt>
            <dd>{family === 'administrative' ? targetUserCount : adverseOutcomes}</dd>
          </div>
          <div>
            <dt>Time window</dt>
            <dd>{traceWindowLabel(state.window)}</dd>
          </div>
        </dl>
        {loading ? (
          <div className="cu-empty">Loading governed events...</div>
        ) : invalidRange ? null : (
          <div className="cu-table-wrap cu-table-wrap--sticky-header">
            <table className="cu-table cu-table--header-band cu-trace-explorer-table">
              <thead>
                <TableHeaderRow columns={columns} />
              </thead>
              <tbody>
                {events.map(event => (
                  <GovernedEventRow event={event} family={family} key={event.eventId} />
                ))}
                {!events.length ? (
                  <tr>
                    <td className="cu-empty" colSpan={columns.length}>
                      {activeFilterCount
                        ? 'No events match the active server-side filters.'
                        : 'No governed events are available in this time window.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {family === 'infrastructure_telemetry' && !loading ? (
          <InfrastructureOperationalSnapshot events={events} />
        ) : null}
        {family === 'infrastructure_telemetry' ? <InfrastructureCostQueryView /> : null}
        {page?.nextCursor ? (
          <div className="cu-trace-pagination">
            <Button disabled={loadingMore} onClick={() => void loadMore()} size="sm">
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
