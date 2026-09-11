import type { McpToolCallOptions } from './client'
import type { McpManager } from './manager'
import {
  type McpStatusHeartbeatMetricsPort,
  mcpStatusHeartbeatMetrics,
} from './statusHeartbeatMetrics'

export interface McpStatusHeartbeatOptions {
  intervalMs: number
  timeoutMs: number
  getRefresher: () => Pick<McpManager, 'refreshAllServerStatus'> | null
  metrics?: McpStatusHeartbeatMetricsPort
  onError?: (error: unknown) => void
}

/**
 * Owns one bounded background status round at a time. It deliberately does
 * not own transports: stopping cancels only its current probe round.
 */
export class McpStatusHeartbeat {
  private readonly metrics: McpStatusHeartbeatMetricsPort
  private interval: ReturnType<typeof setInterval> | null = null
  private initialTick: ReturnType<typeof setTimeout> | null = null
  private activeRound: AbortController | null = null
  private stopped = false

  constructor(private readonly options: McpStatusHeartbeatOptions) {
    this.metrics = options.metrics ?? mcpStatusHeartbeatMetrics
  }

  start(): void {
    if (this.interval || this.initialTick) return
    this.stopped = false
    this.initialTick = setTimeout(() => {
      this.initialTick = null
      void this.tick()
    }, 0)
    this.interval = setInterval(() => void this.tick(), this.options.intervalMs)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.initialTick) clearTimeout(this.initialTick)
    if (this.interval) clearInterval(this.interval)
    this.initialTick = null
    this.interval = null
    this.activeRound?.abort('MCP status heartbeat stopped')
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.activeRound) {
      this.metrics.runSkipped()
      return
    }
    const refresher = this.options.getRefresher()
    if (!refresher) {
      this.metrics.runSkipped()
      return
    }

    const controller = new AbortController()
    this.activeRound = controller
    this.metrics.runStarted()
    const timeout = setTimeout(
      () => controller.abort('MCP status heartbeat timeout'),
      this.options.timeoutMs
    )
    try {
      const summary = await refresher.refreshAllServerStatus({
        timeoutMs: this.options.timeoutMs,
        signal: controller.signal,
      } satisfies McpToolCallOptions)
      this.metrics.runFinished(summary)
    } catch (error) {
      // A throw never yields an authoritative summary. Classify it explicitly so
      // the run is counted as errored (aborted vs failed) instead of a summary
      // with failed:0 that runFinished would misread as a clean 'completed'.
      this.metrics.runErrored(controller.signal.aborted)
      this.options.onError?.(error)
    } finally {
      clearTimeout(timeout)
      if (this.activeRound === controller) this.activeRound = null
    }
  }
}
