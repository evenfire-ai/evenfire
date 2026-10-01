export type LegacySessionAdmissionResult = { allowed: boolean }

export async function admitLegacySessionCreation(
  rpcAccessToken: string
): Promise<LegacySessionAdmissionResult> {
  const response = await fetch(
    `${controlApiBaseUrl()}/internal/rpc-proxy/legacy-session-admission`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcAccessToken}` },
    }
  )
  return { allowed: response.status === 204 }
}

function controlApiBaseUrl(): string {
  return 'http://control-api'
}

export async function fetchArtifactReadHostConnectionFromControlApi(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<unknown> {
  return fetchHostConnectionForPath(userId, hostRef, rpcAccessToken, {
    ...options,
    artifactRead: true,
  })
}

export async function requestHostRpcAdmission(
  subject: string,
  hostRef: string,
  rpcAccessToken: string
): Promise<any> {
  return fetch(
    `http://control-api/rpc/access/users/${encodeURIComponent(subject)}/mcp-hosts/${encodeURIComponent(hostRef)}/host-rpc-admission`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcAccessToken}` },
    }
  )
}

async function fetchHostConnectionForPath(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: { fetchImpl?: typeof fetch; artifactRead?: boolean } = {}
): Promise<unknown> {
  const hostAccessPath = `http://control-api/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${encodeURIComponent(hostRef)}`
  return (options.fetchImpl ?? fetch)(
    options.artifactRead ? `${hostAccessPath}/artifact-read` : hostAccessPath,
    { headers: { authorization: `Bearer ${rpcAccessToken}` } }
  )
}
