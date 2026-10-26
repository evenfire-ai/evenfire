import { describe, expect, it } from 'vitest'
import type { GfsDropRejection } from '../dragSession.types'
import {
  GFS_DROP_SESSION_LOST_MESSAGE,
  gfsDropReasonSentence,
  gfsDropReasonTone,
  gfsDropVerdictAnnouncement,
  gfsDropVerdictReason,
  mayPaintGfsSessionLostBanner,
  presentGfsDropRefusal,
  sameGfsDropVerdict,
} from '../dropVerdict'

const names = { source: 'live tests', target: 'Assets' }

describe('gfsDropReasonTone — deny=error, no-op=info, unknown=warn (matrix §5.2)', () => {
  it('maps the no-op same-parent reason to info', () => {
    expect(gfsDropReasonTone('same-parent')).toBe('info')
  })

  it('maps the unverifiable family to warn', () => {
    expect(gfsDropReasonTone('unavailable')).toBe('warn')
    expect(gfsDropReasonTone('target-unavailable')).toBe('warn')
    expect(gfsDropReasonTone('source-location-unknown')).toBe('warn')
  })

  it('maps structural and permission denies to error', () => {
    for (const reason of [
      'self',
      'descendant',
      'root-source',
      'cross-drive',
      'root-target',
      'destination-write',
      'source-write',
      'source-delete',
      'session-lost',
    ] as const) {
      expect(gfsDropReasonTone(reason)).toBe('error')
    }
  })
})

describe('gfsDropReasonSentence — one honest sentence per reason (matrix §3/§6)', () => {
  it('names the destination and its missing edit access (A6)', () => {
    expect(gfsDropReasonSentence('destination-write', names)).toBe(
      'You don’t have permission to move items into Assets. You need edit access to the destination folder.'
    )
  })

  it('names the folder that contains the item for the missing source write bit (A7)', () => {
    const sentence = gfsDropReasonSentence('source-write', names)
    expect(sentence).toBe(
      'You can’t move live tests out of its current folder because you don’t have edit access to the folder that contains it.'
    )
    expect(sentence).toContain('the folder that contains it')
  })

  it('names the folder that contains the item for the missing source delete bit (A8)', () => {
    expect(gfsDropReasonSentence('source-delete', names)).toBe(
      'You can’t move live tests out of its current folder because you don’t have delete access to the folder that contains it.'
    )
  })

  it('states the no-op as "already in", never as "cannot" (A4)', () => {
    const sentence = gfsDropReasonSentence('same-parent', names)
    expect(sentence).toBe('live tests is already in Assets.')
    expect(sentence).not.toContain('cannot')
    expect(sentence).not.toContain('can’t')
  })

  it('covers the structural refuses with their own wording', () => {
    expect(gfsDropReasonSentence('self', names)).toBe('You cannot move live tests into itself.')
    expect(gfsDropReasonSentence('descendant', names)).toBe(
      'You can’t move live tests into a folder inside itself.'
    )
    expect(gfsDropReasonSentence('root-source', names)).toBe(
      'This location is the top level — it can’t be moved.'
    )
    expect(gfsDropReasonSentence('cross-drive', names)).toBe(
      'Moving between drives isn’t supported.'
    )
  })

  it('never implies the move was forbidden when it merely could not be verified (A10)', () => {
    expect(gfsDropReasonSentence('unavailable', names)).toBe(
      'EvenDrive couldn’t verify this move. Check your connection and try again.'
    )
    expect(gfsDropReasonSentence('target-unavailable', names)).toBe(
      'This folder is no longer available.'
    )
    expect(gfsDropReasonSentence('source-location-unknown', names)).toBe(
      'EvenDrive cannot verify this item’s current location. Refresh and try again.'
    )
  })

  it('carries the persistent session-lost banner copy (A11)', () => {
    expect(gfsDropReasonSentence('session-lost', names)).toBe(GFS_DROP_SESSION_LOST_MESSAGE)
  })

  it('sanitizes externally-controlled names before they reach the sentence', () => {
    expect(gfsDropReasonSentence('same-parent', { source: 'Re‮ports​', target: 'A' })).toBe(
      'Reports is already in A.'
    )
  })

  it('falls back to honest placeholders for empty names', () => {
    expect(gfsDropReasonSentence('same-parent', { source: '', target: '' })).toBe(
      'This item is already in this folder.'
    )
  })
})

describe('gfsDropVerdictAnnouncement — RP-026 one wording per reason (matrix §5.4)', () => {
  it('keeps the per-state sentences for allowed/checking/unavailable', () => {
    expect(gfsDropVerdictAnnouncement('allowed', 'Assets')).toBe('You can move into Assets.')
    expect(gfsDropVerdictAnnouncement('checking', 'Assets')).toBe(
      'Checking whether you can move into Assets…'
    )
    expect(gfsDropVerdictAnnouncement('unavailable', 'Assets')).toBe(
      'EvenDrive could not confirm whether you can move into Assets.'
    )
  })

  it('announces the full reason sentence for a denied verdict', () => {
    expect(gfsDropVerdictAnnouncement('denied', 'Assets', 'source-write', 'live tests')).toBe(
      'You can’t move live tests out of its current folder because you don’t have edit access to the folder that contains it.'
    )
    expect(gfsDropVerdictAnnouncement('denied', 'Assets', 'same-parent', 'live tests')).toBe(
      'live tests is already in Assets.'
    )
  })

  it('keeps the generic denied sentence without a reason', () => {
    expect(gfsDropVerdictAnnouncement('denied', 'Assets')).toBe('You cannot move into Assets.')
  })
})

describe('gfsDropVerdictReason / sameGfsDropVerdict — reason retention (matrix §5.1)', () => {
  it('extracts the reason only from verdicts that carry one', () => {
    expect(gfsDropVerdictReason(undefined)).toBeUndefined()
    expect(gfsDropVerdictReason({ state: 'checking' })).toBeUndefined()
    expect(gfsDropVerdictReason({ state: 'allowed' })).toBeUndefined()
    expect(gfsDropVerdictReason({ state: 'denied', reason: 'same-parent' })).toBe('same-parent')
    expect(gfsDropVerdictReason({ state: 'unavailable', reason: 'transport' })).toBe('transport')
  })

  it('treats a same-state reason change as a different verdict', () => {
    expect(
      sameGfsDropVerdict(
        { state: 'denied', reason: 'destination-write' },
        { state: 'denied', reason: 'self' }
      )
    ).toBe(false)
  })

  it('treats equal states without reasons, and equal reasons, as unchanged', () => {
    expect(sameGfsDropVerdict({ state: 'checking' }, { state: 'checking' })).toBe(true)
    expect(sameGfsDropVerdict({ state: 'allowed' }, { state: 'allowed' })).toBe(true)
    expect(
      sameGfsDropVerdict({ state: 'denied', reason: 'self' }, { state: 'denied', reason: 'self' })
    ).toBe(true)
    expect(sameGfsDropVerdict(undefined, undefined)).toBe(true)
    expect(sameGfsDropVerdict(undefined, { state: 'checking' })).toBe(false)
  })
})

describe('presentGfsDropRefusal — the drop-time presentation', () => {
  it('coaches the self release while the sentence stays spoken (A1)', () => {
    expect(presentGfsDropRefusal({ allowed: false, reason: 'self' }, names)).toEqual({
      message: 'You dropped live tests onto itself. Pick a destination folder.',
      tone: 'error',
    })
  })

  it('presents the no-op as info with the "already in" copy (A4)', () => {
    expect(presentGfsDropRefusal({ allowed: false, reason: 'same-parent' }, names)).toEqual({
      message: 'live tests is already in Assets.',
      tone: 'info',
    })
  })

  it('presents the unknown family as a warning, keeping the vetted server message', () => {
    expect(
      presentGfsDropRefusal(
        {
          allowed: false,
          reason: 'unavailable',
          message: 'Too many file requests — try again in 7s.',
        },
        names
      )
    ).toEqual({ message: 'Too many file requests — try again in 7s.', tone: 'warn' })
  })

  it('falls back to the matrix sentence when the unknown family carries no message', () => {
    expect(presentGfsDropRefusal({ allowed: false, reason: 'unavailable' }, names)).toEqual({
      message: 'EvenDrive couldn’t verify this move. Check your connection and try again.',
      tone: 'warn',
    })
  })

  it('carries the persistent banner copy for a dead session (A11)', () => {
    expect(presentGfsDropRefusal({ allowed: false, reason: 'session-lost' }, names)).toEqual({
      message: GFS_DROP_SESSION_LOST_MESSAGE,
      tone: 'error',
    })
  })

  it('presents permission denies with their exact-reason copy', () => {
    const rejection: GfsDropRejection = { allowed: false, reason: 'source-delete' }
    expect(presentGfsDropRefusal(rejection, names)).toEqual({
      message:
        'You can’t move live tests out of its current folder because you don’t have delete access to the folder that contains it.',
      tone: 'error',
    })
  })
})

describe('mayPaintGfsSessionLostBanner — superseded calls cannot end a healthy session (A11)', () => {
  const admitted = {
    capturedScope: 'env-1:user-1:team-1',
    liveScope: 'env-1:user-1:team-1',
    capturedEpoch: 3,
    liveEpoch: 3,
    capturedSessionGeneration: 7,
    liveSessionGeneration: 7,
    hasSharedSession: true,
  }

  it('paints while the admitted gesture is still the live one', () => {
    expect(mayPaintGfsSessionLostBanner(admitted)).toBe(true)
  })

  it('paints when the session is observably dead (live scope null), even after the revocation invalidated everything', () => {
    expect(
      mayPaintGfsSessionLostBanner({
        ...admitted,
        liveScope: null,
        liveEpoch: 4,
        liveSessionGeneration: 8,
      })
    ).toBe(true)
  })

  it('does not paint when a new, healthy scope is live', () => {
    expect(mayPaintGfsSessionLostBanner({ ...admitted, liveScope: 'env-2:user-1:team-1' })).toBe(
      false
    )
  })

  it('does not paint when a newer gesture on the same surface superseded the drop', () => {
    expect(mayPaintGfsSessionLostBanner({ ...admitted, liveEpoch: 4 })).toBe(false)
  })

  it('does not paint when the shared session generation moved on', () => {
    expect(mayPaintGfsSessionLostBanner({ ...admitted, liveSessionGeneration: 8 })).toBe(false)
  })

  it('without a shared session, the surface epoch alone decides', () => {
    expect(
      mayPaintGfsSessionLostBanner({ ...admitted, hasSharedSession: false, liveEpoch: 3 })
    ).toBe(true)
    expect(
      mayPaintGfsSessionLostBanner({ ...admitted, hasSharedSession: false, liveEpoch: 4 })
    ).toBe(false)
  })
})
