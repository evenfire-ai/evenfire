import { describe, expect, it } from 'vitest'
import type {
  ConfigMapResourceDef,
  CronJobDef,
  DaemonSetDef,
  DeploymentDef,
  JobDef,
  PvcResourceDef,
  SecretResourceDef,
  StatefulSetDef,
  WorkflowRecipeCRD,
} from '../types'
import {
  buildConfigMap,
  buildCronJob,
  buildDaemonSet,
  buildDeployment,
  buildJob,
  buildOAuthBrokerEgressNetworkPolicy,
  buildOAuthBrokerTokenSecret,
  buildPVC,
  buildSecret,
  buildService,
  buildStatefulSet,
  buildUiEgressNetworkPolicy,
  oauthBrokerEgressPolicyName,
  oauthBrokerTokenSecretName,
  recipeHasBackgroundAccessClient,
  resolveCronJobResourceName,
  resolveResourceName,
  resolveScopedCronJobResourceName,
  resolveScopedResourceName,
  resolveScopedStatefulSetResourceName,
  resolveScopedWorkloadResourceName,
  resolveScopedWorkloadRuntimeResourceName,
  resolveStatefulSetHeadlessServiceName,
  resolveStatefulSetResourceName,
  resolveWorkloadMcpServerLabel,
  resolveWorkloadResourceName,
  resolveWorkloadRuntimeResourceName,
  workloadUsesBackgroundOauth,
} from './resourceBuilder'
import { OWNER_RECIPE_LABEL_KEY } from './secretOwnership'

/** Helper: minimal valid WorkflowRecipeCRD */
function makeRecipe(overrides?: Partial<WorkflowRecipeCRD['metadata']>): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'test-recipe',
      namespace: 'sandbox-recipes',
      uid: 'test-uid-123',
      ...overrides,
    },
    spec: {
      workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
    },
  }
}

// ─── Deployment Builder ─────────────────────────────────────────────

describe('buildDeployment', () => {
  const workload: DeploymentDef = {
    id: 'nginx',
    type: 'deployment',
    image: 'nginx:1.30.1-alpine',
    port: 8080,
    replicas: 3,
  }

  it('returns valid V1Deployment (3.1a)', () => {
    const dep = buildDeployment(workload, makeRecipe())
    expect(dep.apiVersion).toBe('apps/v1')
    expect(dep.kind).toBe('Deployment')
    expect(dep.metadata?.name).toBe('nginx')
    expect(dep.spec?.replicas).toBe(3)
    expect(dep.spec?.template.spec?.containers[0].image).toBe('nginx:1.30.1-alpine')
  })

  it('sets standard labels (3.1b)', () => {
    const dep = buildDeployment(workload, makeRecipe())
    const labels = dep.metadata?.labels
    expect(labels?.['clerum.io/managed-by']).toBe('workflow-recipes')
    expect(labels?.['clerum.io/recipe']).toBe('test-recipe')
    expect(labels?.['clerum.io/workload']).toBe('nginx')
    expect(labels?.app).toBe('nginx')
  })

  it('sets ownerReference to WorkflowRecipe (3.1c)', () => {
    const dep = buildDeployment(workload, makeRecipe())
    const refs = dep.metadata?.ownerReferences
    expect(refs).toHaveLength(1)
    expect(refs![0].kind).toBe('WorkflowRecipe')
    expect(refs![0].name).toBe('test-recipe')
    expect(refs![0].uid).toBe('test-uid-123')
    expect(refs![0].controller).toBe(true)
  })

  it('includes clerum.io/context label when contextRef provided (3.1e)', () => {
    const recipe = makeRecipe()
    recipe.spec.contextRef = 'analytics'
    const dep = buildDeployment(workload, recipe)
    expect(dep.metadata?.labels?.['clerum.io/context']).toBe('analytics')
  })

  it('applies security context from isolation level (3.1d)', () => {
    const dep = buildDeployment(workload, makeRecipe(), 'strict')
    const sc = dep.spec?.template.spec?.containers[0].securityContext
    expect(sc?.runAsNonRoot).toBe(true)
    expect(sc?.readOnlyRootFilesystem).toBe(true)
    expect(sc?.capabilities?.drop).toEqual(['ALL'])
  })

  it('hard-pins automountServiceAccountToken: false even at minimal isolation', () => {
    // Recipe workloads never call the K8s API; leaving the default SA token
    // mounted would be a cross-recipe Secret-read credential the moment any
    // RoleBinding grants the namespace SA `get secrets`.
    for (const level of ['minimal', 'standard', 'strict'] as const) {
      const dep = buildDeployment(workload, makeRecipe(), level)
      expect(dep.spec?.template.spec?.automountServiceAccountToken).toBe(false)
    }
  })

  it('defaults replicas to 1 when not specified', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest' }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.replicas).toBe(1)
  })

  it('sets env vars correctly (3.10a)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      env: [{ name: 'NODE_ENV', value: 'production' }],
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].name).toBe('NODE_ENV')
    expect(envVars![0].value).toBe('production')
  })

  it('omits env.value when it is not specified so Kubernetes applies its default', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      env: [{ name: 'OPTIONAL_VALUE' }],
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toEqual([{ name: 'OPTIONAL_VALUE' }])
  })

  it('sets volume mounts (3.10b)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      volumeMounts: [{ name: 'data', mountPath: '/data' }],
    }
    const dep = buildDeployment(w, makeRecipe())
    const vm = dep.spec?.template.spec?.containers[0].volumeMounts
    expect(vm).toHaveLength(1)
    expect(vm![0].mountPath).toBe('/data')
  })

  it('generates PVC volume when volumeMount matches a PVC resource (3.10f)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      volumeMounts: [{ name: 'data-storage', mountPath: '/data' }],
    }
    const recipe = makeRecipe()
    recipe.spec.resources = [{ id: 'data-storage', type: 'pvc', size: '5Gi' }]
    const dep = buildDeployment(w, recipe)
    const volumes = dep.spec?.template.spec?.volumes
    expect(volumes).toHaveLength(1)
    // The pod volume keeps the authored (logical) name…
    expect(volumes![0].name).toBe('data-storage')
    // …but the claim must point at the recipe-scoped physical PVC (issue #571),
    // never the raw generic id that could collide across recipes.
    expect(volumes![0].persistentVolumeClaim?.claimName).toBe(
      resolveResourceName(recipe, 'data-storage')
    )
    expect(volumes![0].persistentVolumeClaim?.claimName).not.toBe('data-storage')
  })

  it('generates emptyDir volume when volumeMount has no matching PVC (3.10g)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
    }
    const dep = buildDeployment(w, makeRecipe())
    const volumes = dep.spec?.template.spec?.volumes
    expect(volumes).toHaveLength(1)
    expect(volumes![0].name).toBe('tmp')
    expect(volumes![0].emptyDir).toEqual({})
  })

  it('omits volumes when no volumeMounts', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest' }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.volumes).toBeUndefined()
  })

  it('sets resource limits (3.10c)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    }
    const dep = buildDeployment(w, makeRecipe())
    const res = dep.spec?.template.spec?.containers[0].resources
    expect(res?.requests?.['cpu']).toBe('100m')
    expect(res?.limits?.['memory']).toBe('512Mi')
  })

  it('sets command and args (3.10d)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      command: ['node'],
      args: ['server.js'],
    }
    const dep = buildDeployment(w, makeRecipe())
    const c = dep.spec?.template.spec?.containers[0]!
    expect(c.command).toEqual(['node'])
    expect(c.args).toEqual(['server.js'])
  })

  it('builds httpGet probe from healthCheck (3.10e)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      port: 8080,
      healthCheck: { type: 'http', path: '/health', port: 8080 },
    }
    const dep = buildDeployment(w, makeRecipe())
    const liveness = dep.spec?.template.spec?.containers[0].livenessProbe
    expect(liveness?.httpGet?.path).toBe('/health')
    expect(liveness?.httpGet?.port).toBe(8080)
  })

  it('builds tcpSocket probe from healthCheck', () => {
    const w: DeploymentDef = {
      id: 'db',
      type: 'deployment',
      image: 'pg:15',
      healthCheck: { type: 'tcp', port: 5432 },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.containers[0].livenessProbe?.tcpSocket?.port).toBe(5432)
  })

  it('builds exec probe from healthCheck', () => {
    const w: DeploymentDef = {
      id: 'db',
      type: 'deployment',
      image: 'pg:15',
      healthCheck: { type: 'exec', command: ['pg_isready'] },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.containers[0].livenessProbe?.exec?.command).toEqual([
      'pg_isready',
    ])
  })

  // ─── envSecret Tests (§3.4.1) ─────────────────────────────────────────────

  it('sets env vars from envSecret with secretKeyRef (3.11a)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'my-secret',
        keys: [
          { secretKey: 'api-key', envVar: 'API_KEY' },
          { secretKey: 'db-password', envVar: 'DB_PASSWORD' },
        ],
      },
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(2)
    expect(envVars![0].name).toBe('API_KEY')
    expect(envVars![0].valueFrom?.secretKeyRef?.name).toBe('my-secret')
    expect(envVars![0].valueFrom?.secretKeyRef?.key).toBe('api-key')
    expect(envVars![1].name).toBe('DB_PASSWORD')
    expect(envVars![1].valueFrom?.secretKeyRef?.key).toBe('db-password')
  })

  it('merges env and envSecret (3.11b)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      env: [{ name: 'NODE_ENV', value: 'production' }],
      envSecret: {
        name: 'creds',
        keys: [{ secretKey: 'api-token', envVar: 'API_TOKEN' }],
      },
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(2)
    expect(envVars![0].name).toBe('NODE_ENV')
    expect(envVars![0].value).toBe('production')
    expect(envVars![1].name).toBe('API_TOKEN')
    expect(envVars![1].valueFrom?.secretKeyRef?.name).toBe('creds')
  })

  it('omits env when neither env nor envSecret specified', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest' }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.containers[0].env).toBeUndefined()
  })

  it('handles empty envSecret keys array', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: { name: 'empty-secret', keys: [] },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.containers[0].env).toBeUndefined()
  })

  it('envSecret takes precedence when envVar name duplicates env name', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      env: [{ name: 'API_KEY', value: 'hardcoded-value' }],
      envSecret: {
        name: 'secret-creds',
        keys: [{ secretKey: 'real-api-key', envVar: 'API_KEY' }],
      },
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(2)
    // Both are present; last one wins at container startup (K8s behavior)
    expect(envVars![0].name).toBe('API_KEY')
    expect(envVars![0].value).toBe('hardcoded-value')
    expect(envVars![1].name).toBe('API_KEY')
    expect(envVars![1].valueFrom?.secretKeyRef?.key).toBe('real-api-key')
  })

  // ─── envSecret optional keys ────────────────────────────────────────────

  it('skips optional+missing envSecret keys when the Secret is unknown', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [
          { secretKey: 'required-key', envVar: 'REQUIRED' },
          { secretKey: 'optional-key', envVar: 'OPTIONAL', optional: true },
        ],
      },
    }
    const dep = buildDeployment(w, makeRecipe(), 'minimal', new Map())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].name).toBe('REQUIRED')
  })

  it('skips optional+missing envSecret keys when the key is absent from the Secret', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [
          { secretKey: 'present-key', envVar: 'PRESENT', optional: true },
          { secretKey: 'absent-key', envVar: 'ABSENT', optional: true },
        ],
      },
    }
    const secretKeys = new Map([
      ['creds', { state: 'accessible' as const, keys: new Set(['present-key']) }],
    ])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].name).toBe('PRESENT')
    expect(envVars![0].valueFrom?.secretKeyRef?.key).toBe('present-key')
  })

  it('emits optional+present envSecret keys exactly like required keys', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [{ secretKey: 'api-key', envVar: 'API_KEY', optional: true }],
      },
    }
    const secretKeys = new Map([
      ['creds', { state: 'accessible' as const, keys: new Set(['api-key']) }],
    ])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].valueFrom?.secretKeyRef).toEqual({ name: 'creds', key: 'api-key' })
  })

  it('emits required+missing envSecret keys unconditionally (kubelet still fails the pod)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }],
      },
    }
    const dep = buildDeployment(w, makeRecipe(), 'minimal', new Map())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].valueFrom?.secretKeyRef).toEqual({ name: 'creds', key: 'api-key' })
  })

  it('skips optional keys when secretKeys argument is omitted (conservative default)', () => {
    // If the caller hasn't told us what's present, an optional key cannot be
    // projected safely — emitting it would risk CreateContainerConfigError,
    // which is exactly what `optional: true` is meant to avoid. Required
    // keys still emit unconditionally.
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [
          { secretKey: 'required-key', envVar: 'REQUIRED' },
          { secretKey: 'optional-key', envVar: 'OPTIONAL', optional: true },
        ],
      },
    }
    const dep = buildDeployment(w, makeRecipe())
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].name).toBe('REQUIRED')
  })

  // ─── envSecret ownership fail-closed (Issue #637) ───────────────────────

  it('does NOT project a required envSecret key when the Secret is ownership-denied', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'victim-secret',
        keys: [{ secretKey: 'api-key', envVar: 'STOLEN' }],
      },
    }
    // 'denied' = the Secret exists but is owned by another recipe. A foreign
    // credential must never be projected — not even for a required mapping
    // (the #637 fix; previously the required secretKeyRef was emitted).
    const secretKeys = new Map([['victim-secret', { state: 'denied' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars ?? []).toHaveLength(0)
  })

  it('does NOT project an optional envSecret key when the Secret is ownership-denied', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'victim-secret',
        keys: [{ secretKey: 'api-key', envVar: 'STOLEN', optional: true }],
      },
    }
    const secretKeys = new Map([['victim-secret', { state: 'denied' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars ?? []).toHaveLength(0)
  })

  it('does NOT project an envSecret key when ownership is unverified (transient error)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }],
      },
    }
    // 'error' = the read failed; ownership could not be verified → fail closed
    // (the reconciler requeues). Never emit a ref we could not authorize.
    const secretKeys = new Map([['creds', { state: 'error' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars ?? []).toHaveLength(0)
  })

  it('does NOT project a denied imagePullSecret (Issue #637 — pod-template defense-in-depth)', () => {
    // A foreign registry pull Secret must never reach the pod's imagePullSecrets —
    // kubelet would otherwise use it to authenticate the image pull. This is the
    // belt-and-suspenders layer below the reconciler's deny-and-teardown gate;
    // reverting the buildPodTemplate `allowedPullSecrets` filter makes this red.
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      imagePullSecrets: ['victim-pull'],
    }
    const secretKeys = new Map([['victim-pull', { state: 'denied' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    expect(dep.spec?.template.spec?.imagePullSecrets ?? []).toHaveLength(0)
  })

  it('does NOT project an imagePullSecret when ownership is unverified (transient error)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      imagePullSecrets: ['creds-pull'],
    }
    const secretKeys = new Map([['creds-pull', { state: 'error' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    expect(dep.spec?.template.spec?.imagePullSecrets ?? []).toHaveLength(0)
  })

  it('DOES project an owned/shared imagePullSecret (control — accessible is not over-dropped)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      imagePullSecrets: ['my-pull'],
    }
    const secretKeys = new Map([
      ['my-pull', { state: 'accessible' as const, keys: new Set<string>() }],
    ])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    expect(dep.spec?.template.spec?.imagePullSecrets).toEqual([{ name: 'my-pull' }])
  })

  it('emits a required envSecret key when the Secret is genuinely missing (kubelet surfaces it)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      envSecret: {
        name: 'creds',
        keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }],
      },
    }
    // 'missing' (404) is NOT a security failure — preserve the historical
    // "emit required, let kubelet raise CreateContainerConfigError" signal.
    const secretKeys = new Map([['creds', { state: 'missing' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    const envVars = dep.spec?.template.spec?.containers[0].env
    expect(envVars).toHaveLength(1)
    expect(envVars![0].valueFrom?.secretKeyRef).toEqual({ name: 'creds', key: 'api-key' })
  })

  it('drops an ownership-denied imagePullSecret (Issue #637)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      imagePullSecrets: ['foreign-pull-secret'],
    }
    const secretKeys = new Map([['foreign-pull-secret', { state: 'denied' as const }]])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    expect(dep.spec?.template.spec?.imagePullSecrets).toBeUndefined()
  })

  it('keeps an owned/shared imagePullSecret (accessible)', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'app:latest',
      imagePullSecrets: ['my-pull-secret'],
    }
    const secretKeys = new Map([
      ['my-pull-secret', { state: 'accessible' as const, keys: new Set<string>() }],
    ])
    const dep = buildDeployment(w, makeRecipe(), 'minimal', secretKeys)
    expect(dep.spec?.template.spec?.imagePullSecrets).toEqual([{ name: 'my-pull-secret' }])
  })
})

// ─── StatefulSet Builder ────────────────────────────────────────────

describe('buildStatefulSet', () => {
  it('returns StatefulSet + headless Service (3.2a)', () => {
    const w: StatefulSetDef = { id: 'pg', type: 'statefulset', image: 'pg:15', port: 5432 }
    const { statefulSet, headlessService } = buildStatefulSet(w, makeRecipe())
    expect(statefulSet.kind).toBe('StatefulSet')
    expect(headlessService.kind).toBe('Service')
    expect(headlessService.spec?.clusterIP).toBe('None')
  })

  it('sets serviceName matching headless service (3.2b)', () => {
    const w: StatefulSetDef = { id: 'pg', type: 'statefulset', image: 'pg:15', port: 5432 }
    const { statefulSet, headlessService } = buildStatefulSet(w, makeRecipe())
    expect(statefulSet.spec?.serviceName).toBe(headlessService.metadata?.name)
  })

  it('uses custom serviceName when provided', () => {
    const w: StatefulSetDef = {
      id: 'pg',
      type: 'statefulset',
      image: 'pg:15',
      port: 5432,
      serviceName: 'pg-svc',
    }
    const { statefulSet, headlessService } = buildStatefulSet(w, makeRecipe())
    expect(statefulSet.spec?.serviceName).toBe('pg-svc')
    expect(headlessService.metadata?.name).toBe('pg-svc')
  })

  it('keeps generated headless service names within the DNS label limit', () => {
    const w: StatefulSetDef = {
      id: 'mongodb',
      type: 'statefulset',
      image: 'mongo:7',
      port: 27017,
    }
    const recipe = makeRecipe({
      name: 'manual-l3a-api-mongo-pg-4step-efde18c3',
      uid: 'long-child-run-uid',
    })
    recipe.spec.steps = [
      {
        id: 'load-mongo',
        run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
      },
    ]

    const { statefulSet, headlessService } = buildStatefulSet(w, recipe)

    expect(resolveWorkloadResourceName(recipe, w.id).length).toBeLessThanOrEqual(63)
    expect(resolveStatefulSetResourceName(recipe, w.id).length).toBeLessThanOrEqual(52)
    expect(resolveWorkloadRuntimeResourceName(recipe, w)).toBe(
      resolveStatefulSetResourceName(recipe, w.id)
    )
    expect(statefulSet.metadata?.name?.length).toBeLessThanOrEqual(52)
    expect(resolveStatefulSetHeadlessServiceName(recipe, w).length).toBeLessThanOrEqual(63)
    expect(headlessService.metadata?.name?.length).toBeLessThanOrEqual(63)
    expect(headlessService.metadata?.name).toContain('headless')
    expect(statefulSet.spec?.selector.matchLabels?.app).toBe(statefulSet.metadata?.name)
    expect(statefulSet.spec?.template.metadata?.labels?.app).toBe(statefulSet.metadata?.name)
    expect(headlessService.spec?.selector?.app).toBe(statefulSet.metadata?.name)
    expect(statefulSet.spec?.serviceName).toBe(headlessService.metadata?.name)
  })

  it('clamps a StatefulSet runtime name to the 52-char controller-revision label budget (boundary)', () => {
    // Non-workflow recipe → resolveWorkloadResourceName returns the raw id, so the
    // clamp input length is exact. 52 is the real limit: 63 - 1 dash - 10-char
    // controller-revision hash label value. A 52-char name passes; 53 clamps.
    const exact52 = 'a'.repeat(52)
    expect(exact52).toHaveLength(52)
    expect(resolveStatefulSetResourceName(makeRecipe(), exact52)).toBe(exact52)

    const clamped = resolveStatefulSetResourceName(makeRecipe(), 'a'.repeat(53))
    expect(clamped.length).toBeLessThanOrEqual(52)
    expect(clamped).toMatch(/-[0-9a-f]{8}$/)
  })
})

// ─── CronJob Builder ────────────────────────────────────────────────

describe('buildCronJob', () => {
  it('returns CronJob with schedule field (3.3a)', () => {
    const w: CronJobDef = { id: 'backup', type: 'cronjob', image: 'pg:15', schedule: '0 2 * * *' }
    const cj = buildCronJob(w, makeRecipe())
    expect(cj.kind).toBe('CronJob')
    expect(cj.spec?.schedule).toBe('0 2 * * *')
  })

  it('sets timeZone when provided (3.3b)', () => {
    const w: CronJobDef = {
      id: 'backup',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
      timeZone: 'America/New_York',
    }
    const cj = buildCronJob(w, makeRecipe())
    expect(cj.spec?.timeZone).toBe('America/New_York')
  })

  it('clamps CronJob runtime names to leave room for child Jobs', () => {
    const recipe = makeRecipe({
      name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
      uid: 'long-cronjob-uid',
    })
    recipe.spec.steps = [
      {
        id: 'prospect',
        run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
      },
    ]
    const w: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'worker:latest',
      schedule: '*/5 * * * *',
    }

    const genericName = resolveWorkloadResourceName(recipe, w.id)
    const runtimeName = resolveCronJobResourceName(recipe, w.id)
    const cj = buildCronJob(w, recipe)

    expect(genericName.length).toBeGreaterThan(52)
    expect(resolveScopedCronJobResourceName(recipe, w.id)).toBe(runtimeName)
    expect(resolveWorkloadRuntimeResourceName(recipe, w)).toBe(runtimeName)
    expect(runtimeName.length).toBeLessThanOrEqual(52)
    expect(cj.metadata?.name).toBe(runtimeName)
    expect(cj.spec?.jobTemplate.spec?.template.metadata?.labels?.app).toBe(runtimeName)
  })

  it('clamps persisted CronJob workloadInstances consistently for create and observe paths', () => {
    const w: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'worker:latest',
      schedule: '*/5 * * * *',
    }
    const storedName = 'recipe-leadforge-app-v1-1-17-4a-prospector-enrich-cron-22afc990'
    const recipe: WorkflowRecipeCRD = {
      ...makeRecipe({ name: 'recipe-leadforge-app-v1-1-17-4a09ccfe', uid: 'long-cronjob-uid' }),
      spec: {
        steps: [
          {
            id: 'prospect',
            run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
          },
        ],
        workloads: [w],
      },
      status: {
        phase: 'degraded',
        workloadInstances: { [w.id]: storedName },
      },
    }

    const runtimeName = resolveWorkloadRuntimeResourceName(recipe, w)
    const cj = buildCronJob(w, recipe)

    expect(storedName.length).toBeGreaterThan(52)
    expect(runtimeName).toBe(resolveCronJobResourceName(recipe, w.id))
    expect(runtimeName.length).toBeLessThanOrEqual(52)
    expect(cj.metadata?.name).toBe(runtimeName)
    expect(cj.spec?.jobTemplate.spec?.template.metadata?.labels?.app).toBe(runtimeName)
  })
})

// ─── Job Builder ────────────────────────────────────────────────────

describe('buildJob', () => {
  it('returns Job (3.4a)', () => {
    const w: JobDef = { id: 'migrate', type: 'job', image: 'migrate:latest' }
    const job = buildJob(w, makeRecipe())
    expect(job.kind).toBe('Job')
    expect(job.spec?.backoffLimit).toBe(3)
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never')
  })

  it('sets custom backoffLimit', () => {
    const w: JobDef = { id: 'migrate', type: 'job', image: 'migrate:latest', backoffLimit: 5 }
    const job = buildJob(w, makeRecipe())
    expect(job.spec?.backoffLimit).toBe(5)
  })
})

// ─── DaemonSet Builder ──────────────────────────────────────────────

describe('buildDaemonSet', () => {
  it('returns DaemonSet (3.5a)', () => {
    const w: DaemonSetDef = { id: 'agent', type: 'daemonset', image: 'agent:latest' }
    const ds = buildDaemonSet(w, makeRecipe())
    expect(ds.kind).toBe('DaemonSet')
    expect(ds.spec?.selector.matchLabels?.app).toBe('agent')
  })
})

// ─── Service Builder ────────────────────────────────────────────────

describe('buildService', () => {
  it('returns ClusterIP Service (3.6a)', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 }
    const svc = buildService(w, makeRecipe())
    expect(svc).not.toBeNull()
    expect(svc!.spec?.type).toBe('ClusterIP')
    expect(svc!.spec?.ports![0].port).toBe(8080)
  })

  it('returns null for transport workloads when contextRef is set', () => {
    const w: DeploymentDef = {
      id: 'mcp',
      type: 'deployment',
      image: 'mcp:latest',
      port: 3000,
      transport: { type: 'streamableHttp' },
    }
    const recipe = makeRecipe()
    recipe.spec.contextRef = 'context1' // HCC path
    const svc = buildService(w, recipe)
    expect(svc).toBeNull()
  })

  it('returns null for transport workloads without contextRef because delegation owns Service', () => {
    const w: DeploymentDef = {
      id: 'mcp',
      type: 'deployment',
      image: 'mcp:latest',
      port: 3000,
      transport: { type: 'streamableHttp' },
    }
    const svc = buildService(w, makeRecipe())
    expect(svc).toBeNull()
  })

  it('uses the shortened StatefulSet runtime name as the Service selector', () => {
    const w: StatefulSetDef = {
      id: 'postgres',
      type: 'statefulset',
      image: 'postgres:16-alpine',
      port: 5432,
    }
    const recipe = makeRecipe({
      name: 'manual-layer3a-api-mongo-postgres-four-step',
      uid: 'long-statefulset-service-uid',
    })
    recipe.spec.steps = [
      {
        id: 'copy-postgres',
        run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
      },
    ]

    const svc = buildService(w, recipe)
    const runtimeName = resolveWorkloadRuntimeResourceName(recipe, w)

    expect(svc?.metadata?.name).toBe(runtimeName)
    expect(svc?.metadata?.name?.length).toBeLessThanOrEqual(52)
    expect(svc?.spec?.selector?.app).toBe(runtimeName)
  })

  it('returns null for workloads without port', () => {
    const w: DeploymentDef = { id: 'worker', type: 'deployment', image: 'worker:latest' }
    const svc = buildService(w, makeRecipe())
    expect(svc).toBeNull()
  })
})

// ─── PVC Builder ────────────────────────────────────────────────────

describe('buildPVC', () => {
  it('returns PersistentVolumeClaim (3.7a)', () => {
    const res: PvcResourceDef = { id: 'data-vol', type: 'pvc', size: '10Gi' }
    const pvc = buildPVC(res, makeRecipe())
    expect(pvc.kind).toBe('PersistentVolumeClaim')
    expect(pvc.spec?.resources?.requests?.['storage']).toBe('10Gi')
  })

  it('does NOT set ownerReference (CRITICAL) (3.7b)', () => {
    const res: PvcResourceDef = { id: 'data-vol', type: 'pvc', size: '10Gi' }
    const pvc = buildPVC(res, makeRecipe())
    expect(pvc.metadata?.ownerReferences).toBeUndefined()
  })

  it('sets storageClassName when provided', () => {
    const res: PvcResourceDef = { id: 'data-vol', type: 'pvc', size: '10Gi', storageClass: 'ssd' }
    const pvc = buildPVC(res, makeRecipe())
    expect(pvc.spec?.storageClassName).toBe('ssd')
  })

  it('defaults accessMode to ReadWriteOnce', () => {
    const res: PvcResourceDef = { id: 'data-vol', type: 'pvc', size: '5Gi' }
    const pvc = buildPVC(res, makeRecipe())
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce'])
  })
})

// ─── Secret Builder ─────────────────────────────────────────────────

describe('buildSecret', () => {
  it('returns Secret with base64 data (3.8a)', () => {
    const res: SecretResourceDef = { id: 'creds', type: 'secret', data: { password: 's3cret' } }
    const secret = buildSecret(res, makeRecipe())
    expect(secret.kind).toBe('Secret')
    expect(secret.type).toBe('Opaque')
    expect(Buffer.from(secret.data!['password'], 'base64').toString()).toBe('s3cret')
  })

  it('generates random values for generateKeys (3.8b)', () => {
    const res: SecretResourceDef = { id: 'creds', type: 'secret', generateKeys: ['api-key'] }
    const secret = buildSecret(res, makeRecipe())
    expect(secret.data!['api-key']).toBeDefined()
    const decoded = Buffer.from(secret.data!['api-key'], 'base64').toString()
    expect(decoded.length).toBe(32)
  })

  it('sets ownerReference', () => {
    const res: SecretResourceDef = { id: 'creds', type: 'secret', data: {} }
    const secret = buildSecret(res, makeRecipe())
    expect(secret.metadata?.ownerReferences).toHaveLength(1)
    expect(secret.metadata?.ownerReferences![0].kind).toBe('WorkflowRecipe')
  })
})

// ─── ConfigMap Builder ──────────────────────────────────────────────

describe('buildConfigMap', () => {
  it('returns ConfigMap (3.9a)', () => {
    const res: ConfigMapResourceDef = {
      id: 'app-config',
      type: 'configmap',
      data: { LOG_LEVEL: 'info' },
    }
    const cm = buildConfigMap(res, makeRecipe())
    expect(cm.kind).toBe('ConfigMap')
    expect(cm.data?.['LOG_LEVEL']).toBe('info')
  })

  it('sets ownerReference', () => {
    const res: ConfigMapResourceDef = { id: 'cfg', type: 'configmap', data: { k: 'v' } }
    const cm = buildConfigMap(res, makeRecipe())
    expect(cm.metadata?.ownerReferences).toHaveLength(1)
  })
})

// ─── imagePullSecrets Support (Phase 8 Hardening) ───────────────────────

describe('buildDeployment - imagePullSecrets', () => {
  it('includes imagePullSecrets in pod spec when specified (3.10a)', () => {
    const workload: DeploymentDef = {
      id: 'test-deployment',
      type: 'deployment',
      image: 'registry.example.com/private-image:latest',
      imagePullSecrets: ['registry-secret'],
      replicas: 1,
    }
    const recipe = makeRecipe()
    const deployment = buildDeployment(workload, recipe, 'minimal')

    expect(deployment.spec?.template.spec?.imagePullSecrets).toEqual([{ name: 'registry-secret' }])
  })

  it('includes multiple imagePullSecrets in pod spec (3.10b)', () => {
    const workload: DeploymentDef = {
      id: 'test-deployment',
      type: 'deployment',
      image: 'registry.example.com/private-image:latest',
      imagePullSecrets: ['registry-secret', 'dockerhub-secret'],
      replicas: 1,
    }
    const recipe = makeRecipe()
    const deployment = buildDeployment(workload, recipe, 'minimal')

    expect(deployment.spec?.template.spec?.imagePullSecrets).toHaveLength(2)
    expect(deployment.spec?.template.spec?.imagePullSecrets).toContainEqual({
      name: 'registry-secret',
    })
    expect(deployment.spec?.template.spec?.imagePullSecrets).toContainEqual({
      name: 'dockerhub-secret',
    })
  })

  it('omits imagePullSecrets when not specified (3.10c)', () => {
    const workload: DeploymentDef = {
      id: 'test-deployment',
      type: 'deployment',
      image: 'nginx:1.30.1-alpine',
      replicas: 1,
    }
    const recipe = makeRecipe()
    const deployment = buildDeployment(workload, recipe, 'minimal')

    expect(deployment.spec?.template.spec?.imagePullSecrets).toBeUndefined()
  })

  it('omits imagePullSecrets when empty array (3.10d)', () => {
    const workload: DeploymentDef = {
      id: 'test-deployment',
      type: 'deployment',
      image: 'nginx:1.30.1-alpine',
      imagePullSecrets: [],
      replicas: 1,
    }
    const recipe = makeRecipe()
    const deployment = buildDeployment(workload, recipe, 'minimal')

    expect(deployment.spec?.template.spec?.imagePullSecrets).toBeUndefined()
  })
})

// ─── volumeClaimTemplates Labels (Phase 8 Hardening) ───────────────────────

describe('buildStatefulSet - volumeClaimTemplates Labels', () => {
  it('includes workload labels in volumeClaimTemplates metadata (3.11a)', () => {
    const workload: StatefulSetDef = {
      id: 'mongodb-stateful',
      type: 'statefulset',
      image: 'mongodb:latest',
      replicas: 1,
      volumeClaimTemplates: [
        {
          name: 'data',
          storageClass: 'standard',
          accessMode: 'ReadWriteOnce',
          size: '10Gi',
        },
      ],
    }
    const recipe = makeRecipe()
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    expect(statefulSet.spec?.volumeClaimTemplates).toBeDefined()
    expect(statefulSet.spec!.volumeClaimTemplates).toHaveLength(1)

    const vct = statefulSet.spec!.volumeClaimTemplates?.[0]
    expect(vct?.metadata?.labels).toEqual({
      app: 'mongodb-stateful',
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/recipe': 'test-recipe',
      'clerum.io/workload': 'mongodb-stateful',
    })
  })

  it('includes multiple volumeClaimTemplates with labels (3.11b)', () => {
    const workload: StatefulSetDef = {
      id: 'multi-pvc-stateful',
      type: 'statefulset',
      image: 'app:latest',
      replicas: 1,
      volumeClaimTemplates: [
        {
          name: 'data',
          storageClass: 'standard',
          accessMode: 'ReadWriteOnce',
          size: '10Gi',
        },
        {
          name: 'logs',
          storageClass: 'fast-ssd',
          accessMode: 'ReadWriteOnce',
          size: '5Gi',
        },
      ],
    }
    const recipe = makeRecipe()
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    expect(statefulSet.spec?.volumeClaimTemplates).toBeDefined()
    expect(statefulSet.spec!.volumeClaimTemplates).toHaveLength(2)

    // First PVC template
    const vct1 = statefulSet.spec!.volumeClaimTemplates?.[0]
    expect(vct1).toBeDefined()
    expect(vct1?.metadata?.labels).toHaveProperty('clerum.io/workload', 'multi-pvc-stateful')
    expect(vct1?.metadata?.labels).toHaveProperty('clerum.io/recipe', 'test-recipe')

    // Second PVC template
    const vct2 = statefulSet.spec!.volumeClaimTemplates?.[1]
    expect(vct2).toBeDefined()
    expect(vct2?.metadata?.labels).toHaveProperty('clerum.io/workload', 'multi-pvc-stateful')
    expect(vct2?.metadata?.labels).toHaveProperty('clerum.io/recipe', 'test-recipe')
  })

  it('omits volumeClaimTemplates when not specified (3.11c)', () => {
    const workload: StatefulSetDef = {
      id: 'simple-stateful',
      type: 'statefulset',
      image: 'app:latest',
      replicas: 1,
    }
    const recipe = makeRecipe()
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    expect(statefulSet.spec?.volumeClaimTemplates).toBeUndefined()
  })

  it('includes labels for contextRef when specified (3.11d)', () => {
    const workload: StatefulSetDef = {
      id: 'contextual-stateful',
      type: 'statefulset',
      image: 'app:latest',
      replicas: 1,
      volumeClaimTemplates: [
        {
          name: 'data',
          storageClass: 'standard',
          accessMode: 'ReadWriteOnce',
          size: '1Gi',
        },
      ],
    }
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'test-uid',
      },
      spec: {
        contextRef: 'production-context',
        workloads: [workload],
      },
    }
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    const vct = statefulSet.spec!.volumeClaimTemplates?.[0]
    expect(vct?.metadata?.labels).toHaveProperty('clerum.io/context', 'production-context')
  })
})

// ─── StatefulSet VCT volume filtering ────────────────────────────────────

describe('buildStatefulSet - VCT volume filtering', () => {
  it('excludes emptyDir volumes for names matching volumeClaimTemplates (VCT-filter)', () => {
    const workload: StatefulSetDef = {
      id: 'postgres',
      type: 'statefulset',
      image: 'postgres:16-alpine',
      port: 5432,
      volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      volumeClaimTemplates: [
        {
          name: 'pgdata',
          storageClass: 'standard',
          accessMode: 'ReadWriteOnce',
          size: '256Mi',
        },
      ],
    }
    const recipe = makeRecipe()
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    // VCT-backed volumes must NOT appear in pod spec.volumes
    const podVolumes = statefulSet.spec?.template?.spec?.volumes ?? []
    const pgdataVol = podVolumes.find(v => v.name === 'pgdata')
    expect(pgdataVol).toBeUndefined()

    // But volumeMounts must still reference pgdata (K8s wires it from VCT)
    const container = statefulSet.spec?.template?.spec?.containers?.[0]
    const pgdataMount = container?.volumeMounts?.find(vm => vm.name === 'pgdata')
    expect(pgdataMount).toBeDefined()
    expect(pgdataMount?.mountPath).toBe('/var/lib/postgresql/data')
  })

  it('keeps non-VCT volumes while filtering VCT ones (VCT-filter-mixed)', () => {
    const workload: StatefulSetDef = {
      id: 'mixed-app',
      type: 'statefulset',
      image: 'app:latest',
      volumeMounts: [
        { name: 'data', mountPath: '/data' },
        { name: 'cache', mountPath: '/cache' },
      ],
      volumeClaimTemplates: [
        { name: 'data', storageClass: 'standard', accessMode: 'ReadWriteOnce', size: '10Gi' },
      ],
    }
    const recipe = makeRecipe()
    const { statefulSet } = buildStatefulSet(workload, recipe, 'minimal')

    const podVolumes = statefulSet.spec?.template?.spec?.volumes ?? []
    // "data" should be filtered (it's a VCT)
    expect(podVolumes.find(v => v.name === 'data')).toBeUndefined()
    // "cache" should remain as emptyDir (not a VCT)
    const cacheVol = podVolumes.find(v => v.name === 'cache')
    expect(cacheVol).toBeDefined()
    expect(cacheVol?.emptyDir).toBeDefined()
  })
})

// ─── Per-Workload Security Overrides (GAP 15) ───────────────────────────

describe('buildDeployment - security overrides', () => {
  it('applies runAsUser from workload.security to podSecurityContext (GAP15a)', () => {
    const w: DeploymentDef = {
      id: 'postgres',
      type: 'deployment',
      image: 'postgres:16-alpine',
      security: { runAsUser: 70, runAsGroup: 70, fsGroup: 70 },
    }
    const dep = buildDeployment(w, makeRecipe(), 'minimal')
    expect(dep.spec?.template.spec?.securityContext?.runAsUser).toBe(70)
    expect(dep.spec?.template.spec?.securityContext?.runAsGroup).toBe(70)
    expect(dep.spec?.template.spec?.securityContext?.fsGroup).toBe(70)
  })

  it('forces runAsNonRoot: true when runAsUser is set (GAP15b)', () => {
    const w: DeploymentDef = {
      id: 'postgres',
      type: 'deployment',
      image: 'postgres:16-alpine',
      security: { runAsUser: 70 },
    }
    const dep = buildDeployment(w, makeRecipe(), 'minimal')
    const containerSc = dep.spec?.template.spec?.containers[0].securityContext
    expect(containerSc?.runAsNonRoot).toBe(true)
  })

  it('without security overrides behaves as before (GAP15c)', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest' }
    const dep = buildDeployment(w, makeRecipe(), 'minimal')
    // minimal: no podSecurityContext
    expect(dep.spec?.template.spec?.securityContext).toBeUndefined()
    // minimal: runAsNonRoot false
    expect(dep.spec?.template.spec?.containers[0].securityContext?.runAsNonRoot).toBe(false)
  })

  it('adds an explicit ownership init container only for writable volume mounts', () => {
    const w: DeploymentDef = {
      id: 'mongodb',
      type: 'deployment',
      image: 'mongodb/mongodb-community-server:7.0-ubi8',
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, prepareVolumeOwnership: true },
      volumeMounts: [
        { name: 'mongodb-data', mountPath: '/data/db' },
        { name: 'config', mountPath: '/etc/mongo', readOnly: true },
      ],
    }

    const dep = buildDeployment(w, makeRecipe(), 'minimal')
    const init = dep.spec?.template.spec?.initContainers?.[0]

    expect(init?.name).toBe('prepare-volume-ownership')
    expect(init?.image).toBe('mongodb/mongodb-community-server:7.0-ubi8')
    expect(init?.command).toEqual([
      'sh',
      '-c',
      [
        'set -eu',
        'for path do',
        '  chown -R "${TARGET_UID}:${TARGET_GID}" "$path"',
        '  chmod -R ug+rwX "$path"',
        'done',
      ].join('\n'),
      '--',
      '/data/db',
    ])
    expect(init?.env).toEqual([
      { name: 'TARGET_UID', value: '1000' },
      { name: 'TARGET_GID', value: '1000' },
    ])
    expect(init?.volumeMounts).toEqual([{ name: 'mongodb-data', mountPath: '/data/db' }])
    expect(init?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: false,
      runAsUser: 0,
      runAsGroup: 0,
      seccompProfile: { type: 'RuntimeDefault' },
    })
  })

  it('does not add an ownership init container when prepareVolumeOwnership is absent', () => {
    const w: DeploymentDef = {
      id: 'mongodb',
      type: 'deployment',
      image: 'mongodb/mongodb-community-server:7.0-ubi8',
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      volumeMounts: [{ name: 'mongodb-data', mountPath: '/data/db' }],
    }

    const dep = buildDeployment(w, makeRecipe(), 'minimal')

    expect(dep.spec?.template.spec?.initContainers).toBeUndefined()
  })
})

describe('buildCronJob - security overrides', () => {
  it('applies security overrides to CronJob pod template (GAP15d)', () => {
    const w: CronJobDef = {
      id: 'backup',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
      security: { runAsUser: 70, fsGroup: 70 },
    }
    const cj = buildCronJob(w, makeRecipe(), 'minimal')
    const podSc = cj.spec?.jobTemplate.spec?.template.spec?.securityContext
    expect(podSc?.runAsUser).toBe(70)
    expect(podSc?.fsGroup).toBe(70)
  })
})

describe('buildStatefulSet - security overrides', () => {
  it('applies security overrides to StatefulSet pod template (GAP15e)', () => {
    const w: StatefulSetDef = {
      id: 'pg',
      type: 'statefulset',
      image: 'postgres:16-alpine',
      port: 5432,
      security: { runAsUser: 70, runAsGroup: 70, fsGroup: 70 },
    }
    const { statefulSet } = buildStatefulSet(w, makeRecipe(), 'minimal')
    expect(statefulSet.spec?.template.spec?.securityContext?.runAsUser).toBe(70)
    expect(statefulSet.spec?.template.spec?.securityContext?.fsGroup).toBe(70)
  })

  it('adds ownership preparation to StatefulSet templates without shadowing volumeClaimTemplates', () => {
    const w: StatefulSetDef = {
      id: 'mongodb',
      type: 'statefulset',
      image: 'mongodb/mongodb-community-server:7.0-ubi8',
      port: 27017,
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, prepareVolumeOwnership: true },
      volumeMounts: [{ name: 'mongodb-data', mountPath: '/data/db' }],
      volumeClaimTemplates: [
        {
          name: 'mongodb-data',
          storageClass: 'standard',
          accessMode: 'ReadWriteOnce',
          size: '1Gi',
        },
      ],
    }

    const { statefulSet } = buildStatefulSet(w, makeRecipe(), 'minimal')
    const podSpec = statefulSet.spec?.template.spec

    expect(podSpec?.initContainers?.[0]?.name).toBe('prepare-volume-ownership')
    expect(podSpec?.initContainers?.[0]?.volumeMounts).toEqual([
      { name: 'mongodb-data', mountPath: '/data/db' },
    ])
    expect(podSpec?.volumes).toBeUndefined()
    expect(statefulSet.spec?.volumeClaimTemplates?.[0]?.metadata?.name).toBe('mongodb-data')
  })
})

// ─── MCP Server Label (Issue #15 — NetworkPolicy label mismatch) ─────────

describe('clerum.io/mcpserver label for transport workloads', () => {
  it('adds mcpserver label to Deployment metadata when transport is set', () => {
    const w: DeploymentDef = {
      id: 'redis-mcp',
      type: 'deployment',
      image: 'redis:7-alpine',
      port: 3000,
      transport: { type: 'streamableHttp' },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.metadata?.labels?.['clerum.io/mcpserver']).toBe('test-recipe-redis-mcp')
  })

  it('adds mcpserver label to Deployment pod template when transport is set', () => {
    const w: DeploymentDef = {
      id: 'redis-mcp',
      type: 'deployment',
      image: 'redis:7-alpine',
      port: 3000,
      transport: { type: 'streamableHttp' },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/mcpserver']).toBe(
      'test-recipe-redis-mcp'
    )
  })

  it('does NOT add mcpserver label when transport is absent', () => {
    const w: DeploymentDef = {
      id: 'nginx',
      type: 'deployment',
      image: 'nginx:1.30.1-alpine',
      port: 8080,
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.metadata?.labels?.['clerum.io/mcpserver']).toBeUndefined()
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/mcpserver']).toBeUndefined()
  })

  it('adds mcpserver label to StatefulSet metadata and pod template', () => {
    const w: StatefulSetDef = {
      id: 'pg-mcp',
      type: 'statefulset',
      image: 'postgres:16-alpine',
      port: 5432,
      transport: { type: 'streamableHttp' },
    }
    const { statefulSet } = buildStatefulSet(w, makeRecipe())
    expect(statefulSet.metadata?.labels?.['clerum.io/mcpserver']).toBe('test-recipe-pg-mcp')
    expect(statefulSet.spec?.template.metadata?.labels?.['clerum.io/mcpserver']).toBe(
      'test-recipe-pg-mcp'
    )
  })

  it('computes mcpserver label as recipeName-workloadId', () => {
    const recipe = makeRecipe({ name: 'mcp-redis-cache' })
    const w: DeploymentDef = {
      id: 'redis-mcp',
      type: 'deployment',
      image: 'redis:7-alpine',
      port: 3000,
      transport: { type: 'streamableHttp' },
    }
    const dep = buildDeployment(w, recipe)
    expect(dep.metadata?.labels?.['clerum.io/mcpserver']).toBe('mcp-redis-cache-redis-mcp')
  })

  it('adds mcpserver label to CronJob when transport is set', () => {
    const w: CronJobDef = {
      id: 'health-checker',
      type: 'cronjob',
      image: 'curlimages/curl:latest',
      schedule: '*/5 * * * *',
      transport: { type: 'streamableHttp' },
    }
    const cj = buildCronJob(w, makeRecipe())
    expect(cj.metadata?.labels?.['clerum.io/mcpserver']).toBe('test-recipe-health-checker')
  })

  it('uses the runtime-safe mcpserver label for workflow transport workloads with long child names', () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'manual-pr259-layer3a-hybrid-secret-pvc-5step-7f99549a',
        namespace: 'sandbox-recipes',
        uid: 'long-child-uid',
      },
      spec: {
        steps: [{ id: 'call-mcp', instruction: 'Call mock tools.' }],
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    }
    const workload = recipe.spec.workloads![0] as DeploymentDef
    const dep = buildDeployment(workload, recipe)
    const expected = resolveWorkloadMcpServerLabel(recipe, workload)

    expect(expected).toBe(resolveWorkloadRuntimeResourceName(recipe, workload))
    expect(expected.length).toBeLessThanOrEqual(63)
    expect(dep.metadata?.labels?.['clerum.io/mcpserver']).toBe(expected)
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/mcpserver']).toBe(expected)
  })
})

// ─── resolveWorkloadResourceName ─────────────────────────────────────────

describe('resolveWorkloadResourceName', () => {
  const workflowRecipe: WorkflowRecipeCRD = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'competitive-intel-report', namespace: 'sandbox-recipes', uid: 'uid-wf' },
    spec: {
      steps: [{ id: 'research', instruction: 'do research' }],
      workloads: [{ id: 'cir-web-search', type: 'deployment', image: 'img:v1', port: 3000 }],
    },
  }

  const plainRecipe: WorkflowRecipeCRD = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'simple-recipe', namespace: 'sandbox-recipes', uid: 'uid-plain' },
    spec: {
      workloads: [{ id: 'web-server', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 }],
    },
  }

  it('generates deterministic SHA256-hash suffix for workflow recipes without workloadInstances', () => {
    const name = resolveWorkloadResourceName(workflowRecipe, 'cir-web-search')
    expect(name).toMatch(/^competitive-intel-report-cir-web-search-[0-9a-f]{8}$/)
  })

  it('returns stored name from status.workloadInstances when available', () => {
    const recipeWithInstances: WorkflowRecipeCRD = {
      ...workflowRecipe,
      status: {
        phase: 'deploying',
        workloadInstances: { 'cir-web-search': 'competitive-intel-report-cir-web-search-a1b2c3d4' },
      },
    }
    expect(resolveWorkloadResourceName(recipeWithInstances, 'cir-web-search')).toBe(
      'competitive-intel-report-cir-web-search-a1b2c3d4'
    )
  })

  it('uses raw workloadId for non-workflow recipes (no steps)', () => {
    expect(resolveWorkloadResourceName(plainRecipe, 'web-server')).toBe('web-server')
  })

  it('can derive a recipe-scoped name for catalog recipes before persistence', () => {
    const scoped = resolveScopedWorkloadResourceName(plainRecipe, 'web-server')
    expect(scoped).toMatch(/^simple-recipe-web-server-[0-9a-f]{8}$/)
    expect(scoped).not.toBe('web-server')
  })

  it('derives different scoped names for different recipe UIDs with the same workload ID', () => {
    const first = resolveScopedWorkloadResourceName(plainRecipe, 'web-server')
    const second = resolveScopedWorkloadResourceName(
      { ...plainRecipe, metadata: { ...plainRecipe.metadata, uid: 'uid-plain-2' } },
      'web-server'
    )
    expect(first).not.toBe(second)
  })

  it('keeps scoped workload names within the DNS label limit for max-length workload IDs', () => {
    const workloadId = 'a' + 'b'.repeat(62)
    const scoped = resolveScopedWorkloadResourceName(
      {
        ...plainRecipe,
        metadata: {
          ...plainRecipe.metadata,
          name: 'catalog-recipe-with-a-name-that-is-long-enough-to-require-clamping',
          uid: 'uid-long-workload',
        },
      },
      workloadId
    )

    expect(scoped.length).toBeLessThanOrEqual(63)
    expect(scoped).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  })

  it('clamps scoped StatefulSet names to leave room for controller-revision labels', () => {
    const recipe: WorkflowRecipeCRD = {
      ...plainRecipe,
      metadata: {
        ...plainRecipe.metadata,
        name: 'catalog-recipe-with-a-name-that-is-long-enough-to-require-clamping',
      },
    }
    const workload: StatefulSetDef = {
      id: 'postgres-with-a-long-workload-name',
      type: 'statefulset',
      image: 'postgres:16',
    }

    expect(resolveScopedStatefulSetResourceName(recipe, workload.id).length).toBeLessThanOrEqual(52)
    expect(resolveScopedWorkloadRuntimeResourceName(recipe, workload)).toBe(
      resolveScopedStatefulSetResourceName(recipe, workload.id)
    )
  })

  it('uses raw workloadId when steps is empty array', () => {
    const emptySteps: WorkflowRecipeCRD = {
      ...plainRecipe,
      spec: { ...plainRecipe.spec, steps: [] },
    }
    expect(resolveWorkloadResourceName(emptySteps, 'web-server')).toBe('web-server')
  })

  it('buildDeployment manifest.name matches resolveWorkloadResourceName for workflow', () => {
    const recipeWithInstances: WorkflowRecipeCRD = {
      ...workflowRecipe,
      status: {
        phase: 'deploying',
        workloadInstances: { 'cir-web-search': 'competitive-intel-report-cir-web-search-a1b2c3d4' },
      },
    }
    const w: DeploymentDef = {
      id: 'cir-web-search',
      type: 'deployment',
      image: 'img:v1',
      port: 3000,
    }
    const dep = buildDeployment(w, recipeWithInstances)
    expect(dep.metadata!.name).toBe(
      resolveWorkloadResourceName(recipeWithInstances, 'cir-web-search')
    )
    expect(dep.metadata!.name).toBe('competitive-intel-report-cir-web-search-a1b2c3d4')
  })
})

// ─── Resource name scoping (issue #571) ─────────────────────────────

describe('resolveScopedResourceName / resolveResourceName (issue #571)', () => {
  it('produces a deterministic {recipe}-{id}-{hash} scoped name, never the raw id', () => {
    const recipe = makeRecipe()
    const a = resolveScopedResourceName(recipe, 'data')
    const b = resolveScopedResourceName(recipe, 'data')
    expect(a).toBe(b)
    expect(a.startsWith('test-recipe-data-')).toBe(true)
    expect(a).not.toBe('data')
    expect(a.length).toBeLessThanOrEqual(63)
  })

  it('derives different scoped names for different recipe UIDs (cross-recipe isolation)', () => {
    const r1 = makeRecipe({ uid: 'uid-1' })
    const r2 = makeRecipe({ uid: 'uid-2' })
    expect(resolveScopedResourceName(r1, 'data')).not.toBe(resolveScopedResourceName(r2, 'data'))
  })

  it('separates a workload and a resource that share the same id (domain separator)', () => {
    const recipe = makeRecipe()
    expect(resolveScopedResourceName(recipe, 'data')).not.toBe(
      resolveScopedWorkloadResourceName(recipe, 'data')
    )
  })

  it('clamps long names to the 63-char DNS-1123 limit', () => {
    const recipe = makeRecipe({ name: 'a'.repeat(70) })
    expect(resolveScopedResourceName(recipe, 'data').length).toBeLessThanOrEqual(63)
  })

  it('resolveResourceName uses the persisted status.resourceInstances fast path', () => {
    const recipe = makeRecipe()
    recipe.status = { phase: 'active', resourceInstances: { data: 'pinned-physical-name' } }
    expect(resolveResourceName(recipe, 'data')).toBe('pinned-physical-name')
  })

  it('resolveResourceName falls back to a freshly scoped name when no status exists', () => {
    const recipe = makeRecipe()
    expect(resolveResourceName(recipe, 'data')).toBe(resolveScopedResourceName(recipe, 'data'))
  })

  it('two recipes with the same resource id get distinct physical PVC names', () => {
    const r1 = makeRecipe({ name: 'recipe-a', uid: 'uid-a' })
    const r2 = makeRecipe({ name: 'recipe-b', uid: 'uid-b' })
    const def: PvcResourceDef = { id: 'data', type: 'pvc', size: '1Gi' }
    const pvc1 = buildPVC(def, r1)
    const pvc2 = buildPVC(def, r2)
    expect(pvc1.metadata?.name).not.toBe(pvc2.metadata?.name)
    expect(pvc1.metadata?.name).not.toBe('data')
  })

  it('buildSecret and buildConfigMap scope metadata.name away from the raw id', () => {
    const recipe = makeRecipe()
    const secretDef: SecretResourceDef = { id: 'credentials', type: 'secret', data: { k: 'v' } }
    const cmDef: ConfigMapResourceDef = { id: 'credentials', type: 'configmap', data: { k: 'v' } }
    const built = buildSecret(secretDef, recipe)
    expect(built.metadata?.name).toBe(resolveResourceName(recipe, 'credentials'))
    expect(built.metadata?.labels?.[OWNER_RECIPE_LABEL_KEY]).toBe(recipe.metadata.name)
    expect(buildConfigMap(cmDef, recipe).metadata?.name).toBe(
      resolveResourceName(recipe, 'credentials')
    )
    expect(built.metadata?.name).not.toBe('credentials')
  })
})

// ─── Sandbox UI label injection ─────────────────────────────────────

describe('sandbox-ui label injection', () => {
  function makeRecipeWithUi(uiWorkloadId: string): WorkflowRecipeCRD {
    const recipe = makeRecipe()
    recipe.spec.workloads = [
      { id: uiWorkloadId, type: 'deployment', image: 'web:1', port: 8080 },
      { id: 'sibling', type: 'deployment', image: 'sib:1', port: 9000 },
    ]
    recipe.spec.ui = { workloadRef: uiWorkloadId, port: 8080 }
    return recipe
  }

  it('does not add sandbox-ui labels when spec.ui is absent', () => {
    const w: DeploymentDef = {
      id: 'app',
      type: 'deployment',
      image: 'nginx:1.30.1-alpine',
      port: 8080,
    }
    const dep = buildDeployment(w, makeRecipe())
    const svc = buildService(w, makeRecipe())
    const podLabels = dep.spec?.template.metadata?.labels ?? {}
    const depLabels = dep.metadata?.labels ?? {}
    const svcLabels = svc!.metadata?.labels ?? {}
    expect(podLabels['clerum.io/sandbox-ui']).toBeUndefined()
    expect(depLabels['clerum.io/sandbox-ui']).toBeUndefined()
    expect(svcLabels['clerum.io/sandbox-ui']).toBeUndefined()
  })

  it('does not add sandbox-ui labels to a non-UI sibling workload', () => {
    const recipe = makeRecipeWithUi('web')
    const sibling: DeploymentDef = {
      id: 'sibling',
      type: 'deployment',
      image: 'sib:1',
      port: 9000,
    }
    const dep = buildDeployment(sibling, recipe)
    const svc = buildService(sibling, recipe)
    expect(dep.metadata?.labels?.['clerum.io/sandbox-ui']).toBeUndefined()
    expect(dep.metadata?.labels?.['clerum.io/recipe-namespace']).toBeUndefined()
    expect(dep.metadata?.labels?.['clerum.io/recipe-name']).toBeUndefined()
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/sandbox-ui']).toBeUndefined()
    expect(svc!.metadata?.labels?.['clerum.io/sandbox-ui']).toBeUndefined()
  })

  it('stamps sandbox-ui labels on the UI workload Deployment metadata + pod template', () => {
    const recipe = makeRecipeWithUi('web')
    const ui: DeploymentDef = { id: 'web', type: 'deployment', image: 'web:1', port: 8080 }
    const dep = buildDeployment(ui, recipe)
    const expected = {
      'clerum.io/sandbox-ui': 'true',
      'clerum.io/recipe-namespace': 'sandbox-recipes',
      'clerum.io/recipe-name': 'test-recipe',
    }
    expect(dep.metadata?.labels).toMatchObject(expected)
    expect(dep.spec?.template.metadata?.labels).toMatchObject(expected)
  })

  it('stamps sandbox-ui labels on the UI workload Service metadata', () => {
    const recipe = makeRecipeWithUi('web')
    const ui: DeploymentDef = { id: 'web', type: 'deployment', image: 'web:1', port: 8080 }
    const svc = buildService(ui, recipe)
    expect(svc).not.toBeNull()
    expect(svc!.metadata?.labels).toMatchObject({
      'clerum.io/sandbox-ui': 'true',
      'clerum.io/recipe-namespace': 'sandbox-recipes',
      'clerum.io/recipe-name': 'test-recipe',
    })
  })

  it('preserves existing labels when overlaying sandbox-ui labels', () => {
    const recipe = makeRecipeWithUi('web')
    recipe.spec.contextRef = 'analytics'
    const ui: DeploymentDef = { id: 'web', type: 'deployment', image: 'web:1', port: 8080 }
    const dep = buildDeployment(ui, recipe)
    const labels = dep.metadata?.labels ?? {}
    expect(labels['clerum.io/recipe']).toBe('test-recipe')
    expect(labels['clerum.io/workload']).toBe('web')
    expect(labels['clerum.io/context']).toBe('analytics')
    expect(labels['clerum.io/managed-by']).toBe('workflow-recipes')
    expect(labels['clerum.io/sandbox-ui']).toBe('true')
  })
})

// ─── UI egress NetworkPolicy ────────────────────────────────────────

describe('buildUiEgressNetworkPolicy', () => {
  const SBX_UI = 'sandbox-ui'
  const SBX_RECIPES = 'sandbox-recipes'

  it('returns null when spec.ui is absent', () => {
    const policy = buildUiEgressNetworkPolicy(makeRecipe(), SBX_UI, SBX_RECIPES, [])
    expect(policy).toBeNull()
  })

  it('emits a policy named ui-egress-<recipeName> in sandbox-ui', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])
    expect(policy).not.toBeNull()
    expect(policy!.metadata?.name).toBe('ui-egress-test-recipe')
    expect(policy!.metadata?.namespace).toBe(SBX_UI)
    expect(policy!.kind).toBe('NetworkPolicy')
    expect(policy!.apiVersion).toBe('networking.k8s.io/v1')
  })

  it('selects pods by the three sandbox-ui labels', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      'clerum.io/sandbox-ui': 'true',
      'clerum.io/recipe-namespace': 'sandbox-recipes',
      'clerum.io/recipe-name': 'test-recipe',
    })
    expect(policy.spec?.policyTypes).toEqual(['Egress'])
  })

  it('builds internal egress rules for sibling workloads in sandbox-recipes', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = {
      workloadRef: 'web',
      port: 8080,
      egress: { internal: [{ workloadRef: 'postgres', port: 5432 }] },
    }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.spec?.egress).toHaveLength(1)
    const rule = policy.spec!.egress![0]
    expect(rule.to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': SBX_RECIPES } },
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': 'test-recipe',
            'clerum.io/workload': 'postgres',
          },
        },
      },
    ])
    expect(rule.ports).toEqual([{ port: 5432, protocol: 'TCP' }])
  })

  it('builds external egress rules with RFC1918 carved out from a wildcard parent', () => {
    // A wildcard /0 only arises if some fqdn resolves to it (in practice it
    // does not). We exercise the carve-out shape directly via the resolved
    // input — same builder code path the reconciler uses.
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const resolved = [
      {
        cidr: '0.0.0.0/0',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'wildcard.example' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    expect(policy.spec?.egress).toHaveLength(1)
    const rule = policy.spec!.egress![0]
    expect(rule.to).toEqual([
      {
        ipBlock: {
          cidr: '0.0.0.0/0',
          except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
        },
      },
    ])
    expect(rule.ports).toEqual([{ port: 443, protocol: 'TCP' }])
  })

  it('omits except entirely when cidr is a /32 public IP (none of RFC1918 is a strict subset)', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const resolved = [
      {
        cidr: '54.221.123.10/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'api.example' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    expect(policy.spec?.egress?.[0].to).toEqual([{ ipBlock: { cidr: '54.221.123.10/32' } }])
  })

  it('keeps only the RFC1918 entries that are strict subsets of the parent cidr', () => {
    // 10.0.0.0/16 sits inside 10.0.0.0/8 only — 172.16/12 and 192.168/16
    // are disjoint. We expect no except entries because 10.0.0.0/8 is not a
    // strict subset of 10.0.0.0/16 (parent is narrower), and the other two
    // aren't contained.
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const resolved = [
      {
        cidr: '10.0.0.0/16',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'private.example' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    expect(policy.spec?.egress?.[0].to).toEqual([{ ipBlock: { cidr: '10.0.0.0/16' } }])
  })

  it('emits one rule per internal + external entry', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = {
      workloadRef: 'web',
      port: 8080,
      egress: {
        internal: [
          { workloadRef: 'postgres', port: 5432 },
          { workloadRef: 'redis', port: 6379 },
        ],
      },
    }
    const resolved = [
      {
        cidr: '93.184.216.10/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'api.example' },
      },
      {
        cidr: '93.184.216.10/32',
        port: 80,
        source: { kind: 'fqdn' as const, fqdn: 'api.example' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    expect(policy.spec?.egress).toHaveLength(4)
  })

  it('emits an empty egress array when ui has no egress section', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.spec?.egress).toEqual([])
  })

  it('stamps managed-by + recipe labels on the policy itself', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.metadata?.labels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/recipe': 'test-recipe',
      'clerum.io/recipe-namespace': 'sandbox-recipes',
      'clerum.io/recipe-name': 'test-recipe',
    })
  })

  it('does NOT set ownerReferences (cross-namespace from the WorkflowRecipe CRD)', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.metadata?.ownerReferences).toBeUndefined()
  })

  it('emits one rule per resolved fqdn-derived /32', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = {
      workloadRef: 'web',
      port: 8080,
      egress: { external: [{ fqdn: 'api.stripe.com', port: 443 }] },
    }
    const resolved = [
      {
        cidr: '93.184.216.10/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'api.stripe.com' },
      },
      {
        cidr: '93.184.216.11/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'api.stripe.com' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    expect(policy.spec?.egress).toHaveLength(2)
    expect(policy.spec?.egress?.[0].to).toEqual([{ ipBlock: { cidr: '93.184.216.10/32' } }])
    expect(policy.spec?.egress?.[1].to).toEqual([{ ipBlock: { cidr: '93.184.216.11/32' } }])
  })

  it('stamps fqdn provenance annotations when fqdn entries resolved into the policy', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const resolved = [
      {
        cidr: '93.184.216.10/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'api.stripe.com' },
      },
      {
        cidr: '8.8.8.8/32',
        port: 443,
        source: { kind: 'fqdn' as const, fqdn: 'ingest.sentry.io' },
      },
    ]
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, resolved)!
    const annotations = policy.metadata?.annotations
    expect(annotations?.['clerum.io/egress-fqdn-resolved-at']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    )
    expect(annotations?.['clerum.io/egress-fqdn-targets']).toBe(
      'api.stripe.com=93.184.216.10/32,ingest.sentry.io=8.8.8.8/32'
    )
  })

  it('omits provenance annotations when no resolved entries are present', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const policy = buildUiEgressNetworkPolicy(recipe, SBX_UI, SBX_RECIPES, [])!
    expect(policy.metadata?.annotations).toBeUndefined()
  })
})

// ─── OAuth broker token (Path B) ────────────────────────────────────

describe('recipe OAuth broker token', () => {
  // A recipe with one backgroundAccess client; `optInWorkloads` is the set of
  // workload ids that reference it via oauthClientRefs.
  function bgRecipe(optInWorkloads: string[] = ['worker']): WorkflowRecipeCRD {
    const recipe = makeRecipe()
    recipe.spec.oauthClients = [
      {
        id: 'sf',
        provider: 'salesforce',
        clientIdRef: { name: 'sf-creds', key: 'client-id' },
        clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
        scopes: ['api', 'refresh_token'],
        backgroundAccess: true,
      },
    ]
    recipe.spec.workloads = optInWorkloads.map(id => ({
      id,
      type: 'deployment' as const,
      image: 'worker:latest',
      oauthClientRefs: ['sf'],
    }))
    return recipe
  }

  const BROKER_VOLUME = 'clerum-oauth-broker-token'
  const BROKER_PATH = '/var/run/clerum/oauth-broker/broker-token'

  it('recipeHasBackgroundAccessClient reflects the backgroundAccess flag', () => {
    expect(recipeHasBackgroundAccessClient(makeRecipe())).toBe(false)
    expect(recipeHasBackgroundAccessClient(bgRecipe())).toBe(true)
  })

  it('workloadUsesBackgroundOauth requires an oauthClientRefs match', () => {
    const recipe = bgRecipe(['worker'])
    const optedIn = recipe.spec.workloads![0]
    expect(workloadUsesBackgroundOauth(optedIn, recipe)).toBe(true)
    // Same recipe, a workload that does not reference the client.
    const noRef: DeploymentDef = { id: 'other', type: 'deployment', image: 'x:latest' }
    expect(workloadUsesBackgroundOauth(noRef, recipe)).toBe(false)
    // Ref points at a client that isn't backgroundAccess → no opt-in.
    const danglingRef: DeploymentDef = {
      id: 'other',
      type: 'deployment',
      image: 'x:latest',
      oauthClientRefs: ['not-a-client'],
    }
    expect(workloadUsesBackgroundOauth(danglingRef, recipe)).toBe(false)
  })

  it('buildOAuthBrokerTokenSecret stores the token base64-encoded under broker-token', () => {
    const secret = buildOAuthBrokerTokenSecret('test-recipe', 'JWT.VALUE', 'sandbox-recipes')
    expect(secret.metadata?.name).toBe(oauthBrokerTokenSecretName('test-recipe'))
    expect(secret.metadata?.namespace).toBe('sandbox-recipes')
    expect(secret.data?.['broker-token']).toBe(Buffer.from('JWT.VALUE').toString('base64'))
  })

  it('mounts the broker token as a Secret volume (not env) into an opted-in workload', () => {
    const recipe = bgRecipe(['worker'])
    const dep = buildDeployment(recipe.spec.workloads![0] as DeploymentDef, recipe)
    const podSpec = dep.spec?.template.spec
    // Volume sourced from the broker-token Secret — survives rotation.
    const vol = podSpec?.volumes?.find(v => v.name === BROKER_VOLUME)
    expect(vol?.secret?.secretName).toBe(oauthBrokerTokenSecretName('test-recipe'))
    // Read-only mount.
    const mount = podSpec?.containers[0].volumeMounts?.find(m => m.name === BROKER_VOLUME)
    expect(mount?.mountPath).toBe('/var/run/clerum/oauth-broker')
    expect(mount?.readOnly).toBe(true)
    // Env carries only the file PATH, never a secretKeyRef to the token value.
    const env = podSpec?.containers[0].env ?? []
    const fileEnv = env.find(e => e.name === 'RECIPE_OAUTH_BROKER_TOKEN_FILE')
    expect(fileEnv?.value).toBe(BROKER_PATH)
    expect(env.some(e => e.name === 'RECIPE_OAUTH_BROKER_TOKEN')).toBe(false)
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/oauth-broker-client']).toBe('true')
  })

  it('does not mount the broker token when the workload has no oauthClientRefs', () => {
    const recipe = bgRecipe([]) // backgroundAccess client declared, but no opt-in
    const w: DeploymentDef = { id: 'worker', type: 'deployment', image: 'worker:latest' }
    const dep = buildDeployment(w, recipe)
    const podSpec = dep.spec?.template.spec
    expect(podSpec?.volumes?.some(v => v.name === BROKER_VOLUME)).toBeFalsy()
    expect(
      (podSpec?.containers[0].env ?? []).some(e => e.name === 'RECIPE_OAUTH_BROKER_TOKEN_FILE')
    ).toBe(false)
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/oauth-broker-client']).toBeUndefined()
  })

  it('does not mount the broker token into an MCP transport workload even with a ref', () => {
    const recipe = bgRecipe([])
    const w: DeploymentDef = {
      id: 'mcp',
      type: 'deployment',
      image: 'mcp:latest',
      transport: { type: 'streamableHttp' },
      oauthClientRefs: ['sf'],
    }
    recipe.spec.workloads = [w]
    const dep = buildDeployment(w, recipe)
    expect(dep.spec?.template.spec?.volumes?.some(v => v.name === BROKER_VOLUME)).toBeFalsy()
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/oauth-broker-client']).toBeUndefined()
  })

  it('does not mount the broker token into the UI workload even with a ref', () => {
    const recipe = bgRecipe([])
    const w: DeploymentDef = {
      id: 'web',
      type: 'deployment',
      image: 'web:latest',
      oauthClientRefs: ['sf'],
    }
    recipe.spec.workloads = [w]
    recipe.spec.ui = { workloadRef: 'web', port: 8080 }
    const dep = buildDeployment(w, recipe)
    expect(dep.spec?.template.spec?.volumes?.some(v => v.name === BROKER_VOLUME)).toBeFalsy()
    expect(dep.spec?.template.metadata?.labels?.['clerum.io/oauth-broker-client']).toBeUndefined()
  })

  it('buildOAuthBrokerEgressNetworkPolicy selects opted-in workloads and targets control-api', () => {
    const recipe = bgRecipe(['worker', 'sync'])
    const np = buildOAuthBrokerEgressNetworkPolicy(
      recipe,
      ['worker', 'sync'],
      'sandbox-recipes',
      'control-plane'
    )
    expect(np?.metadata?.name).toBe(oauthBrokerEgressPolicyName('test-recipe'))
    expect(np?.spec?.podSelector?.matchExpressions?.[0]).toEqual({
      key: 'clerum.io/workload',
      operator: 'In',
      values: ['sync', 'worker'],
    })
    const to = np?.spec?.egress?.[0].to?.[0]
    expect(to?.namespaceSelector?.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'control-plane',
    })
    expect(np?.spec?.egress?.[0].ports?.[0].port).toBe(8090)
  })

  it('buildOAuthBrokerEgressNetworkPolicy returns null when no workload opted in', () => {
    expect(
      buildOAuthBrokerEgressNetworkPolicy(makeRecipe(), [], 'sandbox-recipes', 'control-plane')
    ).toBeNull()
  })

  // Egress NetworkPolicy selects by workload+recipe labels regardless of kind,
  // so CronJob/Job opt-ins need the broker volume + env to match the egress hole.
  it('mounts the broker token into an opted-in CronJob workload', () => {
    const recipe = bgRecipe([])
    const w: CronJobDef = {
      id: 'inbox-poll',
      type: 'cronjob',
      image: 'poller:latest',
      schedule: '*/5 * * * *',
      oauthClientRefs: ['sf'],
    }
    recipe.spec.workloads = [w]
    const podSpec = buildCronJob(w, recipe).spec?.jobTemplate.spec?.template.spec
    expect(podSpec?.volumes?.find(v => v.name === BROKER_VOLUME)?.secret?.secretName).toBe(
      oauthBrokerTokenSecretName('test-recipe')
    )
    expect(
      podSpec?.containers[0].volumeMounts?.find(m => m.name === BROKER_VOLUME)?.mountPath
    ).toBe('/var/run/clerum/oauth-broker')
    expect(
      podSpec?.containers[0].env?.find(e => e.name === 'RECIPE_OAUTH_BROKER_TOKEN_FILE')?.value
    ).toBe(BROKER_PATH)
  })

  it('mounts the broker token into an opted-in Job workload', () => {
    const recipe = bgRecipe([])
    const w: JobDef = {
      id: 'backfill',
      type: 'job',
      image: 'backfill:latest',
      oauthClientRefs: ['sf'],
    }
    recipe.spec.workloads = [w]
    const podSpec = buildJob(w, recipe).spec?.template.spec
    expect(podSpec?.volumes?.find(v => v.name === BROKER_VOLUME)?.secret?.secretName).toBe(
      oauthBrokerTokenSecretName('test-recipe')
    )
    expect(
      podSpec?.containers[0].volumeMounts?.find(m => m.name === BROKER_VOLUME)?.mountPath
    ).toBe('/var/run/clerum/oauth-broker')
    expect(
      podSpec?.containers[0].env?.find(e => e.name === 'RECIPE_OAUTH_BROKER_TOKEN_FILE')?.value
    ).toBe(BROKER_PATH)
  })
})

// ─── PriorityClass (three-tier scheme, stateless agents) ────────────

describe('priorityClassName — clerum-batch on non-transport workloads', () => {
  it('buildJob sets clerum-batch on the pod template', () => {
    const w: JobDef = { id: 'migrate', type: 'job', image: 'migrate:latest' }
    const job = buildJob(w, makeRecipe())
    expect(job.spec?.template.spec?.priorityClassName).toBe('clerum-batch')
  })

  it('buildCronJob sets clerum-batch on the job pod template', () => {
    const w: CronJobDef = { id: 'backup', type: 'cronjob', image: 'pg:15', schedule: '0 2 * * *' }
    const cj = buildCronJob(w, makeRecipe())
    expect(cj.spec?.jobTemplate.spec?.template.spec?.priorityClassName).toBe('clerum-batch')
  })

  it('buildDeployment (sandbox, no transport) sets clerum-batch', () => {
    const w: DeploymentDef = { id: 'app', type: 'deployment', image: 'app:latest' }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.priorityClassName).toBe('clerum-batch')
  })

  it('buildStatefulSet (sandbox, no transport) sets clerum-batch', () => {
    const w: StatefulSetDef = { id: 'db', type: 'statefulset', image: 'postgres:16-alpine' }
    const { statefulSet } = buildStatefulSet(w, makeRecipe())
    expect(statefulSet.spec?.template.spec?.priorityClassName).toBe('clerum-batch')
  })

  it('buildDaemonSet (sandbox, no transport) sets clerum-batch', () => {
    const w: DaemonSetDef = { id: 'agent', type: 'daemonset', image: 'agent:latest' }
    const ds = buildDaemonSet(w, makeRecipe())
    expect(ds.spec?.template.spec?.priorityClassName).toBe('clerum-batch')
  })

  it('transport (MCP serving) workloads stay UNCLASSED — priority 0 service tier', () => {
    const w: DeploymentDef = {
      id: 'mcp',
      type: 'deployment',
      image: 'mcp:latest',
      transport: { type: 'streamableHttp' },
    }
    const dep = buildDeployment(w, makeRecipe())
    expect(dep.spec?.template.spec?.priorityClassName).toBeUndefined()
  })
})
