/**
 * Host execution authorization gate (PR #932 / issue #986).
 *
 * The signed `host:tools:execute` scope is the only way a principal becomes
 * `nativeExecutionAllowed`, and this class binds that grant to one live Host
 * object: exact name, namespace and UID plus a positive generation. It never
 * grants execution from a Host name alone, never defaults a missing identity,
 * and never reads, logs or embeds token material.
 */
import type { VerifiedMcpHostPrincipal } from '../mcpApiAuthentication'

/** Minimal live server record the gate needs; the reader supplies it. */
export interface HostExecutionHostRecord {
  name: string
  namespace: string
  uid: string
  generation: number
  deletionTimestamp?: string
}

export type ReadHostRecord = (
  name: string,
  namespace: string
) => Promise<HostExecutionHostRecord | null>

export type HostExecutionAuthorizationErrorCode =
  | 'native_execution_not_authorized'
  | 'principal_invalid'
  | 'principal_expired'
  | 'host_not_found'
  | 'host_record_invalid'
  | 'host_identity_mismatch'
  | 'host_deleted'
  | 'host_uid_recreated'
  | 'host_generation_changed'

export class HostExecutionAuthorizationError extends Error {
  constructor(readonly code: HostExecutionAuthorizationErrorCode) {
    super(code)
    this.name = 'HostExecutionAuthorizationError'
  }
}

/** Immutable authority snapshot; carries no token, subject or credential. */
export interface HostExecutionBinding {
  readonly hostName: string
  readonly hostUid: string
  readonly namespace: string
  readonly generation: number
}

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const CANONICAL_UID = /^[A-Za-z0-9._:-]{1,128}$/

function fail(code: HostExecutionAuthorizationErrorCode): never {
  throw new HostExecutionAuthorizationError(code)
}

function isDns1123Label(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 63 && DNS1123_LABEL.test(value)
  )
}

/** Host names are DNS-1123 subdomains: <=253 characters of dot-joined labels. */
function isDns1123Subdomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 253 &&
    value.split('.').every(isDns1123Label)
  )
}

/**
 * The scope check comes first so an old credential token cannot reach any read,
 * and a malformed or absent identity field is rejected instead of defaulted.
 */
function requireGrantedPrincipal(principal: VerifiedMcpHostPrincipal, nowSeconds: number): void {
  if (principal.nativeExecutionAllowed !== true) fail('native_execution_not_authorized')
  if (
    !isDns1123Subdomain(principal.hostName) ||
    typeof principal.hostUid !== 'string' ||
    !CANONICAL_UID.test(principal.hostUid) ||
    !isDns1123Label(principal.namespace)
  ) {
    fail('principal_invalid')
  }
  requireUnexpiredPrincipal(principal, nowSeconds)
}

/**
 * Re-checked after every await: the live read can outlive the grant, and
 * authority must never be handed out or confirmed for an expired principal.
 */
function requireUnexpiredPrincipal(principal: VerifiedMcpHostPrincipal, nowSeconds: number): void {
  if (!Number.isSafeInteger(principal.expiresAt)) fail('principal_invalid')
  if (principal.expiresAt <= nowSeconds) fail('principal_expired')
}

/** A missing Host is a distinct failure from a Host that returns nonsense. */
function requireLiveHost(record: unknown): HostExecutionHostRecord {
  if (record === null || record === undefined) fail('host_not_found')
  if (typeof record !== 'object') fail('host_record_invalid')
  const candidate = record as Partial<HostExecutionHostRecord>
  if (
    typeof candidate.name !== 'string' ||
    candidate.name.length === 0 ||
    typeof candidate.namespace !== 'string' ||
    candidate.namespace.length === 0 ||
    typeof candidate.uid !== 'string' ||
    candidate.uid.length === 0
  ) {
    fail('host_record_invalid')
  }
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) <= 0) {
    fail('host_record_invalid')
  }
  return candidate as HostExecutionHostRecord
}

export class HostExecutionAuthorization {
  constructor(private readonly readHost: ReadHostRecord) {}

  /** Binds one granted principal to the live Host it names. */
  async authorize(principal: VerifiedMcpHostPrincipal): Promise<HostExecutionBinding> {
    requireGrantedPrincipal(principal, Math.floor(Date.now() / 1000))
    const live = requireLiveHost(await this.readHost(principal.hostName, principal.namespace))
    requireUnexpiredPrincipal(principal, Math.floor(Date.now() / 1000))
    if (live.deletionTimestamp !== undefined) fail('host_deleted')
    if (
      live.name !== principal.hostName ||
      live.namespace !== principal.namespace ||
      live.uid !== principal.hostUid
    ) {
      fail('host_identity_mismatch')
    }
    return Object.freeze({
      hostName: live.name,
      hostUid: live.uid,
      namespace: live.namespace,
      generation: live.generation,
    })
  }

  /**
   * Re-reads the live Host after any await, before an operation starts or a
   * result is published. UID and generation are compared, not resourceVersion:
   * heartbeat status writes churn resourceVersion without changing authority.
   */
  async revalidate(
    principal: VerifiedMcpHostPrincipal,
    binding: HostExecutionBinding
  ): Promise<void> {
    requireGrantedPrincipal(principal, Math.floor(Date.now() / 1000))
    if (
      binding.hostName !== principal.hostName ||
      binding.namespace !== principal.namespace ||
      binding.hostUid !== principal.hostUid
    ) {
      fail('host_identity_mismatch')
    }
    const live = requireLiveHost(await this.readHost(binding.hostName, binding.namespace))
    requireUnexpiredPrincipal(principal, Math.floor(Date.now() / 1000))
    if (live.deletionTimestamp !== undefined) fail('host_deleted')
    if (live.name !== binding.hostName || live.namespace !== binding.namespace) {
      fail('host_identity_mismatch')
    }
    if (live.uid !== binding.hostUid) fail('host_uid_recreated')
    if (live.generation !== binding.generation) fail('host_generation_changed')
  }
}
