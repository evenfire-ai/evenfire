export class OidcProviderUnavailableError extends Error {
  constructor() {
    super('Configured OIDC provider is temporarily unavailable')
    this.name = 'OidcProviderUnavailableError'
  }
}

export class OidcProviderIncompatibleError extends Error {
  constructor(reason = 'Configured OIDC provider does not meet the supported profile') {
    super(reason)
    this.name = 'OidcProviderIncompatibleError'
  }
}

export type OidcProviderOperationFailure =
  | Readonly<{ kind: 'unavailable'; error: OidcProviderUnavailableError }>
  | Readonly<{ kind: 'incompatible'; error: OidcProviderIncompatibleError }>

export type OidcOperationContext = {
  signal?: AbortSignal
  transportFailure?: OidcProviderOperationFailure
}
