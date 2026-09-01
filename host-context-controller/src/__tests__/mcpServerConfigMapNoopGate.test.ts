import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockCoreApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { updatedLogs } from '../../test/__fixtures__/updatedLogs'
import { McpServerReconciler } from '../reconciler'
import type { McpServerCRD } from '../types'
import { configMapMatchesDesired } from '../utils'

vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:test',
    stdioBridgeResources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
  },
}))

function makeRemoteServer(): McpServerCRD {
  return {
    name: 'mcp-sentry-remote',
    namespace: 'mcp-server',
    uid: 'test-uid-123',
    spec: {
      contextRef: 'context1',
      image: 'clerum/nginx-egress-proxy:0.1.0',
      transport: { type: 'streamableHttp', port: 3000 },
      remote: { baseUrl: 'https://mcp.sentry.io/sse' },
    },
  }
}

function asApiserverConfigMap(
  desired: k8s.V1ConfigMap,
  drift?: { template?: string }
): k8s.V1ConfigMap {
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      resourceVersion: '42',
      uid: 'cm-uid',
      creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
    },
    data: {
      ...desired.data,
      ...(drift?.template !== undefined ? { 'default.conf.template': drift.template } : {}),
    },
  }
}

describe('McpServer nginx ConfigMap no-op gate', () => {
  let coreApi: MockCoreApi
  let reconciler: McpServerReconciler
  const server = makeRemoteServer()

  beforeEach(() => {
    coreApi = createMockCoreApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(createMockCustomApi()),
    })
    coreApi.createNamespacedConfigMap.mockRejectedValue({ code: 409 })
  })

  it('returns false when either ConfigMap is missing (fail-open-to-write)', () => {
    const desired = (reconciler as any).buildNginxConfigMap(server) as k8s.V1ConfigMap
    expect(configMapMatchesDesired(undefined, desired)).toBe(false)
    expect(configMapMatchesDesired(desired, undefined)).toBe(false)
  })

  it('CM-1: identical conf skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildNginxConfigMap(server) as k8s.V1ConfigMap
    coreApi.readNamespacedConfigMap.mockResolvedValue(asApiserverConfigMap(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureConfigMap(server)
      expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
      expect(updatedLogs(log, 'Updated', 'nginx ConfigMap')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('CM-2: a byte change in default.conf.template replaces once', async () => {
    const desired = (reconciler as any).buildNginxConfigMap(server) as k8s.V1ConfigMap
    coreApi.readNamespacedConfigMap.mockResolvedValue(
      asApiserverConfigMap(desired, { template: '# drifted\n' })
    )
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureConfigMap(server)
      expect(coreApi.replaceNamespacedConfigMap).toHaveBeenCalledOnce()
      const body = (
        coreApi.replaceNamespacedConfigMap.mock.calls[0][0] as { body: k8s.V1ConfigMap }
      ).body
      expect(body.data?.['default.conf.template']).toBe(desired.data?.['default.conf.template'])
      expect(updatedLogs(log, 'Updated', 'nginx ConfigMap')).toEqual([
        '[Reconciler] Updated nginx ConfigMap "mcp-sentry-remote-nginx-conf"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('CM-3: replace 409 retries and succeeds', async () => {
    const desired = (reconciler as any).buildNginxConfigMap(server) as k8s.V1ConfigMap
    const drifted = asApiserverConfigMap(desired, { template: '# drifted\n' })
    coreApi.readNamespacedConfigMap
      .mockResolvedValueOnce({
        ...drifted,
        metadata: { ...drifted.metadata, resourceVersion: '42' },
      })
      .mockResolvedValueOnce({
        ...drifted,
        metadata: { ...drifted.metadata, resourceVersion: '43' },
      })
    coreApi.replaceNamespacedConfigMap
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({})

    await (reconciler as any).ensureConfigMap(server)

    expect(coreApi.replaceNamespacedConfigMap).toHaveBeenCalledTimes(2)
    expect(
      (coreApi.replaceNamespacedConfigMap.mock.calls[0][0] as { body: k8s.V1ConfigMap }).body
        .metadata?.resourceVersion
    ).toBe('42')
    expect(
      (coreApi.replaceNamespacedConfigMap.mock.calls[1][0] as { body: k8s.V1ConfigMap }).body
        .metadata?.resourceVersion
    ).toBe('43')
  })

  it('CM-4: isCurrent false skips replace after the gate', async () => {
    const desired = (reconciler as any).buildNginxConfigMap(server) as k8s.V1ConfigMap
    coreApi.readNamespacedConfigMap.mockResolvedValue(
      asApiserverConfigMap(desired, { template: '# drifted\n' })
    )
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)

    await (reconciler as any).ensureConfigMap(server, isCurrent)

    expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    expect(isCurrent).toHaveBeenCalled()
  })
})
