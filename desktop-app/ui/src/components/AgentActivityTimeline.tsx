import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Flex, Tag, Timeline, Typography } from 'antd'
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

function statusColor(status: AgentMessageActivity['status']) {
  if (status === 'streaming' || status === 'reconnecting') return 'processing' as const
  if (status === 'completed') return 'success' as const
  if (status === 'error') return 'error' as const
  return 'default' as const
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

  const timelineItems = visibleEvents.map(event => {
    const expanded = Boolean(expandedByEventId[event.eventId])
    return {
      key: event.eventId,
      color: event.severity === 'error' ? 'red' : event.severity === 'warn' ? 'orange' : 'blue',
      title: (
        <Flex align="center" gap="small" wrap>
          <Typography.Text type="secondary">
            {formatTime(new Date(event.ts).getTime())}
          </Typography.Text>
          <Tag
            color={
              event.severity === 'error'
                ? 'error'
                : event.severity === 'warn'
                  ? 'warning'
                  : 'default'
            }
          >
            {event.type}
          </Tag>
          <Typography.Text>{event.title}</Typography.Text>
          <Button
            type="link"
            aria-expanded={expanded}
            aria-controls={`activity-details-${event.eventId}`}
            onClick={() =>
              setExpandedByEventId(previous => ({
                ...previous,
                [event.eventId]: !previous[event.eventId],
              }))
            }
          >
            {expanded ? 'Hide details' : 'Details'}
          </Button>
        </Flex>
      ),
      content: expanded ? (
        <pre id={`activity-details-${event.eventId}`}>
          {JSON.stringify(event.meta || {}, null, 2)}
        </pre>
      ) : null,
    }
  })

  return (
    <section aria-label="Activity" aria-live="polite">
      <Flex align="center" gap="small">
        <Typography.Title level={5}>Activity</Typography.Title>
        <Tag color={statusColor(activity.status)}>{labelForStatus(activity.status)}</Tag>
      </Flex>
      {!visibleEvents.length ? (
        <Typography.Paragraph type="secondary">
          {labelForStatus(activity.status)}
        </Typography.Paragraph>
      ) : (
        <Timeline items={timelineItems} />
      )}
      {activity.redactionCount > 0 ? (
        <Alert type="info" showIcon title="Some fields were redacted for safety." />
      ) : null}
      {activity.errorMessage ? <Alert type="error" showIcon title={activity.errorMessage} /> : null}
    </section>
  )
}
