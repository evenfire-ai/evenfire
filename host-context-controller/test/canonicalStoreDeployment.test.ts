import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
import { buildCanonicalStoreInitContainer } from '../src/statelessDeployment'
import type { HostCRD } from '../src/types'

function makeHost(overrides: Partial<HostCRD> = {}): HostCRD {
  return {
    name: 'canonical-host',
    namespace: 'tenant-a',
    uid: 'host-uid-1',
    generation: 3,
    spec: { host: 'canonical-host', contextRef: 'context-a', secretRef: 'secret-a' },
    ...overrides,
  }
}

function makeReconciler(): HostReconciler {
  return new HostReconciler({} as k8s.KubeConfig, {
    appsApi: {} as unknown as k8s.AppsV1Api,
    coreApi: {} as unknown as k8s.CoreV1Api,
    networkingApi: {} as unknown as k8s.NetworkingV1Api,
    rbacApi: {} as unknown as k8s.RbacAuthorizationV1Api,
  })
}

function mainContainer(deployment: k8s.V1Deployment): k8s.V1Container {
  const container = deployment.spec?.template?.spec?.containers?.find(c => c.name === 'mcp-host')
  if (!container) throw new Error('mcp-host container missing')
  return container
}

function envMap(deployment: k8s.V1Deployment): Record<string, string | undefined> {
  return Object.fromEntries(mainContainer(deployment).env?.map(v => [v.name, v.value]) ?? [])
}

describe('canonical conversation-store deployment (#825)', () => {
  it('builds the canonical init container with binding env, File termination, uid 1001, and immutable boot verification', () => {
    const init = buildCanonicalStoreInitContainer({
      image: 'ghcr.io/example/mcp-host:sha-abc1234',
      imagePullPolicy: 'IfNotPresent',
      hostUid: 'host-uid-1',
      pvcUid: 'pvc-uid-9',
    })
    expect(init.name).toBe('canonical-store-init')
    expect(init.command?.slice(0, 2)).toEqual(['/bin/sh', '-ec'])
    expect(init.command?.[2]).toContain('/usr/local/bin/node')
    expect(init.command?.[2]).toContain('> /dev/termination-log')
    expect(init.args).toEqual([
      'canonical-store',
      '/app/mcp-host/dist/db/canonicalStore/cli.js',
      'boot-check',
      '--root',
      '/mnt/workspace-root',
      '--host-uid',
      'host-uid-1',
      '--pvc-uid',
      'pvc-uid-9',
      '--storage-contract',
      'canonical',
    ])
    const env = Object.fromEntries(init.env?.map(v => [v.name, v.value]) ?? [])
    expect(env.CLERUM_SESSION_STORE).toBe('sqlite')
    expect(env.CLERUM_SESSION_DB_DIR).toBe('/var/lib/clerum/state')
    expect(env.CLERUM_HOST_UID).toBe('host-uid-1')
    expect(env.CLERUM_PVC_UID).toBe('pvc-uid-9')
    expect(env.CLERUM_CANONICAL_STORE_REQUIRED).toBe('true')
    expect(init.terminationMessagePolicy).toBe('File')
    expect(init.securityContext?.runAsUser).toBe(1001)
    expect(init.securityContext?.runAsGroup).toBe(1001)
    // CLERUM_STATELESS_LIFECYCLE and legacy CLERUM_POD_UID stay stateless-only.
    expect(env.CLERUM_STATELESS_LIFECYCLE).toBeUndefined()
    expect(env.CLERUM_POD_UID).toBeUndefined()
  })

  it('never gives normal init new-store creation authority and requires physical binding', () => {
    const init = buildCanonicalStoreInitContainer({
      image: 'img',
      imagePullPolicy: 'IfNotPresent',
      hostUid: 'host',
      pvcUid: 'pvc',
    })
    expect(init.args).not.toContain('--provenance')
    expect(init.args).not.toContain('migrate')
    expect(() =>
      buildCanonicalStoreInitContainer({
        image: 'img',
        imagePullPolicy: 'IfNotPresent',
        hostUid: '',
        pvcUid: 'pvc',
      })
    ).toThrow(/binding/)
  })

  it('builds the unified canonical template: dual subPaths, binding env, Recreate, grace 30, layout marker', () => {
    const reconciler = makeReconciler()
    const deployment = reconciler.buildDeployment(makeHost(), [], '', undefined, undefined, {
      pvcUid: 'pvc-uid-9',
      canonical: true,
    })
    expect(deployment.spec?.strategy?.type).toBe('Recreate')
    expect(deployment.spec?.strategy?.rollingUpdate).toBeUndefined()
    expect(deployment.spec?.template?.spec?.terminationGracePeriodSeconds).toBe(30)
    expect(deployment.metadata?.annotations?.['clerum.io/canonical-store-layout']).toBe('1')
    const mounts = mainContainer(deployment).volumeMounts ?? []
    expect(mounts).toContainEqual({
      name: 'workspace',
      mountPath: expect.any(String),
      subPath: 'workspace',
    })
    expect(mounts).toContainEqual({
      name: 'workspace',
      mountPath: '/var/lib/clerum/state',
      subPath: 'state',
    })
    const env = envMap(deployment)
    expect(env.CLERUM_SESSION_STORE).toBe('sqlite')
    expect(env.CLERUM_SESSION_DB_DIR).toBe('/var/lib/clerum/state')
    expect(env.CLERUM_HOST_UID).toBe('host-uid-1')
    expect(env.CLERUM_PVC_UID).toBe('pvc-uid-9')
    expect(env.CLERUM_CANONICAL_STORE_REQUIRED).toBe('true')
    expect(env.CLERUM_CANONICAL_STATE_DIR).toBe('/var/lib/clerum/state')
    const init = deployment.spec?.template?.spec?.initContainers?.find(
      c => c.name === 'canonical-store-init'
    )
    expect(init).toBeDefined()
  })

  it.each(['stateful', 'stateless', 'desktop'])(
    'builds the protected %s floor without canonical activation',
    mode => {
      const reconciler = makeReconciler()
      const host = makeHost({
        spec: {
          ...makeHost().spec,
          ...(mode === 'desktop' ? { desktop: { browser: true } } : {}),
          ...(mode === 'stateless' ? { lifecycle: { stateless: true } } : {}),
        },
      })
      const deployment = reconciler.buildDeployment(
        host,
        [],
        '',
        { stateless: mode === 'stateless', state: 'active' },
        undefined,
        { pvcUid: 'pvc-uid-9', storageContract: 'legacy-floor', sourceEnvironment: [] }
      )
      const env = envMap(deployment)
      expect(env.CLERUM_CANONICAL_STATE_DIR).toBe('/var/lib/clerum/state')
      expect(env.CLERUM_SESSION_DB_DIR).toBe('/var/lib/clerum/state')
      expect(env.CLERUM_SESSION_STORE).toBe('sqlite')
      expect(env.CLERUM_CANONICAL_STORE_REQUIRED).toBe('false')
      expect(env.CLERUM_CANONICAL_STORE_CONTRACT).toBe('legacy-floor')
      expect(deployment.metadata?.annotations?.['clerum.io/canonical-store-layout']).toBeUndefined()
      expect(deployment.spec?.strategy?.type).toBe('Recreate')
      expect(mainContainer(deployment).envFrom).toBeUndefined()
      expect(mainContainer(deployment).volumeMounts?.filter(m => m.name === 'workspace')).toEqual([
        {
          name: 'workspace',
          mountPath: mode === 'desktop' ? '/config/workspace' : env.CLERUM_WORKSPACE_PATH,
          subPath: 'workspace',
        },
        { name: 'workspace', mountPath: '/var/lib/clerum/state', subPath: 'state' },
      ])
      const init = deployment.spec!.template.spec!.initContainers![0]
      expect(init.args?.slice(-2)).toEqual(['--storage-contract', 'legacy-floor'])
      expect(Object.fromEntries(init.env!.map(value => [value.name, value.value]))).toMatchObject({
        CLERUM_HOST_UID: host.uid,
        CLERUM_PVC_UID: 'pvc-uid-9',
        CLERUM_CANONICAL_STORE_REQUIRED: 'false',
        CLERUM_CANONICAL_STORE_CONTRACT: 'legacy-floor',
      })
    }
  )

  it('detects a delivery-introducing image or coordination-env change over the applied template', () => {
    const gate = HostReconciler as unknown as {
      deploymentIntroducesCanonicalDelivery(
        desired: k8s.V1Deployment,
        existing: k8s.V1Deployment | undefined
      ): boolean
    }
    const reconciler = makeReconciler()
    const desired = reconciler.buildDeployment(makeHost(), [], '', undefined, undefined, {
      pvcUid: 'pvc-uid-9',
    })
    // Creation always introduces the delivery.
    expect(gate.deploymentIntroducesCanonicalDelivery(desired, undefined)).toBe(true)
    const existing = structuredClone(desired)
    // Same coordination env and image: no delivery introduction, normal
    // convergence may proceed.
    expect(gate.deploymentIntroducesCanonicalDelivery(desired, existing)).toBe(false)
    // A changed global image is a delivery-relevant change: without a valid
    // preparation the applied image must be preserved.
    mainContainer(existing).image =
      'ghcr.io/example/mcp-host@sha256:0000000000000000000000000000000000000000000000000000000000000000'
    expect(gate.deploymentIntroducesCanonicalDelivery(desired, existing)).toBe(true)
  })
})
