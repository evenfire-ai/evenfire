import { describe, expect, it, vi } from 'vitest'
import { type GfsCaller, type GrantsDb, heldPermissions } from '../src/routes/gfs/grants.js'

describe('heldPermissions user-session snapshot', () => {
  it('evaluates ancestry, active memberships, grants, and shares in one statement', async () => {
    const db: GrantsDb = {
      query: vi.fn(async () => ({
        rows: [
          {
            ancestor_ids: ['resource-1', 'folder-1'],
            grants: [
              {
                subject_type: 'team',
                subject_id: 'secondary-team',
                resource_id: 'folder-1',
                permissions: ['read'],
                inherit: true,
              },
            ],
            shares: [],
          },
        ],
      })),
    }
    const caller: GfsCaller = {
      isOperator: false,
      subjects: new Set(['user:user-1', 'team:primary-team', 'team:secondary-team']),
      actorKey: 'user:user-1',
      desktopUserId: 'user-1',
      primaryTeamId: 'primary-team',
      authoritySource: 'user-session',
    }

    await expect(heldPermissions(db, caller, 'main', 'resource-1')).resolves.toContain('read')

    expect(db.query).toHaveBeenCalledOnce()
    const [sql, values] = vi.mocked(db.query).mock.calls[0]!
    expect(sql).toContain('WITH RECURSIVE')
    expect(sql).toContain("tm.status = 'active'")
    expect(sql).toContain('FROM gfs_grants')
    expect(sql).toContain('FROM gfs_shares')
    expect(values).toEqual(['main', 'resource-1', 'user-1', 'primary-team'])
  })

  it('preserves the existing static-caller reader path', async () => {
    const db: GrantsDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ resource_id: 'resource-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    }
    const caller: GfsCaller = {
      isOperator: false,
      subjects: new Set(['host:host-1']),
      actorKey: 'host:host-1',
    }

    await expect(heldPermissions(db, caller, 'main', 'resource-1')).resolves.toEqual([])
    expect(db.query).toHaveBeenCalledTimes(3)
  })
})
