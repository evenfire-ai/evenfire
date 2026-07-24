import { DEFAULT_GFSC_PORT, DEFAULT_INIT_IMAGE, GfsFactoryConfig } from './k8s/gfsFactory'
import { parseNodeLocalDnsCidr } from './k8sApiCidrs'

/**
 * Env-driven defaults for the gfs reconciler's factory config. Kept separate
 * from the gfsReconciler logic (which stays pure/unit-testable) and from the
 * SharedFileSystem config (gfs and SFS are distinct services). Every value is
 * reconciler-owned platform config — the GlobalFileSystem CRD never carries
 * image, pull policy, or resource knobs.
 */

function env(key: string, fallback: string): string {
  const value = process.env[key]
  return value !== undefined && value !== '' ? value : fallback
}

function envInt(key: string, fallback: number): number {
  const value = process.env[key]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`[gfs] ${key} must be a number, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function envPullPolicy(key: string): 'Always' | 'IfNotPresent' | 'Never' {
  const value = process.env[key]
  if (value === undefined || value === '') return 'IfNotPresent'
  if (value === 'Always' || value === 'IfNotPresent' || value === 'Never') return value
  // Fail loud on an explicit misconfiguration rather than silently defaulting.
  throw new Error(`[gfs] ${key} must be Always|IfNotPresent|Never, got ${JSON.stringify(value)}`)
}

export function gfsDefaultFactoryConfig(): GfsFactoryConfig {
  return {
    gfsNamespace: env('CONTEXT_MAPPER_GFS_NAMESPACE', 'gfs'),
    controlPlaneNamespace: env('CONTEXT_MAPPER_CONTROL_PLANE_NAMESPACE', 'control-plane'),
    firstPartyHostNamespace: env('CONTEXT_MAPPER_HOST_NAMESPACE', 'mcp-host'),
    workflowRecipeNamespace: env('CONTEXT_MAPPER_SANDBOX_NAMESPACE', 'sandbox-recipes'),
    postgresPodLabels: { app: env('CONTEXT_MAPPER_GFS_POSTGRES_APP_LABEL', 'control-postgres') },
    postgresPort: envInt('CONTEXT_MAPPER_GFS_POSTGRES_PORT', 5432),
    gfscImage: env('CONTEXT_MAPPER_GFSC_IMAGE', 'clerum/gfs-controller:test'),
    gfscImagePullPolicy: envPullPolicy('CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY'),
    gfscImagePullSecretName: process.env.CONTEXT_MAPPER_GFSC_IMAGE_PULL_SECRET || undefined,
    gfscPriorityClassName: process.env.CONTEXT_MAPPER_GFSC_PRIORITY_CLASS || undefined,
    gfscPort: envInt('CONTEXT_MAPPER_GFSC_PORT', DEFAULT_GFSC_PORT),
    gfscInitImage: env('CONTEXT_MAPPER_GFSC_INIT_IMAGE', DEFAULT_INIT_IMAGE),
    gfscResources: {
      requests: {
        memory: env('CONTEXT_MAPPER_GFSC_REQUEST_MEMORY', '128Mi'),
        cpu: env('CONTEXT_MAPPER_GFSC_REQUEST_CPU', '100m'),
      },
      limits: {
        memory: env('CONTEXT_MAPPER_GFSC_LIMIT_MEMORY', '256Mi'),
        cpu: env('CONTEXT_MAPPER_GFSC_LIMIT_CPU', '500m'),
      },
    },
    jwtPublicKeyConfigMapName: env('CONTEXT_MAPPER_GFS_JWT_CONFIGMAP', 'gfs-config'),
    jwtPublicKeyConfigMapKey: env('CONTEXT_MAPPER_GFS_JWT_CONFIGMAP_KEY', 'jwt-public-key'),
    pgSecretName: env('CONTEXT_MAPPER_GFS_PG_SECRET', 'gfs-controller-db'),
    pgSecretKey: env('CONTEXT_MAPPER_GFS_PG_SECRET_KEY', 'connection-string'),
    readerPgSecretName: env(
      'CONTEXT_MAPPER_GFS_READER_PG_SECRET',
      'gfs-controller-reader-db'
    ),
    readerPgSecretKey: env('CONTEXT_MAPPER_GFS_READER_PG_SECRET_KEY', 'connection-string'),
    driveName: env('CONTEXT_MAPPER_GFS_DRIVE_NAME', 'main'),
    tokenAudience: env('CONTEXT_MAPPER_GFS_TOKEN_AUDIENCE', 'gfs-controller'),
    syncCopyMaxObjects: process.env.GFS_SYNC_COPY_MAX_OBJECTS,
    syncCopyMaxBytes: process.env.GFS_SYNC_COPY_MAX_BYTES,
    syncCopyTimeoutMs: process.env.GFS_SYNC_COPY_TIMEOUT_MS,
    nodeLocalDnsCidr: parseNodeLocalDnsCidr(env('CONTEXT_MAPPER_NODELOCAL_DNS_CIDR', '')),
  }
}
