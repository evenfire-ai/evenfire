import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockAppsApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
} from '../../test/__fixtures__/testMocks'
import { updatedLogs } from '../../test/__fixtures__/updatedLogs'
import { LlmHookReconciler, computePodKey } from '../llmHookReconciler'
import type { HostCRD, LlmHookCRD } from '../types'
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
    llmHooksNamespace: 'llm-hooks',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
  },
}))

const IMG = 'registry.example.com/hook@sha256:' + 'a'.repeat(64)
const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'

function makeHook(): LlmHookCRD {
  return {
    name: 'pre-hook',
    namespace: 'llm-hooks',
    generation: 1,
    spec: {
      target: { image: { ref: IMG, port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
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

describe('LlmHook ensureDeployment no-op gate', () => {
  let appsApi: MockAppsApi
  let reconciler: LlmHookReconciler
  const hook = makeHook()
  const podKey = computePodKey(hook)!
  const members = [hook]

  beforeEach(() => {
    appsApi = createMockAppsApi()
    reconciler = new LlmHookReconciler(
      {} as k8s.KubeConfig,
      new Map<string, LlmHookCRD>(),
      new Map<string, HostCRD>(),
      {
        appsApi: asAppsApi(appsApi),
        coreApi: asCoreApi(createMockCoreApi()),
        customApi: asCustomApi(createMockCustomApi()),
        networkingApi: asNetworkingApi(createMockNetworkingApi()),
      }
    )
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
  })

  it('FIXTURE-1: LlmHook builder output differs from the default-filled live object', () => {
    const desired = (reconciler as any).buildDeployment(
      podKey,
      members,
      'rev-1'
    ) as k8s.V1Deployment
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })

  it('predicate: merged builder vs fixture is a no-op', () => {
    const desired = (reconciler as any).buildDeployment(
      podKey,
      members,
      'rev-1'
    ) as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('LlmHook mutation sweep: every desired leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(
      podKey,
      members,
      'rev-1'
    ) as k8s.V1Deployment
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

  it('LlmHook mutation sweep: every live-only spec leaf is detectable', () => {
    const desired = (reconciler as any).buildDeployment(
      podKey,
      members,
      'rev-1'
    ) as k8s.V1Deployment
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

  it('NOOP-LLMDEP-1: equivalent Deployment skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildDeployment(
      podKey,
      members,
      'rev-1'
    ) as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureDeployment(podKey, members, 'rev-1')
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(updatedLogs(log, 'Updated', 'Deployment')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('ROTATE-LLMDEP-1: credentials revision change replaces once', async () => {
    const live = (reconciler as any).buildDeployment(podKey, members, 'rev-old') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    await (reconciler as any).ensureDeployment(podKey, members, 'rev-new')
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const body = (
      appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
    ).body
    expect(body.spec?.template?.metadata?.annotations?.[CREDENTIALS_REVISION_ANNOTATION]).toBe(
      'rev-new'
    )
  })

  it('IMAGE-LLMDEP-1: image.ref bump replaces once', async () => {
    const live = (reconciler as any).buildDeployment(podKey, members, 'rev-1') as k8s.V1Deployment
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(live))
    const bumped = makeHook()
    bumped.spec.target.image!.ref = 'registry.example.com/hook@sha256:' + 'b'.repeat(64)
    const newKey = computePodKey(bumped)!
    await (reconciler as any).ensureDeployment(newKey, [bumped], 'rev-1')
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const body = (
      appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
    ).body
    expect(body.spec?.template?.spec?.containers?.[0]?.image).toBe(bumped.spec.target.image!.ref)
  })
})
