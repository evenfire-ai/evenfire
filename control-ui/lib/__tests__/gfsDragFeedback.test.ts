import { describe, expect, it } from 'vitest'
import {
  GfsMoveRefusalError,
  computeGfsDropHoverVerdict,
  gfsDropHoverAnnouncement,
  gfsDropRefusalMessage,
  gfsDropRefusalTone,
} from '../gfsDragFeedback'
import type { GfsDropHoverFacts, GfsDropHoverVerdict } from '../gfsDragFeedback.types'

/**
 * The deny-reason → message/tone/announcement contract every refused move
 * shares (docs/design/gfs-move-forbidden-ux-matrix.md §3/§5/§6 and the
 * breadcrumb plan §3.3). One wording per reason on every surface.
 */

const names = { sourceName: 'live tests', targetName: 'Product' }

describe('gfsDropRefusalTone', () => {
  it('maps deny reasons to error', () => {
    for (const reason of [
      'self',
      'descendant',
      'root-source',
      'cross-drive',
      'destination-write',
      'source-write',
      'source-delete',
      'target-unavailable',
      'source-location-unknown',
      'session-lost',
    ] as const) {
      expect(gfsDropRefusalTone(reason)).toBe('error')
    }
  })

  it('maps the same-parent no-op to info (matrix A4)', () => {
    expect(gfsDropRefusalTone('same-parent')).toBe('info')
  })

  it('maps unknown/unverifiable outcomes to warning (matrix A10/B7)', () => {
    for (const reason of [
      'unavailable',
      'unknown-outcome',
      'source-precondition-unavailable',
    ] as const) {
      expect(gfsDropRefusalTone(reason)).toBe('warning')
    }
  })
})

describe('gfsDropRefusalMessage', () => {
  it('carries the matrix §3 wording for every structure deny', () => {
    expect(gfsDropRefusalMessage('self', names)).toBe(
      'You dropped live tests onto itself. Pick a destination folder.'
    )
    expect(gfsDropRefusalMessage('cross-drive', names)).toBe(
      'Moving between drives isn’t supported.'
    )
    expect(gfsDropRefusalMessage('root-source', names)).toBe(
      'This location is the top level — it can’t be moved.'
    )
    expect(gfsDropRefusalMessage('same-parent', names)).toBe('live tests is already in Product.')
    expect(gfsDropRefusalMessage('descendant', names)).toBe(
      "You can't move live tests into a folder inside itself."
    )
  })

  it('names the missing access, never the bit, for A6–A8', () => {
    expect(gfsDropRefusalMessage('destination-write', names)).toBe(
      "You don't have permission to move items into Product. You need edit access to the destination folder."
    )
    expect(gfsDropRefusalMessage('source-write', names)).toBe(
      'You can’t move live tests out of its current folder because you don’t have edit access to the folder that contains it.'
    )
    expect(gfsDropRefusalMessage('source-delete', names)).toBe(
      'You can’t move live tests out of its current folder because you don’t have delete access to the folder that contains it.'
    )
  })

  it('distinguishes the three vanish/verify outcomes honestly (A10/A11/B4/B5/B7)', () => {
    expect(gfsDropRefusalMessage('target-unavailable', names)).toBe(
      'This folder is no longer available.'
    )
    expect(gfsDropRefusalMessage('source-location-unknown', names)).toBe(
      'EvenDrive cannot verify this item’s current location. Refresh and try again.'
    )
    expect(gfsDropRefusalMessage('source-precondition-unavailable', names)).toBe(
      'EvenDrive couldn’t confirm this item’s current version. Refresh the folder and try again.'
    )
    expect(gfsDropRefusalMessage('session-lost', names)).toBe(
      'Your session ended. Sign in again to continue moving files.'
    )
    expect(gfsDropRefusalMessage('unavailable', names)).toBe(
      'EvenDrive couldn’t verify this move. Check your connection and try again.'
    )
    expect(gfsDropRefusalMessage('unknown-outcome', names)).toBe(
      'Couldn’t confirm the move. Refresh before trying again.'
    )
  })

  it('falls back to a named, non-empty sentence for unknown inputs', () => {
    expect(gfsDropRefusalMessage('unavailable' as never, {}).length).toBeGreaterThan(0)
  })
})

describe('gfsDropHoverAnnouncement', () => {
  it('speaks allowed, checking and unavailable hovers', () => {
    expect(gfsDropHoverAnnouncement({ state: 'allowed', evidence: 'file' }, names)).toBe(
      'You can move into Product.'
    )
    expect(gfsDropHoverAnnouncement({ state: 'checking' }, names)).toBe(
      'Checking whether you can move into Product…'
    )
    expect(gfsDropHoverAnnouncement({ state: 'unavailable' }, names)).toBe(
      'EvenDrive could not confirm whether you can move into Product.'
    )
  })

  it('speaks the same reason sentence a refused drop would toast', () => {
    const denied: GfsDropHoverVerdict = { state: 'denied', reason: 'descendant' }
    expect(gfsDropHoverAnnouncement(denied, names)).toBe(gfsDropRefusalMessage('descendant', names))
    expect(gfsDropHoverAnnouncement({ state: 'same-parent', reason: 'same-parent' }, names)).toBe(
      gfsDropRefusalMessage('same-parent', names)
    )
  })
})

describe('GfsMoveRefusalError', () => {
  it('carries its reason and derives the tone', () => {
    const error = new GfsMoveRefusalError(
      'same-parent',
      gfsDropRefusalMessage('same-parent', names)
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.reason).toBe('same-parent')
    expect(error.tone).toBe('info')
    expect(new GfsMoveRefusalError('unknown-outcome', 'x').tone).toBe('warning')
    expect(new GfsMoveRefusalError('target-unavailable', 'x').tone).toBe('error')
  })
})

describe('computeGfsDropHoverVerdict', () => {
  // main › Product › live tests, dragging the `notes.md` row.
  const trail = ['root-id', 'product-id', 'live-tests-id']

  function crumbFacts(overrides: Partial<GfsDropHoverFacts> = {}): GfsDropHoverFacts {
    return {
      drive: 'main',
      sourceResourceId: 'file-id',
      sourceKind: 'file',
      sourceParentKnown: true,
      sourceParentResourceId: 'live-tests-id',
      targetResourceId: 'product-id',
      targetName: 'Product',
      targetIsActiveLocation: false,
      targetIsSourceParent: false,
      // Ancestors of the Product crumb: main, observed to the physical root.
      targetAncestorIds: ['root-id', null],
      knownSourceAncestorIds: new Set(['live-tests-id', 'product-id', 'root-id']),
      ...overrides,
    }
  }

  it('marks an unhydrated root target unavailable without denying (plan §3.1)', () => {
    expect(computeGfsDropHoverVerdict(crumbFacts({ targetResourceId: null }))).toEqual({
      state: 'unavailable',
      reason: 'target-unavailable',
    })
  })

  it('denies dropping onto the dragged item itself (A1)', () => {
    expect(
      computeGfsDropHoverVerdict(
        crumbFacts({ targetResourceId: 'file-id', targetName: 'notes.md' })
      )
    ).toEqual({ state: 'denied', reason: 'self' })
  })

  it('reports the active crumb and the observed own parent as same-parent info (A4)', () => {
    expect(computeGfsDropHoverVerdict(crumbFacts({ targetIsActiveLocation: true }))).toEqual({
      state: 'same-parent',
      reason: 'same-parent',
    })
    expect(
      computeGfsDropHoverVerdict(
        crumbFacts({ targetResourceId: 'live-tests-id', targetName: 'live tests' })
      )
    ).toEqual({ state: 'same-parent', reason: 'same-parent' })
  })

  it('allows an observed ancestor crumb through the common-anchor proof', () => {
    expect(
      computeGfsDropHoverVerdict(
        crumbFacts({ sourceKind: 'directory', sourceResourceId: 'specs-id' })
      )
    ).toEqual({ state: 'allowed', evidence: 'common-anchor' })
  })

  it('stays neutral-checking when ancestry is unproved — never a fake denial (A12)', () => {
    expect(
      computeGfsDropHoverVerdict(
        crumbFacts({
          sourceKind: 'directory',
          sourceResourceId: 'specs-id',
          targetAncestorIds: [],
          knownSourceAncestorIds: new Set(['live-tests-id']),
        })
      )
    ).toEqual({ state: 'checking' })
  })

  it('cannot produce a descendant deny for any crumb of a fresh trail (by construction)', () => {
    // Walk EVERY crumb of main › Product › live tests as a drop target for
    // the `notes.md` row and for a `specs` folder row: crumbs are ancestors
    // of the listing, so no crumb target can sit inside the source subtree.
    for (let index = 0; index < trail.length; index += 1) {
      const chain: (string | null)[] = []
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) chain.push(trail[cursor])
      chain.push(null)
      for (const source of [
        { resourceId: 'file-id', kind: 'file' as const },
        { resourceId: 'specs-id', kind: 'directory' as const },
      ]) {
        const verdict = computeGfsDropHoverVerdict(
          crumbFacts({
            sourceResourceId: source.resourceId,
            sourceKind: source.kind,
            targetResourceId: trail[index],
            targetIsActiveLocation: index === trail.length - 1,
            targetAncestorIds: chain,
            knownSourceAncestorIds: new Set(trail),
          })
        )
        if (verdict.state === 'denied') {
          throw new Error(`crumb ${trail[index]} unexpectedly denied: ${verdict.reason}`)
        }
        if (verdict.state === 'same-parent') continue
        expect(verdict.state).toBe('allowed')
      }
    }
  })
})
