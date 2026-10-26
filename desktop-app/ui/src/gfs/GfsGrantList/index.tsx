import { useMemo } from 'react'
import { DropdownSelect, StatusBanner } from '@components/Common'
import {
  IconAgents,
  IconContexts,
  IconTeams,
  IconUser,
  IconWorkflows,
} from '@components/SidebarNav/icons'
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
 * that directory renders as "Hidden user"/"Hidden team" — never a raw UUID —
 * and carries a hover explanation (plus the id for support) on the row; no row
 * is ever hidden or mislabeled.
 */

const HIDDEN_USER_LABEL = 'Hidden user'
const HIDDEN_TEAM_LABEL = 'Hidden team'

/** The hidden-kind of a user/team subject the visible directory cannot name;
 *  null when the subject resolves (or is not a directory-resolved kind). */
function hiddenSubjectKind(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject'],
  subjects: GfsDelegationSubjectOption[]
): 'user' | 'team' | null {
  if ((subject.type === 'user' || subject.type === 'team') && subject.id) {
    const match = subjects.find(
      candidate => candidate.type === subject.type && candidate.id === subject.id
    )
    if (!match) return subject.type
  }
  return null
}

/** One-phrase hover explanation for a subject the directory cannot name. */
function hiddenSubjectTitle(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject'],
  subjects: GfsDelegationSubjectOption[]
): string | null {
  const kind = hiddenSubjectKind(subject, subjects)
  if (kind === 'user' && subject.type === 'user' && subject.id) {
    return `This member isn’t in any of your teams, so EvenDrive can’t show their name. (${subject.id})`
  }
  if (kind === 'team' && subject.type === 'team' && subject.id) {
    return `This team isn’t in your team list, so EvenDrive can’t show its name. (${subject.id})`
  }
  return null
}

/** Accessible name for a hidden subject: the label alone would collide when a
 *  folder has more than one hidden member, so the id disambiguates for screen
 *  readers and menus while the visible row stays clean. */
function subjectAccessibleName(
  subject:
    | GfsGrantListItem['subject']
    | GfsShareListItem['subject']
    | GfsInheritedAccessItem['subject'],
  subjects: GfsDelegationSubjectOption[],
  label: string
): string {
  const hidden = hiddenSubjectKind(subject, subjects)
  if (!hidden) return label
  const id = subject.type === 'user' || subject.type === 'team' ? (subject.id ?? '') : ''
  return id ? `${label} (${id})` : label
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
    return subject.type === 'user' ? HIDDEN_USER_LABEL : HIDDEN_TEAM_LABEL
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
  onRevoke,
  onChangeRole,
  onChangeInheritedRole,
  onRemoveInherited,
  onRevokeShare,
  revoking = false,
  revokingShare = false,
  updatingRole = false,
}: GfsGrantListProps) {
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
  }, [inheritedItems, items, mergeInherited, shares])

  // Grants and shares are independent server surfaces with independent
  // failure modes (R4 spec §2): one list's error suppresses only its own rows
  // and never the other list's rows or revoke actions.
  const showGrantRows = !error && items.length > 0
  const showShareRows = !shareError && shares.length > 0
  // Merged rows are a client-derived supplement: they render whenever the
  // derivation produced them, including while a direct list failed quietly.
  const showMergedRows = mergedByKey.size > 0
  const hasRows = showGrantRows || showShareRows || showMergedRows
  const hasAnyError = Boolean(error || shareError)

  return (
    <>
      {derivationNotice ? (
        <StatusBanner
          tone="info"
          text={derivationNotice}
          title={derivationNoticeHint ?? undefined}
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
            ? items.map(item => {
                if (mergedByKey.has(subjectKey(item.subject))) return null
                const label = subjectLabel(item.subject, agents, subjects)
                const accessibleName = subjectAccessibleName(item.subject, subjects, label)
                const hiddenTitle = hiddenSubjectTitle(item.subject, subjects)
                const kind = subjectKind(item.subject)
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
                    <span className="da-gfs-grant-list__identity">
                      <span className="da-gfs-grant-list__label" title={hiddenTitle ?? undefined}>
                        {label}
                      </span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      <DropdownSelect
                        ariaLabel={`Access role for ${accessibleName}`}
                        className="da-gfs-grant-list__role"
                        disabled={updatingRole || !onChangeRole}
                        onChange={value => void onChangeRole?.(item, label, value as GfsAccessRole)}
                        options={ROLE_OPTIONS}
                        placeholder="Role"
                        portal
                        value={roleForPermissions(item.permissions)}
                      />
                    </span>
                    <AccessRowMenu
                      disabled={revoking}
                      label={accessibleName}
                      onRemove={() => onRevoke(item, label)}
                    />
                  </li>
                )
              })
            : null}
          {showMergedRows
            ? [...mergedByKey.values()].map(row => {
                const label = subjectLabel(row.subject, agents, subjects)
                const accessibleName = subjectAccessibleName(row.subject, subjects, label)
                const hiddenTitle = hiddenSubjectTitle(row.subject, subjects)
                const kind = subjectKind(row.subject)
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
                    <span className="da-gfs-grant-list__identity">
                      <span className="da-gfs-grant-list__label" title={hiddenTitle ?? undefined}>
                        {label}
                      </span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      {/* Normal toggleable row: any edit opens the
                          parent-folder confirmation in the page. */}
                      <DropdownSelect
                        ariaLabel={`Access role for ${accessibleName}`}
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
                    </span>
                    <AccessRowMenu
                      disabled={revoking || !onRemoveInherited}
                      label={accessibleName}
                      onRemove={() => void onRemoveInherited?.(row, label)}
                    />
                  </li>
                )
              })
            : null}
          {showShareRows
            ? shares.map(item => {
                if (mergedByKey.has(subjectKey(item.subject))) return null
                const label = subjectLabel(item.subject, agents, subjects)
                const accessibleName = subjectAccessibleName(item.subject, subjects, label)
                const hiddenTitle = hiddenSubjectTitle(item.subject, subjects)
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
                      <span className="da-gfs-grant-list__label" title={hiddenTitle ?? undefined}>
                        {label}
                      </span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      <span className="da-gfs-grant-list__role-label">
                        {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                      </span>
                    </span>
                    <AccessRowMenu
                      disabled={revokingShare || !onRevokeShare}
                      label={accessibleName}
                      onRemove={() => onRevokeShare?.(item, label)}
                    />
                  </li>
                )
              })
            : null}
        </ul>
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
