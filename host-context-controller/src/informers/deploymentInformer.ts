/**
 * ManagedDeploymentInformer — watches the Deployments HCC manages in one
 * namespace and reports each one's current rollout state to a consumer.
 *
 * It is level-triggered and holds no object cache: its consumer asks only
 * "what is this Deployment's rollout now", so no event needs a diff. Its state
 * is the resume point, the attempt count, the request and the reconnect timer.
 *
 * A reconnect resumes from the last resourceVersion seen. When a resume is
 * impossible (410 Gone) the next connect lists once and delivers every listed
 * Deployment. A failed list delivers nothing and opens no watch.
 *
 * Disconnect behavior matches SecretInformer: exponential backoff capped at
 * 30 s, reset only while the stream is still live after `watch()` resolves and
 * on any later event. `@kubernetes/client-node@1.4.0` calls `done(err)` then
 * resolves on HTTP 403 / fetch failure; that path must keep climbing.
 */
import * as k8s from '@kubernetes/client-node'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import { evaluateDeploymentRollout } from '../deploymentRollout'
import { hccLogger } from '../logger'
import { deploymentInformerRunning } from '../metrics'
import { type WatchLike, computeWatchBackoffMs, isGone } from './secretInformer'

export type DeploymentObservation = {
  name: string
  deleted: boolean
  ready: boolean
  generation: number
}

export type ManagedDeploymentList = () => Promise<k8s.V1DeploymentList>

export interface ManagedDeploymentInformerDeps {
  watch?: WatchLike
}

const HTTP_GONE = 410
const MANAGED_DEPLOYMENT_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`

/** Lists HCC-managed Deployments of the namespace on a deadline-bound client. */
export function managedDeploymentListFromAppsApi(
  api: Pick<k8s.AppsV1Api, 'listNamespacedDeployment'>,
  namespace: string
): ManagedDeploymentList {
  return () =>
    api.listNamespacedDeployment({ namespace, labelSelector: MANAGED_DEPLOYMENT_SELECTOR })
}

function observationFor(deployment: k8s.V1Deployment, deleted: boolean): DeploymentObservation {
  const name = deployment.metadata?.name
  if (!name) throw new Error('Deployment has no metadata.name')
  const { ready, generation } = evaluateDeploymentRollout(deployment)
  return { name, deleted, ready, generation }
}

function statusCodeOf(error: unknown): unknown {
  return (error as { statusCode?: unknown } | null | undefined)?.statusCode
}

export class ManagedDeploymentInformer {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false
  private resumeVersion: string | null = null
  private readonly watch: WatchLike

  constructor(
    kc: k8s.KubeConfig,
    private readonly namespace: string,
    private readonly onObservation: (observation: DeploymentObservation) => void,
    private readonly list: ManagedDeploymentList,
    deps?: ManagedDeploymentInformerDeps
  ) {
    this.watch = deps?.watch ?? new k8s.Watch(kc)
  }

  /** Resolves true once the watch is established. Reconnects continue in the background. */
  async start(): Promise<boolean> {
    this.stopped = false
    return this.connect()
  }

  stop(): void {
    this.stopped = true
    deploymentInformerRunning.set({ namespace: this.namespace }, 0)
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
    const resumed = this.resumeVersion !== null
    if (!resumed) {
      const listed = await this.listAndDeliver()
      if (this.stopped) return false
      if (!listed) {
        deploymentInformerRunning.set({ namespace: this.namespace }, 0)
        this.scheduleReconnect()
        return false
      }
    }

    const resourceVersion = this.resumeVersion
    if (resourceVersion === null) {
      // A watch without a resourceVersion would replay every Deployment; a
      // successful list always sets it.
      throw new Error(
        `[DeploymentInformer] informer for ${this.namespace} has no resourceVersion to watch from`
      )
    }

    let watchEnded = false
    const onEvent = (type: string, apiObj: unknown): void => {
      if (this.stopped || watchEnded) return
      this.handleEvent(type, apiObj)
    }
    const onDone = (err: Error | null): void => {
      if (this.stopped || watchEnded) return
      watchEnded = true
      if (isGone(err)) this.expireResumeVersion('the watch request answered HTTP 410')
      hccLogger.warn('[DeploymentInformer] watch ended, reconnecting', {
        event: 'deployment-informer-watch-ended',
        namespace: this.namespace,
        statusCode: statusCodeOf(err),
        err,
      })
      deploymentInformerRunning.set({ namespace: this.namespace }, 0)
      this.scheduleReconnect()
    }

    try {
      const request = await this.watch.watch(
        `/apis/apps/v1/namespaces/${this.namespace}/deployments`,
        {
          resourceVersion,
          allowWatchBookmarks: true,
          labelSelector: MANAGED_DEPLOYMENT_SELECTOR,
        },
        onEvent,
        onDone
      )
      // Client 1.4.0: HTTP 403 / fetch failure calls done(err) then resolves.
      // Resetting here would pin the informer at 1 s forever.
      if (this.stopped || watchEnded) {
        request.abort()
        this.abortController = null
        return false
      }
      this.abortController = request
      this.attempts = 0
      deploymentInformerRunning.set({ namespace: this.namespace }, 1)
      hccLogger.info('[DeploymentInformer] watch established', {
        event: 'deployment-informer-watch-established',
        namespace: this.namespace,
        resumed,
      })
      return true
    } catch (err) {
      if (this.stopped) return false
      if (isGone(err)) this.expireResumeVersion('the watch request answered HTTP 410')
      deploymentInformerRunning.set({ namespace: this.namespace }, 0)
      hccLogger.warn('[DeploymentInformer] failed to start watch', {
        event: 'deployment-informer-watch-failed',
        namespace: this.namespace,
        statusCode: statusCodeOf(err),
        err,
      })
      this.scheduleReconnect()
      return false
    }
  }

  /** Returns false when the list failed; nothing was delivered then. */
  private async listAndDeliver(): Promise<boolean> {
    let observations: DeploymentObservation[]
    let resourceVersion: string
    try {
      const listed = await this.list()
      const version = listed.metadata?.resourceVersion
      if (!version) throw new Error('Deployment list returned no resourceVersion')
      observations = listed.items.map(item => observationFor(item, false))
      resourceVersion = version
    } catch (err) {
      hccLogger.error(
        '[DeploymentInformer] Deployment list failed; no watch until a list succeeds',
        {
          event: 'deployment-informer-list-failed',
          namespace: this.namespace,
          err,
        }
      )
      return false
    }
    if (this.stopped) return false
    this.resumeVersion = resourceVersion
    for (const observation of observations) this.deliver(observation)
    return true
  }

  private handleEvent(type: string, apiObj: unknown): void {
    const metadata = (apiObj as k8s.V1Deployment | null)?.metadata
    if (type === 'BOOKMARK') {
      if (metadata?.resourceVersion) this.resumeVersion = metadata.resourceVersion
      return
    }
    if (type === 'ERROR') {
      const code = (apiObj as { code?: unknown } | null)?.code
      if (code === HTTP_GONE) {
        this.expireResumeVersion('the watch stream reported 410 Gone')
      } else {
        hccLogger.warn('[DeploymentInformer] watch stream reported an error', {
          namespace: this.namespace,
          code,
        })
      }
      return
    }
    if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED') return
    if (!metadata?.name || !metadata.resourceVersion) {
      hccLogger.error('[DeploymentInformer] watch event without name or resourceVersion ignored', {
        event: 'deployment-informer-event-invalid',
        namespace: this.namespace,
        type,
      })
      return
    }
    this.attempts = 0
    this.resumeVersion = metadata.resourceVersion
    this.deliver(observationFor(apiObj as k8s.V1Deployment, type === 'DELETED'))
  }

  private expireResumeVersion(reason: string): void {
    this.resumeVersion = null
    hccLogger.warn(
      `[DeploymentInformer] resourceVersion expired (${reason}); the next connect lists`,
      {
        event: 'deployment-informer-resume-expired',
        namespace: this.namespace,
      }
    )
  }

  private deliver(observation: DeploymentObservation): void {
    try {
      this.onObservation(observation)
    } catch (err) {
      hccLogger.error('[DeploymentInformer] observation consumer threw', {
        namespace: this.namespace,
        name: observation.name,
        err,
      })
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return

    const delay = computeWatchBackoffMs(this.attempts)
    hccLogger.warn(`[DeploymentInformer] reconnecting in ${delay}ms (attempt ${this.attempts})`, {
      namespace: this.namespace,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(err => {
        deploymentInformerRunning.set({ namespace: this.namespace }, 0)
        hccLogger.error('[DeploymentInformer] reconnect failed', {
          namespace: this.namespace,
          err,
        })
      })
    }, delay)
  }
}
