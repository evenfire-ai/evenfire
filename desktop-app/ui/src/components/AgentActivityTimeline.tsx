import { useEffect, useMemo, useState } from 'react'
import { Button } from '@components/Common'
import { formatTime } from '../lib/format'
import type { AgentMessageActivity } from '../uiTypes'

type Props = {
  activity: AgentMessageActivity
}

function labelForStatus(status: AgentMessageActivity['status']): string {
  if (status === 'waiting') return 'Waiting for host activity...'
  if (status === 'streaming') return 'Streaming activity'
  if (status === 'reconnecting') return 'Stream reconnecting'
  if (status === 'completed') return 'Activity complete'
  if (status === 'no_activity') return 'No activity'
  return 'Activity error'
}

export function AgentActivityTimeline({ activity }: Props) {
  const [expandedByEventId, setExpandedByEventId] = useState<Record<string, boolean>>({})
  const [visibleCount, setVisibleCount] = useState(0)
  const events = useMemo(() => activity.events.slice(-100), [activity.events])
  const visibleEvents = useMemo(() => events.slice(0, visibleCount), [events, visibleCount])

  useEffect(() => {
    if (events.length === 0) {
      setVisibleCount(0)
      return
    }
    if (visibleCount === 0 && events.length > 0) {
      setVisibleCount(1)
      return
    }
    if (visibleCount >= events.length) return
    const timer = window.setTimeout(() => {
      setVisibleCount(previous => Math.min(previous + 1, events.length))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [events.length, visibleCount])

  return (
    <section className="activity-timeline" aria-live="polite">
      <header className="activity-header">
        <strong>Activity</strong>
        <span className={`activity-status ${activity.status}`}>
          {labelForStatus(activity.status)}
          {activity.status === 'streaming' && (
            <span className="activity-caret" aria-hidden="true" />
          )}
        </span>
      </header>

      {!visibleEvents.length ? (
        <p className="activity-empty muted">{labelForStatus(activity.status)}</p>
      ) : (
        <div className="activity-event-list">
          {visibleEvents.map(event => {
            const expanded = Boolean(expandedByEventId[event.eventId])
            return (
              <article key={event.eventId} className={`activity-event severity-${event.severity}`}>
                <div className="activity-row">
                  <time className="activity-time">{formatTime(new Date(event.ts).getTime())}</time>
                  <span className="activity-type">{event.type}</span>
                  <span className="activity-title">{event.title}</span>
                  <Button
                    color="neutral"
                    onClick={() =>
                      setExpandedByEventId(previous => ({
                        ...previous,
                        [event.eventId]: !previous[event.eventId],
                      }))
                    }
                    aria-expanded={expanded}
                    size="xs"
                    variant="ghost"
                  >
                    {expanded ? 'Hide details' : 'Details'}
                  </Button>
                </div>
                {expanded && (
                  <pre className="activity-meta">{JSON.stringify(event.meta || {}, null, 2)}</pre>
                )}
              </article>
            )
          })}
        </div>
      )}

      {activity.redactionCount > 0 && (
        <p className="activity-redaction muted">Some fields were redacted for safety.</p>
      )}
      {activity.errorMessage && <p className="activity-error muted">{activity.errorMessage}</p>}
    </section>
  )
}
