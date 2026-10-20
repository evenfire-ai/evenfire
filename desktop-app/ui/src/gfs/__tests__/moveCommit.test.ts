import { describe, expect, it, vi } from 'vitest'
import { commitGfsMove, suggestNumberedMoveName } from '../moveCommit'
import type { MoveCommitSourceSnapshot } from '../moveCommit'
import type { MoveCommitDeps, MoveCommitPlan } from '../moveCommit'

function resolved(overrides: Partial<MoveCommitSourceSnapshot> = {}): MoveCommitSourceSnapshot {
  return {
    resourceId: 'r-1',
    gfsUri: 'gfs://main/r1',
    kind: 'file',
    name: 'report.md',
    version: 7,
    parentResourceId: 'old-parent',
    ...overrides,
  }
}

function deps(overrides: Partial<MoveCommitDeps> = {}): MoveCommitDeps {
  return {
    resolveSource: vi.fn(async (_gfsUri: string) => resolved()),
    moveResource: vi.fn(async () => ({ resourceId: 'r-1', version: 8 })),
    isSessionAuthorityFailure: vi.fn(() => false),
    ...overrides,
  }
}

function plan(overrides: Partial<MoveCommitPlan> = {}): MoveCommitPlan {
  return {
    source: { resourceId: 'r-1', gfsUri: 'gfs://main/r1', kind: 'file', name: 'report.md' },
    destination: { resourceId: 'dest-1', name: 'Dest' },
    allowNumberedRename: false,
    ...overrides,
  }
}

describe('commitGfsMove — commit-time source refresh', () => {
  it('resolves the source and sends exactly one PATCH with the fresh version and ifMatch', async () => {
    const moveResource = vi.fn(async () => ({ resourceId: 'r-1', version: 8 }))
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome).toEqual({ status: 'committed', version: 8 })
    expect(moveResource).toHaveBeenCalledTimes(1)
    expect(moveResource).toHaveBeenCalledWith('r-1', 'dest-1', 7, undefined)
  })

  it('refuses without a request when the fresh parent already IS the destination (no-op)', async () => {
    const moveResource = vi.fn()
    const outcome = await commitGfsMove(
      deps({
        resolveSource: vi.fn(async () => resolved({ parentResourceId: 'dest-1' })),
        moveResource,
      }),
      plan()
    )
    expect(outcome.status).toBe('no-op')
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('a missing source (404 on resolve) stops as source-unavailable', async () => {
    const outcome = await commitGfsMove(
      deps({
        resolveSource: vi.fn(async () => {
          throw new Error('404 Not Found: httpStatus=404')
        }),
      }),
      plan()
    )
    expect(outcome.status).toBe('source-unavailable')
  })

  it('a session-authority failure on resolve fails closed', async () => {
    const outcome = await commitGfsMove(
      deps({
        resolveSource: vi.fn(async () => {
          throw new Error('401')
        }),
        isSessionAuthorityFailure: error => String(error) === 'Error: 401',
      }),
      plan()
    )
    expect(outcome.status).toBe('session-lost')
  })
})

describe('commitGfsMove — conflict policy (rev-2 §5)', () => {
  function conflictError(): Error {
    const error = new Error(
      'Error invoking remote method: Error: 409 Conflict: a resource with this name already exists httpStatus=409'
    )
    return error
  }

  it('without a pre-approved policy a 409 stops with alternatives copy and no retry', async () => {
    const moveResource = vi.fn(async () => {
      throw conflictError()
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome.status).toBe('conflict-stopped')
    if (outcome.status === 'conflict-stopped') {
      expect(outcome.message).toContain('Choose another folder')
    }
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('with an approved policy it retries numbered names, whole-resource, capped at 3 attempts', async () => {
    const moveResource = vi
      .fn()
      .mockImplementation(async (_id: string, _dest: string, _v: number, newName?: string) => {
        if (newName === undefined || newName === 'report.md') throw conflictError()
        return { resourceId: 'r-1', version: 9 }
      })
    const outcome = await commitGfsMove(deps({ moveResource }), plan({ allowNumberedRename: true }))
    expect(outcome).toEqual({ status: 'committed', version: 9, renamedTo: 'report (1).md' })
    expect(moveResource).toHaveBeenCalledTimes(2)
    expect(moveResource).toHaveBeenLastCalledWith('r-1', 'dest-1', 7, 'report (1).md')
  })

  it('seeds the ladder from plan.occupiedDestinationNames so known-taken names are skipped', async () => {
    // RP-003: with the destination already holding report.md, report (1).md
    // and report (2).md, a blind ladder burns all three attempts on taken
    // names. Seeded from the plan, the first 409 jumps straight past them.
    const moveResource = vi
      .fn()
      .mockImplementation(async (_id: string, _dest: string, _v: number, newName?: string) => {
        if (
          newName === undefined ||
          newName === 'report.md' ||
          newName === 'report (1).md' ||
          newName === 'report (2).md'
        ) {
          throw conflictError()
        }
        return { resourceId: 'r-1', version: 10 }
      })
    const outcome = await commitGfsMove(
      deps({ moveResource }),
      plan({
        allowNumberedRename: true,
        occupiedDestinationNames: new Set(['report.md', 'report (1).md', 'report (2).md']),
      })
    )
    expect(outcome).toEqual({ status: 'committed', version: 10, renamedTo: 'report (3).md' })
    expect(moveResource).toHaveBeenCalledTimes(2)
    expect(moveResource).toHaveBeenLastCalledWith('r-1', 'dest-1', 7, 'report (3).md')
  })

  it('a concurrent-name storm stops after the attempt cap with the destination-changed copy', async () => {
    const moveResource = vi.fn(async () => {
      throw conflictError()
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan({ allowNumberedRename: true }))
    expect(outcome.status).toBe('conflict-stopped')
    if (outcome.status === 'conflict-stopped') {
      expect(outcome.message).toContain('The destination changed')
      // Never claim all numbered names were used.
      expect(outcome.message).not.toContain('all numbered names')
    }
    expect(moveResource).toHaveBeenCalledTimes(3)
  })
})

describe('commitGfsMove — server verdicts', () => {
  it('412 surfaces as changed and never auto re-PATCHes', async () => {
    const moveResource = vi.fn(async () => {
      throw new Error('412 Precondition Failed: httpStatus=412')
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome.status).toBe('changed')
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('404 maps to target-unavailable', async () => {
    const outcome = await commitGfsMove(
      deps({
        moveResource: vi.fn(async () => {
          throw new Error('404 Not Found: httpStatus=404')
        }),
      }),
      plan()
    )
    expect(outcome.status).toBe('target-unavailable')
  })

  it('429 maps to rate-limited with the parsed window', async () => {
    const outcome = await commitGfsMove(
      deps({
        moveResource: vi.fn(async () => {
          throw new Error('429 Too Many Requests: httpStatus=429 retryAfterSeconds=7')
        }),
      }),
      plan()
    )
    expect(outcome.status).toBe('rate-limited')
    if (outcome.status === 'rate-limited') expect(outcome.retryAfterSeconds).toBe(7)
  })

  it('transport loss after dispatch verifies by resolve and never repeats the PATCH', async () => {
    const moveResource = vi.fn(async () => {
      throw new Error('network error')
    })
    const resolveSource = vi
      .fn()
      // Pre-dispatch refresh: still in the old parent.
      .mockResolvedValueOnce(resolved())
      // Post-loss verification: the move actually landed.
      .mockResolvedValueOnce(resolved({ parentResourceId: 'dest-1', version: 11 }))
    const outcome = await commitGfsMove(deps({ moveResource, resolveSource }), plan())
    expect(outcome).toEqual({ status: 'committed', version: 11 })
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('an unverifiable transport loss stays unconfirmed', async () => {
    const moveResource = vi.fn(async () => {
      throw new Error('network error')
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome.status).toBe('unconfirmed')
    expect(moveResource).toHaveBeenCalledTimes(1)
  })
})

describe('suggestNumberedMoveName', () => {
  it('proposes the first free numbered name only when the plain name is taken', () => {
    expect(suggestNumberedMoveName('report.md', new Set(['other.md']))).toBeUndefined()
    expect(suggestNumberedMoveName('report.md', new Set(['report.md']))).toBe('report (1).md')
    expect(suggestNumberedMoveName('report.md', new Set(['report.md', 'report (1).md']))).toBe(
      'report (2).md'
    )
  })
})
