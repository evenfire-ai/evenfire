'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { SelectionDropdown } from '@components/SelectionDropdown'
import type { AdminUser, WorkflowGrantUser } from '../../lib/api'
import { getAdminUsers, listWorkflowGrants, setWorkflowGrants } from '../../lib/api'

export type GrantsPanelProps =
  | {
      mode: 'edit'
      namespace: string
      recipeName: string
      selectedUserIds: string[]
      onSelectedChange: (next: string[]) => void
      inlineError?: string | null
    }
  | {
      mode: 'create'
      selectedUserIds: string[]
      onSelectedChange: (next: string[]) => void
      inlineError?: string | null
    }

export function GrantsPanel(props: GrantsPanelProps): React.JSX.Element {
  const { mode, selectedUserIds, onSelectedChange, inlineError } = props
  const { confirm, confirmDialog } = useConfirmDialog()
  const [grantsFromServer, setGrantsFromServer] = useState<WorkflowGrantUser[] | null>(null)
  const [allUsers, setAllUsers] = useState<AdminUser[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mutating, setMutating] = useState(false)
  const [mutateError, setMutateError] = useState<string | null>(null)
  const [pickUserIds, setPickUserIds] = useState<string[]>([])
  const editNamespace = mode === 'edit' ? props.namespace : ''
  const editRecipeName = mode === 'edit' ? props.recipeName : ''

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadGrants = useCallback(
    async (namespace: string, recipeName: string) => {
      if (!mountedRef.current) return
      setLoadError(null)
      try {
        const res = await listWorkflowGrants(namespace, recipeName)
        if (!mountedRef.current) return
        setGrantsFromServer(res.items ?? [])
        onSelectedChange((res.items ?? []).map(g => g.id))
      } catch (err) {
        if (!mountedRef.current) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load grants')
      }
    },
    [onSelectedChange]
  )

  const loadUsers = useCallback(async () => {
    if (!mountedRef.current) return
    setLoadError(null)
    try {
      const res = await getAdminUsers('')
      if (!mountedRef.current) return
      setAllUsers(res.items ?? [])
    } catch (err) {
      if (!mountedRef.current) return
      setLoadError(err instanceof Error ? err.message : 'Failed to load users')
    }
  }, [])

  useEffect(() => {
    loadUsers()
    if (mode === 'edit') {
      loadGrants(editNamespace, editRecipeName)
    }
  }, [editNamespace, editRecipeName, loadGrants, loadUsers, mode])

  async function replaceGrants(nextUserIds: string[]) {
    if (mode === 'create') {
      onSelectedChange(nextUserIds)
      return
    }
    if (!mountedRef.current) return
    setMutating(true)
    setMutateError(null)
    try {
      await setWorkflowGrants(props.namespace, props.recipeName, nextUserIds)
      await loadGrants(props.namespace, props.recipeName)
    } catch (err) {
      if (!mountedRef.current) return
      setMutateError(err instanceof Error ? err.message : 'Failed to save grants')
    } finally {
      if (mountedRef.current) setMutating(false)
    }
  }

  async function handleGrant() {
    if (pickUserIds.length === 0) return
    const next = Array.from(new Set([...selectedUserIds, ...pickUserIds]))
    setPickUserIds([])
    await replaceGrants(next)
  }

  async function handleRevoke(userId: string) {
    if (mode === 'edit') {
      const user = displayList.find(item => item.id === userId)
      const shouldRevoke = await confirm({
        title: 'Revoke Workflow Access',
        message: `Revoke workflow trigger access for ${user?.displayName || user?.name || user?.email || 'this user'}?`,
        confirmLabel: 'Revoke',
        tone: 'danger',
      })
      if (!shouldRevoke) return
    }

    const next = selectedUserIds.filter(id => id !== userId)
    await replaceGrants(next)
  }

  const selectedSet = new Set(selectedUserIds)
  const ungrantedUsers = (allUsers ?? []).filter(u => !selectedSet.has(u.id))
  const userOptions = useMemo(
    () =>
      ungrantedUsers.map(user => ({
        value: user.id,
        label: user.displayName || user.name || user.email || user.id,
        description: user.email || user.id,
      })),
    [ungrantedUsers]
  )
  const displayList: Array<{
    id: string
    email: string
    name: string | null
    displayName: string | null
  }> =
    mode === 'edit' ? (grantsFromServer ?? []) : (allUsers ?? []).filter(u => selectedSet.has(u.id))
  const countLabel =
    mode === 'edit'
      ? grantsFromServer === null
        ? '…'
        : String(grantsFromServer.length)
      : String(selectedUserIds.length)

  return (
    <div className="cu-workflow-access__section" data-testid="grants-panel">
      <div className="cu-workflow-access__section-head">
        <div>
          <div className="cu-workflow-access__section-title">Authorized users</div>
          <p className="cu-workflow-access__section-description">
            Users allowed to trigger this workflow.
          </p>
        </div>
        <span className="cu-workflow-access__count">{countLabel}</span>
      </div>
      {(loadError || inlineError) && (
        <div className="cu-workflow-access__error" role="alert">
          {inlineError ?? loadError}
        </div>
      )}
      {mutateError && (
        <div className="cu-workflow-access__error" role="alert">
          {mutateError}
        </div>
      )}
      {displayList.length === 0 && (
        <div className="cu-workflow-access__empty">
          {mode === 'create'
            ? 'No users selected. Add admins below before deploy, or grant access later via Edit.'
            : 'No users have been granted trigger access yet.'}
        </div>
      )}
      {displayList.length > 0 && (
        <div className="cu-workflow-access__rows">
          {displayList.map(u => (
            <div className="cu-workflow-access__row" key={u.id}>
              <div className="cu-workflow-access__row-main">
                <span className="cu-workflow-access__row-title">
                  {u.displayName || u.name || u.email}
                </span>
                {u.displayName || u.name ? (
                  <span className="cu-workflow-access__row-meta">{u.email}</span>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={`Revoke access for ${u.email}`}
                disabled={mutating}
                onClick={() => void handleRevoke(u.id)}
                className="cu-btn cu-btn--ghost-danger cu-btn--sm"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {allUsers !== null && (
        <div className="cu-workflow-access__picker">
          <SelectionDropdown
            id="workflow-grants-user-picker"
            value={pickUserIds}
            onChange={setPickUserIds}
            options={userOptions}
            placeholder={ungrantedUsers.length === 0 ? 'All users already granted' : 'Pick users'}
            searchPlaceholder="Search users..."
            selectionLabel="Selected users"
            emptyLabel="All users already granted."
            disabled={mutating || ungrantedUsers.length === 0}
          />
          <button
            type="button"
            onClick={handleGrant}
            disabled={pickUserIds.length === 0 || mutating}
            className="cu-btn cu-btn--primary cu-btn--sm"
          >
            Grant
          </button>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
