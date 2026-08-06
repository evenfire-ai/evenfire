import type { IdentityProviderConnection } from './identityProviders.types'

export function identityProviderConnectionLabel(connection: IdentityProviderConnection): string {
  return connection.displayName || connection.directoryTenantId
}
