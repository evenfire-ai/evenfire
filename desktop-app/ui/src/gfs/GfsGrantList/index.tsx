import { useEffect, useMemo, useState } from 'react'
import { Alert, Avatar, Empty, Flex, Listy, Select, Spin, Tooltip, Typography } from 'antd'
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
 * that directory has no name this surface can act on, so its row is filtered
 * and one muted line explains what isn't listed and why; unresolved host ids
 * keep their raw identifier (the agent tail is meaningful). No row is ever
 * mislabeled, and a filtered list never claims to be empty.
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

type AccessListRow = {
  key: string
  testId: string
  inherited?: boolean
  subject: { type: string; id?: string }
  label: string
  permissions: string[]
  selectableRole: boolean
  roleDisabled: boolean
  onRoleChange?: (role: GfsAccessRole) => void | Promise<void>
  onRemove: () => void | Promise<void>
  removeDisabled: boolean
}

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
      // A directory-less member has no name this surface can act on.
      if (isHiddenSubject(inherited.subject, subjects)) continue
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
  }, [inheritedItems, items, mergeInherited, shares, subjects])

  // Grants and shares are independent server surfaces with independent
  // failure modes (R4 spec §2): one list's error suppresses only its own rows
  // and never the other list's rows or revoke actions.
  const visibleItems = error ? [] : items.filter(item => !isHiddenSubject(item.subject, subjects))
  const visibleShares = shareError
    ? []
    : shares.filter(share => !isHiddenSubject(share.subject, subjects))
  // How many rows the filter removed: drives the muted explanation line and
  // the honest empty state (a filtered list never claims to be empty). An
  // errored surface's rows are error-suppressed, not filtered — never count
  // them, or a failure would be reported as a directory gap.
  const hiddenInheritedCount = mergeInherited
    ? inheritedItems.filter(item => isHiddenSubject(item.subject, subjects)).length
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

  const rows: AccessListRow[] = []
  if (showGrantRows) {
    visibleItems.forEach(item => {
      if (mergedByKey.has(subjectKey(item.subject))) return
      const label = subjectLabel(item.subject, agents, subjects)
      rows.push({
        key: `grant:${item.id}`,
        testId: `gfs-access-row-grant-${item.id}`,
        subject: item.subject,
        label,
        permissions: item.permissions,
        selectableRole: true,
        roleDisabled: updatingRole || !onChangeRole,
        onRoleChange: role => onChangeRole?.(item, label, role),
        onRemove: () => onRevoke(item, label),
        removeDisabled: revoking,
      })
    })
  }
  if (showMergedRows) {
    ;[...mergedByKey.values()].forEach(row => {
      const label = subjectLabel(row.subject, agents, subjects)
      rows.push({
        key: `inherited:${subjectKey(row.subject)}`,
        testId: `gfs-access-row-inherited-${subjectKey(row.subject)}`,
        inherited: true,
        subject: row.subject,
        label,
        permissions: row.permissions,
        selectableRole: true,
        roleDisabled: updatingRole || !onChangeInheritedRole,
        onRoleChange: role => onChangeInheritedRole?.(row, label, role),
        onRemove: () => onRemoveInherited?.(row, label),
        removeDisabled: revoking || !onRemoveInherited,
      })
    })
  }
  if (showShareRows) {
    visibleShares.forEach(item => {
      if (mergedByKey.has(subjectKey(item.subject))) return
      const label = subjectLabel(item.subject, agents, subjects)
      rows.push({
        key: `share:${item.id}`,
        testId: `gfs-access-row-share-${item.id}`,
        subject: item.subject,
        label,
        permissions: item.permissions,
        selectableRole: false,
        roleDisabled: false,
        onRemove: () => onRevokeShare?.(item, label),
        removeDisabled: revokingShare || !onRevokeShare,
      })
    })
  }

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
        <Tooltip
          trigger={['hover', 'focus']}
          title={
            stableNotice === derivationNotice ? (derivationNoticeHint ?? undefined) : undefined
          }
        >
          <div tabIndex={0}>
            <Alert showIcon type="info" title={stableNotice} />
          </div>
        </Tooltip>
      ) : null}
      {hasAnyError ? (
        <Flex vertical gap="small" data-testid="gfs-access-list-error">
          {error ? (
            <Alert
              showIcon
              type={error.severity === 'quiet' ? 'info' : 'error'}
              title={error.message}
            />
          ) : null}
          {shareError ? (
            <Alert
              showIcon
              type={shareError.severity === 'quiet' ? 'info' : 'error'}
              title={shareError.message}
            />
          ) : null}
        </Flex>
      ) : null}
      {hasRows ? (
        <div role="list" aria-label="Resource access">
          <Listy
            items={rows}
            rowKey="key"
            virtual={false}
            itemRender={row => {
              const kind = subjectKind(row.subject)
              return (
                <div
                  data-inherited={row.inherited ? 'true' : undefined}
                  data-testid={row.testId}
                  role="listitem"
                >
                  <Flex align="center" justify="space-between" wrap>
                    <Flex align="center" gap="small">
                      <Avatar
                        aria-hidden="true"
                        className={`da-gfs-grant-list__avatar da-gfs-grant-list__avatar--${kind}`}
                        data-subject-kind={kind}
                        icon={<AccessSubjectIcon kind={kind} />}
                        size={30}
                      />
                      <Typography.Text>{row.label}</Typography.Text>
                    </Flex>
                    <Flex align="center" gap="small" wrap>
                      {row.selectableRole ? (
                        <Select
                          aria-label={`Access role for ${row.label}`}
                          disabled={row.roleDisabled}
                          onChange={value => void row.onRoleChange?.(value as GfsAccessRole)}
                          options={ROLE_OPTIONS}
                          size="small"
                          value={roleForPermissions(row.permissions)}
                        />
                      ) : (
                        <Typography.Text>
                          {roleForPermissions(row.permissions) === 'editor' ? 'Editor' : 'Read'}
                        </Typography.Text>
                      )}
                      <AccessRowMenu
                        disabled={row.removeDisabled}
                        label={row.label}
                        onRemove={row.onRemove}
                      />
                    </Flex>
                  </Flex>
                </div>
              )
            }}
          />
        </div>
      ) : !hasAnyError && hiddenCount > 0 ? (
        // The filter removed every row: never claim an empty folder.
        loading ? (
          <Flex align="center" gap="small">
            <Spin size="small" />
            <Typography.Text>Loading access…</Typography.Text>
          </Flex>
        ) : (
          <Typography.Text type="secondary">{ONLY_HIDDEN_ACCESS_NOTICE}</Typography.Text>
        )
      ) : !hasAnyError ? (
        loading ? (
          <Flex align="center" gap="small">
            <Spin size="small" />
            <Typography.Text>Loading access…</Typography.Text>
          </Flex>
        ) : derivationNotice ? null : (
          <Empty description="No one has access yet." />
        )
      ) : null}
    </>
  )
}

export type { GfsAccessRole, GfsGrantListProps } from './types'
