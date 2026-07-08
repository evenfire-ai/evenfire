import type { GfsScope } from '../auth/gfsToken'
import type { HostParty } from '../auth/issuerSubjectClass'

export const GFS_READ_SCOPE: GfsScope = 'gfs.read'
export const GFS_WRITE_SCOPE: GfsScope = 'gfs.write'

const THIRD_PARTY_PROVISIONER_SCOPES = new Set<GfsScope>([GFS_READ_SCOPE, GFS_WRITE_SCOPE])

export function provisionerScopesAllowed(party: HostParty, scopes: readonly GfsScope[]): boolean {
  if (party !== '3rd') return true
  return scopes.every(scope => THIRD_PARTY_PROVISIONER_SCOPES.has(scope))
}
