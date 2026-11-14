export class ExternalSessionIssuanceUnavailableError extends Error {
  readonly status = 503
  readonly code = 'session_issuance_temporarily_unavailable'

  constructor() {
    super('A session could not be issued right now. Try again in two seconds.')
    this.name = 'ExternalSessionIssuanceUnavailableError'
  }
}
