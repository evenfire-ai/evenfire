import { useEffect, useMemo, useState } from 'react'
import { isEditorGfsPermissions } from '@clerum/gfs-interaction-policy'
import { DropdownSelect, StatusBanner } from '@components/Common'
import {
  IconAgents,
  IconContexts,
  IconTeams,
  IconUser,
  IconWorkflows,
} from '@components/SidebarNav/icons'
import { permissionsForRole } from '@/gfs/delegation'
import type {
  GfsAgentSubjectOption,
  GfsDelegationSubjectOption,
  GfsGrantListItem,
  GfsInheritedAccessItem,
  GfsShareListItem,
} from '@/gfs/delegation.types'
import { AccessRowMenu } from './AccessRowMenu'
import type { GfsGrantListProps, GfsMergedAccessRow } from './types'
import type { GfsAccessRole } from './types'

type AccessSubjectKind = 'agent' | 'context' | 'team' | 'user' | 'workflow'

function subjectKey(subject: { type: string; id?: string }): string {
  return `${subject.type}:${subject.id ?? ''}`
}

function canChangeSubjectRole(
  subject: { type: string; id?: string },
  agents: GfsAgentSubjectOption[]
): boolean {
  if (subject.type === 'context') return false
  return subject.type !== 'host' || agents.some(agent => agent.id === subject.id)
}

function subjectKind(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject']
): AccessSubjectKind {
  if (subject.type === 'team') return 'team'
  if (subject.type === 'host') return subject.id?.startsWith('3rd:') ? 'workflow' : 'agent'
  if (subject.type === 'context') return 'context'
  return 'user'
}

function AccessSubjectIcon({ kind }: { kind: AccessSubjectKind }) {
  if (kind === 'agent') return <IconAgents />
  if (kind === 'context') return <IconContexts />
  if (kind === 'team') return <IconTeams />
  if (kind === 'workflow') return <IconWorkflows />
  return <IconUser />
}

/**
 * "Who has access" — the resource's current grants, sourced from the user-plane
 * grants GET (the only revoke-id source: the grant PUT returns no ids). Subject
 * labels resolve host ids to agent names via the caller's own agent directory
 * and user/team ids via the visible team directory. A user/team subject outside
 * that directory has no name this surface can act on, so its row is filtered
 * and one muted line explains what isn't listed and why; unresolved host ids
 * keep their raw identifier (the agent tail is meaningful). No row is ever
 * mislabeled, and a filtered list never claims to be empty. The home owner's
 * row follows the same rule, except that the owner always sees their own row in
 * their own home.
 */

/** One informational banner explains the filter. The hidden-members sentence
 *  subsumes the derivation notice (it already covers access inherited from
 *  parent folders), so the surface never shows both. */
const HIDDEN_ACCESS_NOTICE =
  'Members outside your teams aren’t listed here. Access can also follow from parent folders you cannot see.'

/** The muted empty state when the filter removed every row. */
const ONLY_HIDDEN_ACCESS_NOTICE = 'Only members outside your teams have access here.'

/** True when a user/team subject is not in the caller's visible directory —
 *  the surface cannot name it, so the row is filtered out. */
function isHiddenSubject(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject'],
  subjects: GfsDelegationSubjectOption[]
): boolean {
  if ((subject.type === 'user' || subject.type === 'team') && subject.id) {
    return !subjects.some(
      candidate => candidate.type === subject.type && candidate.id === subject.id
    )
  }
  return false
}

function subjectLabel(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject'],
  agents: GfsAgentSubjectOption[],
  subjects: GfsDelegationSubjectOption[]
): string {
  if (subject.type === 'host' && subject.id) {
    const agent = agents.find(candidate => candidate.id === subject.id)
    // Visible agent name (spec.displayName); fall back to the id-based `name`
    // when the displayName is absent or blank/whitespace-only.
    if (agent) return (agent.displayName ?? '').trim() || agent.name
    if (subject.id.startsWith('3rd:')) return subject.id.split('/').at(-1) || subject.id
  }
  if ((subject.type === 'user' || subject.type === 'team') && subject.id) {
    const match = subjects.find(
      candidate => candidate.type === subject.type && candidate.id === subject.id
    )
    if (match) return match.label
  }
  return subject.id ?? subject.type
}

function roleForPermissions(permissions: string[]): GfsAccessRole {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
    ? 'editor'
    : 'read'
}

const ROLE_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'editor', label: 'Editor' },
]

export function GfsGrantList({
  items,
  shares = [],
  inheritedItems = [],
  mergeInherited = false,
  loading = false,
  derivationNotice = null,
  derivationNoticeHint = null,
  error = null,
  shareError = null,
  agents,
  subjects,
  isOwnHomeRoot,
  onRevoke,
  onChangeRole,
  onChangeInheritedRole,
  onRemoveInherited,
  onRevokeShare,
  onLowerShare,
  revoking = false,
  revokingShare = false,
  updatingRole = false,
}: GfsGrantListProps) {
  const ownHomeOwnerGrant = (grant: GfsGrantListItem | null | undefined) =>
    grant?.homeOwner === true && isOwnHomeRoot?.(grant.resourceId) === true
  const ownHomeOwnerRow = (
    inherited: GfsInheritedAccessItem,
    grant: GfsGrantListItem | null | undefined
  ) =>
    (inherited.homeOwner === true &&
      inherited.sources.some(source => isOwnHomeRoot?.(source.resourceId) === true)) ||
    ownHomeOwnerGrant(grant)
  // File dialogs dedupe to exactly one row per member across the direct
  // grant, direct shares, and derived ancestor access; the merged row keeps
  // the strongest effective role. Direct rows for a merged subject are
  // consumed so the member never renders twice.
  const mergedByKey = useMemo(() => {
    const merged = new Map<string, GfsMergedAccessRow>()
    if (!mergeInherited) return merged
    for (const inherited of inheritedItems) {
      const key = subjectKey(inherited.subject)
      const grant = items.find(item => subjectKey(item.subject) === key) ?? null
      const subjectShares = shares.filter(share => subjectKey(share.subject) === key)
      if (!ownHomeOwnerRow(inherited, grant) && isHiddenSubject(inherited.subject, subjects))
        continue
      merged.set(key, {
        subject: inherited.subject,
        permissions: [
          ...new Set([
            ...inherited.permissions,
            ...(grant?.permissions ?? []),
            ...subjectShares.flatMap(share => share.permissions),
          ]),
        ],
        grant,
        shares: subjectShares,
        inherited,
      })
    }
    return merged
    // ownHomeOwnerRow reads `isOwnHomeRoot`; the dependency keeps the memo in
    // step with a late-ready home.
  }, [inheritedItems, isOwnHomeRoot, items, mergeInherited, shares, subjects])

  // Grants and shares are independent server surfaces with independent
  // failure modes (R4 spec §2): one list's error suppresses only its own rows
  // and never the other list's rows or revoke actions.
  const visibleItems = error
    ? []
    : items.filter(item => ownHomeOwnerGrant(item) || !isHiddenSubject(item.subject, subjects))
  const visibleShares = shareError
    ? []
    : shares.filter(share => !isHiddenSubject(share.subject, subjects))
  // How many rows the filter removed: drives the muted explanation line and
  // the honest empty state (a filtered list never claims to be empty). An
  // errored surface's rows are error-suppressed, not filtered — never count
  // them, or a failure would be reported as a directory gap.
  const hiddenInheritedCount = mergeInherited
    ? inheritedItems.filter(item => {
        const key = subjectKey(item.subject)
        const grant = items.find(candidate => subjectKey(candidate.subject) === key)
        return !ownHomeOwnerRow(item, grant) && isHiddenSubject(item.subject, subjects)
      }).length
    : 0
  const hiddenCount =
    (error ? 0 : items.length - visibleItems.length) +
    (shareError ? 0 : shares.length - visibleShares.length) +
    hiddenInheritedCount
  const showGrantRows = visibleItems.length > 0
  const showShareRows = visibleShares.length > 0
  // Merged rows are a client-derived supplement: they render whenever the
  // derivation produced them, including while a direct list failed quietly.
  const showMergedRows = mergedByKey.size > 0
  const hasRows = showGrantRows || showShareRows || showMergedRows
  const hasAnyError = Boolean(error || shareError)

  // ONE informational banner. The hidden-members sentence subsumes the
  // derivation notice when it applies (it already covers access inherited
  // from parent folders), so the surface never shows two overlapping lines.
  // The last stable text survives refetch/loading cycles — recomputing from
  // live props made the notice blink while the lists reloaded.
  const noticeText = hiddenCount > 0 ? HIDDEN_ACCESS_NOTICE : derivationNotice
  const [stableNotice, setStableNotice] = useState(derivationNotice)
  useEffect(() => {
    if (!loading) setStableNotice(noticeText)
  }, [loading, noticeText])

  return (
    <>
      {stableNotice ? (
        <StatusBanner
          tone="info"
          text={stableNotice}
          title={
            stableNotice === derivationNotice ? (derivationNoticeHint ?? undefined) : undefined
          }
        />
      ) : null}
      {hasAnyError ? (
        <div className="da-gfs-grant-list__errors" data-testid="gfs-access-list-error">
          {error ? (
            <StatusBanner
              tone={error.severity === 'quiet' ? 'info' : 'error'}
              text={error.message}
            />
          ) : null}
          {shareError ? (
            <StatusBanner
              tone={shareError.severity === 'quiet' ? 'info' : 'error'}
              text={shareError.message}
            />
          ) : null}
        </div>
      ) : null}
      {hasRows ? (
        <ul className="da-gfs-grant-list" aria-label="Resource access">
          {showGrantRows
            ? visibleItems.map(item => {
                if (mergedByKey.has(subjectKey(item.subject))) return null
                const label = subjectLabel(item.subject, agents, subjects)
                const kind = subjectKind(item.subject)
                const ownerProtected = item.homeOwner === true
                return (
                  <li
                    className="da-gfs-grant-list__row"
                    data-testid={`gfs-access-row-grant-${item.id}`}
                    key={`grant:${item.id}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`da-gfs-grant-list__avatar da-gfs-grant-list__avatar--${kind}`}
                      data-subject-kind={kind}
                    >
                      <AccessSubjectIcon kind={kind} />
                    </span>
                    {ownerProtected && isHiddenSubject(item.subject, subjects) ? null : (
                      <span className="da-gfs-grant-list__identity">
                        <span className="da-gfs-grant-list__label">{label}</span>
                      </span>
                    )}
                    <span className="da-gfs-grant-list__meta">
                      {ownerProtected ? (
                        <span className="da-gfs-grant-list__role-label">Owner</span>
                      ) : !canChangeSubjectRole(item.subject, agents) ? (
                        <span className="da-gfs-grant-list__role-label">
                          {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                        </span>
                      ) : (
                        <DropdownSelect
                          ariaLabel={`Access role for ${label}`}
                          className="da-gfs-grant-list__role"
                          disabled={updatingRole || !onChangeRole}
                          onChange={value =>
                            void onChangeRole?.(item, label, value as GfsAccessRole)
                          }
                          options={ROLE_OPTIONS}
                          placeholder="Role"
                          portal
                          value={roleForPermissions(item.permissions)}
                        />
                      )}
                    </span>
                    {!ownerProtected ? (
                      <AccessRowMenu
                        disabled={revoking}
                        label={label}
                        onRemove={() => onRevoke(item, label)}
                      />
                    ) : null}
                  </li>
                )
              })
            : null}
          {showMergedRows
            ? [...mergedByKey.values()].map(row => {
                const label = subjectLabel(row.subject, agents, subjects)
                const kind = subjectKind(row.subject)
                const ownerProtected =
                  row.grant?.homeOwner === true || row.inherited?.homeOwner === true
                return (
                  <li
                    className="da-gfs-grant-list__row"
                    data-inherited="true"
                    data-testid={`gfs-access-row-inherited-${subjectKey(row.subject)}`}
                    key={`inherited:${subjectKey(row.subject)}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`da-gfs-grant-list__avatar da-gfs-grant-list__avatar--${kind}`}
                      data-subject-kind={kind}
                    >
                      <AccessSubjectIcon kind={kind} />
                    </span>
                    {ownerProtected && isHiddenSubject(row.subject, subjects) ? null : (
                      <span className="da-gfs-grant-list__identity">
                        <span className="da-gfs-grant-list__label">{label}</span>
                      </span>
                    )}
                    <span className="da-gfs-grant-list__meta">
                      {/* Normal toggleable row: any edit opens the
                          parent-folder confirmation in the page. */}
                      {ownerProtected ? (
                        <span className="da-gfs-grant-list__role-label">Owner</span>
                      ) : !canChangeSubjectRole(row.subject, agents) ? (
                        <span className="da-gfs-grant-list__role-label">
                          {roleForPermissions(row.permissions) === 'editor' ? 'Editor' : 'Read'}
                        </span>
                      ) : (
                        <DropdownSelect
                          ariaLabel={`Access role for ${label}`}
                          className="da-gfs-grant-list__role"
                          disabled={updatingRole || !onChangeInheritedRole}
                          onChange={value =>
                            void onChangeInheritedRole?.(row, label, value as GfsAccessRole)
                          }
                          options={ROLE_OPTIONS}
                          placeholder="Role"
                          portal
                          value={roleForPermissions(row.permissions)}
                        />
                      )}
                    </span>
                    {!ownerProtected ? (
                      <AccessRowMenu
                        disabled={revoking || !onRemoveInherited}
                        label={label}
                        onRemove={() => void onRemoveInherited?.(row, label)}
                      />
                    ) : null}
                  </li>
                )
              })
            : null}
          {showShareRows
            ? visibleShares.map(item => {
                if (mergedByKey.has(subjectKey(item.subject))) return null
                const label = subjectLabel(item.subject, agents, subjects)
                const kind = subjectKind(item.subject)
                return (
                  <li
                    className="da-gfs-grant-list__row"
                    data-testid={`gfs-access-row-share-${item.id}`}
                    key={`share:${item.id}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`da-gfs-grant-list__avatar da-gfs-grant-list__avatar--${kind}`}
                      data-subject-kind={kind}
                    >
                      <AccessSubjectIcon kind={kind} />
                    </span>
                    <span className="da-gfs-grant-list__identity">
                      <span className="da-gfs-grant-list__label">{label}</span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      {onRevokeShare &&
                      isEditorGfsPermissions(item.permissions) &&
                      permissionsForRole('read', false, item.permissions).length > 0 &&
                      canChangeSubjectRole(item.subject, agents) ? (
                        <DropdownSelect
                          ariaLabel={`Access role for ${label}`}
                          className="da-gfs-grant-list__role"
                          disabled={updatingRole || !onLowerShare}
                          onChange={value => {
                            if (value === 'read') void onLowerShare?.(item, label)
                          }}
                          options={ROLE_OPTIONS}
                          placeholder="Role"
                          portal
                          value="editor"
                        />
                      ) : (
                        <span className="da-gfs-grant-list__role-label">
                          {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                        </span>
                      )}
                    </span>
                    <AccessRowMenu
                      disabled={revokingShare || !onRevokeShare}
                      label={label}
                      onRemove={() => onRevokeShare?.(item, label)}
                    />
                  </li>
                )
              })
            : null}
        </ul>
      ) : !hasAnyError && hiddenCount > 0 ? (
        // The filter removed every row: never claim an empty folder.
        loading ? (
          <p className="muted">Loading access…</p>
        ) : (
          <p className="muted">{ONLY_HIDDEN_ACCESS_NOTICE}</p>
        )
      ) : !hasAnyError ? (
        loading ? (
          <p className="muted">Loading access…</p>
        ) : derivationNotice ? null : (
          <p className="muted">No one has access yet.</p>
        )
      ) : null}
    </>
  )
}

export type { GfsAccessRole, GfsGrantListProps } from './types'
