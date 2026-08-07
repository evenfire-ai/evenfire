import { controlApiRequest } from '../controlApiClient.js'

export async function searchDirectory(teamId: string, q: string, sessionToken: string) {
  if (!q.trim()) {
    return { items: [] }
  }
  return controlApiRequest<{ items: unknown[] }>('GET', '/external/directory/search', {
    query: {
      teamId,
      q: q.trim(),
    },
    userSessionToken: sessionToken,
  })
}
