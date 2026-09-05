export type HostPrimaryLlmBinding = {
  provider?: string | null
  name?: string | null
  connectionRef?: string | null
  secretRef?: string | null
}

/** Fail-closed Host sentinel. Empty/missing is not the reserved grant. */
export const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned' as const

export function assignedConnectionRef(connectionRef?: string | null): string {
  const trimmed = typeof connectionRef === 'string' ? connectionRef.trim() : ''
  return trimmed || CODEX_UNASSIGNED_CONNECTION_KEY
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
