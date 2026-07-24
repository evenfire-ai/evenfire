import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
import type { CommunicationChannelCRD } from '../src/types'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from './__fixtures__/testMocks'

vi.mock('../src/config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    channelsNamespace: 'channels',
    channelReaderImage: 'clerum/channel-reader:test',
    channelReaderImagePullPolicy: 'IfNotPresent',
    hostFullReconcileConcurrency: 2,
  },
}))

type FinderOpts = {
  findByName: (name: string) => CommunicationChannelCRD[]
  findByHost: (host: string) => CommunicationChannelCRD[]
}

function createReconciler(finders: FinderOpts) {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()
  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    networkingApi: asNetworkingApi(networkingApi),
    rbacApi: asRbacApi(rbacApi),
  })
  reconciler.setFindCommunicationChannelsByCredentialsSecretName(finders.findByName)
  reconciler.setFindCommunicationChannelsByHostRef(finders.findByHost)
  return { reconciler, appsApi, coreApi }
}

describe('reconcileChannelReaderRevision (cache-based)', () => {
  it('skips when no CC references the secret', async () => {
    const findByName = vi.fn(() => [] as CommunicationChannelCRD[])
    const { reconciler, appsApi } = createReconciler({
      findByName,
      findByHost: () => [],
    })

    await reconciler.reconcileChannelReaderRevision('orphan-secret', 'channels')

    expect(findByName).toHaveBeenCalledWith('orphan-secret')
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('patches each affected host exactly once when multiple CCs share a secret', async () => {
    const sharedCCs: CommunicationChannelCRD[] = [
      {
        name: 'cc-1',
        namespace: 'channels',
        spec: { hostRef: 'h1', credentialsSecretRef: { name: 'shared' } },
      },
      {
        name: 'cc-2',
        namespace: 'channels',
        spec: { hostRef: 'h2', credentialsSecretRef: { name: 'shared' } },
      },
      {
        name: 'cc-3',
        namespace: 'channels',
        spec: { hostRef: 'h1', credentialsSecretRef: { name: 'shared' } },
      },
    ]
    const { reconciler, appsApi, coreApi } = createReconciler({
      findByName: name => (name === 'shared' ? sharedCCs : []),
      findByHost: host => [
        {
          name: `cc-${host}`,
          namespace: 'channels',
          spec: { hostRef: host, credentialsSecretRef: { name: 'shared' } },
        },
      ],
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: {} })
    appsApi.patchNamespacedDeployment.mockResolvedValue({})

    await reconciler.reconcileChannelReaderRevision('shared', 'channels')

    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(2)
    const callNames = appsApi.patchNamespacedDeployment.mock.calls
      .map(c => (c[0] as { name: string }).name)
      .sort()
    expect(callNames).toEqual(['channel-reader-h1', 'channel-reader-h2'])
  })

  it('ignores secrets in other namespaces (does not consult the cache)', async () => {
    const findByName = vi.fn(
      () =>
        [
          {
            name: 'cc-x',
            namespace: 'channels',
            spec: { hostRef: 'h1', credentialsSecretRef: { name: 'shared' } },
          },
        ] as CommunicationChannelCRD[]
    )
    const { reconciler, appsApi } = createReconciler({
      findByName,
      findByHost: () => [],
    })

    await reconciler.reconcileChannelReaderRevision('shared', 'control-plane')

    expect(findByName).not.toHaveBeenCalled()
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
  })
})
