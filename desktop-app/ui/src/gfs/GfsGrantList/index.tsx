import { Badge, Button, Pill, StatusBanner } from '@components/Common'
import { GFS_PERMISSION_LABELS } from '@/gfs/GfsPermissionDropdown/constants'
import type {
  GfsAgentSubjectOption,
  GfsDelegationSubjectOption,
  GfsGrantListItem,
} from '@/gfs/delegation.types'
import type { GfsGrantListProps } from './types'

/**
 * "Who has access" — the resource's current grants, sourced from the user-plane
 * grants GET (the only revoke-id source: the grant PUT returns no ids). Subject
 * labels resolve host ids to agent names via the caller's own agent directory
 * and user/team ids via the visible team directory; anything unresolved shows
 * its raw id so a row is never hidden or mislabeled.
 */

function subjectLabel(
  subject: GfsGrantListItem['subject'],
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

export function GfsGrantList({
  items,
  loading = false,
  error = null,
  agents,
  subjects,
  onRevoke,
  revoking = false,
}: GfsGrantListProps) {
  if (error) {
    return (
      <StatusBanner tone={error.severity === 'quiet' ? 'info' : 'error'} text={error.message} />
    )
  }
  if (loading && items.length === 0) {
    return <p className="muted">Loading access…</p>
  }
  if (items.length === 0) {
    return <p className="muted">No one has been granted access yet.</p>
  }

  return (
    <ul className="da-gfs-grant-list">
      {items.map(item => {
        const label = subjectLabel(item.subject, agents, subjects)
        return (
          <li className="da-gfs-grant-list__row" key={item.id}>
            <span className="da-gfs-grant-list__identity">
              <span className="da-gfs-grant-list__label">{label}</span>
              <span className="da-gfs-grant-list__subject-type">{item.subject.type}</span>
            </span>
            <span className="da-gfs-grant-list__meta">
              <span className="da-gfs-grant-list__chips">
                {item.permissions.map(permission => (
                  <Pill key={permission} size="xs" tone="neutral">
                    {GFS_PERMISSION_LABELS[permission] ?? permission}
                  </Pill>
                ))}
              </span>
              {item.inherit ? <Badge tone="accent">Includes contents</Badge> : null}
            </span>
            <Button
              aria-label={`Revoke access for ${label}`}
              color="danger"
              disabled={revoking}
              onClick={() => void onRevoke(item, label)}
              size="sm"
              type="button"
              variant="outline"
            >
              Revoke
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

export type { GfsGrantListProps } from './types'
