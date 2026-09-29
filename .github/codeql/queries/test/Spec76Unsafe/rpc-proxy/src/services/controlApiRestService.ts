export async function admitLegacySessionCreation(rpcAccessToken: string): Promise<any> {
  return fetch(`${controlApiBaseUrl()}/internal/rpc-proxy/wrong-admission-endpoint`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcAccessToken}` },
  })
}

function controlApiBaseUrl(): string {
  return 'http://control-api'
}
