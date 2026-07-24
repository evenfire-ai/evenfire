import type { GfsScope } from '../auth/gfsToken'
import type { HostParty } from '../auth/issuerSubjectClass'

export const GFS_READ_SCOPE: GfsScope = 'gfs.read'
export const GFS_WRITE_SCOPE: GfsScope = 'gfs.write'

const HOST_PROVISIONER_SCOPES = new Set<GfsScope>([GFS_READ_SCOPE, GFS_WRITE_SCOPE])

export function provisionerScopesAllowed(_party: HostParty, scopes: readonly GfsScope[]): boolean {
  // Both provisioners mint host credentials. Host authority is deliberately
  // limited to the data plane: read and write. Governance remains on the
  // operator/user plane, so neither first-party HCC agents nor third-party WRC
  // workloads can mint delete/share/manage-acl authority into their runtime.
  return scopes.every(scope => HOST_PROVISIONER_SCOPES.has(scope))
}
