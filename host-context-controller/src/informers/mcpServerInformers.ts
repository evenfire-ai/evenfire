import * as k8s from '@kubernetes/client-node'
import { config } from '../config'
import { makeK8sApiClientWithDeadline } from '../k8s/k8sRequestDeadline'
import type { McpServerWatcher } from '../k8sClient'
import { hccLogger } from '../logger'
import { ManagedDeploymentInformer, managedDeploymentListFromAppsApi } from './deploymentInformer'
import { SecretInformer, secretListFromCoreApi } from './secretInformer'

export interface McpServerInformers {
  /** Stops the Deployment informer, then the three Secret informers. */
  stop(): void
}

/**
 * Construct and start the production informers that feed the watcher: the
 * managed Deployment informer and the Secret informers on the McpServer,
 * channels and llm-hooks namespaces. main() calls it once the provider has
 * started; a test can call it without starting the process.
 */
export async function startMcpServerInformers(
  kc: k8s.KubeConfig,
  watcher: McpServerWatcher
): Promise<McpServerInformers> {
  // Re-enqueues a server with a terminal RolloutIncomplete when its Deployment
  // moves. Not awaited: the watch request has no transport deadline, and an await
  // that hangs here would keep main()'s SIGTERM handler from ever registering.
  const deploymentListApi = makeK8sApiClientWithDeadline(
    kc,
    k8s.AppsV1Api,
    config.k8sRequestTimeoutMs
  )
  const deploymentInformer = new ManagedDeploymentInformer(
    kc,
    config.namespace,
    watcher.handleDeploymentObservation,
    managedDeploymentListFromAppsApi(deploymentListApi, config.namespace)
  )
  void deploymentInformer.start().catch(err => {
    hccLogger.error('[Main] Deployment informer failed to start', { err })
  })

  // SecretInformer on the McpServer namespace: reacts to Secret lifecycle
  // events so McpServers referencing a missing Secret reconcile once the
  // Secret appears (or disappears). #1338: only this informer runs in resume
  // mode. Each page of its list runs on HCC's request deadline.
  const secretListApi = makeK8sApiClientWithDeadline(kc, k8s.CoreV1Api, config.k8sRequestTimeoutMs)
  const secretInformer = new SecretInformer(kc, config.namespace, watcher.handleSecretEvent, {
    mode: 'resume',
    list: secretListFromCoreApi(secretListApi),
  })
  try {
    const running = await secretInformer.start()
    if (running) {
      hccLogger.info(`[Main] SecretInformer started on namespace ${config.namespace}`)
    } else {
      hccLogger.warn(
        `[Main] SecretInformer degraded on namespace ${config.namespace}; reconnect will continue in background`
      )
    }
  } catch (err) {
    hccLogger.error('[Main] SecretInformer failed to start', { err })
  }

  // Second SecretInformer: per-host channel-reader credentials Secrets in
  // the channels namespace. Events drive rolling restarts of channel-reader
  // pods via the credentials-revision annotation.
  //
  // reconcileChannelReaderRevision is self-contained (does not throw), so
  // the .catch here is defensive — it catches any unexpected runtime error
  // in the SecretInformer's own callback path.
  const channelSecretInformer = new SecretInformer(
    kc,
    config.channelsNamespace,
    evt => {
      watcher.reconcileChannelReaderRevision(evt.name, evt.namespace).catch(err => {
        hccLogger.error('[Main] reconcileChannelReaderRevision failed', { err })
      })
    },
    // Replay mode until this consumer has its own retry owner (#1360).
    { mode: 'replay' }
  )
  try {
    await channelSecretInformer.start()
    hccLogger.info(
      `[Main] channels SecretInformer started on namespace ${config.channelsNamespace}`
    )
  } catch (err) {
    hccLogger.error('[Main] channels SecretInformer failed to start', { err })
  }

  // Third SecretInformer: hook credential Secrets in the llm-hooks namespace.
  // A rotation re-stamps the credentials-revision and rolls the hook pod
  // (§8.2, mirroring the McpServer envSecret informer above).
  const llmHooksSecretInformer = new SecretInformer(
    kc,
    config.llmHooksNamespace,
    evt => {
      watcher.reconcileLlmHookByEnvSecret(evt.name, evt.namespace).catch(err => {
        hccLogger.error('[Main] reconcileLlmHookByEnvSecret failed', { err })
      })
    },
    // Replay mode until this consumer has its own retry owner (#1360).
    { mode: 'replay' }
  )
  try {
    await llmHooksSecretInformer.start()
    hccLogger.info(
      `[Main] llm-hooks SecretInformer started on namespace ${config.llmHooksNamespace}`
    )
  } catch (err) {
    hccLogger.error('[Main] llm-hooks SecretInformer failed to start', { err })
  }

  return {
    stop() {
      deploymentInformer.stop()
      secretInformer.stop()
      channelSecretInformer.stop()
      llmHooksSecretInformer.stop()
    },
  }
}
