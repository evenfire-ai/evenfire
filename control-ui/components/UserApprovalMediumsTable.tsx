'use client'

import React from 'react'
import { DataTable } from '@clerum/frontend-table-system'
import type { WorkflowApprovalMediumAccount } from '../lib/workflowApprovalMediums'
import { IconX } from './icons'

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
    <div className="eft-table-viewport cu-table-wrap">
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
                <td>
                  <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                    {!account.isPreferred && (
                      <button
                        type="button"
                        className="cu-btn cu-btn--ghost cu-btn--sm"
                        onClick={() => onPrefer(account.id)}
                        disabled={busy}
                      >
                        Prefer
                      </button>
                    )}
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--danger-icon"
                      onClick={() => onRevoke(account.id)}
                      disabled={busy}
                      title="Revoke"
                      aria-label={`Revoke ${account.medium} approval DM`}
                    >
                      <IconX width={16} height={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
    </div>
  )
}
