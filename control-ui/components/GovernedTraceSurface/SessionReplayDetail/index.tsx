'use client'

import { useEffect, useState } from 'react'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { IconRefresh } from '@components/icons'
import { Button } from '@components/ui'
import { getGovernedTraceSessionDetail } from '@lib/governedTrace'
import type { GovernedTraceSessionDetail } from '@lib/governedTrace'
import { SessionApprovalTimeline } from './SessionApprovalTimeline'
import { SessionIdentity } from './SessionIdentity'
import { SessionInteractionTimeline } from './SessionInteractionTimeline'
import { SessionTokenUsage } from './SessionTokenUsage'
import { SessionToolUsage } from './SessionToolUsage'
import type { SessionReplayDetailProps } from './types'

export function SessionReplayDetail({ hostRef, sessionId }: SessionReplayDetailProps) {
  const [detail, setDetail] = useState<GovernedTraceSessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshEpoch, setRefreshEpoch] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void getGovernedTraceSessionDetail(hostRef, sessionId, {}, controller.signal)
      .then(setDetail)
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(readError instanceof Error ? readError.message : 'Unable to read this session.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [hostRef, refreshEpoch, sessionId])

  async function loadMoreInteractions() {
    if (!detail?.nextCursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const next = await getGovernedTraceSessionDetail(hostRef, sessionId, {
        cursor: detail.nextCursor,
      })
      setDetail(current =>
        current
          ? {
              ...current,
              interactions: [...current.interactions, ...next.interactions],
              nextCursor: next.nextCursor,
            }
          : next
      )
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to load more interactions.')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="cu-trace-layout">
      <div className="cu-card cu-card--viewport-fill cu-trace-detail">
        <TablePanelHeader
          refreshAction={
            <button
              aria-label={loading ? 'Refreshing session replay' : 'Refresh session replay'}
              className="cu-trace-refresh"
              disabled={loading || loadingMore}
              onClick={() => setRefreshEpoch(current => current + 1)}
              title="Refresh"
              type="button"
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} height={18} width={18} />
            </button>
          }
          subtitle={`MCP host ${hostRef} · session ${sessionId}`}
          title="Session replay"
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        {loading && !detail ? (
          <div className="cu-empty">Loading session replay...</div>
        ) : detail ? (
          <div className="cu-trace-detail__body">
            <SessionIdentity detail={detail} />
            <SessionTokenUsage usage={detail.tokenUsage} />
            <SessionToolUsage tools={detail.tools} />
            <SessionApprovalTimeline approvals={detail.approvals} human={detail.summary.human} />
            <SessionInteractionTimeline
              human={detail.summary.human}
              interactions={detail.interactions}
            />
            {detail.nextCursor ? (
              <div className="cu-trace-pagination">
                <Button
                  disabled={loadingMore}
                  onClick={() => void loadMoreInteractions()}
                  size="sm"
                >
                  {loadingMore ? 'Loading...' : 'Load more interactions'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : !loading ? (
          <div className="cu-empty">This governed session is unavailable.</div>
        ) : null}
      </div>
    </section>
  )
}
