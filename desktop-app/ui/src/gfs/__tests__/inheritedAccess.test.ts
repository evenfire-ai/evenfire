// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveGfsInheritedAccess } from '../inheritedAccess'

/** Walk shape: file → team-docs (inheriting grants) → drive root (share). */
const FILE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FOLDER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ROOT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function resolveView(
  resourceId: string,
  name: string,
  parentResourceId: string | null,
  kind = 'directory'
) {
  return {
    drive: 'main',
    resourceId,
    parentResourceId,
    rid: resourceId.replace(/-/g, ''),
    gfsUri: `gfs://main/${resourceId}`,
    name,
    kind,
    pathCache: null,
    version: 1,
  }
}

function installClerumGfs(
  resolve: (uri: string) => Promise<ReturnType<typeof resolveView> | null>,
  listGrants: (resourceId: string) => Promise<unknown[]>,
  listShares: (resourceId: string) => Promise<unknown[]>
) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve,
        listGrants,
        listShares,
      },
    },
  })
}

describe('deriveGfsInheritedAccess', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('collects inheriting rows with their editable source folder, nearest first', async () => {
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) {
          return resolveView(ROOT_ID, '', null)
        }
        return null
      },
      async resourceId =>
        resourceId === FOLDER_ID
          ? [
              {
                id: 'g1',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'user', id: 'miguel' },
                permissions: ['read', 'write'],
                inherit: true,
              },
              {
                id: 'g2',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'user', id: 'marcela' },
                permissions: ['read'],
                inherit: false,
              },
            ]
          : [],
      async resourceId =>
        resourceId === ROOT_ID
          ? [
              {
                id: 's1',
                drive: 'main',
                resourceId: ROOT_ID,
                subject: { type: 'team', id: 'research' },
                permissions: ['read'],
                includeDescendants: true,
              },
            ]
          : []
    )

    const items = await deriveGfsInheritedAccess(FILE_ID)

    expect(items).toEqual([
      {
        subject: { type: 'user', id: 'miguel' },
        permissions: ['read', 'write'],
        inheritedFrom: ['team-docs'],
        source: {
          resourceId: FOLDER_ID,
          name: 'team-docs',
          permissions: ['read', 'write'],
          grantId: 'g1',
          shareIds: [],
        },
      },
      {
        subject: { type: 'team', id: 'research' },
        permissions: ['read'],
        // The root's empty name falls back to the drive label.
        inheritedFrom: ['main'],
        source: {
          resourceId: ROOT_ID,
          name: 'main',
          permissions: ['read'],
          grantId: null,
          shareIds: ['s1'],
        },
      },
    ])
  })

  it('stops the walk at an ancestor the caller cannot resolve and skips unviewable ACLs', async () => {
    const listGrants = vi.fn(async () => {
      throw new Error('403 manage_acl_required')
    })
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          throw new Error('403 forbidden')
        }
        return null
      },
      listGrants,
      async () => []
    )

    const items = await deriveGfsInheritedAccess(FILE_ID)

    expect(items).toEqual([])
    expect(listGrants).not.toHaveBeenCalled()
  })

  it('merges one subject inherited through multiple folders into a single strongest-source row', async () => {
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) {
          return resolveView(ROOT_ID, '', null)
        }
        return null
      },
      async resourceId =>
        resourceId === FOLDER_ID || resourceId === ROOT_ID
          ? [
              {
                id: `g-${resourceId}`,
                drive: 'main',
                resourceId,
                subject: { type: 'user', id: 'miguel' },
                permissions: resourceId === FOLDER_ID ? ['read', 'write'] : ['read', 'share'],
                inherit: true,
              },
            ]
          : [],
      async () => []
    )

    const items = await deriveGfsInheritedAccess(FILE_ID)

    expect(items).toHaveLength(1)
    const merged = items[0]
    expect(merged?.permissions.sort()).toEqual(['read', 'share', 'write'])
    expect(merged?.inheritedFrom).toEqual(['team-docs', 'main'])
    // The nearest editor folder is the editable source, even though the root
    // also grants read: editing the weaker ancestor could not change the
    // subject's effective access.
    expect(merged?.source).toEqual({
      resourceId: FOLDER_ID,
      name: 'team-docs',
      permissions: ['read', 'write'],
      grantId: `g-${FOLDER_ID}`,
      shareIds: [],
    })
  })

  it('unions a grant and a share for one subject on the same folder into one source', async () => {
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) {
          return resolveView(ROOT_ID, '', null)
        }
        return null
      },
      async resourceId =>
        resourceId === FOLDER_ID
          ? [
              {
                id: 'g1',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'user', id: 'miguel' },
                permissions: ['read', 'write'],
                inherit: true,
              },
            ]
          : [],
      async resourceId =>
        resourceId === FOLDER_ID
          ? [
              {
                id: 's1',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'user', id: 'miguel' },
                permissions: ['read'],
                includeDescendants: true,
              },
            ]
          : []
    )

    const items = await deriveGfsInheritedAccess(FILE_ID)

    expect(items).toHaveLength(1)
    expect(items[0]?.source).toEqual({
      resourceId: FOLDER_ID,
      name: 'team-docs',
      permissions: ['read', 'write'],
      grantId: 'g1',
      shareIds: ['s1'],
    })
  })
})
