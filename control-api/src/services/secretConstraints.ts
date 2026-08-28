import { SecretUpsertRequest } from '../types.js'
import { REGISTRY_OPERATION_ID_ANNOTATION } from './registryMutation.js'

export const ALLOWED_SECRET_TYPES: readonly string[] = [
  'Opaque',
  'kubernetes.io/tls',
  'kubernetes.io/dockerconfigjson',
]

/**
 * Existing Secret types are normally safe to preserve. These are the narrow
 * exceptions whose lifecycle is owned by Kubernetes bootstrap controllers or
 * Helm, so control-api must not mutate their data or metadata. In particular,
 * basic-auth, ssh-auth, and custom types remain valid preserved state.
 */
const NON_MUTABLE_PRESERVED_SECRET_TYPES: readonly string[] = [
  'kubernetes.io/service-account-token',
  'bootstrap.kubernetes.io/token',
  'helm.sh/release.v1',
]

const INFRA_ANNOTATION_PREFIXES: readonly string[] = [
  'kubectl.kubernetes.io/',
  'kubernetes.io/',
  'meta.helm.sh/',
]

const PLATFORM_ANNOTATION_PREFIXES: readonly string[] = ['clerum.io/']

export function isInfrastructureAnnotationKey(key: string): boolean {
  return INFRA_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix))
}

export function isPlatformAnnotationKey(key: string): boolean {
  return PLATFORM_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix))
}

/** Platform metadata that a public rotation route may preserve, but never set. */
export const REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS = [
  'clerum.io/catalog-id',
  'clerum.io/catalog-version',
] as const

/** Operation marker used only by the internal Registry mutation capability. */
export const REGISTRY_SECRET_OPERATION_ID_ANNOTATION = REGISTRY_OPERATION_ID_ANNOTATION

/** Platform keys a public Registry credential rotation may preserve, never assign. */
export const REGISTRY_SECRET_ROTATION_PRESERVED_ANNOTATION_KEYS = [
  ...REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS,
  REGISTRY_SECRET_OPERATION_ID_ANNOTATION,
] as const

/** Additional metadata owned by the internal Registry credential writer. */
const REGISTRY_CREDENTIAL_WRITABLE_ANNOTATION_KEYS = [
  ...REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS,
  'clerum.io/trust-level',
  REGISTRY_SECRET_OPERATION_ID_ANNOTATION,
] as const

export type SecretWriteCapability = 'registryCredential' | 'registryPullSecret'

const CAPABILITY_ANNOTATION_KEYS: Record<SecretWriteCapability, readonly string[]> = {
  registryCredential: REGISTRY_CREDENTIAL_WRITABLE_ANNOTATION_KEYS,
  registryPullSecret: ['clerum.io/pull-key-fingerprint'],
}

/**
 * Options for Secret write-path constraint validation.
 *
 * Platform-internal writers must declare the narrow capability that owns the
 * exact platform annotation keys they need. User-facing endpoints MUST leave
 * this unset to prevent callers from claiming platform ownership.
 */
export interface SecretConstraintOptions {
  capability?: SecretWriteCapability
  /** Exact platform keys allowed only when validating already-persisted metadata. */
  allowExistingPlatformAnnotationKeys?: readonly string[]
}

function allowedPlatformAnnotationKeys(opts?: SecretConstraintOptions): ReadonlySet<string> {
  return new Set(opts?.capability ? CAPABILITY_ANNOTATION_KEYS[opts.capability] : [])
}

function isBlockedAnnotationKey(key: string, opts?: SecretConstraintOptions): boolean {
  if (INFRA_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix))) return true
  return (
    PLATFORM_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix)) &&
    !allowedPlatformAnnotationKeys(opts).has(key)
  )
}

function reservedPrefixes(): readonly string[] {
  return [...INFRA_ANNOTATION_PREFIXES, ...PLATFORM_ANNOTATION_PREFIXES]
}

function secretTypeErrorMessage(type: string): string {
  return `Secret type "${type}" is not allowed; must be one of: ${ALLOWED_SECRET_TYPES.join(', ')}`
}

function managedSecretTypeErrorMessage(type: string): string {
  return `Secret type "${type}" is managed by Kubernetes or Helm and cannot be mutated`
}

function annotationKeyErrorMessage(key: string, prefixes: readonly string[]): string {
  return `annotation key "${key}" is not allowed: keys starting with ${prefixes.map(p => `"${p}"`).join(' or ')} are reserved`
}

export class InvalidSecretTypeError extends Error {
  readonly status = 400
  readonly type: string
  constructor(type: string, message = secretTypeErrorMessage(type)) {
    super(message)
    this.name = 'InvalidSecretTypeError'
    this.type = type
  }
}

export class DangerousAnnotationError extends Error {
  readonly status = 400
  readonly annotationKey: string
  constructor(key: string, prefixes: readonly string[]) {
    super(annotationKeyErrorMessage(key, prefixes))
    this.name = 'DangerousAnnotationError'
    this.annotationKey = key
  }
}

export function invalidSecretTypeReason(type: string): string | null {
  if (!ALLOWED_SECRET_TYPES.includes(type)) {
    return secretTypeErrorMessage(type)
  }
  return null
}

export function dangerousAnnotationKeyReason(
  key: string,
  opts?: SecretConstraintOptions
): string | null {
  return isBlockedAnnotationKey(key, opts)
    ? annotationKeyErrorMessage(key, reservedPrefixes())
    : null
}

export function assertValidSecretType(type: string): void {
  if (invalidSecretTypeReason(type) !== null) {
    throw new InvalidSecretTypeError(type)
  }
}

export function assertMutablePreservedSecretType(type: string | undefined): void {
  if (type !== undefined && NON_MUTABLE_PRESERVED_SECRET_TYPES.includes(type)) {
    throw new InvalidSecretTypeError(type, managedSecretTypeErrorMessage(type))
  }
}

export function assertValidSecretAnnotations(
  annotations: Record<string, string> | undefined,
  opts?: SecretConstraintOptions,
  existingAnnotations?: Record<string, string>
): void {
  if (!annotations) return
  for (const key of Object.keys(annotations)) {
    const isUnchangedInfrastructureMetadata =
      isInfrastructureAnnotationKey(key) && existingAnnotations?.[key] === annotations[key]
    const isUnchangedPlatformMetadata =
      isPlatformAnnotationKey(key) && existingAnnotations?.[key] === annotations[key]
    if (
      !isUnchangedInfrastructureMetadata &&
      !isUnchangedPlatformMetadata &&
      isBlockedAnnotationKey(key, opts)
    ) {
      throw new DangerousAnnotationError(key, reservedPrefixes())
    }
  }
}

export function assertValidSecretConstraints(
  req: SecretUpsertRequest,
  opts?: SecretConstraintOptions,
  existingAnnotations?: Record<string, string>
): void {
  // The allowlist applies only to an explicit caller assignment. A preserved
  // type is checked separately against the narrow controller-owned denylist.
  if (req.type !== undefined) {
    assertValidSecretType(req.type)
  }
  assertValidSecretAnnotations(req.annotations, opts, existingAnnotations)
}

/**
 * Resolve the annotation map a full replacement is allowed to leave behind.
 * Requested reserved keys must match the live value; omitted protected keys
 * are carried forward. Caller-owned keys retain full-replace semantics.
 */
export function resolveSecretAnnotationsForReplace(
  existingAnnotations: Record<string, string> | undefined,
  requestedAnnotations: Record<string, string> | undefined,
  opts?: SecretConstraintOptions
): Record<string, string> | undefined {
  if (requestedAnnotations === undefined) {
    return existingAnnotations
  }

  assertValidSecretAnnotations(requestedAnnotations, opts, existingAnnotations)

  const resolved: Record<string, string> = { ...requestedAnnotations }
  for (const [key, value] of Object.entries(existingAnnotations ?? {})) {
    if (isInfrastructureAnnotationKey(key)) {
      if (requestedAnnotations[key] === undefined) resolved[key] = value
      continue
    }

    if (isPlatformAnnotationKey(key) && requestedAnnotations[key] === undefined) {
      const allowPreserve = opts?.allowExistingPlatformAnnotationKeys?.includes(key)
      const capabilityOwnsKey = allowedPlatformAnnotationKeys(opts).has(key)
      // Unknown/future platform metadata is immutable to public writers and is
      // carried forward. A declared capability may explicitly remove only its
      // own keys; a preservation allowlist keeps the narrow partial-writer
      // contract for the public rotation path.
      if (allowPreserve || !capabilityOwnsKey) resolved[key] = value
    }
  }
  return resolved
}
