/**
 * #1338: the NetworkPolicy and McpServer runtime reconcilers build their
 * Kubernetes clients with a per-request deadline.
 *
 * `@kubernetes/client-node` sets no request or socket timeout, so a request on
 * a connection that stops answering never settles. These tests use the real
 * client against a local server that accepts every request and never answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as http from 'node:http'
import { K8S_REQUEST_TIMEOUT_CODE } from './k8s/k8sRequestDeadline'
import { NetworkPolicyReconciler } from './networkPolicyReconciler'
import { McpServerReconciler } from './reconciler'

const DEADLINE_MS = 200

vi.mock('./config', async importOriginal => {
  const actual = await importOriginal<typeof import('./config')>()
  return { ...actual, config: { ...actual.config, k8sRequestTimeoutMs: 200 } }
})

const servers: http.Server[] = []
const seenPaths: string[] = []

/** A Kubernetes API endpoint that accepts every request and never answers. */
async function silentApiServer(): Promise<k8s.KubeConfig> {
  const server = http.createServer(req => {
    seenPaths.push(req.url ?? '')
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no TCP address')
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'silent', server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }],
    users: [{ name: 'tester' }],
    contexts: [{ name: 'silent', cluster: 'silent', user: 'tester' }],
    currentContext: 'silent',
  })
  return kc
}

/** Rejects if `request` has not settled well after the deadline. */
async function settleWithin<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`request still pending after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

afterEach(async () => {
  seenPaths.length = 0
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('#1338 request deadlines on the NetworkPolicy pass path', () => {
  it('ends a full NetworkPolicy reconciliation whose LIST never answers', async () => {
    const reconciler = new NetworkPolicyReconciler(await silentApiServer(), new Map())
    const pass = reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })

    await expect(settleWithin(pass, DEADLINE_MS * 10)).rejects.toMatchObject({
      code: K8S_REQUEST_TIMEOUT_CODE,
      operation: 'NetworkingV1Api.listNamespacedNetworkPolicy',
      timeoutMs: DEADLINE_MS,
    })
    // Witness: the request reached the API server.
    expect(seenPaths.some(path => path.includes('/networkpolicies'))).toBe(true)
  })

  it('bounds the NetworkPolicy reconciler custom-object reads', async () => {
    const reconciler = new NetworkPolicyReconciler(await silentApiServer(), new Map())
    const customApi = (reconciler as unknown as { customApi: k8s.CustomObjectsApi }).customApi
    const read = customApi.getNamespacedCustomObject({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'mcp-server',
      plural: 'mcpservers',
      name: 'absent',
    })

    await expect(settleWithin(read, DEADLINE_MS * 10)).rejects.toMatchObject({
      code: K8S_REQUEST_TIMEOUT_CODE,
      operation: 'CustomObjectsApi.getNamespacedCustomObject',
    })
    expect(seenPaths.some(path => path.includes('/mcpservers/absent'))).toBe(true)
  })

  it.each([
    [
      'AppsV1Api.readNamespacedDeployment',
      (r: any) => r.appsApi.readNamespacedDeployment({ name: 'x', namespace: 'mcp-server' }),
      '/deployments/x',
    ],
    [
      'CoreV1Api.readNamespacedService',
      (r: any) => r.coreApi.readNamespacedService({ name: 'x', namespace: 'mcp-server' }),
      '/services/x',
    ],
    [
      'CustomObjectsApi.getNamespacedCustomObject',
      (r: any) =>
        r.customApi.getNamespacedCustomObject({
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace: 'mcp-server',
          plural: 'mcpservers',
          name: 'x',
        }),
      '/mcpservers/x',
    ],
  ])('bounds the McpServer runtime reconciler call %s', async (operation, call, path) => {
    const reconciler = new McpServerReconciler(await silentApiServer())
    await expect(settleWithin(call(reconciler), DEADLINE_MS * 10)).rejects.toMatchObject({
      code: K8S_REQUEST_TIMEOUT_CODE,
      operation,
    })
    expect(seenPaths.some(seen => seen.includes(path))).toBe(true)
  })
})
