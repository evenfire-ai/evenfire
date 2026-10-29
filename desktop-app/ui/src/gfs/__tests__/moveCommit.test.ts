import { describe, expect, it, vi } from 'vitest'
import { commitGfsMove, suggestNumberedMoveName, toastMoveOutcome } from '../moveCommit'
import type { MoveCommitSourceSnapshot } from '../moveCommit'
import type { MoveCommitDeps, MoveCommitOutcome, MoveCommitPlan } from '../moveCommit'

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
    ...overrides,
  }
}

describe('commitGfsMove — commit-time source refresh', () => {
  it('resolves the source and sends exactly one PATCH with the fresh version and ifMatch', async () => {
    const moveResource = vi.fn(async () => ({ resourceId: 'r-1', version: 8 }))
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome).toEqual({ status: 'committed', version: 8, previousParentId: 'old-parent' })
    expect(moveResource).toHaveBeenCalledTimes(1)
    expect(moveResource).toHaveBeenCalledWith('r-1', 'dest-1', 7, undefined, 'old-parent')
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

  it('retries one numbered name only after explicit authorization', async () => {
    const moveResource = vi
      .fn()
      .mockImplementation(async (_id: string, _dest: string, _v: number, newName?: string) => {
        if (newName === undefined || newName === 'report.md') throw conflictError()
        return { resourceId: 'r-1', version: 9 }
      })
    const authorizeNumberedRename = vi.fn(async () => true)
    const outcome = await commitGfsMove(deps({ moveResource, authorizeNumberedRename }), plan())
    expect(outcome).toEqual({
      status: 'committed',
      version: 9,
      renamedTo: 'report (1).md',
      previousParentId: 'old-parent',
    })
    expect(moveResource).toHaveBeenCalledTimes(2)
    expect(authorizeNumberedRename).toHaveBeenCalledTimes(1)
    expect(authorizeNumberedRename).toHaveBeenCalledWith('report (1).md')
    expect(moveResource).toHaveBeenLastCalledWith('r-1', 'dest-1', 7, 'report (1).md', 'old-parent')
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
      deps({ moveResource, authorizeNumberedRename: async () => true }),
      plan({
        occupiedDestinationNames: new Set(['report.md', 'report (1).md', 'report (2).md']),
      })
    )
    expect(outcome).toEqual({
      status: 'committed',
      version: 10,
      renamedTo: 'report (3).md',
      previousParentId: 'old-parent',
    })
    expect(moveResource).toHaveBeenCalledTimes(2)
    expect(moveResource).toHaveBeenLastCalledWith('r-1', 'dest-1', 7, 'report (3).md', 'old-parent')
  })

  it('a repeated 409 stops after one explicitly consented numbered retry', async () => {
    const moveResource = vi.fn(async () => {
      throw conflictError()
    })
    const authorizeNumberedRename = vi.fn(async () => true)
    const outcome = await commitGfsMove(deps({ moveResource, authorizeNumberedRename }), plan())
    expect(outcome.status).toBe('conflict-stopped')
    if (outcome.status === 'conflict-stopped') {
      expect(outcome.message).toContain('choose another folder')
      expect(outcome.message).not.toContain('all numbered names')
    }
    expect(authorizeNumberedRename).toHaveBeenCalledTimes(1)
    expect(authorizeNumberedRename).toHaveBeenCalledWith('report (1).md')
    expect(moveResource).toHaveBeenCalledTimes(2)
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

  it('a 404 PATCH with a resolvable source maps to target-unavailable', async () => {
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

  // RP-027 — the PATCH answers 404 for a vanished source AND for a vanished
  // destination. Telling a user that "this folder is no longer available"
  // when their item was deleted sends them looking in the wrong place.
  it('a 404 PATCH with a vanished source maps to source-unavailable', async () => {
    // The commit-time resolve succeeds; the re-read after the 404 fails.
    let reads = 0
    const resolveSource = vi.fn(async (_gfsUri: string) => {
      reads += 1
      if (reads > 1) throw new Error('404 Not Found: httpStatus=404')
      return resolved()
    })
    const outcome = await commitGfsMove(
      deps({
        resolveSource,
        moveResource: vi.fn(async () => {
          throw new Error('404 Not Found: httpStatus=404')
        }),
      }),
      plan()
    )
    expect(outcome.status).toBe('source-unavailable')
    // The source is re-read once to tell the two sides apart.
    expect(resolveSource).toHaveBeenCalledTimes(2)
  })

  it('a 404 PATCH that already landed in the destination commits', async () => {
    let reads = 0
    const resolveSource = vi.fn(async (_gfsUri: string) => {
      reads += 1
      if (reads > 1) return resolved({ parentResourceId: 'dest-1', version: 9 })
      return resolved()
    })
    const outcome = await commitGfsMove(
      deps({
        resolveSource,
        moveResource: vi.fn(async () => {
          throw new Error('404 Not Found: httpStatus=404')
        }),
      }),
      plan()
    )
    expect(outcome).toEqual({
      status: 'committed',
      version: 9,
      previousParentId: 'old-parent',
    })
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

  it('a 403 explains unconfirmed permission without raw HTTP prose or a named bit (B6)', async () => {
    const outcome = await commitGfsMove(
      deps({
        moveResource: vi.fn(async () => {
          throw new Error('403 Forbidden: manage_acl_required httpStatus=403')
        }),
      }),
      plan()
    )
    expect(outcome.status).toBe('unconfirmed')
    if (outcome.status !== 'unconfirmed') return
    expect(outcome.message).toBe(
      'EvenDrive could not confirm permission for this move. Refresh and try again.'
    )
    expect(outcome.message).not.toContain('403')
    expect(outcome.message).not.toContain('manage_acl_required')
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
    expect(outcome).toEqual({
      status: 'committed',
      version: 11,
      previousParentId: 'old-parent',
    })
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

  it('a validated 5xx that merely mentions "already exists" is not a name conflict', async () => {
    // The vetted status is the verdict. A 5xx body can carry the phrase for
    // any reason; re-PATCHing under a new name would rename an item the
    // server never rejected.
    const moveResource = vi.fn(async () => {
      throw new Error(
        'Error invoking remote method: Error: 500 Internal Server Error: a resource with this name already exists httpStatus=500'
      )
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome.status).toBe('unconfirmed')
    // No numbered-name retry: the move was never a collision.
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('a validated 503 that mentions "already exists" is verified, never retried', async () => {
    const moveResource = vi.fn(async () => {
      throw new Error(
        'Error invoking remote method: Error: 503 Service Unavailable: destination already exists upstream httpStatus=503'
      )
    })
    const resolveSource = vi
      .fn()
      .mockResolvedValueOnce(resolved())
      .mockResolvedValueOnce(resolved({ parentResourceId: 'dest-1', version: 12 }))
    const outcome = await commitGfsMove(deps({ moveResource, resolveSource }), plan())
    // The move actually landed: the outcome is verified, not retried.
    expect(outcome).toEqual({
      status: 'committed',
      version: 12,
      previousParentId: 'old-parent',
    })
    expect(moveResource).toHaveBeenCalledTimes(1)
  })
  it('a 5xx body that mentions "already exists" without a vetted marker is not a name conflict', async () => {
    // No `httpStatus=` marker crossed the boundary, but the response still
    // carries its own status line: 5xx is not a collision, so the outcome is
    // verified instead of retried under a new name.
    const moveResource = vi.fn(async () => {
      throw new Error('500 Internal Server Error: a resource with this name already exists')
    })
    const outcome = await commitGfsMove(deps({ moveResource }), plan())
    expect(outcome.status).toBe('unconfirmed')
    expect(moveResource).toHaveBeenCalledTimes(1)
  })
})

describe('commitGfsMove — gesture ownership (rev-2 §4.1)', () => {
  it('never dispatches when the gesture is no longer current', async () => {
    const moveResource = vi.fn()
    const outcome = await commitGfsMove(deps({ moveResource, isCurrent: () => false }), plan())
    expect(outcome).toEqual({ status: 'gesture-lost' })
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('re-checks ownership before every retry, so a gesture lost mid-ladder never re-PATCHes', async () => {
    // The first attempt fails with a name conflict; the gesture is superseded
    // while the numbered-name ladder is being prepared. The second attempt
    // must not reach the server.
    let checks = 0
    const moveResource = vi.fn(async () => {
      throw new Error(
        'Error invoking remote method: Error: 409 Conflict: a resource with this name already exists httpStatus=409'
      )
    })
    const outcome = await commitGfsMove(
      deps({
        moveResource,
        authorizeNumberedRename: async () => true,
        isCurrent: () => {
          checks += 1
          return checks === 1
        },
      }),
      plan()
    )
    expect(outcome.status).toBe('conflict-stopped')
    if (outcome.status === 'conflict-stopped') {
      expect(outcome.message).toContain('already exists')
    }
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('dispatches the commit-time parent, never the gesture parent', async () => {
    // The convergence has to drop the item from the folder it REALLY left.
    // The drag-start parent can be stale (or unknown), and an unknown parent
    // is not the physical root.
    const moveResource = vi.fn(async () => ({ resourceId: 'r-1', version: 8 }))
    await commitGfsMove(
      deps({
        moveResource,
        resolveSource: vi.fn(async () => resolved({ parentResourceId: 'fresh-parent' })),
      }),
      plan()
    )
    expect(moveResource).toHaveBeenCalledWith('r-1', 'dest-1', 7, undefined, 'fresh-parent')
  })

  it('dispatches every retry with the commit-time parent', async () => {
    const moveResource = vi
      .fn()
      .mockImplementation(async (_id: string, _dest: string, _v: number, newName?: string) => {
        if (newName === undefined) {
          throw new Error(
            'Error invoking remote method: Error: 409 Conflict: a resource with this name already exists httpStatus=409'
          )
        }
        return { resourceId: 'r-1', version: 9 }
      })
    await commitGfsMove(
      deps({
        moveResource,
        authorizeNumberedRename: async () => true,
        resolveSource: vi.fn(async () => resolved({ parentResourceId: 'fresh-parent' })),
      }),
      plan()
    )
    expect(moveResource).toHaveBeenNthCalledWith(1, 'r-1', 'dest-1', 7, undefined, 'fresh-parent')
    expect(moveResource).toHaveBeenNthCalledWith(
      2,
      'r-1',
      'dest-1',
      7,
      'report (1).md',
      'fresh-parent'
    )
  })

  it('dispatches when the gesture is still current', async () => {
    const moveResource = vi.fn(async () => ({ resourceId: 'r-1', version: 8 }))
    const outcome = await commitGfsMove(deps({ moveResource, isCurrent: () => true }), plan())
    expect(outcome).toEqual({ status: 'committed', version: 8, previousParentId: 'old-parent' })
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

describe('toastMoveOutcome — unknown outcomes warn, definite negatives error (B6–B8)', () => {
  const present = (outcome: MoveCommitOutcome) => {
    const pushToast = vi.fn()
    toastMoveOutcome(pushToast, outcome, 'report.md', 'Dest', 'file')
    return pushToast.mock.calls as Array<[string, string]>
  }

  it('an unconfirmed outcome (transport loss, 403) warns instead of erroring', () => {
    const calls = present({
      status: 'unconfirmed',
      message: 'Couldn’t confirm the move. Refresh before trying again.',
    })
    expect(calls).toEqual([
      ['report.md → Dest: Couldn’t confirm the move. Refresh before trying again.', 'warn'],
    ])
  })

  it('a rate-limited outcome warns', () => {
    const calls = present({
      status: 'rate-limited',
      message: 'Too many file requests — try again in 7s.',
      retryAfterSeconds: 7,
    })
    expect(calls).toEqual([['report.md → Dest: Too many file requests — try again in 7s.', 'warn']])
  })

  it('definite negatives stay errors and successes stay successes', () => {
    expect(present({ status: 'conflict-stopped', message: 'blocked' })).toEqual([
      ['report.md → Dest: blocked', 'error'],
    ])
    expect(present({ status: 'target-unavailable', message: 'gone' })).toEqual([
      ['report.md → Dest: gone', 'error'],
    ])
    expect(present({ status: 'committed', version: 8, previousParentId: 'p' })).toEqual([
      ['Moved report.md to Dest', 'success'],
    ])
  })

  it('sanitizes captured names and the renamed-to label before toast interpolation', () => {
    const pushToast = vi.fn()
    toastMoveOutcome(
      pushToast,
      {
        status: 'committed',
        version: 8,
        previousParentId: 'p',
        renamedTo: 'report\u202e (1).txt',
      },
      'report\u202e.txt',
      'Archive\u200b',
      'file'
    )

    expect(pushToast).toHaveBeenCalledWith(
      'Moved report.txt to Archive as report (1).txt',
      'success'
    )
  })

  it('a dead or superseded gesture stays silent', () => {
    expect(present({ status: 'session-lost' })).toEqual([])
    expect(present({ status: 'gesture-lost' })).toEqual([])
  })
})
