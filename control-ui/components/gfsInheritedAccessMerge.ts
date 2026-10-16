import {
  gfsRoleRank,
  gfsSubjectKeyOf,
  isEditorGfsPermissions,
  mergeGfsInheritedAccessItem as mergeInheritedAccessPolicy,
  strongestGfsInheritedSource,
} from '@clerum/gfs-interaction-policy'
import type {
  GfsInheritedAccessItem as PolicyInheritedAccessItem,
  GfsInheritedAccessSource as PolicyInheritedAccessSource,
} from '@clerum/gfs-interaction-policy'
import type { GfsInheritedAccessItem, GfsInheritedAccessSource } from './GfsGrantPanel.types'

/**
 * Control UI adapter over the shared inherited-access policy
 * (`@clerum/gfs-interaction-policy`), which owns the pure merge/planner
 * semantics (property tested there). This module keeps the app's historical
 * export surface and contribution shape stable: Control UI walkers hand over
 * rows pre-filtered to inheriting grants and descendant-covering shares, so
 * every translated contribution carries inherit/includeDescendants=true and
 * the same row ids the legacy core recorded.
 */

/** Stable per-subject merge key. Mirrors the panel's direct-row subject key. */
export function inheritedSubjectKey(subject: { type: string; id?: string }): string {
  return gfsSubjectKeyOf(subject)
}

/** Editor-strength rows (write/delete/manage_acl) outrank read-only rows. */
export const isEditorPermissions = isEditorGfsPermissions

/** Total role order over permission sets: Read (0) < Editor (1). */
export const roleRank = gfsRoleRank

/** One inheriting row on an ancestor folder, carrying its mutable row ids. */
export interface InheritedAccessContribution {
  subject: { type: string; id?: string }
  permissions: string[]
  grantId: string | null
  shareIds: string[]
}

/** The ancestor folder a contribution was collected from. */
export interface InheritedAccessFolder {
  resourceId: string
  name: string
}

/** The strongest contributing folder: editor beats read, nearest among equals. */
export function strongestInheritedSource(
  sources: GfsInheritedAccessSource[]
): GfsInheritedAccessSource | null {
  return strongestGfsInheritedSource(
    sources as PolicyInheritedAccessSource[]
  ) as GfsInheritedAccessSource | null
}

/**
 * Which ancestor folders a confirmed role change to the target role must
 * touch (R1-H1 semantics, verified against Google Drive):
 * - downgrade: EVERY source whose role is above the target (ancestors at or
 *   below the target stay untouched);
 * - upgrade: the single strongest source (nearest among equals) — the
 *   effective role is the strongest across sources, so one raise is enough;
 * - no-op (target equals the effective role): none.
 *
 * Kept flat and order-preserving (the app's established contract): the
 * richer grant-vs-share split planner remains available from the shared
 * package for the scoped per-source edit work.
 */
export function planInheritedRoleChange(
  item: Pick<GfsInheritedAccessItem, 'permissions' | 'sources'>,
  targetRoleIsEditor: boolean
): GfsInheritedAccessSource[] {
  const effectiveIsEditor = isEditorGfsPermissions(item.permissions)
  if (targetRoleIsEditor === effectiveIsEditor) return []
  if (!targetRoleIsEditor) {
    return item.sources.filter(source => isEditorGfsPermissions(source.permissions))
  }
  const strongest = strongestInheritedSource(item.sources)
  return strongest ? [strongest] : []
}

/**
 * Folds one inheriting row into a subject's derived access item (creating it
 * on first sight) through the shared pure core, then projects the result back
 * to the app's legacy-exact source shape. The policy core carries richer
 * per-row provenance (grant bits/scope flag, share entries) for the upcoming
 * scoped per-source edit work; this adapter exposes exactly the fields the
 * app consumes today, so importers and tests observe byte-identical items.
 */
export function mergeInheritedAccessItem(
  current: GfsInheritedAccessItem | null,
  contribution: InheritedAccessContribution,
  folder: InheritedAccessFolder
): GfsInheritedAccessItem {
  let folded = current as unknown as PolicyInheritedAccessItem | null
  if (contribution.grantId !== null && contribution.grantId !== '') {
    folded = mergeInheritedAccessPolicy(
      folded,
      {
        subject: contribution.subject,
        permissions: contribution.permissions,
        rowKind: 'grant',
        rowId: contribution.grantId,
        inherit: true,
      },
      folder
    )
  }
  for (const shareId of contribution.shareIds) {
    folded = mergeInheritedAccessPolicy(
      folded,
      {
        subject: contribution.subject,
        permissions: contribution.permissions,
        rowKind: 'share',
        rowId: shareId,
        includeDescendants: true,
      },
      folder
    )
  }
  if (
    (contribution.grantId === null || contribution.grantId === '') &&
    contribution.shareIds.length === 0
  ) {
    folded = mergeInheritedAccessPolicy(
      folded,
      {
        subject: contribution.subject,
        permissions: contribution.permissions,
        rowKind: 'grant',
        rowId: null,
      },
      folder
    )
  }
  return toAppInheritedAccessItem(folded)
}

/** Project a policy item onto the app's legacy-exact item/source shape. */
function toAppInheritedAccessItem(item: PolicyInheritedAccessItem | null): GfsInheritedAccessItem {
  return {
    subject: item?.subject ?? { type: 'user' },
    permissions: [...(item?.permissions ?? [])],
    inheritedFrom: [...(item?.inheritedFrom ?? [])],
    sources: (item?.sources ?? []).map(source => ({
      resourceId: source.resourceId,
      name: source.name,
      permissions: [...source.permissions],
      grantId: source.grantId,
      shareIds: [...source.shareIds],
    })),
  } as GfsInheritedAccessItem
}
