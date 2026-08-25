import type { SecretPreconditions, SecretUpsertRequest } from '../types.js'
import type { SecretConstraintOptions } from './secretConstraints.js'

/** The subset of a Kubernetes Secret that callers are allowed to observe. */
export interface SecretResource {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: Array<unknown>
    finalizers?: string[]
  }
  type?: string
  immutable?: boolean
  data?: Record<string, string>
  stringData?: Record<string, string>
}

/** A server-confirmed Secret identity and its restorable state. */
export interface SecretSnapshot {
  name: string
  namespace: string
  uid: string
  resourceVersion: string
  type?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<unknown>
  finalizers?: string[]
  immutable?: boolean
  data?: Record<string, string>
  stringData?: Record<string, string>
}

/** Typed boundary for every Secret mutation used by control-api. */
export interface SecretRepository {
  listSecrets(namespace?: string): Promise<unknown[]>
  getSecret(name: string, namespace?: string): Promise<SecretResource>
  createSecret(req: SecretUpsertRequest, opts?: SecretConstraintOptions): Promise<SecretSnapshot>
  updateSecret(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions,
    opts?: SecretConstraintOptions
  ): Promise<SecretSnapshot>
  mergeSecret(req: SecretUpsertRequest, opts?: SecretConstraintOptions): Promise<SecretSnapshot>
  removeSecretKey(req: { name: string; namespace?: string; key: string }): Promise<SecretSnapshot>
  deleteSecret(
    name: string,
    namespace?: string,
    precondition?: SecretPreconditions
  ): Promise<unknown>
}

/** Convert an apiserver response into the only mutation result callers may use for CAS. */
export function toSecretSnapshot(
  raw: unknown,
  fallbackName: string,
  fallbackNamespace: string
): SecretSnapshot {
  const source = (raw ?? {}) as SecretResource
  const metadata = source.metadata
  if (typeof metadata?.uid !== 'string' || typeof metadata.resourceVersion !== 'string') {
    throw Object.assign(
      new Error(`Secret/${fallbackName} did not return a complete Kubernetes identity`),
      { status: 503, code: 'secret_identity_unavailable' }
    )
  }

  return {
    name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : fallbackName,
    namespace:
      typeof metadata.namespace === 'string' && metadata.namespace.trim()
        ? metadata.namespace
        : fallbackNamespace,
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
    ...(typeof source.type === 'string' ? { type: source.type } : {}),
    ...(metadata.labels ? { labels: metadata.labels } : {}),
    ...(metadata.annotations ? { annotations: metadata.annotations } : {}),
    ...(metadata.ownerReferences ? { ownerReferences: metadata.ownerReferences } : {}),
    ...(metadata.finalizers ? { finalizers: metadata.finalizers } : {}),
    ...(typeof source.immutable === 'boolean' ? { immutable: source.immutable } : {}),
    ...(source.data ? { data: source.data } : {}),
    ...(source.stringData ? { stringData: source.stringData } : {}),
  }
}
