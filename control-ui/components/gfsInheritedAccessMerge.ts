import type { GfsSubjectInput } from '@lib/api'
import type { GfsInheritedAccessItem, GfsInheritedAccessSource } from './GfsGrantPanel.types'

/**
 * Pure merge core for the client-side inherited-access derivation (R1-M4).
 * No network — everything here is a function of its inputs, which is what
 * the fast-check property suite in
 * `__tests__/gfsInheritedAccessMerge.prop.test.ts` relies on: merge
 * idempotency, no source dropped, effective role = strongest of sources,
 * and a total role order.
 */

/** Stable per-subject merge key. Mirrors the panel's direct-row subject key. */
export function inheritedSubjectKey(subject: { type: string; id?: string }): string {
  return `${subject.type}:${subject.id ?? ''}`
}

/** Editor-strength rows (write/delete/manage_acl) outrank read-only rows. */
export function isEditorPermissions(permissions: string[]): boolean {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
}

/** Total role order over permission sets: Read (0) < Editor (1). */
export function roleRank(permissions: string[]): number {
  return isEditorPermissions(permissions) ? 1 : 0
}

/** The strongest contributing folder: editor beats read, nearest among equals. */
export function strongestInheritedSource(
  sources: GfsInheritedAccessSource[]
): GfsInheritedAccessSource | null {
  return sources.reduce<GfsInheritedAccessSource | null>(
    (strongest, source) =>
      strongest === null || roleRank(strongest.permissions) < roleRank(source.permissions)
        ? source
        : strongest,
    null
  )
}

/**
 * Which ancestor folders a confirmed role change to the target role must
 * touch (R1-H1 semantics, verified against Google Drive):
 * - downgrade: EVERY source whose role is above the target (ancestors at or
 *   below the target stay untouched);
 * - upgrade: the single strongest source (nearest among equals) — the
 *   effective role is the strongest across sources, so one raise is enough;
 * - no-op (target equals the effective role): none.
 */
export function planInheritedRoleChange(
  item: Pick<GfsInheritedAccessItem, 'permissions' | 'sources'>,
  targetRoleIsEditor: boolean
): GfsInheritedAccessSource[] {
  const effectiveIsEditor = isEditorPermissions(item.permissions)
  if (targetRoleIsEditor === effectiveIsEditor) return []
  if (!targetRoleIsEditor) {
    // Downgrade: lower every editor source down to Read.
    return item.sources.filter(source => isEditorPermissions(source.permissions))
  }
  // Upgrade: raise the strongest source (nearest among equals) to Editor.
  const strongest = strongestInheritedSource(item.sources)
  return strongest ? [strongest] : []
}

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
 * on first sight). Pure: never mutates its inputs. EVERY contributing folder
 * is kept as an editable source (R1-H1); a grant and a share for one subject
 * on the same folder consolidate into one source (unioned permissions and
 * row ids) so a confirmed edit mutates them together.
 */
export function mergeInheritedAccessItem(
  current: GfsInheritedAccessItem | null,
  contribution: InheritedAccessContribution,
  folder: InheritedAccessFolder
): GfsInheritedAccessItem {
  if (current === null) {
    return {
      subject: contribution.subject as GfsSubjectInput,
      permissions: [...contribution.permissions],
      inheritedFrom: [folder.name],
      sources: [
        {
          resourceId: folder.resourceId,
          name: folder.name,
          permissions: [...contribution.permissions],
          grantId: contribution.grantId,
          shareIds: [...contribution.shareIds],
        },
      ],
    }
  }
  const next: GfsInheritedAccessItem = {
    ...current,
    permissions: [...new Set([...current.permissions, ...contribution.permissions])],
    inheritedFrom: current.inheritedFrom.includes(folder.name)
      ? [...current.inheritedFrom]
      : [...current.inheritedFrom, folder.name],
    sources: current.sources.map(source => ({ ...source, shareIds: [...source.shareIds] })),
  }
  const sameFolder = next.sources.find(source => source.resourceId === folder.resourceId)
  if (sameFolder) {
    sameFolder.permissions = [...new Set([...sameFolder.permissions, ...contribution.permissions])]
    sameFolder.grantId = sameFolder.grantId ?? contribution.grantId
    sameFolder.shareIds = [...new Set([...sameFolder.shareIds, ...contribution.shareIds])]
  } else {
    next.sources.push({
      resourceId: folder.resourceId,
      name: folder.name,
      permissions: [...contribution.permissions],
      grantId: contribution.grantId,
      shareIds: [...contribution.shareIds],
    })
  }
  return next
}
