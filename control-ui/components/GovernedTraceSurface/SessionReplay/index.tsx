'use client'

import { useEffect, useMemo, useState } from 'react'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { Button } from '@components/ui'
import { getGovernedTraceSessions } from '@lib/governedTrace'
import type { GovernedTraceSessionPage, GovernedTraceSessionSummaryV1 } from '@lib/governedTrace'
import { traceActiveFilterCount, traceWindowLabel } from '@lib/governedTraceFilters'
import {
  TRACE_ALL_FILTERS_ID,
  TraceFilterHeaderLabel,
  TraceFilters,
  TraceTimeWindowControl,
} from '../TraceFilters'
import { SESSION_FILTERS } from '../TraceFilters/constants'
import { useTraceExplorationState } from '../TraceFilters/useTraceExplorationState'
import { SessionRow } from './SessionRow'
import { SESSION_COLUMN_LAYOUT } from './constants'
import type { SessionReplayProps } from './types'

function filterCountForColumn(
  definitionId: string,
  filters: Record<string, readonly string[]>
): number {
  const definition = SESSION_FILTERS.find(item => item.id === definitionId)
  return definition?.fields.filter(field => filters[field.key]?.length).length ?? 0
}

export function SessionReplay({
  subtitle = 'MCP host sessions with verified human and acting-agent attribution.',
  title = 'Run replay',
}: SessionReplayProps) {
  const [boundaryEpoch, setBoundaryEpoch] = useState(0)
  const { apiQuery, invalidRange, state, stateKey, updateState } = useTraceExplorationState(
    'sessions',
    boundaryEpoch
  )
  const [page, setPage] = useState<GovernedTraceSessionPage | null>(null)
  const [sessions, setSessions] = useState<GovernedTraceSessionSummaryV1[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [openFilterId, setOpenFilterId] = useState<string | null>(null)
  const [copiedSessionKey, setCopiedSessionKey] = useState<string | null>(null)

  const columns = useMemo<TableHeaderColumn[]>(
    () =>
      SESSION_COLUMN_LAYOUT.map(column => ({
        ...column,
        label: (
          <TraceFilterHeaderLabel
            activeCount={filterCountForColumn(column.key, state.filters)}
            label={column.label}
            onOpen={() => setOpenFilterId(column.key)}
          />
        ),
      })),
    [state.filters]
  )

  useEffect(() => {
    setPage(null)
    setSessions([])
    setError(null)
    if (!apiQuery) return
    const controller = new AbortController()
    setLoading(true)
    void getGovernedTraceSessions(apiQuery, controller.signal)
      .then(next => {
        setPage(next)
        setSessions(next.sessions)
      })
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(readError instanceof Error ? readError.message : 'Unable to read sessions.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [apiQuery, boundaryEpoch, stateKey])

  async function loadMore() {
    if (!apiQuery || !page?.nextCursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const next = await getGovernedTraceSessions({ ...apiQuery, cursor: page.nextCursor })
      setPage(next)
      setSessions(current => [...current, ...next.sessions])
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to load more sessions.')
    } finally {
      setLoadingMore(false)
    }
  }

  const runCount = sessions.reduce((total, session) => total + session.runCount, 0)
  const approvalCount = sessions.reduce((total, session) => total + session.approvals.requested, 0)
  const meteredTokenCount = sessions.reduce(
    (total, session) => total + session.tokenUsage.totalTokens,
    0
  )
  const activeFilterCount = traceActiveFilterCount(state)

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          actions={
            <>
              <TraceTimeWindowControl onChange={updateState} state={state} />
              <button
                aria-label={loading ? 'Refreshing sessions' : 'Refresh sessions'}
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
          definitions={SESSION_FILTERS}
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
        <dl aria-label="Loaded session summary" className="cu-trace-summary" role="group">
          <div>
            <dt>Loaded sessions</dt>
            <dd>{sessions.length}</dd>
          </div>
          <div>
            <dt>Loaded runs</dt>
            <dd>{runCount}</dd>
          </div>
          <div>
            <dt>Approval requests</dt>
            <dd>{approvalCount}</dd>
          </div>
          <div>
            <dt>Metered tokens</dt>
            <dd>{meteredTokenCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Time window</dt>
            <dd>{traceWindowLabel(state.window)}</dd>
          </div>
        </dl>
        {loading ? (
          <div className="cu-empty">Loading governed sessions...</div>
        ) : invalidRange ? null : (
          <div className="cu-table-wrap cu-table-wrap--sticky-header">
            <table className="cu-table cu-table--header-band cu-trace-explorer-table">
              <thead>
                <TableHeaderRow columns={columns} />
              </thead>
              <tbody>
                {sessions.map(session => {
                  const sessionKey = `${session.hostRef}:${session.sessionId}`
                  return (
                    <SessionRow
                      copied={copiedSessionKey === sessionKey}
                      key={sessionKey}
                      onCopy={() => {
                        void navigator.clipboard?.writeText(session.sessionId)
                        setCopiedSessionKey(sessionKey)
                        window.setTimeout(() => setCopiedSessionKey(null), 1500)
                      }}
                      session={session}
                    />
                  )
                })}
                {!sessions.length ? (
                  <tr>
                    <td className="cu-empty" colSpan={columns.length}>
                      {activeFilterCount
                        ? 'No sessions match the active server-side filters.'
                        : 'No governed MCP host sessions are available in this time window.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
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
