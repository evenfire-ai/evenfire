import { SecretUpsertRequest } from '../types.js'

export const ALLOWED_SECRET_TYPES: readonly string[] = [
  'Opaque',
  'kubernetes.io/tls',
  'kubernetes.io/dockerconfigjson',
]

const INFRA_ANNOTATION_PREFIXES: readonly string[] = [
  'kubectl.kubernetes.io/',
  'kubernetes.io/',
  'meta.helm.sh/',
]

const PLATFORM_ANNOTATION_PREFIXES: readonly string[] = ['clerum.io/']

/**
 * Options for Secret write-path constraint validation.
 *
 * Only platform-internal routes (registry install/upgrade) should set
 * `allowPlatformAnnotations: true`. User-facing endpoints (admin/secrets,
 * recipe-secrets, communication-channel-credentials) MUST leave this unset
 * to prevent callers from claiming platform ownership via annotations.
 */
export interface SecretConstraintOptions {
  allowPlatformAnnotations?: boolean
}

function blockedPrefixes(opts?: SecretConstraintOptions): readonly string[] {
  return opts?.allowPlatformAnnotations
    ? INFRA_ANNOTATION_PREFIXES
    : [...INFRA_ANNOTATION_PREFIXES, ...PLATFORM_ANNOTATION_PREFIXES]
}

function secretTypeErrorMessage(type: string): string {
  return `Secret type "${type}" is not allowed; must be one of: ${ALLOWED_SECRET_TYPES.join(', ')}`
}

function annotationKeyErrorMessage(key: string, prefixes: readonly string[]): string {
  return `annotation key "${key}" is not allowed: keys starting with ${prefixes.map(p => `"${p}"`).join(' or ')} are reserved`
}

export class InvalidSecretTypeError extends Error {
  readonly status = 400
  readonly type: string
  constructor(type: string) {
    super(secretTypeErrorMessage(type))
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
  const prefixes = blockedPrefixes(opts)
  for (const prefix of prefixes) {
    if (key.startsWith(prefix)) {
      return annotationKeyErrorMessage(key, prefixes)
    }
  }
  return null
}

export function assertValidSecretType(type: string): void {
  if (invalidSecretTypeReason(type) !== null) {
    throw new InvalidSecretTypeError(type)
  }
}

export function assertValidSecretAnnotations(
  annotations: Record<string, string> | undefined,
  opts?: SecretConstraintOptions
): void {
  if (!annotations) return
  const prefixes = blockedPrefixes(opts)
  for (const key of Object.keys(annotations)) {
    if (dangerousAnnotationKeyReason(key, opts) !== null) {
      throw new DangerousAnnotationError(key, prefixes)
    }
  }
}

export function stripBlockedAnnotationKeys(
  annotations: Record<string, string> | undefined,
  opts?: SecretConstraintOptions
): Record<string, string> | undefined {
  if (!annotations) return annotations
  const prefixes = blockedPrefixes(opts)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(annotations)) {
    if (!prefixes.some(p => key.startsWith(p))) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function assertValidSecretConstraints(
  req: SecretUpsertRequest,
  opts?: SecretConstraintOptions
): void {
  // Type validation fires only on explicit type assignment. When req.type is
  // undefined, the write method defaults to 'Opaque' (create) or preserves
  // the existing type (update/merge) — no attacker-controlled type enters.
  if (req.type !== undefined) {
    assertValidSecretType(req.type)
  }
  assertValidSecretAnnotations(req.annotations, opts)
}
