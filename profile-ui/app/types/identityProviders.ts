export type PublicIdentityProviderConnection = {
  id: string
  provider: 'microsoft'
  displayName: string
}

export type IdentityProviderListResponse = {
  items: PublicIdentityProviderConnection[]
}
