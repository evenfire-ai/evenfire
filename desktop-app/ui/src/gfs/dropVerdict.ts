import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import type { GfsDropDenialReason, GfsDropRejection, GfsDropVerdict } from './dragSession.types'
import type {
  GfsDropFeedbackTone,
  GfsDropReasonNames,
  GfsDropRefusalPresentation,
} from './dropVerdict.types'

export type {
  GfsDropFeedbackTone,
  GfsDropReasonNames,
  GfsDropRefusalPresentation,
} from './dropVerdict.types'

/**
 * The spoken + written form of a drop verdict (RP-026, refusal UX matrix §5).
 *
 * The verdict itself is painted on the target row — a tone-keyed tint, a
 * `data-drop-state` and a `data-drop-reason` attribute — which a screen
 * reader never announces. This module is the ONE browser-safe presenter for
 * the reason copy and its tone: hover tooltips, the live-region
 * announcements, and the drop-time refusal toast/banner all render the same
 * sentence for the same reason on every surface. A GFS name is externally
 * controlled input, so every interpolated name is sanitized here before it
 * reaches a visible string.
 */

/** A11: the drop-refusal surface for a dead session — a persistent banner,
 *  never a one-shot toast (matrix §5.3). */
export const GFS_DROP_SESSION_LOST_MESSAGE =
  'Your session ended. Sign in again to continue moving files.'

/** The refusal family that is NOT a deny: the move could not be verified, so
 *  it must neither wear error-red nor imply the move was forbidden (A10). */
export function isGfsDropUnknownReason(reason: GfsDropDenialReason): boolean {
  return (
    reason === 'unavailable' ||
    reason === 'target-unavailable' ||
    reason === 'source-location-unknown'
  )
}

export function gfsDropReasonTone(reason: GfsDropDenialReason): GfsDropFeedbackTone {
  if (reason === 'same-parent') return 'info'
  if (isGfsDropUnknownReason(reason)) return 'warn'
  return 'error'
}

function displaySource(name: string | undefined): string {
  return sanitizeAppTabTitle(name ?? '') || 'This item'
}

function displayTarget(name: string | undefined): string {
  return sanitizeAppTabTitle(name ?? '') || 'this folder'
}

/**
 * One sentence per reason (matrix §3/§6): names the missing access as
 * "edit access"/"delete access" (never the wire bit), and distinguishes the
 * three places a move touches — the item, the folder it leaves ("the folder
 * that contains it"), and the folder it enters.
 */
export function gfsDropReasonSentence(
  reason: GfsDropDenialReason,
  names: GfsDropReasonNames
): string {
  const source = displaySource(names.source)
  const target = displayTarget(names.target)
  switch (reason) {
    case 'self':
      return `You cannot move ${source} into itself.`
    case 'descendant':
      return `You can’t move ${source} into a folder inside itself.`
    case 'same-parent':
      return `${source} is already in ${target}.`
    case 'root-source':
      return 'This location is the top level — it can’t be moved.'
    case 'cross-drive':
      return 'Moving between drives isn’t supported.'
    case 'root-target':
      return `You can’t move items into ${target}.`
    case 'destination-write':
      return `You don’t have permission to move items into ${target}. You need edit access to the destination folder.`
    case 'source-write':
      return `You can’t move ${source} out of its current folder because you don’t have edit access to the folder that contains it.`
    case 'source-delete':
      return `You can’t move ${source} out of its current folder because you don’t have delete access to the folder that contains it.`
    case 'source-location-unknown':
      return 'EvenDrive cannot verify this item’s current location. Refresh and try again.'
    case 'target-unavailable':
      return 'This folder is no longer available.'
    case 'unavailable':
      return 'EvenDrive couldn’t verify this move. Check your connection and try again.'
    case 'session-lost':
      return GFS_DROP_SESSION_LOST_MESSAGE
  }
}

/**
 * The spoken form of a drop verdict (RP-026). Extended per the refusal UX
 * matrix §5.4: a denied verdict now announces its full reason sentence, so
 * the same wording reaches the screen reader on every surface. Without a
 * reason the generic per-state sentences remain.
 */
export function gfsDropVerdictAnnouncement(
  state: GfsDropVerdict['state'],
  targetName: string,
  reason?: GfsDropDenialReason,
  sourceName?: string
): string {
  const target = displayTarget(targetName)
  switch (state) {
    case 'allowed':
      return `You can move into ${target}.`
    case 'denied':
      return reason
        ? gfsDropReasonSentence(reason, { source: sourceName ?? '', target: targetName })
        : `You cannot move into ${target}.`
    case 'unavailable':
      return `EvenDrive could not confirm whether you can move into ${target}.`
    default:
      return `Checking whether you can move into ${target}…`
  }
}

/** The verdict's machine-readable reason, when it carries one. */
export function gfsDropVerdictReason(
  verdict: GfsDropVerdict | undefined
): GfsDropDenialReason | 'rate-limit' | 'transport' | 'session' | undefined {
  if (!verdict) return undefined
  if (verdict.state === 'denied' || verdict.state === 'unavailable') return verdict.reason
  return undefined
}

/** The live-region sentence for a FULL verdict: a denied verdict announces its
 *  reason; the other states keep their per-state sentences. */
export function gfsDropVerdictLiveAnnouncement(
  verdict: GfsDropVerdict,
  targetName: string,
  sourceName?: string
): string {
  if (verdict.state === 'denied') {
    return gfsDropVerdictAnnouncement(verdict.state, targetName, verdict.reason, sourceName)
  }
  return gfsDropVerdictAnnouncement(verdict.state, targetName)
}

/** Structural equality that does not collapse a same-state reason change. */
export function sameGfsDropVerdict(
  left: GfsDropVerdict | undefined,
  right: GfsDropVerdict | undefined
): boolean {
  if (left === right) return true
  if (!left || !right || left.state !== right.state) return false
  if (left.state === 'checking' || left.state === 'allowed') return true
  return left.reason === (right as typeof left).reason
}

export interface GfsSessionLostBannerGateInput {
  /** The surface's live drag scope captured when the drop was admitted. */
  capturedScope: string | null
  /** The surface's live drag scope NOW (null while revoked). */
  liveScope: string | null
  /** The surface's local gesture counter captured at admission. */
  capturedEpoch: number
  /** The surface's local gesture counter now. */
  liveEpoch: number
  /** The shared session generation captured at admission (null without one). */
  capturedSessionGeneration: number | null
  /** The shared session generation now (null without one). */
  liveSessionGeneration: number | null
  /** Whether the shared drag-session provider is present. */
  hasSharedSession: boolean
}

/**
 * May a drop callback that answered `session-lost` still paint the local
 * banner and announcement? Only when the surface's session is observably dead
 * now (live scope null — the revocation itself proves it), or when the very
 * gesture that asked is still the live one. A call superseded by a newer
 * gesture or a new, healthy scope must not declare that session ended (A11).
 */
export function mayPaintGfsSessionLostBanner(input: GfsSessionLostBannerGateInput): boolean {
  if (input.liveScope === null) return true
  if (input.liveScope !== input.capturedScope) return false
  if (input.liveEpoch !== input.capturedEpoch) return false
  if (input.hasSharedSession) {
    return input.liveSessionGeneration === input.capturedSessionGeneration
  }
  return true
}

/**
 * Present a drop-time refusal (matrix §3). The unavailable family keeps the
 * vetted server-derived message when the adjudicator produced one (e.g. a
 * parsed rate-limit window) and only falls back to the matrix sentence;
 * `session-lost` carries the persistent-banner copy — the caller renders it
 * as a banner, not a toast.
 */
export function presentGfsDropRefusal(
  rejection: GfsDropRejection,
  names: GfsDropReasonNames
): GfsDropRefusalPresentation {
  const tone = gfsDropReasonTone(rejection.reason)
  if (isGfsDropUnknownReason(rejection.reason) && rejection.message) {
    return { message: rejection.message, tone }
  }
  if (rejection.reason === 'self') {
    // A1's drop copy coaches the release; the sentence above stays spoken.
    return {
      message: `You dropped ${displaySource(names.source)} onto itself. Pick a destination folder.`,
      tone,
    }
  }
  return { message: gfsDropReasonSentence(rejection.reason, names), tone }
}
