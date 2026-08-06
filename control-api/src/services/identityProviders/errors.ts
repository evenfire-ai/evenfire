export class IdentityProviderError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'IdentityProviderError'
    this.status = status
  }
}

export function identityProviderError(status: number, message: string): IdentityProviderError {
  return new IdentityProviderError(status, message)
}
