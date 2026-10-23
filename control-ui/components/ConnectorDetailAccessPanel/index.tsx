'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { DataTable, TableRow, TableStateRow, TableViewport } from '@clerum/frontend-components'
import { RowActionsMenu } from '@components/RowActionsMenu'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { FormSection } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { sortAccessPrincipals } from '@lib/connectorAccess'
import { connectorUserAndTeamAccess } from '@lib/connectorAccessManagement'
import type { ConnectorDetailAccessPanelProps, ConnectorDetailAccessRow } from './types'

function boundaryLabel(boundary: ConnectorDetailAccessPanelProps['boundary']): string {
  return boundary === 'users' ? 'User' : boundary === 'teams' ? 'Team' : 'Agent'
}

function boundaryTitle(boundary: ConnectorDetailAccessPanelProps['boundary']): string {
  return boundary === 'users' ? 'Users' : boundary === 'teams' ? 'Teams' : 'Agents'
}

function routeForPrincipal(
  boundary: ConnectorDetailAccessPanelProps['boundary'],
  principalId: string
): string | undefined {
  if (boundary === 'users') return CONTROL_ROUTES.usersAndTeams.userTab(principalId, 'agents')
  if (boundary === 'teams') return CONTROL_ROUTES.usersAndTeams.teamTab(principalId, 'agents')
  return CONTROL_ROUTES.agents.detail(principalId)
}

function sourceNote(boundary: ConnectorDetailAccessPanelProps['boundary']): string {
  if (boundary === 'users') {
    return 'User access is derived from the agents each user can access. Manage it from the user’s Agents tab.'
  }
  if (boundary === 'teams') {
    return 'Team access is derived from the agents assigned to each team. Manage it from the team’s Agents tab.'
  }
  return 'Connector access is assigned to agents. Changes here refresh the derived Users and Teams views.'
}

export function ConnectorDetailAccessPanel({
  boundary,
  server,
  snapshot,
  agentBindings,
  loading,
  updating,
  error,
  notice,
  onRemove,
}: ConnectorDetailAccessPanelProps) {
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const label = boundaryLabel(boundary)
  const rows = useMemo<ConnectorDetailAccessRow[]>(() => {
    if (boundary === 'agents') {
      return agentBindings.map(binding => ({
        id: binding.contextRef,
        label: binding.agents.map(agent => agent.label).join(', '),
        binding,
      }))
    }
    if (!snapshot) return []
    const access = connectorUserAndTeamAccess(
      { metadata: { name: server.name, namespace: server.namespace } },
      snapshot
    )
    return sortAccessPrincipals(boundary === 'users' ? access.users : access.teams)
  }, [agentBindings, boundary, server.name, server.namespace, snapshot])
  const sortedRows = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...rows].sort(
      (left, right) =>
        left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }) * direction ||
        left.id.localeCompare(right.id)
    )
  }, [rows, sortDirection])
  const columns: TableHeaderColumn[] = [
    {
      key: 'name',
      label,
      activeDirection: sortDirection,
      onSort: () => setSortDirection(value => (value === 'asc' ? 'desc' : 'asc')),
    },
    ...(boundary === 'agents'
      ? [{ key: 'actions', ariaLabel: 'Actions', align: 'right' as const, width: '3.5rem' }]
      : []),
  ]
  const emptyMessage =
    boundary === 'agents'
      ? 'No agents have access to this connector.'
      : boundary === 'users'
        ? 'No users have access through an assigned agent.'
        : 'No teams have access through an assigned agent.'
  const rowLabel = (row: ConnectorDetailAccessRow) =>
    boundary === 'agents' && row.binding?.agents.length === 1
      ? row.binding.agents[0].label
      : row.label

  return (
    <FormSection title={boundaryTitle(boundary)} description={sourceNote(boundary)}>
      {notice ? (
        <p className="cu-muted" role="status">
          {notice}
        </p>
      ) : null}
      {boundary !== 'agents' && snapshot?.warning ? (
        <p className="cu-banner cu-banner--warning" role="status">
          {snapshot.warning}
        </p>
      ) : null}
      <TableViewport className="cu-table-wrap">
        <DataTable className="eft-table cu-table cu-table--header-band">
          <thead>
            <TableHeaderRow columns={columns} />
          </thead>
          <tbody>
            {loading && !snapshot ? (
              <TableStateRow colSpan={columns.length} kind="loading" message="Loading access…" />
            ) : error && !snapshot ? (
              <TableStateRow colSpan={columns.length} kind="error" message={error} />
            ) : sortedRows.length === 0 ? (
              <TableStateRow colSpan={columns.length} message={emptyMessage} />
            ) : (
              sortedRows.map(row => {
                const actionLabel =
                  row.binding?.agents.length === 1
                    ? `Remove from ${row.binding.agents[0].label}`
                    : `Remove from ${row.binding?.agents.length ?? 0} agents`
                return (
                  <TableRow key={row.id}>
                    <td>
                      {boundary === 'agents' && row.binding ? (
                        row.binding.agents.map((agent, index) => (
                          <span key={agent.id}>
                            {index > 0 ? ', ' : null}
                            <Link href={CONTROL_ROUTES.agents.detail(agent.id)}>{agent.label}</Link>
                          </span>
                        ))
                      ) : routeForPrincipal(boundary, row.id) ? (
                        <Link href={routeForPrincipal(boundary, row.id) as string}>
                          {rowLabel(row)}
                        </Link>
                      ) : (
                        rowLabel(row)
                      )}
                    </td>
                    {boundary === 'agents' ? (
                      <td
                        className="cu-table__cell-actions"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                      >
                        <RowActionsMenu
                          ariaLabel={`Actions for connector access to ${rowLabel(row)}`}
                          actions={
                            row.binding
                              ? [
                                  {
                                    key: 'remove-access',
                                    label: actionLabel,
                                    danger: true,
                                    disabled: updating,
                                    onClick: () => onRemove(row.binding!),
                                  },
                                ]
                              : []
                          }
                        />
                      </td>
                    ) : null}
                  </TableRow>
                )
              })
            )}
          </tbody>
        </DataTable>
      </TableViewport>
      {error && snapshot ? (
        <p className="cu-banner cu-banner--error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && snapshot ? (
        <p className="cu-muted" role="status">
          Refreshing access…
        </p>
      ) : null}
    </FormSection>
  )
}
