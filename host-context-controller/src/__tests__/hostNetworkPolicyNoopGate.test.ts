import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockNetworkingApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
  createMockRbacApi,
  makeStubKc,
} from '../../test/__fixtures__/testMocks'
import { HostReconciler } from '../hostReconciler'
import type { HostCRD } from '../types'
import { asApiserverNetworkPolicy } from './asApiserverNetworkPolicy'

function makeHost(): HostCRD {
  return {
    name: 'chatllm',
    namespace: 'mcp-host',
    uid: 'chatllm-uid',
    spec: {
      host: 'chatllm',
      contextRef: 'ctx',
      secretRef: 'secret',
    },
  }
}

describe('Host ensureMcpHostIngressNetworkPolicy inherits applyNetworkPolicy gate', () => {
  let networkingApi: MockNetworkingApi
  let reconciler: HostReconciler
  const host = makeHost()

  beforeEach(() => {
    networkingApi = createMockNetworkingApi()
    reconciler = new HostReconciler(makeStubKc(), {
      coreApi: asCoreApi(createMockCoreApi()),
      appsApi: asAppsApi(createMockAppsApi()),
      networkingApi: asNetworkingApi(networkingApi),
      rbacApi: asRbacApi(createMockRbacApi()),
      customApi: asCustomApi(createMockCustomApi()),
    })
  })

  it('INHERIT-NP-1: equivalent recorded policy skips replace; drift replaces once', async () => {
    let captured: k8s.V1NetworkPolicy | undefined
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async ({ body }) => {
      captured = body as k8s.V1NetworkPolicy
      return body
    })
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async () => {
      if (!captured) throw Object.assign(new Error('not found'), { code: 404 })
      if (!captured.spec) throw new Error('create did not capture a spec')
      return asApiserverNetworkPolicy(captured)
    })

    await (reconciler as any).ensureMcpHostIngressNetworkPolicy(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    networkingApi.readNamespacedNetworkPolicy.mockClear()
    networkingApi.createNamespacedNetworkPolicy.mockClear()
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })

    await (reconciler as any).ensureMcpHostIngressNetworkPolicy(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(networkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()

    networkingApi.replaceNamespacedNetworkPolicy.mockClear()
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async () => {
      if (!captured?.spec) throw new Error('create did not capture a spec')
      return asApiserverNetworkPolicy(captured, { port: 9090 })
    })
    await (reconciler as any).ensureMcpHostIngressNetworkPolicy(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledOnce()
  })
})
