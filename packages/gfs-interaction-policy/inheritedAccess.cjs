'use strict'

/**
 * Pure, browser-safe inherited-access policy shared by Control UI and Desktop.
 * Coverage classification, per-subject source merging (every contributing row
 * preserved with its own scope flags), and the scoped role-edit planner.
 * Transports, presentation, and caches stay inside each application.
 */

const GFS_INHERITED_WALK_MAX_DEPTH = 64
const GFS_RETRY_AFTER_MAX_SECONDS = 300

/** Stable per-subject merge key (`operator` carries no id). */
function gfsSubjectKeyOf(subject) {
  return `${subject.type}:${subject.id ?? ''}`
}

/**
 * `/docs/report.md` → `['/docs', '/']` (nearest ancestor first, depth-capped).
 * Segment boundaries are literal path splits; no ancestor id is inferred.
 */
function gfsAncestorPathsOf(path) {
  const segments = (path.startsWith('/') ? path : `/${path}`)
    .split('/')
    .filter(segment => segment.length > 0)
  if (segments.length === 0) return []
  const ancestors = []
  for (let count = segments.length - 1; count > 0; count -= 1) {
    ancestors.push(`/${segments.slice(0, count).join('/')}`)
  }
  ancestors.push('/')
  return ancestors.slice(0, GFS_INHERITED_WALK_MAX_DEPTH)
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * Best-effort HTTP status of a failed read. Explicit structured status wins
 * (Control UI `ApiError.status`); the `httpStatus=` marker appended by the
 * Desktop main process and a leading `NNN` status line follow.
 */
function gfsHttpStatusOf(error) {
  const details = isObject(error) ? error : null
  const structured = details?.status ?? details?.response?.status
  if (structured !== undefined) {
    const structuredNumber = Number(structured)
    if (Number.isInteger(structuredNumber)) return structuredNumber
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const marker = message.match(/\bhttpStatus=(\d{3})\b/)
  if (marker) return Number(marker[1])
  const leading = message.match(/^\s*(\d{3})\b/)
  if (leading) return Number(leading[1])
  return null
}

/** Trailing vetted `retryAfterSeconds=N` marker, clamped to 300 s. */
function gfsRetryAfterSecondsOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const match = message.match(/\bretryAfterSeconds=(\d+)\s*$/)
  if (!match) return null
  return Math.min(Number(match[1]), GFS_RETRY_AFTER_MAX_SECONDS)
}

/**
 * Classify one failed ancestor/target ACL or resolve read:
 * - 'denied'      403 — an expected privacy boundary (view-ACL = manage-ACL),
 *                  never a session failure and never identities to reveal.
 * - 'missing'     404/410 — the folder is gone (moved/tombstoned).
 * - 'rate-limited' 429 — stop the walk, keep partial truth, retry later.
 * - 'retryable'   transient transport (408/425/5xx/network).
 * - 'error'       anything unexpected.
 */
function classifyGfsAclReadFailure(error) {
  const status = gfsHttpStatusOf(error)
  if (status !== null) {
    if (status === 403 || status === 401) return 'denied'
    if (status === 404 || status === 410) return 'missing'
    if (status === 429) return 'rate-limited'
    if (status === 408 || status === 425 || status >= 500) return 'retryable'
    return 'error'
  }
  if (error instanceof TypeError) return 'retryable'
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/\bnetwork\b|\bfetch\b|\btimeout\b|\btimed out\b|\bsocket\b|\bconnection\b/i.test(message)) {
    return 'retryable'
  }
  return 'error'
}

/** Editor-strength rows (write/delete/manage_acl) outrank read-only rows. */
function isEditorGfsPermissions(permissions) {
  return (permissions ?? []).some(permission =>
    ['write', 'delete', 'manage_acl'].includes(permission)
  )
}

/** Total role order over permission sets: Read (0) < Editor (1). */
function gfsRoleRank(permissions) {
  return isEditorGfsPermissions(permissions) ? 1 : 0
}

/** The strongest contributing folder: editor beats read, nearest among equals. */
function strongestGfsInheritedSource(sources) {
  return (sources ?? []).reduce(
    (strongest, source) =>
      strongest === null || gfsRoleRank(strongest.permissions) < gfsRoleRank(source.permissions)
        ? source
        : strongest,
    null
  )
}

/**
 * Fold one contributing ACL row into a subject's derived access item (creating
 * it on first sight). Pure: never mutates its inputs. EVERY contributing
 * folder is kept as a source; a grant and a share for one subject on the same
 * folder consolidate into one source while their row ids, bits, and scope
 * flags (inherit / includeDescendants) stay separately recorded — no OR'd
 * coverage is ever written back from this model.
 *
 * A contribution whose `rowId` is null/absent is an OBSERVATION without an
 * editable row handle (the legacy app cores folded such rows): its
 * permissions still union into the subject's folder source, but no grant id,
 * grant scope flags, or share ids are created or modified.
 */
function mergeGfsInheritedAccessItem(current, contribution, folder) {
  const contributionPermissions = [...(contribution.permissions ?? [])]
  const hasGrantRow =
    contribution.rowKind === 'grant' && contribution.rowId != null && contribution.rowId !== ''
  const hasShareRow =
    contribution.rowKind === 'share' && contribution.rowId != null && contribution.rowId !== ''
  if (current === null) {
    return {
      subject: contribution.subject,
      permissions: [...contributionPermissions],
      inheritedFrom: [folder.name],
      sources: [
        {
          resourceId: folder.resourceId,
          name: folder.name,
          permissions: [...contributionPermissions],
          grantId: hasGrantRow ? contribution.rowId : null,
          shareIds: hasShareRow ? [contribution.rowId] : [],
          grantPermissions: hasGrantRow ? [...contributionPermissions] : null,
          grantInherit: hasGrantRow ? Boolean(contribution.inherit) : null,
          shareEntries: hasShareRow
            ? [
                {
                  rowId: contribution.rowId,
                  permissions: [...contributionPermissions],
                  includeDescendants: Boolean(contribution.includeDescendants),
                },
              ]
            : [],
        },
      ],
    }
  }
  const next = {
    ...current,
    permissions: [...new Set([...(current.permissions ?? []), ...contributionPermissions])],
    inheritedFrom: (current.inheritedFrom ?? []).includes(folder.name)
      ? [...(current.inheritedFrom ?? [])]
      : [...(current.inheritedFrom ?? []), folder.name],
    // Sources may arrive provenance-projected (an app adapter feeding its
    // legacy-exact shape back in): treat missing optional fields as empty.
    sources: (current.sources ?? []).map(source => ({
      ...source,
      shareIds: [...(source.shareIds ?? [])],
      shareEntries: (source.shareEntries ?? []).map(entry => ({ ...entry })),
    })),
  }
  const sameFolder = next.sources.find(source => source.resourceId === folder.resourceId)
  if (sameFolder) {
    sameFolder.permissions = [...new Set([...sameFolder.permissions, ...contributionPermissions])]
    if (hasGrantRow) {
      sameFolder.grantId = sameFolder.grantId ?? contribution.rowId
      sameFolder.grantPermissions = [...contributionPermissions]
      sameFolder.grantInherit = Boolean(contribution.inherit)
    } else if (hasShareRow) {
      sameFolder.shareIds = [...new Set([...(sameFolder.shareIds ?? []), contribution.rowId])]
      sameFolder.shareEntries = [
        ...(sameFolder.shareEntries ?? []).filter(entry => entry.rowId !== contribution.rowId),
        {
          rowId: contribution.rowId,
          permissions: [...contributionPermissions],
          includeDescendants: Boolean(contribution.includeDescendants),
        },
      ]
    }
    // A rowless observation unions permissions only: no row ids or scope
    // flags are touched.
  } else {
    next.sources.push({
      resourceId: folder.resourceId,
      name: folder.name,
      permissions: [...contributionPermissions],
      grantId: hasGrantRow ? contribution.rowId : null,
      shareIds: hasShareRow ? [contribution.rowId] : [],
      grantPermissions: hasGrantRow ? [...contributionPermissions] : null,
      grantInherit: hasGrantRow ? Boolean(contribution.inherit) : null,
      shareEntries: hasShareRow
        ? [
            {
              rowId: contribution.rowId,
              permissions: [...contributionPermissions],
              includeDescendants: Boolean(contribution.includeDescendants),
            },
          ]
        : [],
    })
  }
  return next
}

/**
 * Which ancestor-folder sources a confirmed role change to the target role
 * must touch, split by what this release may edit:
 * - `grantSources`: folder rows backed by a stored grant. A role edit rewrites
 *   exactly these rows, each preserving its own `grantInherit` scope flag.
 * - `shareOnlySources`: folder rows whose only contribution is a URI share.
 *   Shares are view/remove-only in this release, so a downgrade cannot lower
 *   them; callers must disclose that residual access instead of deleting or
 *   rewriting the share.
 * Plan semantics (R1-H1): downgrade = every editor-strength source above the
 * target; upgrade = the single strongest source (nearest among equals); a
 * no-op (target equals the effective role) touches nothing.
 */
function planGfsInheritedRoleChange(item, targetRoleIsEditor) {
  const sources = item.sources ?? []
  const effectiveIsEditor = isEditorGfsPermissions(item.permissions)
  if (targetRoleIsEditor === effectiveIsEditor) {
    return { grantSources: [], shareOnlySources: [] }
  }
  if (!targetRoleIsEditor) {
    const editorSources = sources.filter(source => isEditorGfsPermissions(source.permissions))
    return {
      grantSources: editorSources.filter(source => source.grantId !== null),
      shareOnlySources: editorSources.filter(source => source.grantId === null),
    }
  }
  const strongest = strongestGfsInheritedSource(sources)
  if (strongest === null) return { grantSources: [], shareOnlySources: [] }
  if (strongest.grantId !== null) return { grantSources: [strongest], shareOnlySources: [] }
  // The strongest contributor is a share this release cannot edit; raise the
  // strongest grant-backed source instead and disclose the share residual.
  const grantBacked = sources.filter(source => source.grantId !== null)
  const strongestGrant = strongestGfsInheritedSource(grantBacked) ?? null
  return {
    grantSources: strongestGrant ? [strongestGrant] : [],
    shareOnlySources: [strongest],
  }
}

const GFS_COVERAGE_PRECEDENCE = [
  'error',
  'rate-limited',
  'retryable',
  'missing',
  'denied',
  'depth-cap',
  'complete',
]

/** Worst-first combination of walk-segment classifications for one status. */
function worstGfsCoverageClass(classifications) {
  let worst = 'complete'
  for (const classification of classifications) {
    if (GFS_COVERAGE_PRECEDENCE.indexOf(classification) < GFS_COVERAGE_PRECEDENCE.indexOf(worst)) {
      worst = classification
    }
  }
  return worst
}

module.exports = {
  GFS_INHERITED_WALK_MAX_DEPTH,
  GFS_RETRY_AFTER_MAX_SECONDS,
  classifyGfsAclReadFailure,
  gfsAncestorPathsOf,
  gfsHttpStatusOf,
  gfsRetryAfterSecondsOf,
  gfsRoleRank,
  gfsSubjectKeyOf,
  isEditorGfsPermissions,
  mergeGfsInheritedAccessItem,
  planGfsInheritedRoleChange,
  strongestGfsInheritedSource,
  worstGfsCoverageClass,
}
