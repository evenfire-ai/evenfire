// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  grantsListPage,
  listGrantsFailureMessage,
  listSharesFailureMessage,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  sharesListPage,
} from '../__fixtures__/gfsProducerFixtures'
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
  resolve: (uri: string) => Promise<Awaited<ReturnType<typeof resolveResource>> | null>,
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

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('complete')
    expect(result.items).toEqual([
      {
        subject: { type: 'user', id: 'miguel' },
        permissions: ['read', 'write'],
        inheritedFrom: ['team-docs'],
        sources: [
          {
            resourceId: FOLDER_ID,
            name: 'team-docs',
            permissions: ['read', 'write'],
            grantId: 'g1',
            shareIds: [],
            grantPermissions: ['read', 'write'],
            grantInherit: true,
            shareEntries: [],
          },
        ],
      },
      {
        subject: { type: 'team', id: 'research' },
        permissions: ['read'],
        // The root's empty name falls back to the drive label.
        inheritedFrom: ['main'],
        sources: [
          {
            resourceId: ROOT_ID,
            name: 'main',
            permissions: ['read'],
            grantId: null,
            shareIds: ['s1'],
            grantPermissions: null,
            grantInherit: null,
            shareEntries: [{ rowId: 's1', permissions: ['read'], includeDescendants: true }],
          },
        ],
      },
    ])
  })

  // R1-H3: a 403 resolve above the readable chain is an expected privacy
  // boundary, not a derivation failure — the rows folded from the readable
  // chain are retained and the coverage tells the UI which notice to show.
  it('retains known rows with read-boundary coverage when resolve 403s above the readable chain', async () => {
    const rootDenied = await resolveDeniedMessage(`gfs://main/${ROOT_ID.replace(/-/g, '')}`, {
      code: 'forbidden',
      message: 'not authorized to read this resource',
    })
    const listGrants = vi.fn(async () =>
      grantsListPage([
        {
          id: 'g1',
          drive: 'main',
          resourceId: FOLDER_ID,
          subject: { type: 'user', id: 'miguel' },
          permissions: ['read', 'write'],
          inherit: true,
        },
      ])
    )
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        throw new Error(rootDenied)
      },
      listGrants,
      async () => sharesListPage([])
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('read-boundary')
    expect(result.items).toEqual([
      {
        subject: { type: 'user', id: 'miguel' },
        permissions: ['read', 'write'],
        inheritedFrom: ['team-docs'],
        sources: [
          {
            resourceId: FOLDER_ID,
            name: 'team-docs',
            permissions: ['read', 'write'],
            grantId: 'g1',
            shareIds: [],
            grantPermissions: ['read', 'write'],
            grantInherit: true,
            shareEntries: [],
          },
        ],
      },
    ])
    // The unreadable boundary is never asked for its ACL rows.
    expect(listGrants).toHaveBeenCalledTimes(1)
  })

  // R1-H3: grants and shares settle INDEPENDENTLY. A 403 on one family keeps
  // the other family's rows, and the walk continues upward because the
  // readable ancestor's parent id is already known from its resolve.
  it('folds the healthy family and continues past an ACL-denied family', async () => {
    const folder = await resolveResource(
      resolvedDirectory(FOLDER_ID, 'team-docs', { parentResourceId: ROOT_ID })
    )
    const root = await resolveResource(resolvedDirectory(ROOT_ID, '', { parentResourceId: null }))
    const grantsDenied = await listGrantsFailureMessage()
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveResource(
            resolvedDirectory(FILE_ID, 'report.md', { parentResourceId: FOLDER_ID })
          )
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) return folder
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) return root
        return null
      },
      async resourceId => {
        if (resourceId === FOLDER_ID) throw new Error(grantsDenied)
        return grantsListPage([
          {
            id: 'g-root',
            drive: 'main',
            resourceId: ROOT_ID,
            subject: { type: 'user', id: 'marcela' },
            permissions: ['read'],
            inherit: true,
          },
        ])
      },
      async resourceId =>
        resourceId === FOLDER_ID
          ? sharesListPage([
              {
                id: 's1',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'team', id: 'research' },
                permissions: ['read'],
                includeDescendants: true,
              },
            ])
          : sharesListPage([])
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('acl-limited')
    // The folder's SHARES survived its grants denial; the root was still
    // visited because the folder's parent was known from its resolve.
    expect(result.items).toEqual([
      {
        subject: { type: 'team', id: 'research' },
        permissions: ['read'],
        inheritedFrom: ['team-docs'],
        sources: [
          {
            resourceId: FOLDER_ID,
            name: 'team-docs',
            permissions: ['read'],
            grantId: null,
            shareIds: ['s1'],
            grantPermissions: null,
            grantInherit: null,
            shareEntries: [{ rowId: 's1', permissions: ['read'], includeDescendants: true }],
          },
        ],
      },
      {
        subject: { type: 'user', id: 'marcela' },
        permissions: ['read'],
        inheritedFrom: ['main'],
        sources: [
          {
            resourceId: ROOT_ID,
            name: 'main',
            permissions: ['read'],
            grantId: 'g-root',
            shareIds: [],
            grantPermissions: ['read'],
            grantInherit: true,
            shareEntries: [],
          },
        ],
      },
    ])
  })

  it('stops with unavailable coverage but retained rows when an ACL read is rate limited', async () => {
    const grantsLimited = await listGrantsFailureMessage(429, {
      code: 'rate_limited',
      message: 'too many requests',
    })
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        return null
      },
      async () => {
        throw new Error(grantsLimited)
      },
      async resourceId =>
        resourceId === FOLDER_ID
          ? [
              {
                id: 's1',
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: { type: 'team', id: 'research' },
                permissions: ['read'],
                includeDescendants: true,
              },
            ]
          : []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('unavailable')
    expect(result.items).toEqual([
      {
        subject: { type: 'team', id: 'research' },
        permissions: ['read'],
        inheritedFrom: ['team-docs'],
        sources: [
          {
            resourceId: FOLDER_ID,
            name: 'team-docs',
            permissions: ['read'],
            grantId: null,
            shareIds: ['s1'],
            grantPermissions: null,
            grantInherit: null,
            shareEntries: [{ rowId: 's1', permissions: ['read'], includeDescendants: true }],
          },
        ],
      },
    ])
  })

  it.each(['resolve', 'grants', 'shares'] as const)(
    'rethrows a session 401 from %s instead of classifying it as a boundary',
    async family => {
      const message =
        family === 'resolve'
          ? await resolveDeniedMessage(
              `gfs://main/${FOLDER_ID.replace(/-/g, '')}`,
              {
                code: 'unauthorized',
                message: 'session rejected',
              },
              401
            )
          : family === 'grants'
            ? await listGrantsFailureMessage(401, {
                code: 'unauthorized',
                message: 'session rejected',
              })
            : await listSharesFailureMessage(401, {
                code: 'unauthorized',
                message: 'session rejected',
              })
      installClerumGfs(
        async uri => {
          if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
            return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
          }
          throw new Error(message)
        },
        async () => {
          throw new Error(message)
        },
        async () => {
          throw new Error(message)
        }
      )

      await expect(deriveGfsInheritedAccess(FILE_ID)).rejects.toThrow('httpStatus=401')
    }
  )

  it('reports a parent cycle as unavailable without losing folded rows', async () => {
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', FOLDER_ID, 'file')
        }
        if (uri.endsWith(FOLDER_ID.replace(/-/g, ''))) {
          // ROOT's parent points back at FOLDER — a corrupted chain.
          return resolveView(FOLDER_ID, 'team-docs', ROOT_ID)
        }
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) {
          return resolveView(ROOT_ID, '', FOLDER_ID)
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
                permissions: ['read'],
                inherit: true,
              },
            ]
          : [],
      async () => []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('unavailable')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.subject).toEqual({ type: 'user', id: 'miguel' })
  })

  it('reports the depth cap instead of inventing root completion', async () => {
    // An endless parent chain (depth0 → depth1 → …) never repeats and never
    // reaches a null parent: the walk must report the cap, never 'complete'.
    // Ids carry no dashes — the walk rid-strips them before resolving.
    const targetDepthParent = 'depth0'
    installClerumGfs(
      async uri => {
        const rid = uri.split('/').at(-1) ?? ''
        if (rid === FILE_ID.replace(/-/g, '')) {
          return resolveView(FILE_ID, 'report.md', targetDepthParent, 'file')
        }
        const match = /^depth(\d+)$/.exec(rid)
        if (match) return resolveView(rid, `folder-${match[1]}`, `depth${Number(match[1]) + 1}`)
        return null
      },
      async () => [],
      async () => []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('unavailable')
    expect(result.items).toEqual([])
  })

  // RP-021 — the depth cap must not hide behind an earlier denial. The
  // shared precedence ranks "denied" first, so a walk that was denied AND
  // truncated reported the denial and never said that the rows above the cap
  // were never seen.
  it('reports the depth cap even when an earlier ancestor was ACL-denied', async () => {
    const targetDepthParent = 'depth0'
    const grantsDenied = await listGrantsFailureMessage()
    installClerumGfs(
      async uri => {
        const rid = uri.split('/').at(-1) ?? ''
        if (rid === FILE_ID.replace(/-/g, '')) {
          return resolveView(FILE_ID, 'report.md', targetDepthParent, 'file')
        }
        const match = /^depth(\d+)$/.exec(rid)
        if (match) return resolveView(rid, `folder-${match[1]}`, `depth${Number(match[1]) + 1}`)
        return null
      },
      async resourceId => {
        // The nearest ancestor's grant listing is denied: a quiet ACL
        // boundary. The walk continues upward and hits the depth cap.
        if (resourceId === 'depth0') throw new Error(grantsDenied)
        return []
      },
      async () => []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    // The cap is the honest terminal state: rows above it were never seen.
    expect(result.coverage).toBe('unavailable')
  })

  // RP-008 — the status that decided the response is the VETTED one the
  // main process appended. A copy carried by the server's own body sits
  // ahead of it, and the shared reader takes the FIRST `httpStatus=` token
  // it finds — so a 500 whose body mentioned another status was classified
  // by that other status.
  it('classifies a read failure by the vetted status, not by one in the body', async () => {
    const bodyMentionsForbidden =
      '500 Internal Server Error: {"detail":"httpStatus=403"} httpStatus=500'
    installClerumGfs(
      async uri => {
        if (uri.endsWith(FILE_ID.replace(/-/g, ''))) {
          return resolveView(FILE_ID, 'report.md', ROOT_ID, 'file')
        }
        if (uri.endsWith(ROOT_ID.replace(/-/g, ''))) {
          return resolveView(ROOT_ID, '', null)
        }
        return null
      },
      async () => {
        throw new Error(bodyMentionsForbidden)
      },
      async () => []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    // The vetted 500 is retryable; the body's 403 would have been a quiet
    // ACL boundary.
    expect(result.coverage).toBe('unavailable')
  })

  it('maps an unreadable target to read-boundary with no rows', async () => {
    const targetDenied = await resolveDeniedMessage(`gfs://main/${FILE_ID.replace(/-/g, '')}`)
    installClerumGfs(
      async () => {
        throw new Error(targetDenied)
      },
      async () => [],
      async () => []
    )

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('read-boundary')
    expect(result.items).toEqual([])
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

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('complete')
    expect(result.items).toHaveLength(1)
    const merged = result.items[0]
    expect(merged?.permissions.sort()).toEqual(['read', 'share', 'write'])
    expect(merged?.inheritedFrom).toEqual(['team-docs', 'main'])
    // R1-H1: EVERY contributing folder is kept, nearest first — the nearest
    // editor folder is the upgrade target, both are removal targets.
    expect(merged?.sources).toEqual([
      {
        resourceId: FOLDER_ID,
        name: 'team-docs',
        permissions: ['read', 'write'],
        grantId: `g-${FOLDER_ID}`,
        shareIds: [],
        grantPermissions: ['read', 'write'],
        grantInherit: true,
        shareEntries: [],
      },
      {
        resourceId: ROOT_ID,
        name: 'main',
        permissions: ['read', 'share'],
        grantId: `g-${ROOT_ID}`,
        shareIds: [],
        grantPermissions: ['read', 'share'],
        grantInherit: true,
        shareEntries: [],
      },
    ])
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

    const result = await deriveGfsInheritedAccess(FILE_ID)

    expect(result.coverage).toBe('complete')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.sources).toEqual([
      {
        resourceId: FOLDER_ID,
        name: 'team-docs',
        permissions: ['read', 'write'],
        grantId: 'g1',
        shareIds: ['s1'],
        grantPermissions: ['read', 'write'],
        grantInherit: true,
        shareEntries: [{ rowId: 's1', permissions: ['read'], includeDescendants: true }],
      },
    ])
  })
})
