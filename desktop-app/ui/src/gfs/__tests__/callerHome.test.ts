import { describe, expect, it } from 'vitest'
import { GFS_MY_HOME_LABEL } from '@constants/gfsBrowser'
import {
  callerHomeDisplayName,
  callerHomeRootNode,
  isCallerHomeRoot,
  isInsideCallerHome,
} from '../callerHome'
import type { GfsCallerHome } from '../callerHome.types'

const HOME_ID = '0123456789abcdef0123456789abcdef'

const home = (overrides: Partial<NonNullable<GfsCallerHome>> = {}): GfsCallerHome => ({
  state: 'ready',
  drive: 'main',
  resourceId: HOME_ID,
  path: '/Users/fixture',
  ...overrides,
})

const inheritedFrom = (resourceId: string) => ({ sources: [{ resourceId }] })

describe('isCallerHomeRoot', () => {
  it.each<[string, GfsCallerHome, { resourceId: string; drive: string }, boolean]>([
    ['the ready home root on its drive', home(), { resourceId: HOME_ID, drive: 'main' }, true],
    ['the same id on another drive', home(), { resourceId: HOME_ID, drive: 'archive' }, false],
    ['another resource', home(), { resourceId: 'other', drive: 'main' }, false],
    ['a pending home', home({ state: 'pending' }), { resourceId: HOME_ID, drive: 'main' }, false],
    [
      'a home in conflict',
      home({ state: 'conflict' }),
      { resourceId: HOME_ID, drive: 'main' },
      false,
    ],
    ['a retired home', home({ state: 'retired' }), { resourceId: HOME_ID, drive: 'main' }, false],
    ['no home', null, { resourceId: HOME_ID, drive: 'main' }, false],
    [
      'a ready home without a drive',
      home({ drive: null }),
      { resourceId: HOME_ID, drive: 'main' },
      false,
    ],
    [
      'a ready home without a resource id',
      home({ resourceId: null }),
      { resourceId: HOME_ID, drive: 'main' },
      false,
    ],
  ])('answers %s', (_case, callerHome, resource, expected) => {
    expect(isCallerHomeRoot(callerHome, resource)).toBe(expected)
  })
})

describe('callerHomeRootNode', () => {
  const listedRoot = {
    resourceId: HOME_ID,
    rid: HOME_ID,
    gfsUri: `gfs://main/${HOME_ID}`,
    drive: 'main',
    parentResourceId: 'users-dir',
    name: 'fixture-user',
    kind: 'directory' as const,
    path: '/Users/fixture',
    version: 4,
    bytes: 0,
    sources: ['grant'],
    permissions: ['read', 'write', 'manage_acl'],
    coversDescendants: true,
  }

  it.each(['pending', 'conflict', 'retired'])('returns no root for a %s home', state => {
    expect(callerHomeRootNode(home({ state }), [listedRoot])).toBeNull()
  })

  it('returns no root without a home', () => {
    expect(callerHomeRootNode(null, [listedRoot])).toBeNull()
  })

  it('reuses the listed home row, named My home, with its own permissions', () => {
    const node = callerHomeRootNode(home(), [listedRoot])
    expect(node).toEqual({ ...listedRoot, name: GFS_MY_HOME_LABEL })
    expect(node).not.toBe(listedRoot)
  })

  it('builds the root from the home view while discovery does not list it', () => {
    const dashed = '01234567-89ab-cdef-0123-456789ABCDEF'
    expect(callerHomeRootNode(home({ resourceId: dashed }), [])).toEqual({
      resourceId: dashed,
      rid: HOME_ID,
      gfsUri: `gfs://main/${HOME_ID}`,
      drive: 'main',
      parentResourceId: null,
      name: GFS_MY_HOME_LABEL,
      kind: 'directory',
      path: '/Users/fixture',
      version: 0,
      bytes: 0,
    })
  })

  it('does not reuse a listed row with the home id on another drive', () => {
    const elsewhere = { ...listedRoot, drive: 'archive', gfsUri: `gfs://archive/${HOME_ID}` }
    const node = callerHomeRootNode(home(), [elsewhere])
    // Witness: a root is returned, built from the home view, not from the other drive's row.
    expect(node).toMatchObject({
      drive: 'main',
      parentResourceId: null,
      gfsUri: `gfs://main/${HOME_ID}`,
      name: GFS_MY_HOME_LABEL,
    })
    expect(node).not.toHaveProperty('permissions')
  })
})

describe('isInsideCallerHome', () => {
  it.each<
    [
      string,
      GfsCallerHome,
      { resourceId: string; drive: string },
      { sources: { resourceId: string }[] }[],
      boolean,
    ]
  >([
    ['the home root itself', home(), { resourceId: HOME_ID, drive: 'main' }, [], true],
    [
      'a resource with access inherited from the home root',
      home(),
      { resourceId: 'sub-folder', drive: 'main' },
      [inheritedFrom('parent-folder'), inheritedFrom(HOME_ID)],
      true,
    ],
    [
      'a resource whose inherited access never comes from the home root',
      home(),
      { resourceId: 'sub-folder', drive: 'main' },
      [inheritedFrom('parent-folder'), inheritedFrom('other-root')],
      false,
    ],
    [
      'a resource on another drive whose source has the home id',
      home(),
      { resourceId: 'sub-folder', drive: 'archive' },
      [inheritedFrom(HOME_ID)],
      false,
    ],
    [
      'a resource inherited from the root of a pending home',
      home({ state: 'pending' }),
      { resourceId: 'sub-folder', drive: 'main' },
      [inheritedFrom(HOME_ID)],
      false,
    ],
    [
      'a resource without a home',
      null,
      { resourceId: 'sub-folder', drive: 'main' },
      [inheritedFrom(HOME_ID)],
      false,
    ],
    [
      'a resource whose inherited access is not known yet',
      home(),
      { resourceId: 'sub-folder', drive: 'main' },
      [],
      false,
    ],
  ])('answers %s', (_case, callerHome, resource, inherited, expected) => {
    expect(isInsideCallerHome(callerHome, resource, inherited)).toBe(expected)
  })
})

describe('callerHomeDisplayName', () => {
  it.each<[string, GfsCallerHome, string, string]>([
    ['the ready home root', home(), HOME_ID, GFS_MY_HOME_LABEL],
    ['another resource', home(), 'other', 'fixture-folder'],
    ['the root of a home in conflict', home({ state: 'conflict' }), HOME_ID, 'fixture-folder'],
  ])('names %s', (_case, callerHome, resourceId, expected) => {
    expect(
      callerHomeDisplayName(callerHome, { resourceId, drive: 'main', name: 'fixture-folder' })
    ).toBe(expected)
  })
})
