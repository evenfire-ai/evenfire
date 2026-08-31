import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { type SharedFileSystemFactoryConfig, buildDeployment } from '../k8s/sharedFileSystemFactory'
import { SharedFileSystemReconciler } from '../sharedFileSystemReconciler'
import type { SharedFileSystemCRD } from '../types'
import { deploymentMatchesDesired, preserveDeploymentAnnotations } from '../utils'
import { asApiserverDeployment } from './asApiserverDeployment'
import { cloneAndMutateLeaf, collectLeafPaths, formatLeafPath } from './mutateJsonLeaves'

const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'
const RESTART_STAMP = '2026-08-31T10:00:00Z'

const factoryConfig: SharedFileSystemFactoryConfig = {
  hostNamespace: 'mcp-host',
  controlPlaneNamespace: 'control-plane',
  wfcImage: 'registry.example/clerum/workspace-files-controller:0.1.0',
  wfcImagePullPolicy: 'IfNotPresent',
  wfcImagePullSecretName: 'clerum',
  wfcPort: 8086,
  wfcInitImage: 'busybox:1.36',
  wfcResources: {
    requests: { memory: '64Mi', cpu: '50m' },
    limits: { memory: '128Mi', cpu: '200m' },
  },
  wfcJwtPublicKeyConfigMapName: 'mcp-host-config',
  wfcJwtPublicKeyConfigMapKey: 'CLERUM_AUTH_JWT_PUBLIC_KEY',
  wfcMaxUploadBytes: 100 * 1024 * 1024,
  wfcMaxListEntries: 5000,
  wfcMaxPathDepth: 32,
}

function makeSfs(): SharedFileSystemCRD {
  return {
    name: 'team-mission',
    namespace: 'mcp-host',
    spec: {
      size: '5Gi',
      directories: ['docs', 'runbooks'],
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
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

function withRestartedAt(deployment: k8s.V1Deployment, stamp = RESTART_STAMP): k8s.V1Deployment {
  const live = structuredClone(deployment)
  const templateMeta = live.spec?.template?.metadata
  if (!templateMeta) throw new Error('expected pod template metadata')
  templateMeta.annotations = {
    ...templateMeta.annotations,
    [RESTARTED_AT]: stamp,
  }
  return live
}

describe('SFS Deployment no-op gate', () => {
  const sfs = makeSfs()
  let appsApi: {
    createNamespacedDeployment: ReturnType<typeof vi.fn>
    readNamespacedDeployment: ReturnType<typeof vi.fn>
    replaceNamespacedDeployment: ReturnType<typeof vi.fn>
  }

  function makeReconciler(cfg: SharedFileSystemFactoryConfig = factoryConfig) {
    appsApi = {
      createNamespacedDeployment: vi.fn().mockRejectedValue({ code: 409 }),
      readNamespacedDeployment: vi.fn(),
      replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
    }
    return new SharedFileSystemReconciler(null, {
      appsApi: appsApi as never,
      coreApi: {} as never,
      batchApi: {} as never,
      networkingApi: {} as never,
      customApi: {} as never,
      factoryConfig: cfg,
    })
  }

  beforeEach(() => {
    appsApi = {
      createNamespacedDeployment: vi.fn(),
      readNamespacedDeployment: vi.fn(),
      replaceNamespacedDeployment: vi.fn(),
    }
  })

  it('FIXTURE-1: SFS builder output differs from the default-filled live object', () => {
    const desired = buildDeployment(sfs, factoryConfig)
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })

  it('predicate: merged builder vs fixture is a no-op', () => {
    const desired = buildDeployment(sfs, factoryConfig)
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('SFS mutation sweep: every desired leaf is detectable', () => {
    const desired = buildDeployment(sfs, factoryConfig)
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

  it('NOOP-SFS-1: equivalent Deployment skips replace', async () => {
    const reconciler = makeReconciler()
    const desired = buildDeployment(sfs, factoryConfig)
    appsApi.readNamespacedDeployment.mockResolvedValue(asApiserverDeployment(desired))
    await (reconciler as any).ensureDeployment(sfs)
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('SFS-3: live restartedAt plus identical desired skips without clearing the marker', async () => {
    const reconciler = makeReconciler()
    const desired = buildDeployment(sfs, factoryConfig)
    const live = withRestartedAt(asApiserverDeployment(desired))
    appsApi.readNamespacedDeployment.mockResolvedValue(live)
    await (reconciler as any).ensureDeployment(sfs)
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('SFS-3: a real change replaces once and keeps restartedAt', async () => {
    const oldConfig = { ...factoryConfig, wfcImage: 'wfc:old' }
    const newConfig = { ...factoryConfig, wfcImage: 'wfc:new' }
    const live = withRestartedAt(asApiserverDeployment(buildDeployment(sfs, oldConfig)))
    const reconciler = makeReconciler(newConfig)
    appsApi.readNamespacedDeployment.mockResolvedValue(live)
    await (reconciler as any).ensureDeployment(sfs)
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const body = (
      appsApi.replaceNamespacedDeployment.mock.calls[0][0] as { body: k8s.V1Deployment }
    ).body
    expect(body.spec?.template?.spec?.containers?.[0]?.image).toBe('wfc:new')
    expect(body.spec?.template?.metadata?.annotations?.[RESTARTED_AT]).toBe(RESTART_STAMP)
  })

  it('IMAGE-SFS-1: wfcImage bump replaces once', async () => {
    const live = asApiserverDeployment(
      buildDeployment(sfs, { ...factoryConfig, wfcImage: 'wfc:old' })
    )
    const reconciler = makeReconciler({ ...factoryConfig, wfcImage: 'wfc:new' })
    appsApi.readNamespacedDeployment.mockResolvedValue(live)
    await (reconciler as any).ensureDeployment(sfs)
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })
})
