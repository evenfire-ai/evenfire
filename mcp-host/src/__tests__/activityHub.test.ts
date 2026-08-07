import { describe, expect, it } from 'vitest'
import { HostActivityHub } from '../activityHub'

describe('HostActivityHub', () => {
  it('creates required event fields with monotonic eventId', () => {
    const hub = new HostActivityHub(10, 4096)
    const first = hub.publish({
      hostRef: 'chatllm',
      type: 'task.queued',
      title: 'Task queued',
      severity: 'info',
      meta: { queueDepth: 1 },
    })
    const second = hub.publish({
      hostRef: 'chatllm',
      type: 'task.started',
      title: 'Task started',
      severity: 'info',
    })

    expect(first.version).toBe('1.0')
    expect(first.hostRef).toBe('chatllm')
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(first.eventId < second.eventId).toBe(true)
  })

  it('enforces redactions and max event bytes', () => {
    const hub = new HostActivityHub(10, 220)
    const event = hub.publish({
      hostRef: 'chatllm',
      type: 'task.failed',
      title: 'Task failed',
      severity: 'error',
      meta: {
        reasoning: 'must-not-leak',
        prompt: 'must-not-leak',
        small: 'ok',
        huge: 'x'.repeat(1000),
      },
    })

    expect(event.meta.reasoning).toBeUndefined()
    expect(event.meta.prompt).toBeUndefined()
    expect(event.redactions).toContain('reasoning')
    expect(event.redactions).toContain('prompt')
    expect(event.redactions).toContain('meta')
  })

  it('supports snapshot pagination by limit and sinceEventId', () => {
    const hub = new HostActivityHub(20, 2048)
    const e1 = hub.publish({
      hostRef: 'chatllm',
      type: 'task.queued',
      title: 'queued',
      severity: 'info',
    })
    hub.publish({
      hostRef: 'chatllm',
      type: 'task.started',
      title: 'started',
      severity: 'info',
    })
    const e3 = hub.publish({
      hostRef: 'chatllm',
      type: 'task.completed',
      title: 'completed',
      severity: 'info',
    })

    const snap = hub.snapshot('chatllm', 10, e1.eventId)
    expect(snap.items).toHaveLength(2)
    expect(snap.items[1]?.eventId).toBe(e3.eventId)
    expect(snap.nextCursor).toBe(e3.eventId)
  })
})
