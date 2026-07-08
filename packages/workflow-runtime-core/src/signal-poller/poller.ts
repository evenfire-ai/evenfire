import type { Signal } from '../config-loader/types'
import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'
import { requireRuntimeToken } from '../runtime-token-provider/provider'
import { sendWithAuthRetryOn401 } from '../status-reporter/authRetry'
import { emitLog } from '../status-reporter/logger'

export type SignalCallback = (signal: Signal) => void | Promise<void>

export class SignalPoller {
  private readonly wrcUrl: string
  private readonly workflowName: string
  private readonly tokenProvider: RuntimeTokenProvider
  private readonly intervalMs: number
  private readonly seenIds = new Set<string>()
  private static readonly MAX_SEEN_IDS = 10_000

  private trackSeen(id: string): void {
    if (this.seenIds.size >= SignalPoller.MAX_SEEN_IDS) {
      // Evict oldest 1000 entries via insertion-order iterator — avoids full-Set spread
      let evicted = 0
      for (const old of this.seenIds) {
        this.seenIds.delete(old)
        if (++evicted >= 1000) break
      }
    }
    this.seenIds.add(id)
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private pendingSignals: Signal[] = []
  private stopped = false
  private polling = false // prevents overlapping fetches when poll takes longer than intervalMs

  constructor(opts: {
    wrcUrl: string
    workflowName: string
    tokenProvider: RuntimeTokenProvider
    intervalMs: number
  }) {
    this.wrcUrl = opts.wrcUrl
    this.workflowName = opts.workflowName
    this.tokenProvider = opts.tokenProvider
    this.intervalMs = opts.intervalMs
  }

  private async authHeader(): Promise<string> {
    const token = await requireRuntimeToken(this.tokenProvider, 'getWrcToken', 'WRC_TOKEN_FILE')
    return `Bearer ${token}`
  }

  pollSignals(callback: SignalCallback): () => void {
    const poll = async () => {
      if (this.stopped) return
      // Skip if a previous poll is still running — prevents duplicate signal delivery
      // when a fetch takes longer than intervalMs (JS single-threaded but await yields control)
      if (this.polling) return
      this.polling = true
      try {
        const url = `${this.wrcUrl}/api/v1/workflow/${encodeURIComponent(this.workflowName)}/signals`
        const resp = await sendWithAuthRetryOn401(
          async () =>
            fetch(url, {
              headers: { Authorization: await this.authHeader() },
            }),
          'signal poll'
        )
        if (!resp.ok) {
          emitLog('warn', `Signal poll failed: HTTP ${resp.status}`)
          return
        }
        const envelope = (await resp.json()) as { signals: Signal[] }
        const signals = envelope.signals
        // Guard against malformed WRC response (missing key, schema mismatch during rolling updates).
        if (!Array.isArray(signals)) return
        for (const signal of signals) {
          if (this.stopped) break
          if (this.seenIds.has(signal.requestId)) continue
          this.trackSeen(signal.requestId)
          if (this.pendingSignals.length >= SignalPoller.MAX_PENDING_SIGNALS) {
            const dropped = this.pendingSignals.shift()
            emitLog(
              'warn',
              `Signal queue full (cap ${SignalPoller.MAX_PENDING_SIGNALS}), dropped oldest signal`,
              {
                droppedType: dropped?.type,
                droppedRequestId: dropped?.requestId,
              }
            )
          }
          this.pendingSignals.push(signal)
          try {
            await callback(signal)
          } catch (err) {
            emitLog('warn', `Signal callback error: ${(err as Error).message}`, {
              signalType: signal.type,
              requestId: signal.requestId,
            })
          }
        }
      } catch (err) {
        emitLog('warn', `Signal poll error: ${(err as Error).message}`)
      } finally {
        this.polling = false
      }
    }

    poll()
    this.timer = setInterval(poll, this.intervalMs)

    return () => this.stop()
  }

  private static readonly MAX_PENDING_SIGNALS = 200

  pushSignal(signal: Signal): void {
    if (this.seenIds.has(signal.requestId)) return
    this.trackSeen(signal.requestId)
    if (this.pendingSignals.length >= SignalPoller.MAX_PENDING_SIGNALS) {
      const dropped = this.pendingSignals.shift()
      emitLog(
        'warn',
        `Signal queue full (cap ${SignalPoller.MAX_PENDING_SIGNALS}), dropped oldest signal`,
        {
          droppedType: dropped?.type,
          droppedRequestId: dropped?.requestId,
        }
      )
    }
    this.pendingSignals.push(signal)
  }

  getSignals(): Signal[] {
    return [...this.pendingSignals]
  }

  hasSignal(type: Signal['type']): boolean {
    return this.pendingSignals.some(s => s.type === type)
  }

  consumeSignal(type: Signal['type']): Signal | undefined {
    const idx = this.pendingSignals.findIndex(s => s.type === type)
    if (idx === -1) return undefined
    return this.pendingSignals.splice(idx, 1)[0]
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Note: pendingSignals are intentionally NOT cleared here — signals received just
    // before stop() must remain readable by the coordinator loop to avoid losing a
    // cancel/approval signal that arrived concurrently with shutdown().
  }
}
