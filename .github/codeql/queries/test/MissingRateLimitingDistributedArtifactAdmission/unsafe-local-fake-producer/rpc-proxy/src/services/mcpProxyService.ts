import { fetchArtifactReadHostConnectionFromControlApi } from './controlApiRestService.js'

export async function resolveArtifactReadHostConnectionForUser(userId: string, hostRef: string, token: string) {
  return fetchArtifactReadHostConnectionFromControlApi(userId, hostRef, token)
}
