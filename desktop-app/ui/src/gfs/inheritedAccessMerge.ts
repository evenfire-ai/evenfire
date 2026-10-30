import {
  gfsRoleRank,
  gfsSubjectKeyOf,
  isEditorGfsPermissions,
  mergeGfsInheritedAccessItem as mergeInheritedAccessPolicy,
} from '@clerum/gfs-interaction-policy'
import type { GfsInheritedAccessItem as PolicyInheritedAccessItem } from '@clerum/gfs-interaction-policy'
import type { GfsInheritedAccessItem, GfsInheritedAccessSource } from './delegation.types'

/**
 * Desktop adapter over the shared inherited-access policy
 * (`@clerum/gfs-interaction-policy`), which owns the pure merge/planner
 * semantics (property tested there). This module keeps the app's historical
 * export surface and contribution shape stable: the Desktop walker hands
 * over rows pre-filtered to inheriting grants and descendant-covering shares,
 * so every translated contribution carries inherit/includeDescendants=true
 * and the same row ids the legacy core recorded.
 */

/** Stable per-subject merge key. */
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

/**
 * Folds one inheriting row into a subject's derived access item (creating it
 * on first sight) through the shared pure core, then projects the result back
 * to the app's source shape INCLUDING the policy's per-row provenance
 * (R1-M5: grant bits/scope flag and share entries survive the projection so
 * role edits can preserve each row's own scope and never touch shares).
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

/** Project a policy item onto the app item/source shape (provenance kept, R1-M5). */
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
      grantPermissions:
        source.grantPermissions === null ? null : [...(source.grantPermissions ?? [])],
      grantInherit: source.grantInherit ?? null,
      shareEntries: (source.shareEntries ?? []).map(entry => ({
        rowId: entry.rowId,
        permissions: [...entry.permissions],
        includeDescendants: entry.includeDescendants,
      })),
    })),
  } as GfsInheritedAccessItem
}
