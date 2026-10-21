import type { GfsDropVerdict } from './dragSession.types'

/**
 * The spoken form of a drop verdict (RP-026).
 *
 * The verdict itself is painted on the target row — a border tint and a
 * `data-drop-state` attribute — which a screen reader never announces. The
 * user dragging with a keyboard or a screen reader therefore gets no feedback
 * at all about whether the folder under the pointer accepts the move.
 *
 * One wording for every surface, so the sidebar and the Files page announce
 * the same thing for the same verdict.
 */
export function gfsDropVerdictAnnouncement(
  state: GfsDropVerdict['state'],
  targetName: string
): string {
  const target = targetName.trim() || 'this folder'
  switch (state) {
    case 'allowed':
      return `You can move into ${target}.`
    case 'denied':
      return `You cannot move into ${target}.`
    case 'unavailable':
      return `EvenDrive could not confirm whether you can move into ${target}.`
    default:
      return `Checking whether you can move into ${target}…`
  }
}
