import { SecretUpsertRequest } from '../types.js'

export const ALLOWED_SECRET_TYPES: readonly string[] = [
  'Opaque',
  'kubernetes.io/tls',
  'kubernetes.io/dockerconfigjson',
]

const INFRA_ANNOTATION_PREFIXES: readonly string[] = ['kubectl.kubernetes.io/', 'kubernetes.io/']

const PLATFORM_ANNOTATION_PREFIXES: readonly string[] = ['clerum.io/']

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

export function assertValidSecretConstraints(
  req: SecretUpsertRequest,
  opts?: SecretConstraintOptions
): void {
  if (req.type !== undefined) {
    assertValidSecretType(req.type)
  }
  assertValidSecretAnnotations(req.annotations, opts)
}
