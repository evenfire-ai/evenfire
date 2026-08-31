/**
 * SecretInformer — watches v1 Secrets in a target namespace and re-emits
 * ADDED / MODIFIED / DELETED events to a consumer callback.
 *
 * Used by HCC to react to Secret lifecycle changes so that McpServer CRDs
 * referencing a Secret can be re-reconciled (e.g. a missing Secret is
 * created after the McpServer, or a required key is added later).
 *
 * Disconnect behavior: exponential backoff 1s → 2s → 4s → … capped at 30s.
 * Reset only while the stream is still live after `watch()` resolves, and on
 * any later Secret event. `@kubernetes/client-node@1.4.0` calls `done(err)`
 * then resolves on HTTP 403 / fetch failure; that path must keep climbing
 * (#461 / jozer review 5065983153).
 */
import * as k8s from '@kubernetes/client-node'
import {
  secretInformerEventsTotal,
  secretInformerReconnectsTotal,
  secretInformerRunning,
} from '../metrics'

export type SecretEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

export interface SecretEvent {
  type: SecretEventType
  name: string
  namespace: string
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

/**
 * Minimal shape of the `Watch` object we depend on. Allows test injection
 * without spying on the (ESM-locked) `@kubernetes/client-node` namespace.
 */
export interface WatchLike {
  watch(
    path: string,
    queryParams: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, apiObj: unknown, watchObj?: unknown) => void,
    done: (err: Error | null) => void
  ): Promise<AbortController>
}

export interface SecretInformerDeps {
  watch?: WatchLike
}

export class SecretInformer {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false
  private readonly watch: WatchLike

  constructor(
    kc: k8s.KubeConfig,
    private readonly namespace: string,
    private readonly onSecretEvent: (evt: SecretEvent) => void,
    deps?: SecretInformerDeps
  ) {
    if (deps?.watch) {
      this.watch = deps.watch
    } else {
      this.watch = new k8s.Watch(kc)
    }
  }

  /**
   * Start the informer. Resolves once the initial list+watch stream
   * has been established. Reconnects run in the background.
   */
  async start(): Promise<boolean> {
    this.stopped = false
    return this.connect()
  }

  /**
   * Stop the informer and cancel any pending reconnect.
   */
  stop(): void {
    this.stopped = true
    secretInformerRunning.set(0)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  /**
   * Compute exponential backoff capped at MAX_BACKOFF_MS.
   * attempts=1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s, 5 → 16s, 6+ → 30s.
   */
  private computeBackoff(): number {
    const exponent = Math.max(0, this.attempts - 1)
    const delay = INITIAL_BACKOFF_MS * Math.pow(2, exponent)
    return Math.min(delay, MAX_BACKOFF_MS)
  }

  private async connect(): Promise<boolean> {
    if (this.stopped) return false

    const path = `/api/v1/namespaces/${this.namespace}/secrets`
    let watchEnded = false

    const watchCallback = (type: string, apiObj: unknown): void => {
      if (this.stopped || watchEnded) return

      const evtType = type as SecretEventType
      if (evtType !== 'ADDED' && evtType !== 'MODIFIED' && evtType !== 'DELETED') {
        // Ignore BOOKMARK or ERROR events.
        return
      }

      const metadata = (apiObj as { metadata?: { name?: string; namespace?: string } } | null)
        ?.metadata
      const name = metadata?.name
      const namespace = metadata?.namespace ?? this.namespace
      if (!name) return

      // Reset backoff on any successful event — stream is healthy.
      this.attempts = 0

      secretInformerEventsTotal.inc({ type: evtType })

      try {
        this.onSecretEvent({ type: evtType, name, namespace })
      } catch (err) {
        console.error('[SecretInformer] onSecretEvent callback threw:', err)
      }
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped || watchEnded) return
      watchEnded = true
      if (err) {
        console.warn('[SecretInformer] watch ended with error:', err.message)
      } else {
        console.warn('[SecretInformer] watch ended (server-side close), reconnecting')
      }
      secretInformerRunning.set(0)
      this.scheduleReconnect()
    }

    try {
      this.attempts += 1
      const request = await this.watch.watch(path, {}, watchCallback, doneCallback)
      // Client 1.4.0: HTTP 403 / fetch failure calls done(err) then resolves.
      // Resetting here would pin every informer at 1s forever.
      if (this.stopped || watchEnded) {
        request.abort()
        this.abortController = null
        return false
      }
      this.abortController = request
      this.attempts = 0
      secretInformerRunning.set(1)
      console.log(`[SecretInformer] watch established for namespace ${this.namespace}`)
      return true
    } catch (err) {
      if (this.stopped) return false
      secretInformerRunning.set(0)
      console.warn('[SecretInformer] failed to start watch:', err)
      this.scheduleReconnect()
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return // already scheduled

    secretInformerReconnectsTotal.inc()

    const delay = this.computeBackoff()
    console.warn(`[SecretInformer] reconnecting in ${delay}ms (attempt ${this.attempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(err => {
        secretInformerRunning.set(0)
        console.error('[SecretInformer] reconnect failed:', err)
      })
    }, delay)
  }
}
