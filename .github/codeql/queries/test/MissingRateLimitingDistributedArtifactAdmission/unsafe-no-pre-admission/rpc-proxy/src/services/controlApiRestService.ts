type Options = { artifactRead?: boolean }

async function fetchHostConnectionForPath(
  userId: string,
  hostRef: string,
  token: string,
  options: Options,
): Promise<{ url: string } | null> {
  const base = `/rpc/access/users/${userId}/mcp-hosts/${hostRef}`
  const endpoint = options.artifactRead ? `${base}/artifact-read` : base
  return fetch(endpoint, { headers: { authorization: `Bearer ${token}` } }) as never
}

export async function fetchArtifactReadHostConnectionFromControlApi(userId: string, hostRef: string, token: string) {
  return fetchHostConnectionForPath(userId, hostRef, token, { artifactRead: true })
}
