export type OidcProviderValidationReason =
  | 'provider-unavailable'
  | 'unsupported-provider-profile'
  | 'untrusted-endpoint'

export type OidcAttemptRejectionReason =
  | 'malformed-callback'
  | 'issuer-binding'
  | 'expired-or-replayed'
  | 'provider-response'
  | 'verified-token'

export type OidcProtocolOutcome =
  | 'provider-unavailable'
  | 'provider-incompatible'
  | 'attempt-rejected'
  | 'caller-cancelled'
  | 'credential-configuration'
  | 'persistence-failure'

export class OidcProviderUnavailableError extends Error {
  readonly category: OidcProtocolOutcome = 'provider-unavailable'

  constructor(
    readonly reason = 'transport',
    readonly retrySameAttempt = true
  ) {
    super('Configured OIDC provider is temporarily unavailable')
    this.name = 'OidcProviderUnavailableError'
  }
}

export class OidcProviderIncompatibleError extends Error {
  category: OidcProtocolOutcome = 'provider-incompatible'

  constructor(
    message = 'Configured OIDC provider does not meet the supported profile',
    readonly reason: OidcProviderValidationReason = 'unsupported-provider-profile'
  ) {
    super(message)
    this.name = 'OidcProviderIncompatibleError'
  }
}

export class OidcAttemptRejectedError extends OidcProviderIncompatibleError {
  override category: OidcProtocolOutcome = 'attempt-rejected'

  constructor(
    readonly attemptReason: OidcAttemptRejectionReason,
    message: string
  ) {
    super(message)
    this.name = 'OidcAttemptRejectedError'
  }
}

export class OidcCallerCancelledError extends Error {
  readonly category: OidcProtocolOutcome = 'caller-cancelled'

  constructor() {
    super('OIDC protocol operation was cancelled by its caller')
    this.name = 'OidcCallerCancelledError'
  }
}

export class OidcCredentialConfigurationError extends OidcProviderIncompatibleError {
  override category: OidcProtocolOutcome = 'credential-configuration'

  constructor() {
    super('OIDC provider credential is unavailable')
    this.name = 'OidcCredentialConfigurationError'
  }
}

export type OidcPersistenceOperation = 'insert' | 'preflight' | 'claim' | 'finalize'

export class OidcPersistenceFailure extends Error {
  readonly category: OidcProtocolOutcome = 'persistence-failure'

  constructor(
    readonly operation: OidcPersistenceOperation,
    readonly primaryOutcome?: OidcProtocolOutcome,
    readonly priorPersistenceOperation?: OidcPersistenceOperation,
    readonly retrySameAttempt = operation === 'insert' || operation === 'preflight'
  ) {
    super('OIDC protocol-attempt persistence failed')
    this.name = 'OidcPersistenceFailure'
  }
}

export type OidcProviderOperationFailure =
  | Readonly<{ kind: 'unavailable'; error: OidcProviderUnavailableError }>
  | Readonly<{ kind: 'incompatible'; error: OidcProviderIncompatibleError }>

export type OidcOperationContext = {
  signal?: AbortSignal
  transportFailure?: OidcProviderOperationFailure
}
