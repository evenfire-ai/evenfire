import { describe, expect, it } from 'vitest'
import { desktopQueryKeys } from '../queryKeys'

describe('desktopQueryKeys', () => {
  it('scopes GFS content and access-management caches by authenticated session', () => {
    const aliceScope = 'user-alice:team-red'
    const bobScope = 'user-bob:team-red'

    expect(desktopQueryKeys.gfsChildren(aliceScope, 'res-root', 'personal')).toEqual([
      'desktop-app',
      'gfs',
      aliceScope,
      'children',
      'personal',
      'res-root',
    ])
    expect(desktopQueryKeys.gfsAffordances(aliceScope, 'res-root', 'personal')).toEqual([
      'desktop-app',
      'gfs',
      aliceScope,
      'affordances',
      'personal',
      'res-root',
    ])
    expect(desktopQueryKeys.gfsChildren(aliceScope, 'res-root', 'personal')).not.toEqual(
      desktopQueryKeys.gfsChildren(bobScope, 'res-root', 'personal')
    )
    expect(desktopQueryKeys.gfsGrants(aliceScope, 'res-root', 'personal')).toEqual([
      'desktop-app',
      'gfs',
      aliceScope,
      'grants',
      'personal',
      'res-root',
    ])
    expect(desktopQueryKeys.gfsShares(aliceScope, 'res-root', 'personal')).toEqual([
      'desktop-app',
      'gfs',
      aliceScope,
      'shares',
      'personal',
      'res-root',
    ])
    expect(desktopQueryKeys.gfsShares(aliceScope, 'res-root', 'personal')).not.toEqual(
      desktopQueryKeys.gfsShares(bobScope, 'res-root', 'personal')
    )
  })

  it('exposes a stable GFS root for logout cache invalidation', () => {
    expect(desktopQueryKeys.gfsRoot).toEqual(['desktop-app', 'gfs'])
  })
})
