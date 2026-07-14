import * as k8s from '@kubernetes/client-node'
import { SecretEventType, SecretLike, SecretWatcher } from './reconciler/secretWatcher'

/**
 * K8s `watch` HTTP loop for v1 Secrets in a single namespace. Drives a
 * `SecretWatcher` with `handleEvent` calls; the watcher decides whether to
 * fan reconciles out based on key-set diffs.
 *
 * Restarts automatically on watch end (errored or graceful) with the same
 * backoff style as the WorkflowRecipe watcher (5s on error, 1s on clean
 * close).
 */
export class K8sSecretWatchLoop {
  private readonly watch: k8s.Watch
  private watchRequest: { abort: () => void } | null = null
  private stopped = false

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly namespace: string,
    private readonly handler: SecretWatcher
  ) {
    this.watch = new k8s.Watch(kc)
  }

  async start(): Promise<void> {
    console.log(`[WR-SecretWatch] Starting Secret watcher in namespace "${this.namespace}"`)
    await this.startWatch()
  }

  stop(): void {
    this.stopped = true
    if (this.watchRequest) {
      this.watchRequest.abort()
      this.watchRequest = null
    }
    this.handler.stop()
  }

  private async startWatch(): Promise<void> {
    const path = `/api/v1/namespaces/${this.namespace}/secrets`

    const onEvent = (type: string, apiObj: unknown): void => {
      if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED') return
      this.handler.handleEvent(type as SecretEventType, apiObj as SecretLike)
    }

    const onDone = (err: Error | null): void => {
      if (this.stopped) return
      if (err) console.error('[WR-SecretWatch] Watch error:', err)
      console.log('[WR-SecretWatch] Watch ended, restarting...')
      setTimeout(() => this.startWatch(), err ? 5000 : 1000)
    }

    try {
      this.watchRequest = await this.watch.watch(path, {}, onEvent, onDone)
    } catch (err) {
      console.error('[WR-SecretWatch] Failed to start watch:', err)
      if (!this.stopped) setTimeout(() => this.startWatch(), 5000)
    }
  }
}
