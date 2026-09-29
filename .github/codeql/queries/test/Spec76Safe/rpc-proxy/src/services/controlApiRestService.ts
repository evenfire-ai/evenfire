export type LegacySessionAdmissionResult = { allowed: boolean }

export async function admitLegacySessionCreation(
  rpcAccessToken: string
): Promise<LegacySessionAdmissionResult> {
  const response = await fetch(`${controlApiBaseUrl()}/internal/rpc-proxy/legacy-session-admission`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcAccessToken}` },
  })
  return { allowed: response.status === 204 }
}

function controlApiBaseUrl(): string {
  return 'http://control-api'
}
