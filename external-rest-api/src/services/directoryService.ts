import { controlApiRequest } from '../controlApiClient.js'

export async function searchDirectory(
  teamId: string,
  q: string,
  sessionToken: string,
  cursor?: string
) {
  if (!q.trim()) {
    return { items: [] }
  }
  return controlApiRequest<{ items: unknown[] }>('GET', '/external/directory/search', {
    query: {
      teamId,
      q: q.trim(),
      cursor,
    },
    userSessionToken: sessionToken,
  })
}
