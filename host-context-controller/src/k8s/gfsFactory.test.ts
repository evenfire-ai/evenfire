import { describe, expect, it } from 'vitest'
import type { GlobalFileSystemCRD } from '../types'
import {
  DEFAULT_GFS_STORAGE_CLASS,
  GFS_TEMPLATE_HASH_ANNOTATION,
  GfsFactoryConfig,
  buildDeployment,
  buildEgressNetworkPolicy,
  buildIngressNetworkPolicy,
  buildPodDisruptionBudget,
  buildPvc,
  buildService,
  buildWriterInitArgs,
  buildWriterService,
  deploymentTemplateHash,
  readerReplicas,
  serviceUrl,
  writerServiceUrl,
} from './gfsFactory'

const config: GfsFactoryConfig = {
  gfsNamespace: 'gfs',
  controlPlaneNamespace: 'control-plane',
  postgresPodLabels: { app: 'control-postgres' },
  postgresPort: 5432,
  gfscImage: 'clerum-gfs-controller:test',
  gfscImagePullPolicy: 'IfNotPresent',
  gfscPort: 8087,
  gfscInitImage: 'busybox:1.36',
  gfscResources: {
    requests: { memory: '128Mi', cpu: '100m' },
    limits: { memory: '256Mi', cpu: '500m' },
  },
  jwtPublicKeyConfigMapName: 'gfs-config',
  jwtPublicKeyConfigMapKey: 'jwt-public-key',
  pgSecretName: 'gfs-controller-db',
  pgSecretKey: 'connection-string',
  driveName: 'main',
  tokenAudience: 'gfs-controller',
}

function gfs(spec: GlobalFileSystemCRD['spec'] = {}): GlobalFileSystemCRD {
  return { name: 'gfs', namespace: 'gfs', spec }
}

describe('gfsFactory PVC', () => {
  it('defaults to standard-rwo + ReadWriteOnce + 500Gi', () => {
    const pvc = buildPvc(gfs(), config)
    expect(pvc.spec?.storageClassName).toBe(DEFAULT_GFS_STORAGE_CLASS)
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce'])
    expect(pvc.spec?.resources?.requests?.storage).toBe('500Gi')
    expect(pvc.metadata?.namespace).toBe('gfs')
  })

  it('honors explicit storage overrides', () => {
    const pvc = buildPvc(
      gfs({ storage: { size: '1Ti', storageClassName: 'fast', accessModes: ['ReadWriteMany'] } }),
      config
    )
    expect(pvc.spec?.resources?.requests?.storage).toBe('1Ti')
    expect(pvc.spec?.storageClassName).toBe('fast')
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteMany'])
  })
})

describe('readerReplicas', () => {
  it('defaults to 2 and rejects negatives', () => {
    expect(readerReplicas({})).toBe(2)
    expect(readerReplicas({ readerReplicas: 0 })).toBe(0)
    expect(readerReplicas({ readerReplicas: 5 })).toBe(5)
    expect(() => readerReplicas({ readerReplicas: -1 })).toThrow()
  })
})

describe('gfsFactory writer Deployment', () => {
  const dep = buildDeployment(gfs(), config, 'writer')

  it('is a single RW replica with same-pod ownership preparation', () => {
    expect(dep.metadata?.name).toBe('gfsc-writer')
    expect(dep.spec?.replicas).toBe(1)
    expect(dep.spec?.strategy?.type).toBe('Recreate')
    expect(dep.spec?.template.spec?.initContainers).toHaveLength(1)
    const init = dep.spec?.template.spec?.initContainers?.[0]
    expect(init?.name).toBe('init')
    expect(init?.image).toBe('busybox:1.36')
    expect(init?.args?.[0]).toBe(buildWriterInitArgs(gfs()))
    expect(init?.volumeMounts).toEqual([{ name: 'drive', mountPath: '/data/gfs' }])
    const mount = dep.spec?.template.spec?.containers[0].volumeMounts?.[0]
    expect(mount?.readOnly).toBeFalsy() // writer mounts RW
  })

  it('runs a bounded ownership repair and leaves the sentinel owned by gfsc', () => {
    const args = buildWriterInitArgs(gfs())
    expect(args).toContain('timeout 900 chown -R 1000:1000 -- /data/gfs')
    expect(args).toContain('chown 1000:1000 /data/gfs/.clerum-gfs-owned')
  })

  it('annotates the Deployment and pod template with a stable rollout hash', () => {
    const hash = dep.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]
    expect(hash).toMatch(/^[a-f0-9]{16}$/)
    expect(dep.spec?.template.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]).toBe(hash)
    expect(deploymentTemplateHash('writer', dep.spec?.template ?? {})).not.toBe(hash)
  })

  it('changes the rollout hash when the writer pod template changes', () => {
    const first = buildDeployment(gfs(), config, 'writer')
    const second = buildDeployment(
      gfs(),
      { ...config, gfscImage: 'clerum-gfs-controller:next' },
      'writer'
    )
    expect(first.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]).not.toBe(
      second.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]
    )
  })

  it('hardens the writer init container without leaking root to gfsc', () => {
    const pod = dep.spec?.template.spec
    const init = pod?.initContainers?.[0]
    expect(init?.securityContext).toEqual({
      runAsUser: 0,
      runAsGroup: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })

    const gfsc = pod?.containers[0]
    expect(pod?.securityContext?.runAsNonRoot).toBe(true)
    expect(gfsc?.securityContext?.readOnlyRootFilesystem).toBe(true)
    expect(gfsc?.securityContext?.capabilities?.drop).toEqual(['ALL'])
  })

  it('sets GFS_STORAGE_ROLE=writer and wires the DB secret + public-key configmap', () => {
    const env = dep.spec?.template.spec?.containers[0].env ?? []
    const byName = (n: string) => env.find(e => e.name === n)
    expect(byName('GFS_STORAGE_ROLE')?.value).toBe('writer')
    expect(byName('GFS_PORT')?.value).toBe('8087')
    expect(byName('GFS_DRIVE_NAME')?.value).toBe('main')
    expect(byName('GFS_TOKEN_AUDIENCE')?.value).toBe('gfs-controller')
    expect(byName('GFS_PG_CONNECTION_STRING')?.valueFrom?.secretKeyRef?.name).toBe(
      'gfs-controller-db'
    )
    expect(byName('GFS_JWT_PUBLIC_KEY')?.valueFrom?.configMapKeyRef?.name).toBe('gfs-config')
  })

  it('runs non-root, drops all caps, read-only rootfs (reconciler owns securityContext)', () => {
    const pod = dep.spec?.template.spec
    expect(pod?.securityContext?.runAsNonRoot).toBe(true)
    expect(pod?.securityContext?.runAsUser).toBe(1000)
    expect(pod?.securityContext?.fsGroup).toBe(1000)
    expect(pod?.securityContext?.fsGroupChangePolicy).toBe('OnRootMismatch')
    const c = pod?.containers[0]
    expect(c?.securityContext?.readOnlyRootFilesystem).toBe(true)
    expect(c?.securityContext?.capabilities?.drop).toEqual(['ALL'])
    // imagePullPolicy comes from config (the reconciler), never the CRD.
    expect(c?.imagePullPolicy).toBe('IfNotPresent')
  })

  it('does not require pod affinity, so it can be the first RWO PVC consumer', () => {
    expect(dep.spec?.template.spec?.affinity?.podAffinity).toBeUndefined()
  })
})

describe('gfsFactory writer PodDisruptionBudget', () => {
  it('protects the single writer: minAvailable:1, selects exactly the writer pods', () => {
    const pdb = buildPodDisruptionBudget(gfs(), config)
    expect(pdb.apiVersion).toBe('policy/v1')
    expect(pdb.kind).toBe('PodDisruptionBudget')
    expect(pdb.spec?.minAvailable).toBe(1)
    const writerSelector = buildDeployment(gfs(), config, 'writer').spec?.selector?.matchLabels
    expect(pdb.spec?.selector?.matchLabels).toEqual(writerSelector)
  })
})

describe('gfsFactory priorityClassName', () => {
  it('omits priorityClassName by default and sets it when configured', () => {
    expect(
      buildDeployment(gfs(), config, 'writer').spec?.template?.spec?.priorityClassName
    ).toBeUndefined()
    const withPc = { ...config, gfscPriorityClassName: 'gfs-writer-critical' }
    expect(buildDeployment(gfs(), withPc, 'writer').spec?.template?.spec?.priorityClassName).toBe(
      'gfs-writer-critical'
    )
  })
})

describe('gfsFactory reader Deployment', () => {
  const dep = buildDeployment(gfs({ readerReplicas: 3 }), config, 'reader')

  it('scales to readerReplicas, mounts RO, and has NO init container', () => {
    expect(dep.metadata?.name).toBe('gfsc-reader')
    expect(dep.spec?.replicas).toBe(3)
    expect(dep.spec?.template.spec?.initContainers).toBeUndefined()
    const mount = dep.spec?.template.spec?.containers[0].volumeMounts?.[0]
    expect(mount?.readOnly).toBe(true)
    const env = dep.spec?.template.spec?.containers[0].env ?? []
    expect(env.find(e => e.name === 'GFS_STORAGE_ROLE')?.value).toBe('reader')
  })

  it('requires same-node scheduling with the writer under standard-rwo', () => {
    const affinity = dep.spec?.template.spec?.affinity?.podAffinity
    const terms = affinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []
    expect(terms).toHaveLength(1)
    expect(terms[0].topologyKey).toBe('kubernetes.io/hostname')
    expect(terms[0].labelSelector?.matchLabels).toEqual({
      app: 'gfs-controller',
      'clerum.io/gfsc-role': 'writer',
    })
  })
})

describe('gfsFactory Service', () => {
  it('builds a read ClusterIP named gfsc selecting all gfsc pods', () => {
    const svc = buildService(gfs(), config)
    expect(svc.metadata?.name).toBe('gfsc')
    expect(svc.spec?.type).toBe('ClusterIP')
    expect(svc.spec?.selector).toEqual({ app: 'gfs-controller' })
    expect(serviceUrl(gfs(), config)).toBe('http://gfsc.gfs.svc.cluster.local:8087')
  })

  it('builds a writer ClusterIP named gfsc-writer selecting only writer pods', () => {
    const svc = buildWriterService(gfs(), config)
    expect(svc.metadata?.name).toBe('gfsc-writer')
    expect(svc.spec?.type).toBe('ClusterIP')
    expect(svc.spec?.selector).toEqual({
      app: 'gfs-controller',
      'clerum.io/gfsc-role': 'writer',
    })
    expect(writerServiceUrl(gfs(), config)).toBe('http://gfsc-writer.gfs.svc.cluster.local:8087')
  })
})

describe('gfsFactory NetworkPolicies', () => {
  it('ingress allows control-api and GFS-capable mcp-host runtimes on the gfsc port', () => {
    const np = buildIngressNetworkPolicy(gfs(), config)
    const rule = np.spec?.ingress?.[0] as { _from?: unknown[]; ports?: { port?: number }[] }
    const from = rule._from as Array<{
      namespaceSelector?: { matchLabels?: Record<string, string> }
      podSelector?: { matchLabels?: Record<string, string> }
    }>
    expect(from).toHaveLength(3)
    expect(from[0].podSelector?.matchLabels?.app).toBe('control-api')
    expect(from[1].namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe('mcp-host')
    expect(from[1].podSelector?.matchLabels?.['clerum.io/managed-by']).toBe(
      'host-context-controller'
    )
    expect(from[2].namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
      'sandbox-recipes'
    )
    expect(from[2].podSelector?.matchLabels?.['clerum.io/component']).toBe('workflow-mcp-host')
    expect(rule.ports?.[0].port).toBe(8087)
  })

  it('egress allows DNS AND the permission-store Postgres (gfs-specific, NOT DNS-only like SFS)', () => {
    const np = buildEgressNetworkPolicy(gfs(), config)
    const egress = np.spec?.egress ?? []
    // DNS rule
    const dns = egress.find(r => r.ports?.some(p => p.port === 53))
    expect(dns).toBeDefined()
    // Postgres rule — the gfs-critical difference; without it gfsc fails closed forever.
    const pg = egress.find(r => r.ports?.some(p => p.port === 5432))
    expect(pg).toBeDefined()
    const pgTo = pg?.to?.[0] as { podSelector?: { matchLabels?: Record<string, string> } }
    expect(pgTo.podSelector?.matchLabels?.app).toBe('control-postgres')
  })

  it('adds kube-dns service-ip egress only when GKE NodeLocal DNS CIDR is configured', () => {
    const local = buildEgressNetworkPolicy(gfs(), config)
    const localIpBlocks = (local.spec?.egress ?? []).flatMap(rule =>
      (rule.to ?? []).map(to => to.ipBlock?.cidr).filter(Boolean)
    )
    expect(localIpBlocks).toEqual([])

    const gke = buildEgressNetworkPolicy(gfs(), {
      ...config,
      nodeLocalDnsCidr: '203.0.113.10/32',
    })
    const gkeIpBlocks = (gke.spec?.egress ?? []).flatMap(rule =>
      (rule.to ?? []).map(to => to.ipBlock?.cidr).filter(Boolean)
    )
    expect(gkeIpBlocks).toContain('203.0.113.10/32')
  })
})

describe('security guardrail', () => {
  it('rejects a root identity (runAsUser/fsGroup < 1)', () => {
    expect(() => buildDeployment(gfs({ security: { runAsUser: 0 } }), config, 'writer')).toThrow()
  })
})
