import * as k8s from '@kubernetes/client-node'
import { config } from '../config'
import { makeK8sApiClientWithDeadline } from './k8sRequestDeadline'

export type WatcherK8sClients = {
  customObjectsApi: k8s.CustomObjectsApi
  hostCustomObjectsApi: k8s.CustomObjectsApi
  coreApi: k8s.CoreV1Api
}

/**
 * The watcher's shared finite-call clients. Every one carries a per-request
 * deadline: `customObjectsApi` serves McpServer/Context inventory reads,
 * including reads on the keyed effect queues the NetworkPolicy pass waits on
 * (#1338), and `coreApi` serves the MCP authorization store's Secret reads.
 * Watches use `k8s.Watch` and are not affected.
 */
export function createWatcherK8sClients(kc: k8s.KubeConfig): WatcherK8sClients {
  return {
    customObjectsApi: makeK8sApiClientWithDeadline(
      kc,
      k8s.CustomObjectsApi,
      config.k8sRequestTimeoutMs
    ),
    hostCustomObjectsApi: makeK8sApiClientWithDeadline(
      kc,
      k8s.CustomObjectsApi,
      config.hostK8sRequestTimeoutMs
    ),
    coreApi: makeK8sApiClientWithDeadline(kc, k8s.CoreV1Api, config.k8sRequestTimeoutMs),
  }
}
