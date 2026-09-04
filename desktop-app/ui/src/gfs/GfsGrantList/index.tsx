import { Badge, IconButton, SelectInput, StatusBanner } from '@components/Common'
import type {
  GfsAgentSubjectOption,
  GfsDelegationSubjectOption,
  GfsGrantListItem,
  GfsShareListItem,
} from '@/gfs/delegation.types'
import type { GfsGrantListProps } from './types'
import type { GfsAccessRole } from './types'

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
                return (
                  <li
                    className="da-gfs-grant-list__row"
                    data-testid={`gfs-access-row-grant-${item.id}`}
                    key={`grant:${item.id}`}
                  >
                    <span className="da-gfs-grant-list__identity">
                      <span className="da-gfs-grant-list__label">{label}</span>
                      <span className="da-gfs-grant-list__subject-type">
                        Direct grant · {item.subject.type}
                      </span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      <SelectInput
                        aria-label={`Access role for ${label}`}
                        className="da-gfs-grant-list__role"
                        dense
                        disabled={updatingRole || !onChangeRole}
                        onChange={event =>
                          void onChangeRole?.(
                            item,
                            label,
                            event.currentTarget.value as GfsAccessRole
                          )
                        }
                        value={roleForPermissions(item.permissions)}
                      >
                        <option value="read">Read</option>
                        <option value="editor">Editor</option>
                      </SelectInput>
                      {item.inherit ? <Badge tone="accent">Includes contents</Badge> : null}
                    </span>
                    <IconButton
                      color="danger"
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
                return (
                  <li
                    className="da-gfs-grant-list__row"
                    data-testid={`gfs-access-row-share-${item.id}`}
                    key={`share:${item.id}`}
                  >
                    <span className="da-gfs-grant-list__identity">
                      <span className="da-gfs-grant-list__label">{label}</span>
                      <span className="da-gfs-grant-list__subject-type">
                        Share · {item.subject.type}
                      </span>
                    </span>
                    <span className="da-gfs-grant-list__meta">
                      <span className="da-gfs-grant-list__role-label">
                        {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                      </span>
                      {item.includeDescendants ? (
                        <Badge tone="accent">Includes contents</Badge>
                      ) : null}
                    </span>
                    <IconButton
                      color="danger"
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
          <p className="muted">No direct grants or shares yet.</p>
        )
      ) : null}
    </>
  )
}

export type { GfsAccessRole, GfsGrantListProps } from './types'
