import { DropdownSelect, IconButton, StatusBanner } from '@components/Common'
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
  GfsShareListItem,
} from '@/gfs/delegation.types'
import type { GfsGrantListProps } from './types'
import type { GfsAccessRole } from './types'

type AccessSubjectKind = 'agent' | 'context' | 'team' | 'user' | 'workflow'

function subjectKind(
  subject: GfsGrantListItem['subject'] | GfsShareListItem['subject']
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
 * and user/team ids via the visible team directory; anything unresolved shows
 * its raw id so a row is never hidden or mislabeled.
 */

function subjectLabel(
  subject: GfsGrantListItem['subject'] | GfsShareListItem['subject'],
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
  loading = false,
  error = null,
  shareError = null,
  agents,
  subjects,
  onRevoke,
  onChangeRole,
  onRevokeShare,
  revoking = false,
  revokingShare = false,
  updatingRole = false,
}: GfsGrantListProps) {
  // Grants and shares are independent server surfaces with independent
  // failure modes (R4 spec §2): one list's error suppresses only its own rows
  // and never the other list's rows or revoke actions.
  const showGrantRows = !error && items.length > 0
  const showShareRows = !shareError && shares.length > 0
  const hasRows = showGrantRows || showShareRows
  const hasAnyError = Boolean(error || shareError)

  return (
    <>
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
                const label = subjectLabel(item.subject, agents, subjects)
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
                      <span className="da-gfs-grant-list__label">{label}</span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      <DropdownSelect
                        ariaLabel={`Access role for ${label}`}
                        className="da-gfs-grant-list__role"
                        disabled={updatingRole || !onChangeRole}
                        onChange={value => void onChangeRole?.(item, label, value as GfsAccessRole)}
                        options={ROLE_OPTIONS}
                        placeholder="Role"
                        portal
                        value={roleForPermissions(item.permissions)}
                      />
                    </span>
                    <IconButton
                      className="da-gfs-grant-list__revoke"
                      data-testid={`gfs-revoke-grant-${item.id}`}
                      disabled={revoking}
                      label={`Revoke access for ${label}`}
                      onClick={() => void onRevoke(item, label)}
                      size="xs"
                      variant="ghost"
                    >
                      X
                    </IconButton>
                  </li>
                )
              })
            : null}
          {showShareRows
            ? shares.map(item => {
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
                      <span className="da-gfs-grant-list__role-label">
                        {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                      </span>
                    </span>
                    <IconButton
                      className="da-gfs-grant-list__revoke"
                      data-testid={`gfs-revoke-share-${item.id}`}
                      disabled={revokingShare || !onRevokeShare}
                      label={`Revoke shared access for ${label}`}
                      onClick={() => void onRevokeShare?.(item, label)}
                      size="xs"
                      variant="ghost"
                    >
                      X
                    </IconButton>
                  </li>
                )
              })
            : null}
        </ul>
      ) : !hasAnyError ? (
        loading ? (
          <p className="muted">Loading access…</p>
        ) : (
          <p className="muted">No one has access yet.</p>
        )
      ) : null}
    </>
  )
}

export type { GfsAccessRole, GfsGrantListProps } from './types'
