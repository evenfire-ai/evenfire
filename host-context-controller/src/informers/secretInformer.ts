/**
 * SecretInformer — watches v1 Secrets in a target namespace and re-emits
 * ADDED / MODIFIED / DELETED events to a consumer callback.
 *
 * Used by HCC to react to Secret lifecycle changes so that McpServer CRDs
 * referencing a Secret can be re-reconciled (e.g. a missing Secret is
 * created after the McpServer, or a required key is added later).
 *
 * Two modes, chosen per instance:
 * - `replay`: every connect watches without a resourceVersion, so the
 *   apiserver replays every Secret as ADDED after each reconnect. The
 *   informer holds no state between connections.
 * - `resume` (#1338 F2 Layer B): the informer keeps a metadata-only cache
 *   (name, uid, resourceVersion) and the last resourceVersion it saw. A
 *   reconnect resumes the watch from that resourceVersion, so a reconnect
 *   after which nothing changed emits nothing. When a resume is impossible
 *   (410 Gone) it relists, paginated, and diffs the complete list against the
 *   cache: a Secret first seen is ADDED, a changed or recreated one MODIFIED,
 *   a missing one DELETED. A failed or partial list is never diffed, no event
 *   is emitted, and no watch is opened until a complete list succeeds.
 *
 * Disconnect behavior: exponential backoff 1s → 2s → 4s → … capped at 30s.
 * Reset only while the stream is still live after `watch()` resolves, and on
 * any later Secret event. `@kubernetes/client-node@1.4.0` calls `done(err)`
 * then resolves on HTTP 403 / fetch failure; that path must keep climbing
 * (#461 / jozer review 5065983153).
 */
import * as k8s from '@kubernetes/client-node'
import { hccLogger } from '../logger'
import {
  secretInformerEventsTotal,
  secretInformerListsTotal,
  secretInformerReconnectsTotal,
  secretInformerResumesTotal,
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
/** One list page at a time bounds the transient memory of a relist. */
const SECRET_LIST_PAGE_SIZE = 50
/** The apiserver no longer holds the requested resourceVersion. */
const HTTP_GONE = 410

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

/** One page of a paginated Secret list. */
export type SecretListPage = { limit: number; continueToken?: string }

/** Lists one page of the namespace's Secrets (`CoreV1Api.listNamespacedSecret`). */
export type SecretList = (namespace: string, page: SecretListPage) => Promise<k8s.V1SecretList>

/** The production list: one page of `CoreV1Api.listNamespacedSecret`. */
export function secretListFromCoreApi(
  api: Pick<k8s.CoreV1Api, 'listNamespacedSecret'>
): SecretList {
  return (namespace, page) =>
    api.listNamespacedSecret({
      namespace,
      limit: page.limit,
      _continue: page.continueToken,
    })
}

/**
 * `resume` needs the list that seeds and repairs its cache; `replay` never
 * lists, so its wiring carries no list dependency.
 */
export type SecretInformerMode = { mode: 'resume'; list: SecretList } | { mode: 'replay' }

export interface SecretInformerDeps {
  watch?: WatchLike
}

interface CachedSecret {
  uid: string
  resourceVersion: string
}

type SecretMetadata = {
  name?: string
  namespace?: string
  uid?: string
  resourceVersion?: string
}

/** client-node 1.4.0 reports a non-200 watch response as `statusCode`, never as `code`. */
export function isGone(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null | undefined)?.statusCode === HTTP_GONE
}

/**
 * Exponential reconnect backoff capped at MAX_BACKOFF_MS.
 * attempts=1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s, 5 → 16s, 6+ → 30s.
 */
export function computeWatchBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  const delay = INITIAL_BACKOFF_MS * Math.pow(2, exponent)
  return Math.min(delay, MAX_BACKOFF_MS)
}

export class SecretInformer {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false
  private readonly watch: WatchLike
  /** Resume mode only; null in replay mode. */
  private readonly list: SecretList | null
  /**
   * Resume mode only: metadata of every Secret this process has seen in the
   * namespace. Secret data, labels and annotations are never retained.
   */
  private cache = new Map<string, CachedSecret>()
  /** Resume mode only: the resourceVersion the next watch resumes from; null forces a relist. */
  private resumeVersion: string | null = null
  /** Resume mode only: a complete list has succeeded at least once. */
  private listed = false

  constructor(
    kc: k8s.KubeConfig,
    private readonly namespace: string,
    private readonly onSecretEvent: (evt: SecretEvent) => void,
    mode: SecretInformerMode,
    deps?: SecretInformerDeps
  ) {
    this.list = mode.mode === 'resume' ? mode.list : null
    if (deps?.watch) {
      this.watch = deps.watch
    } else {
      this.watch = new k8s.Watch(kc)
    }
  }

  /**
   * Start the informer. Resolves once the initial list (resume mode) and
   * watch stream have been established. Reconnects run in the background.
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
    secretInformerRunning.set({ namespace: this.namespace }, 0)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  private async connect(): Promise<boolean> {
    if (this.stopped) return false

    this.attempts += 1
    const resumed = this.list !== null && this.resumeVersion !== null
    if (this.list !== null && this.resumeVersion === null) {
      const synced = await this.syncFromList(this.list)
      if (this.stopped) return false
      if (!synced) {
        secretInformerRunning.set({ namespace: this.namespace }, 0)
        this.scheduleReconnect()
        return false
      }
    }

    const path = `/api/v1/namespaces/${this.namespace}/secrets`
    let queryParams: Record<string, string | boolean> = {}
    if (this.list !== null) {
      const resourceVersion = this.resumeVersion
      if (resourceVersion === null) {
        // A resume-mode watch without a resourceVersion would replay every
        // Secret as ADDED; a successful list always sets it.
        throw new Error(
          `[SecretInformer] resume-mode informer for ${this.namespace} has no resourceVersion to watch from`
        )
      }
      queryParams = { resourceVersion, allowWatchBookmarks: true }
    }
    let watchEnded = false

    const watchCallback = (type: string, apiObj: unknown): void => {
      if (this.stopped || watchEnded) return
      const metadata = (apiObj as { metadata?: SecretMetadata } | null)?.metadata
      if (this.list !== null) {
        this.handleResumeModeEvent(type, apiObj, metadata)
        return
      }

      const evtType = type as SecretEventType
      if (evtType !== 'ADDED' && evtType !== 'MODIFIED' && evtType !== 'DELETED') {
        // Ignore BOOKMARK or ERROR events.
        return
      }
      const name = metadata?.name
      if (!name) return

      // Reset backoff on any successful event — stream is healthy.
      this.attempts = 0
      this.emit({ type: evtType, name, namespace: metadata?.namespace ?? this.namespace })
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped || watchEnded) return
      watchEnded = true
      if (err) {
        if (isGone(err)) this.expireResumeVersion('the watch request answered HTTP 410')
        hccLogger.warn('[SecretInformer] watch ended with error', {
          namespace: this.namespace,
          err,
        })
      } else {
        hccLogger.warn('[SecretInformer] watch ended (server-side close), reconnecting', {
          namespace: this.namespace,
        })
      }
      secretInformerRunning.set({ namespace: this.namespace }, 0)
      this.scheduleReconnect()
    }

    try {
      if (resumed) secretInformerResumesTotal.inc({ namespace: this.namespace })
      const request = await this.watch.watch(path, queryParams, watchCallback, doneCallback)
      // Client 1.4.0: HTTP 403 / fetch failure calls done(err) then resolves.
      // Resetting here would pin every informer at 1s forever.
      if (this.stopped || watchEnded) {
        request.abort()
        this.abortController = null
        return false
      }
      this.abortController = request
      this.attempts = 0
      secretInformerRunning.set({ namespace: this.namespace }, 1)
      hccLogger.info(`[SecretInformer] watch established for namespace ${this.namespace}`, {
        namespace: this.namespace,
        resumed,
      })
      return true
    } catch (err) {
      if (this.stopped) return false
      if (isGone(err)) this.expireResumeVersion('the watch request answered HTTP 410')
      secretInformerRunning.set({ namespace: this.namespace }, 0)
      hccLogger.warn('[SecretInformer] failed to start watch', { namespace: this.namespace, err })
      this.scheduleReconnect()
      return false
    }
  }

  /**
   * Resume mode: keep the cache and the resume point current, and emit only
   * what a consumer must act on.
   */
  private handleResumeModeEvent(
    type: string,
    apiObj: unknown,
    metadata: SecretMetadata | undefined
  ): void {
    if (type === 'BOOKMARK') {
      if (metadata?.resourceVersion) this.resumeVersion = metadata.resourceVersion
      return
    }
    if (type === 'ERROR') {
      const code = (apiObj as { code?: unknown } | null)?.code
      if (code === HTTP_GONE) {
        this.expireResumeVersion('the watch stream reported 410 Gone')
      } else {
        hccLogger.warn('[SecretInformer] watch stream reported an error', {
          namespace: this.namespace,
          code,
        })
      }
      return
    }
    if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED') return
    const name = metadata?.name
    if (!name) return
    const uid = metadata?.uid
    const resourceVersion = metadata?.resourceVersion
    if (!uid || !resourceVersion) {
      hccLogger.error(
        '[SecretInformer] watch event without uid or resourceVersion ignored; the cache cannot track it',
        { event: 'secret-informer-event-invalid', namespace: this.namespace, type }
      )
      return
    }

    // Reset backoff on any successful event — stream is healthy.
    this.attempts = 0
    this.resumeVersion = resourceVersion
    const namespace = metadata?.namespace ?? this.namespace

    if (type === 'DELETED') {
      this.cache.delete(name)
      this.emit({ type: 'DELETED', name, namespace })
      return
    }
    const cached = this.cache.get(name)
    this.cache.set(name, { uid, resourceVersion })
    if (type === 'MODIFIED') {
      this.emit({ type: 'MODIFIED', name, namespace })
      return
    }
    if (cached === undefined) {
      // Genuinely first seen by this process (Q1 (a): not evidence).
      this.emit({ type: 'ADDED', name, namespace })
      return
    }
    if (cached.uid === uid && cached.resourceVersion === resourceVersion) {
      // A watch resumed from a resourceVersion never replays a Secret it
      // already delivered; seeing one means the resume contract was broken.
      hccLogger.warn('[SecretInformer] duplicate ADDED for a cached Secret suppressed', {
        event: 'secret-informer-duplicate-added',
        namespace: this.namespace,
      })
      return
    }
    // A cached name with another uid or resourceVersion changed since it was seen.
    this.emit({ type: 'MODIFIED', name, namespace })
  }

  /**
   * Resume mode: list the namespace completely, then diff it against the
   * cache. Returns false when the list failed; nothing was diffed or emitted
   * then, and the cache and resume point are unchanged.
   */
  private async syncFromList(list: SecretList): Promise<boolean> {
    const outcome = this.listed ? 'relist' : 'initial'
    let listedSecrets: Map<string, CachedSecret>
    let listVersion: string
    try {
      ;({ secrets: listedSecrets, resourceVersion: listVersion } = await this.listAllSecrets(list))
    } catch (err) {
      secretInformerListsTotal.inc({ namespace: this.namespace, outcome: 'failed' })
      // A failed list is never treated as empty: that would synthesize
      // DELETED for every Secret and fail the fleet closed.
      hccLogger.error(
        '[SecretInformer] Secret list failed; no watch until a complete list succeeds',
        {
          event: 'secret-informer-list-failed',
          namespace: this.namespace,
          err,
        }
      )
      return false
    }
    if (this.stopped) return false

    const previous = this.cache
    this.cache = listedSecrets
    this.resumeVersion = listVersion
    this.listed = true
    secretInformerListsTotal.inc({ namespace: this.namespace, outcome })
    for (const [name, entry] of listedSecrets) {
      const cached = previous.get(name)
      if (cached === undefined) {
        this.emit({ type: 'ADDED', name, namespace: this.namespace })
      } else if (cached.uid !== entry.uid || cached.resourceVersion !== entry.resourceVersion) {
        // A changed resourceVersion is a modification; a changed uid is a
        // delete and recreate while the watch was down.
        this.emit({ type: 'MODIFIED', name, namespace: this.namespace })
      }
    }
    for (const name of previous.keys()) {
      if (!listedSecrets.has(name)) this.emit({ type: 'DELETED', name, namespace: this.namespace })
    }
    return true
  }

  /** Page through the namespace; any failed page aborts the whole list. */
  private async listAllSecrets(
    list: SecretList
  ): Promise<{ secrets: Map<string, CachedSecret>; resourceVersion: string }> {
    const secrets = new Map<string, CachedSecret>()
    let continueToken: string | undefined
    let resourceVersion: string | undefined
    do {
      const page = await list(this.namespace, { limit: SECRET_LIST_PAGE_SIZE, continueToken })
      for (const item of page.items) {
        const name = item.metadata?.name
        const uid = item.metadata?.uid
        const itemVersion = item.metadata?.resourceVersion
        if (!name || !uid || !itemVersion) {
          throw new Error(
            `Secret list of ${this.namespace} returned an item without name, uid or resourceVersion`
          )
        }
        secrets.set(name, { uid, resourceVersion: itemVersion })
      }
      resourceVersion = page.metadata?.resourceVersion
      continueToken = page.metadata?._continue || undefined
    } while (continueToken !== undefined)
    if (!resourceVersion) {
      throw new Error(`Secret list of ${this.namespace} returned no resourceVersion`)
    }
    return { secrets, resourceVersion }
  }

  private expireResumeVersion(reason: string): void {
    if (this.list === null) return
    this.resumeVersion = null
    hccLogger.warn(
      `[SecretInformer] resourceVersion expired (${reason}); the next connect relists`,
      {
        event: 'secret-informer-resume-expired',
        namespace: this.namespace,
      }
    )
  }

  private emit(evt: SecretEvent): void {
    secretInformerEventsTotal.inc({ namespace: this.namespace, type: evt.type })
    try {
      this.onSecretEvent(evt)
    } catch (err) {
      hccLogger.error('[SecretInformer] onSecretEvent callback threw', {
        namespace: this.namespace,
        err,
      })
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return // already scheduled

    secretInformerReconnectsTotal.inc({ namespace: this.namespace })

    const delay = computeWatchBackoffMs(this.attempts)
    hccLogger.warn(`[SecretInformer] reconnecting in ${delay}ms (attempt ${this.attempts})`, {
      namespace: this.namespace,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(err => {
        secretInformerRunning.set({ namespace: this.namespace }, 0)
        hccLogger.error('[SecretInformer] reconnect failed', { namespace: this.namespace, err })
      })
    }, delay)
  }
}
