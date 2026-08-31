import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockAppsApi,
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
import { deploymentMatchesDesired, preserveDeploymentAnnotations } from '../utils'
import { asApiserverDeployment } from './asApiserverDeployment'
import {
  cloneAndMutateLeaf,
  collectLeafPaths,
  collectLiveOnlySpecLeaves,
  formatLeafPath,
  undetectableLiveOnlySpecLeaves,
} from './mutateJsonLeaves'

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

const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'

function makeServer(): McpServerCRD {
  return {
    name: 'test-mcp',
    namespace: 'mcp-server',
    uid: 'uid-test-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'my-mcp-server:v1',
      transport: { type: 'streamableHttp', port: 3000, url: 'http://test.mcp-server.svc:3000/mcp' },
      envSecret: {
        name: 'test-mcp-credentials',
        keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }],
      },
    },
  }
}

function makeStdioServer(): McpServerCRD {
  return {
    name: 'test-mcp',
    namespace: 'mcp-server',
    uid: 'uid-test-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'my-mcp-server:v1',
      transport: { type: 'stdio', port: 3000 },
      command: ['/mcp-bin/mcp-server'],
    },
  }
}

function mergedForCompare(desired: k8s.V1Deployment, existing: k8s.V1Deployment): k8s.V1Deployment {
  return preserveDeploymentAnnotations(
    {
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
    },
    existing
  )
}

describe('McpServer ensureDeployment no-op gate', () => {
  let appsApi: MockAppsApi
  let reconciler: McpServerReconciler
  const server = makeServer()

  beforeEach(() => {
    appsApi = createMockAppsApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(createMockCoreApi()),
      customApi: asCustomApi(createMockCustomApi()),
    })
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
  })

  it('FIXTURE-1: McpServer builder output differs from the default-filled live object', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })

  it('predicate: merged builder vs fixture is a no-op', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('McpServer mutation sweep: every desired leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    const undetectable: string[] = []
    for (const path of collectLeafPaths(desired)) {
      const mutated = cloneAndMutateLeaf(desired, path) as k8s.V1Deployment
      if (deploymentMatchesDesired(mergedForCompare(mutated, existing), existing)) {
        undetectable.push(formatLeafPath(path))
      }
    }
    expect(undetectable, `undetectable leaf path(s): ${undetectable.join(', ')}`).toEqual([])
  })

  it('McpServer mutation sweep: every live-only spec leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    expect(collectLiveOnlySpecLeaves(desired, existing).length).toBeGreaterThan(0)
    expect(
      undetectableLiveOnlySpecLeaves(desired, existing, mutated =>
        deploymentMatchesDesired(
          mergedForCompare(desired, mutated as k8s.V1Deployment),
          mutated as k8s.V1Deployment
        )
      )
    ).toEqual([])
  })

  it('NOOP-MCPDEP-1: equivalent Deployment skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureDeployment(server, 'rev-1')
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(updatedLogs(log, 'Updated', 'Deployment "test-mcp"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('ROTATE-MCPDEP-1: credentials revision change replaces once with the new annotation', async () => {
    const live = (reconciler as any).buildDeployment(server, 'rev-old') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureDeployment(server, 'rev-new')
      expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
      const body = (
        appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
      ).body
      expect(body.spec?.template?.metadata?.annotations?.[CREDENTIALS_REVISION_ANNOTATION]).toBe(
        'rev-new'
      )
      expect(updatedLogs(log, 'Updated', 'Deployment "test-mcp"')).toEqual([
        '[Reconciler] Updated Deployment "test-mcp"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('IMAGE-MCPDEP-1: image bump replaces once', async () => {
    const live = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    const bumped = makeServer()
    bumped.spec.image = 'my-mcp-server:v2'
    await (reconciler as any).ensureDeployment(bumped, 'rev-1')
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const body = (
      appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
    ).body
    expect(body.spec?.template?.spec?.containers?.[0]?.image).toBe('my-mcp-server:v2')
  })

  it('GATE-MCPDEP-1: drift plus isCurrent false skips replace after the gate', async () => {
    const live = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const bumped = makeServer()
    bumped.spec.image = 'my-mcp-server:v2'

    await (reconciler as any).ensureDeployment(bumped, 'rev-1', isCurrent)

    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(isCurrent).toHaveBeenCalled()
  })
})

describe('McpServer stdio ensureDeployment no-op gate', () => {
  let appsApi: MockAppsApi
  let reconciler: McpServerReconciler
  const server = makeStdioServer()

  beforeEach(() => {
    appsApi = createMockAppsApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(createMockCoreApi()),
      customApi: asCustomApi(createMockCustomApi()),
    })
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
  })

  it('stdio-bridge authors imagePullPolicy so the live default-fill is a no-op', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const podSpec = desired.spec?.template?.spec
    expect(podSpec?.initContainers?.find(c => c.name === 'copy-mcp-app')?.imagePullPolicy).toBe(
      'IfNotPresent'
    )
    expect(podSpec?.containers?.find(c => c.name === 'stdio-bridge')?.imagePullPolicy).toBe(
      'IfNotPresent'
    )
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('McpServer stdio mutation sweep: every desired leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    const undetectable: string[] = []
    for (const path of collectLeafPaths(desired)) {
      const mutated = cloneAndMutateLeaf(desired, path) as k8s.V1Deployment
      if (deploymentMatchesDesired(mergedForCompare(mutated, existing), existing)) {
        undetectable.push(formatLeafPath(path))
      }
    }
    expect(undetectable, `undetectable leaf path(s): ${undetectable.join(', ')}`).toEqual([])
  })

  it('McpServer stdio mutation sweep: every live-only spec leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    expect(collectLiveOnlySpecLeaves(desired, existing).length).toBeGreaterThan(0)
    expect(
      undetectableLiveOnlySpecLeaves(desired, existing, mutated =>
        deploymentMatchesDesired(
          mergedForCompare(desired, mutated as k8s.V1Deployment),
          mutated as k8s.V1Deployment
        )
      )
    ).toEqual([])
  })

  it('NOOP-MCPDEP-STDIO-1: equivalent stdio Deployment skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureDeployment(server, 'rev-1')
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(updatedLogs(log, 'Updated', 'Deployment "test-mcp"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('IMAGE-MCPDEP-STDIO-1: image bump replaces the copy init container once', async () => {
    const live = (reconciler as any).buildDeployment(server, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    const bumped = makeStdioServer()
    bumped.spec.image = 'my-mcp-server:v2'
    await (reconciler as any).ensureDeployment(bumped, 'rev-1')
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const body = (
      appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
    ).body
    const copyImage = body.spec?.template?.spec?.initContainers?.find(
      c => c.name === 'copy-mcp-app'
    )?.image
    expect(copyImage).toBe('my-mcp-server:v2')
  })
})
