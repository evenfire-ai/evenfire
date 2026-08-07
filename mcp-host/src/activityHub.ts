import type {
  HostActivityEvent,
  HostActivitySeverity,
  HostActivitySnapshotResponse,
  HostActivityType,
} from './server/types'

type PublishInput = {
  hostRef: string
  taskId?: string
  type: HostActivityType
  title: string
  severity: HostActivitySeverity
  meta?: Record<string, unknown>
}

type Subscriber = (event: HostActivityEvent) => void

const DISALLOWED_META_KEYS = new Set([
  'reasoning',
  'thought',
  'chainofthought',
  'cot',
  'prompt',
  'response',
  'content',
  'stack',
  'token',
  'authorization',
  'apikey',
  'secret',
  'internalurl',
  'url',
])

function redactMeta(input: Record<string, unknown>): {
  meta: Record<string, unknown>
  redactions: string[]
} {
  const redactions: string[] = []
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (DISALLOWED_META_KEYS.has(normalized)) {
      redactions.push(key)
      continue
    }
    out[key] = value
  }
  return { meta: out, redactions }
}

export class HostActivityHub {
  private readonly buffer: HostActivityEvent[] = []
  private readonly subscribers = new Set<Subscriber>()
  private eventCounter = 0

  constructor(
    private readonly maxBufferSize: number,
    private readonly maxEventBytes: number
  ) {}

  publish(input: PublishInput): HostActivityEvent {
    const safeTitle = String(input.title || 'Host activity').trim() || 'Host activity'
    const { meta, redactions } = redactMeta(input.meta || {})
    const eventId = `evt_${String(++this.eventCounter).padStart(10, '0')}`
    const event: HostActivityEvent = {
      version: '1.0',
      eventId,
      hostRef: input.hostRef,
      ts: new Date().toISOString(),
      taskId: input.taskId,
      type: input.type,
      title: safeTitle.slice(0, 180),
      severity: input.severity,
      meta,
      redactions,
    }

    const serialized = JSON.stringify(event)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxEventBytes) {
      event.meta = {}
      event.redactions = Array.from(new Set([...event.redactions, 'meta']))
    }

    this.buffer.push(event)
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize)
    }

    for (const subscriber of this.subscribers) {
      subscriber(event)
    }
    return event
  }

  snapshot(hostRef: string, limit: number, sinceEventId?: string): HostActivitySnapshotResponse {
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200)
    let minId = 0
    if (sinceEventId) {
      const match = sinceEventId.match(/^evt_(\d+)$/)
      if (match) minId = Number(match[1])
    }
    const filtered = this.buffer.filter(entry => {
      const match = entry.eventId.match(/^evt_(\d+)$/)
      const num = match ? Number(match[1]) : 0
      return num > minId
    })
    const items = filtered.slice(-max)
    return {
      hostRef,
      version: '1.0',
      items,
      nextCursor: items.length ? items[items.length - 1]!.eventId : null,
    }
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler)
    return () => {
      this.subscribers.delete(handler)
    }
  }
}
