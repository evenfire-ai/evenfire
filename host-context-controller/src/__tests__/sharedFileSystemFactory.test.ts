import { describe, expect, it } from 'vitest'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import {
  DEFAULT_INIT_IMAGE,
  DEFAULT_SFS_SIZE,
  DEFAULT_WFC_PORT,
  MAX_SFS_DIRECTORIES,
  MAX_SFS_DIRECTORY_LENGTH,
  SFS_DIRECTORY_PATTERN,
  SFS_LABEL,
  SFS_NAMESPACE_LABEL,
  type SharedFileSystemFactoryConfig,
  WFC_APP_LABEL,
  WFC_MOUNT_PATH,
  WFC_POLICY_TYPE,
  buildDeployment,
  buildEgressNetworkPolicy,
  buildIngressNetworkPolicy,
  buildPvc,
  buildSeedArgs,
  buildService,
  pvcName,
  sharedFileSystemHash,
  wfcDeploymentName,
  wfcEgressPolicyName,
  wfcIngressPolicyName,
  wfcInitJobNamePrefix,
  wfcReplicas,
  wfcServiceName,
} from '../k8s/sharedFileSystemFactory'
import type { SharedFileSystemCRD } from '../types'

const config: SharedFileSystemFactoryConfig = {
  hostNamespace: 'mcp-host',
  controlPlaneNamespace: 'control-plane',
  wfcImage: 'registry.example/clerum/workspace-files-controller:0.1.0',
  wfcImagePullPolicy: 'IfNotPresent',
  wfcImagePullSecretName: 'clerum',
  wfcPort: DEFAULT_WFC_PORT,
  wfcInitImage: DEFAULT_INIT_IMAGE,
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

function makeSfs(overrides: Partial<SharedFileSystemCRD> = {}): SharedFileSystemCRD {
  return {
    name: 'team-mission',
    namespace: 'mcp-host',
    spec: {
      size: '5Gi',
      directories: ['docs', 'runbooks'],
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    },
    ...overrides,
  }
}

/** PodSpec of the wfc Deployment (where init now lives). */
function podSpec(sfs: SharedFileSystemCRD) {
  return buildDeployment(sfs, config).spec?.template.spec
}
function initContainer(sfs: SharedFileSystemCRD) {
  return podSpec(sfs)?.initContainers?.[0]
}
function appContainer(sfs: SharedFileSystemCRD) {
  return podSpec(sfs)?.containers?.[0]
}

describe('sharedFileSystemFactory — naming helpers', () => {
  it('produces a stable 10-char hash from namespace/name', () => {
    const a = sharedFileSystemHash({ name: 'team-mission', namespace: 'mcp-host' })
    const b = sharedFileSystemHash({ name: 'team-mission', namespace: 'mcp-host' })
    expect(a).toEqual(b)
    expect(a).toMatch(/^[0-9a-f]{10}$/)
  })

  it('hashes are different across SharedFileSystems (name) and (namespace)', () => {
    const a = sharedFileSystemHash({ name: 'team-mission', namespace: 'mcp-host' })
    const b = sharedFileSystemHash({ name: 'customer-complaints', namespace: 'mcp-host' })
    const c = sharedFileSystemHash({ name: 'team-mission', namespace: 'other-ns' })
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('builds resource names that fit the K8s 63-char DNS-1123 limit', () => {
    const sfs = makeSfs()
    expect(pvcName(sfs)).toMatch(/^sfs-[0-9a-f]{10}-files$/)
    expect(pvcName(sfs).length).toBeLessThanOrEqual(63)
    expect(wfcDeploymentName(sfs)).toMatch(/^wfc-[0-9a-f]{10}$/)
    expect(wfcServiceName(sfs)).toEqual(wfcDeploymentName(sfs))
    // The init Job is gone; the prefix helper scopes legacy-Job cleanup.
    expect(wfcInitJobNamePrefix(sfs)).toMatch(/^wfc-init-[0-9a-f]{10}-$/)
    expect(wfcIngressPolicyName(sfs)).toMatch(/^wfc-[0-9a-f]{10}-ingress$/)
    expect(wfcEgressPolicyName(sfs)).toMatch(/^wfc-[0-9a-f]{10}-egress$/)
  })
})

describe('sharedFileSystemFactory — wfcReplicas', () => {
  it('always returns 1 in v1 regardless of accessModes', () => {
    expect(wfcReplicas({ accessModes: ['ReadWriteMany'] })).toBe(1)
    expect(wfcReplicas({ accessModes: ['ReadWriteOnce'] })).toBe(1)
    expect(wfcReplicas({})).toBe(1)
  })
})

describe('sharedFileSystemFactory — buildPvc', () => {
  it('builds a PVC in the host namespace with default size and RWO accessModes (#592)', () => {
    const sfs = makeSfs({ spec: { directories: [] } })
    const pvc = buildPvc(sfs, config)
    expect(pvc.metadata?.namespace).toBe('mcp-host')
    expect(pvc.metadata?.name).toEqual(pvcName(sfs))
    // Literal (not [...DEFAULT_SFS_ACCESS_MODES]) so this fails loudly if the
    // default is ever reverted to ReadWriteMany on an RWO-only cluster (#592).
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce'])
    expect(pvc.spec?.resources?.requests?.storage).toBe(DEFAULT_SFS_SIZE)
    expect(pvc.spec?.storageClassName).toBeUndefined()
  })

  it('honours explicit size, storageClass, accessModes, and annotations', () => {
    const sfs = makeSfs({
      spec: {
        size: '50Gi',
        storageClassName: 'gcs-fuse-csi',
        accessModes: ['ReadWriteMany'],
        annotations: { 'team.example/owner': 'support' },
      },
    })
    const pvc = buildPvc(sfs, config)
    expect(pvc.spec?.resources?.requests?.storage).toBe('50Gi')
    expect(pvc.spec?.storageClassName).toBe('gcs-fuse-csi')
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteMany'])
    expect(pvc.metadata?.annotations).toEqual({ 'team.example/owner': 'support' })
  })

  it('emits required clerum management labels for ops cleanup', () => {
    const sfs = makeSfs()
    const pvc = buildPvc(sfs, config)
    expect(pvc.metadata?.labels).toMatchObject({
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [SFS_LABEL]: 'team-mission',
      [SFS_NAMESPACE_LABEL]: 'mcp-host',
    })
  })

  it('preserves explicit empty storageClassName ("" means cluster default)', () => {
    const sfs = makeSfs({ spec: { storageClassName: '' } })
    const pvc = buildPvc(sfs, config)
    expect(pvc.spec?.storageClassName).toBe('')
  })
})

describe('sharedFileSystemFactory — buildSeedArgs (init seeding shell)', () => {
  it('mkdirs each requested directory under WFC_MOUNT_PATH and chowns to security UID/GID', () => {
    const sfs = makeSfs({
      spec: {
        directories: ['docs', 'runbooks'],
        security: { runAsUser: 1234, runAsGroup: 5678, fsGroup: 5678 },
      },
    })
    const args = buildSeedArgs(sfs)
    expect(args).toContain(`mkdir -p '${WFC_MOUNT_PATH}/docs' '${WFC_MOUNT_PATH}/runbooks'`)
    expect(args).toContain(`chown -R 1234:5678 -- '${WFC_MOUNT_PATH}'`)
  })

  it('guards the recursive chown behind a content sentinel (uid:gid:dirhash) and keeps mkdir unguarded', () => {
    const args = buildSeedArgs(
      makeSfs({ spec: { directories: ['docs'], security: { runAsUser: 1234, runAsGroup: 5678 } } })
    )
    // mkdir runs every boot (self-heals layout) — BEFORE the guard.
    const idxMkdir = args.indexOf('mkdir -p')
    const idxGuard = args.indexOf('if [ "$(cat')
    expect(idxMkdir).toBeGreaterThanOrEqual(0)
    expect(idxGuard).toBeGreaterThan(idxMkdir)
    // Single sentinel file; its CONTENT encodes uid:gid + a directory hash.
    expect(args).toContain(`'${WFC_MOUNT_PATH}/.clerum-seeded'`)
    expect(args).toMatch(/'1234:5678:[0-9a-f]{12}'/)
  })

  it('re-triggers the chown when spec.directories change (sentinel content differs)', () => {
    const want = (s: string) => s.match(/'1000:1000:([0-9a-f]{12})'/)?.[1]
    const a = buildSeedArgs(
      makeSfs({ spec: { directories: ['docs'], security: { runAsUser: 1000, runAsGroup: 1000 } } })
    )
    const b = buildSeedArgs(
      makeSfs({
        spec: { directories: ['docs', 'reports'], security: { runAsUser: 1000, runAsGroup: 1000 } },
      })
    )
    expect(want(a)).toBeTruthy()
    expect(want(b)).toBeTruthy()
    // Adding a directory changes the sentinel content => chown -R re-runs once,
    // correcting ownership of the newly-mkdir'd (root-owned) directory.
    expect(want(a)).not.toEqual(want(b))
  })

  it('re-triggers the chown when only spec.security (uid/gid) changes', () => {
    const want = (s: string) => s.match(/'(\d+:\d+:[0-9a-f]{12})'/)?.[1]
    const a = buildSeedArgs(
      makeSfs({ spec: { directories: ['docs'], security: { runAsUser: 1000, runAsGroup: 1000 } } })
    )
    const b = buildSeedArgs(
      makeSfs({ spec: { directories: ['docs'], security: { runAsUser: 2000, runAsGroup: 2000 } } })
    )
    expect(want(a)).not.toEqual(want(b))
  })

  it('is byte-identical for an unchanged spec (idempotent skip on plain restarts)', () => {
    const spec = {
      directories: ['docs', 'runbooks'],
      security: { runAsUser: 1000, runAsGroup: 1000 },
    }
    expect(buildSeedArgs(makeSfs({ spec }))).toEqual(buildSeedArgs(makeSfs({ spec })))
  })

  it('keeps the sentinel invariant to directory ORDER (canonical hash, no needless re-chown)', () => {
    const want = (s: string) => s.match(/'(\d+:\d+:[0-9a-f]{12})'/)?.[1]
    const a = buildSeedArgs(
      makeSfs({
        spec: {
          directories: ['docs', 'runbooks'],
          security: { runAsUser: 1000, runAsGroup: 1000 },
        },
      })
    )
    const b = buildSeedArgs(
      makeSfs({
        spec: {
          directories: ['runbooks', 'docs'],
          security: { runAsUser: 1000, runAsGroup: 1000 },
        },
      })
    )
    expect(want(a)).toEqual(want(b))
  })

  it('rejects a root (uid/gid < 1) security identity at build time', () => {
    expect(() =>
      buildSeedArgs(
        makeSfs({ spec: { directories: ['docs'], security: { runAsUser: 0, runAsGroup: 0 } } })
      )
    ).toThrow(/root is not allowed/)
    expect(() =>
      buildDeployment(makeSfs({ spec: { security: { runAsUser: 0 } } }), config)
    ).toThrow(/root is not allowed/)
  })

  it('bounds the chown with timeout and keeps chmod NON-recursive', () => {
    const args = buildSeedArgs(makeSfs())
    expect(args).toMatch(/timeout \d+ chown -R/)
    expect(args).toContain(`chmod 0775 -- '${WFC_MOUNT_PATH}'`)
    expect(args).not.toMatch(/chmod\s+-R/)
  })

  it('falls back to a single mkdir of the mount root when directories are empty', () => {
    const args = buildSeedArgs(makeSfs({ spec: { directories: [] } }))
    expect(args).toContain(`mkdir -p '${WFC_MOUNT_PATH}'`)
  })

  it('uses default UID/GID when security is unset', () => {
    const args = buildSeedArgs(makeSfs({ spec: { directories: ['notes'] } }))
    expect(args).toContain('chown -R 1000:1000 --')
  })

  it('never leaks secret-shaped tokens into the seed command', () => {
    const args = buildSeedArgs(makeSfs())
    expect(args).not.toMatch(/sk_|whsec_|PRIVATE KEY|token|secret|password/i)
  })
})

describe('sharedFileSystemFactory — directory validation (shell-injection defense)', () => {
  it('accepts well-formed relative paths', () => {
    expect('docs').toMatch(SFS_DIRECTORY_PATTERN)
    expect('reports/2026_q1').toMatch(SFS_DIRECTORY_PATTERN)
    for (const ok of ['docs', 'reports/2026.q1', 'a-b', 'a_b', 'deep/nested/path']) {
      expect(() => buildSeedArgs(makeSfs({ spec: { directories: [ok] } }))).not.toThrow()
    }
  })

  it.each([
    '../escape',
    'docs/../escape',
    '..',
    '/absolute',
    '/etc/passwd',
    'foo; rm -rf /workspace',
    'foo$(id)',
    'a`id`',
    'a|b',
    'a&b',
    'a>b',
    'a*',
    'a?',
    '[a]',
    '$IFS',
    'a\\b',
    '-rf',
    "a'b",
    'has space',
    'a\nb',
  ])('rejects hostile directory %j before any shell is built', hostile => {
    const sfs = makeSfs({ spec: { directories: [hostile] } })
    expect(() => buildSeedArgs(sfs)).toThrow(/SharedFileSystem director/i)
    // And the Deployment builder (which calls buildSeedArgs) also refuses.
    expect(() => buildDeployment(sfs, config)).toThrow(/SharedFileSystem director/i)
  })

  it('rejects a directory longer than the max length', () => {
    const tooLong = 'a'.repeat(MAX_SFS_DIRECTORY_LENGTH + 1)
    expect(() => buildSeedArgs(makeSfs({ spec: { directories: [tooLong] } }))).toThrow(
      /SharedFileSystem director/i
    )
  })

  it('rejects more than the maximum number of directories', () => {
    const many = Array.from({ length: MAX_SFS_DIRECTORIES + 1 }, (_, i) => `d${i}`)
    expect(() => buildSeedArgs(makeSfs({ spec: { directories: many } }))).toThrow(
      /SharedFileSystem director/i
    )
  })

  it('resolves the directory-pattern regex in linear time (no ReDoS)', () => {
    const adversarial = `${'a/'.repeat(2000)}!`
    const start = performance.now()
    SFS_DIRECTORY_PATTERN.test(adversarial)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

describe('sharedFileSystemFactory — buildDeployment (controller + root initContainer)', () => {
  it('runs the controller as a non-root user with the requested security context', () => {
    const sfs = makeSfs({
      spec: { security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 } },
    })
    expect(podSpec(sfs)?.securityContext).toMatchObject({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      fsGroup: 1000,
      fsGroupChangePolicy: 'OnRootMismatch',
    })
  })

  it('does not mount Kubernetes API credentials into generated wfc pods', () => {
    expect(podSpec(makeSfs())?.automountServiceAccountToken).toBe(false)
  })

  it('co-locates seeding in a root initContainer in the SAME pod (no separate Job)', () => {
    const sfs = makeSfs()
    const spec = podSpec(sfs)
    // The #549 invariant: exactly one init + one app container, one pod template,
    // a single PVC consumer — no sibling workload can re-introduce a 2nd mounter.
    expect(spec?.initContainers).toHaveLength(1)
    expect(spec?.containers).toHaveLength(1)
    expect(spec?.volumes).toEqual([
      { name: 'workspace', persistentVolumeClaim: { claimName: pvcName(sfs) } },
    ])
    const init = initContainer(sfs)
    expect(init?.name).toBe('init')
    expect(init?.image).toBe(DEFAULT_INIT_IMAGE)
    expect(init?.args?.[0]).toBe(buildSeedArgs(sfs))
    expect(init?.volumeMounts).toEqual([{ name: 'workspace', mountPath: WFC_MOUNT_PATH }])
    expect(init?.ports).toBeUndefined()
  })

  it('hardens the root initContainer securityContext (caps minimal, container-scoped root)', () => {
    const init = initContainer(makeSfs())
    expect(init?.securityContext).toEqual({
      runAsUser: 0,
      runAsGroup: 0,
      // container-scoped ONLY — overrides pod-level runAsNonRoot:true
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })
  })

  it('keeps the serving container non-root (regression lock — root must NOT leak)', () => {
    const app = appContainer(makeSfs())
    expect(app?.name).toBe('workspace-files-controller')
    expect(app?.securityContext?.runAsNonRoot).toBeUndefined() // inherits pod runAsNonRoot:true
    expect(app?.securityContext?.runAsUser).toBeUndefined()
    expect(app?.securityContext?.allowPrivilegeEscalation).toBe(false)
    expect(app?.securityContext?.readOnlyRootFilesystem).toBe(true)
    expect(app?.securityContext?.capabilities?.drop).toEqual(['ALL'])
    expect(app?.securityContext?.capabilities?.add).toBeUndefined()
  })

  it.each(['ReadWriteOnce', 'ReadWriteMany'])(
    'emits an identical root initContainer for accessModes=%j (the #549 fix is universal)',
    modes => {
      const sfs = makeSfs({ spec: { directories: ['docs'], accessModes: [modes] } })
      const init = initContainer(sfs)
      expect(init?.name).toBe('init')
      expect(init?.securityContext?.runAsUser).toBe(0)
      expect(init?.securityContext?.runAsNonRoot).toBe(false)
    }
  )

  it('mounts the PVC at WFC_MOUNT_PATH read-write in the serving container', () => {
    const sfs = makeSfs()
    expect(appContainer(sfs)?.volumeMounts).toEqual([
      { name: 'workspace', mountPath: WFC_MOUNT_PATH },
    ])
  })

  it('emits the required env vars including SFS identity and JWT key from configmap', () => {
    const env = appContainer(makeSfs())?.env ?? []
    const byName = Object.fromEntries(env.map(e => [e.name, e]))
    expect(byName.WSF_PORT?.value).toBe(String(DEFAULT_WFC_PORT))
    expect(byName.WSF_MOUNT_PATH?.value).toBe(WFC_MOUNT_PATH)
    expect(byName.WSF_SHARED_FILESYSTEM_NAME?.value).toBe('team-mission')
    expect(byName.WSF_SHARED_FILESYSTEM_NAMESPACE?.value).toBe('mcp-host')
    expect(byName.WSF_JWT_PUBLIC_KEY?.valueFrom?.configMapKeyRef).toEqual({
      name: 'mcp-host-config',
      key: 'CLERUM_AUTH_JWT_PUBLIC_KEY',
    })
    expect(byName.WSF_MAX_UPLOAD_BYTES?.value).toBe(String(100 * 1024 * 1024))
    expect(byName.WSF_MAX_LIST_ENTRIES?.value).toBe('5000')
    expect(byName.WSF_MAX_PATH_DEPTH?.value).toBe('32')
  })

  it('uses Recreate strategy so RWO upgrades do not deadlock on volume re-attach', () => {
    const dep = buildDeployment(makeSfs(), config)
    expect(dep.spec?.strategy?.type).toBe('Recreate')
    expect(dep.spec?.replicas).toBe(1)
  })

  it('omits imagePullSecrets when the WFC pull reference config is empty', () => {
    const dep = buildDeployment(makeSfs(), { ...config, wfcImagePullSecretName: '' })
    expect(dep.spec?.template.spec?.imagePullSecrets).toBeUndefined()
  })

  it('selects pods by app=workspace-files-controller plus SFS identity', () => {
    const dep = buildDeployment(makeSfs(), config)
    expect(dep.spec?.selector.matchLabels).toMatchObject({
      app: WFC_APP_LABEL,
      [SFS_LABEL]: 'team-mission',
      [SFS_NAMESPACE_LABEL]: 'mcp-host',
    })
  })
})

describe('sharedFileSystemFactory — buildService', () => {
  it('creates a ClusterIP Service named after the wfc Deployment, exposing http→wfcPort', () => {
    const sfs = makeSfs()
    const svc = buildService(sfs, config)
    expect(svc.metadata?.name).toEqual(wfcServiceName(sfs))
    expect(svc.spec?.type).toBe('ClusterIP')
    expect(svc.spec?.ports?.[0]).toMatchObject({
      name: 'http',
      port: DEFAULT_WFC_PORT,
      protocol: 'TCP',
    })
    expect(svc.spec?.selector).toMatchObject({
      app: WFC_APP_LABEL,
      [SFS_LABEL]: 'team-mission',
    })
  })
})

describe('sharedFileSystemFactory — NetworkPolicies', () => {
  it('ingress policy allows port from control-plane / app=control-api only', () => {
    const sfs = makeSfs()
    const np = buildIngressNetworkPolicy(sfs, config)
    expect(np.spec?.policyTypes).toEqual(['Ingress'])
    expect(np.spec?.podSelector?.matchLabels).toMatchObject({ app: WFC_APP_LABEL })
    const ingress = np.spec?.ingress?.[0]
    // The K8s client-node typings rename `from` to `_from` to dodge the JS reserved keyword.
    expect((ingress as Record<string, unknown>)._from).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'control-plane' } },
        podSelector: { matchLabels: { app: 'control-api' } },
      },
    ])
    expect(ingress?.ports).toEqual([{ port: DEFAULT_WFC_PORT, protocol: 'TCP' }])
    expect(np.metadata?.labels?.['clerum.io/policy-type']).toBe(WFC_POLICY_TYPE)
  })

  it('egress policy allows DNS only', () => {
    const sfs = makeSfs()
    const np = buildEgressNetworkPolicy(sfs, config)
    expect(np.spec?.policyTypes).toEqual(['Egress'])
    expect(np.spec?.egress?.[0]?.to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ])
    expect(np.spec?.egress?.[0]?.ports).toEqual([
      { port: 53, protocol: 'UDP' },
      { port: 53, protocol: 'TCP' },
    ])
  })
})
