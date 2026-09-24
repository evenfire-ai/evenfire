'use client'

import React from 'react'
import { DataTable, RowActionMenu, TableViewport } from '@clerum/frontend-components'
import type { WorkflowApprovalMediumAccount } from '../lib/workflowApprovalMediums'

function formatAccount(account: WorkflowApprovalMediumAccount): string {
  if (account.medium === 'telegram') {
    return `user ${account.providerUserId} / chat ${account.providerChannelId || '-'}`
  }
  return `workspace ${account.providerWorkspaceId || '-'} / user ${account.providerUserId} / DM ${
    account.providerChannelId || '-'
  }`
}

export function UserApprovalMediumsTable({
  items,
  loading,
  busy,
  onPrefer,
  onRevoke,
}: {
  items: WorkflowApprovalMediumAccount[]
  loading: boolean
  busy: boolean
  onPrefer: (accountId: string) => void
  onRevoke: (accountId: string) => void
}) {
  return (
    <TableViewport className="cu-table-wrap">
      <DataTable className="eft-table cu-table">
        <thead>
          <tr>
            <th>Medium</th>
            <th>Verified identity</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            [1, 2].map(row => (
              <tr key={row}>
                <td>
                  <div className="cu-skeleton cu-skeleton--cell" style={{ width: '6rem' }} />
                </td>
                <td>
                  <div className="cu-skeleton cu-skeleton--cell" style={{ width: '16rem' }} />
                </td>
                <td>
                  <div className="cu-skeleton cu-skeleton--cell" style={{ width: '6rem' }} />
                </td>
                <td></td>
              </tr>
            ))
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={4}>
                <div className="cu-empty">No verified approval DMs yet.</div>
              </td>
            </tr>
          ) : (
            items.map(account => (
              <tr key={account.id}>
                <td>{account.medium}</td>
                <td>{formatAccount(account)}</td>
                <td>{account.isPreferred ? 'Preferred' : 'Verified'}</td>
                <td className="cu-table__cell-actions">
                  <RowActionMenu
                    ariaLabel={`Actions for ${account.medium} approval account`}
                    actions={[
                      ...(!account.isPreferred
                        ? [
                            {
                              key: 'prefer',
                              label: 'Make preferred',
                              disabled: busy,
                              onSelect: () => onPrefer(account.id),
                            },
                          ]
                        : []),
                      {
                        key: 'revoke',
                        label: 'Revoke',
                        danger: true,
                        disabled: busy,
                        onSelect: () => onRevoke(account.id),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
    </TableViewport>
  )
}
