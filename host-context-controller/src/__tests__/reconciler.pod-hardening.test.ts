import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { McpServerReconciler } from '../reconciler'
import { McpServerCRD } from '../types'

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

function makeServer(
  overrides: Partial<McpServerCRD['spec']> & { name?: string } = {}
): McpServerCRD {
  const { name, ...specOverrides } = overrides
  return {
    name: name ?? 'test-mcp',
    namespace: 'mcp-server',
    uid: 'uid-test-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'my-mcp-server:v1',
      transport: { type: 'streamableHttp', port: 3000, url: 'http://test.mcp-server.svc:3000/mcp' },
      ...specOverrides,
    },
  }
}

function capturedDeployment(appsApi: ReturnType<typeof createMockAppsApi>): k8s.V1Deployment {
  const call = appsApi.createNamespacedDeployment.mock.calls[0]
  return (call[0] as { body: k8s.V1Deployment }).body
}

function expectPodTokenAndSeccomp(dep: k8s.V1Deployment): void {
  const pod = dep.spec!.template.spec!
  expect(pod.automountServiceAccountToken).toBe(false)
  expect(pod.enableServiceLinks).toBe(false)
  expect(pod.securityContext?.runAsNonRoot).toBe(true)
  expect(pod.securityContext?.runAsUser).toBe(1000)
  expect(pod.securityContext?.runAsGroup).toBe(1000)
  expect(pod.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' })
}

function expectContainerBoundary(container: k8s.V1Container): void {
  expect(container.securityContext?.allowPrivilegeEscalation).toBe(false)
  expect(container.securityContext?.capabilities?.drop).toEqual(['ALL'])
  expect(container.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' })
}

function expectDefaultMcpIdentity(container: k8s.V1Container): void {
  expect(container.securityContext?.runAsNonRoot).toBe(true)
  expect(container.securityContext?.runAsUser).toBe(1000)
  expect(container.securityContext?.runAsGroup).toBe(1000)
}

function expectRemoteProxyIdentity(container: k8s.V1Container): void {
  expect(container.securityContext?.runAsNonRoot).toBe(true)
  expect(container.securityContext?.runAsUser).toBe(101)
  expect(container.securityContext?.runAsGroup).toBe(101)
}

describe('McpServer generated pod hardening', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('disables service account tokens and hardens local HTTP MCP containers', async () => {
    await reconciler.reconcile(makeServer())

    const dep = capturedDeployment(appsApi)
    const container = dep.spec!.template.spec!.containers![0]
    expectPodTokenAndSeccomp(dep)
    expectContainerBoundary(container)
    expectDefaultMcpIdentity(container)
  })

  it('applies the same token and seccomp boundary to remote egress proxy pods', async () => {
    await reconciler.reconcile(
      makeServer({
        name: 'remote-mcp',
        remote: { baseUrl: 'https://api.example.com' },
      })
    )

    const dep = capturedDeployment(appsApi)
    const container = dep.spec!.template.spec!.containers![0]
    expectPodTokenAndSeccomp(dep)
    expectContainerBoundary(container)
    expectRemoteProxyIdentity(container)
  })

  it('hardens stdio init and bridge containers without mounting service account tokens', async () => {
    await reconciler.reconcile(
      makeServer({
        name: 'stdio-mcp',
        transport: { type: 'stdio', port: 3000 },
        command: ['/mcp-bin/mcp-server'],
      })
    )

    const dep = capturedDeployment(appsApi)
    const pod = dep.spec!.template.spec!
    expectPodTokenAndSeccomp(dep)
    expectContainerBoundary(pod.initContainers![0])
    expectContainerBoundary(pod.containers![0])
    expectDefaultMcpIdentity(pod.initContainers![0])
    expectDefaultMcpIdentity(pod.containers![0])
  })
})
