import { describe, expect, it } from 'vitest'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '../queryKeys'

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

describe('GFS generation authority keys', () => {
  it('preserves invalidation prefixes while separating every authority family by generation', () => {
    const scope = 'env:user:team'
    const builders = [
      (generation?: number | null) => desktopQueryKeys.gfsAccessState(scope, generation),
      (generation?: number | null) => desktopQueryKeys.gfsAccessible(scope, 'main', generation),
      ...[
        desktopQueryKeys.gfsChildren,
        desktopQueryKeys.gfsAffordances,
        desktopQueryKeys.gfsGrants,
        desktopQueryKeys.gfsShares,
        desktopQueryKeys.gfsInheritedAccess,
      ].map(
        builder => (generation?: number | null) => builder(scope, 'resource', 'main', generation)
      ),
    ]
    for (const build of builders) {
      expect(build(7)).toEqual([...build(), { sessionGeneration: 7 }])
      expect(build(7)).not.toEqual(build(8))
      expect(hasGfsSessionGeneration(build(7), 7)).toBe(true)
      expect(hasGfsSessionGeneration(build(7), 8)).toBe(false)
      expect(hasGfsSessionGeneration(build(), 7)).toBe(false)
    }
  })

  it('fails closed for unknown or malformed authority and changed scope or generation', () => {
    for (const invalid of [undefined, null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) {
      expect(isGfsSessionGeneration(invalid)).toBe(false)
    }
    expect(isGfsSessionGeneration(0)).toBe(true)
    expect(isGfsSessionAuthorityCurrent('scope', 7, 'scope', 7)).toBe(true)
    expect(isGfsSessionAuthorityCurrent('scope', null, 'scope', null)).toBe(false)
    expect(isGfsSessionAuthorityCurrent('scope', 7, 'scope', 8)).toBe(false)
    expect(isGfsSessionAuthorityCurrent('scope', 7, 'other', 7)).toBe(false)
  })
})
