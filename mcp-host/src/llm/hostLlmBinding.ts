export type HostPrimaryLlmBinding = {
  provider?: string | null
  name?: string | null
  connectionRef?: string | null
  secretRef?: string | null
}

export function assignedConnectionRef(connectionRef?: string | null): string {
  return connectionRef?.trim() || 'deployment-default'
}

export function hostPrimaryLlmBindingChanged(
  previous: HostPrimaryLlmBinding | null | undefined,
  next: HostPrimaryLlmBinding
): {
  providerChanged: boolean
  modelChanged: boolean
  secretRefChanged: boolean
  connectionRefChanged: boolean
} {
  return {
    providerChanged: previous?.provider !== next.provider,
    modelChanged: previous?.name !== next.name,
    secretRefChanged: previous?.secretRef !== next.secretRef,
    connectionRefChanged:
      assignedConnectionRef(previous?.connectionRef) !== assignedConnectionRef(next.connectionRef),
  }
}
