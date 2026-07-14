'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { DashboardLayout } from '@components/DashboardLayout'
import { SectionSearchInput } from '@components/SectionSearchInput'
import { IconSharedFiles } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconRefresh, IconX } from '@components/icons'
import { Button } from '@components/ui'
import {
  type SharedFileSystemResource,
  deleteSharedFileSystem,
  getSharedFileSystems,
  isSilentApiError,
} from '@lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'

const SHARED_FILE_SYSTEM_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'phase', label: 'Phase' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'storage-class', label: 'Storage Class' },
  { key: 'mounted-by-contexts', label: 'Mounted by Contexts' },
  { key: 'actions', label: 'Actions', width: '8rem', align: 'right' },
]

const DELETE_REFRESH_DELAY_MS = 1200
const DELETE_REFRESH_ATTEMPTS = 6

/**
 * Lists every SharedFileSystem CRD (always in mcp-host namespace in v1) and
 * surfaces the status reported by HCC's sharedFileSystemReconciler. Clicking
 * a row drills into the per-SFS file browser at /shared-filesystems/[name].
 *
 * Admin can create + delete SharedFileSystems from this view; HCC reconciles
 * PVC + init Job + workspace-files-controller Deployment + Service +
 * NetworkPolicies in the background.
 */
export default function SharedFileSystemsPage() {
  const { authState } = useAuth()
  const router = useRouter()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<SharedFileSystemResource[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [deletingNames, setDeletingNames] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const load = useCallback(
    async (options: { silent?: boolean; toastOnError?: boolean } = {}) => {
      const { silent = false, toastOnError = false } = options
      if (!silent) setLoading(true)
      if (!silent) setError('')
      try {
        const r = await getSharedFileSystems()
        const nextItems = (r.items || []) as SharedFileSystemResource[]
        setItems(nextItems)
        return nextItems
      } catch (e) {
        if (isSilentApiError(e)) return null
        const message = e instanceof Error ? e.message : 'Failed to load shared filesystems'
        if (toastOnError) showToast(message, { tone: 'error' })
        else setError(message)
        return null
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [showToast]
  )

  const markDeleting = useCallback((name: string, deleting: boolean) => {
    if (!mountedRef.current) return
    setDeletingNames(current => {
      const next = new Set(current)
      if (deleting) next.add(name)
      else next.delete(name)
      return next
    })
  }, [])

  async function waitForDeletionToDisappear(name: string) {
    for (let attempt = 0; attempt < DELETE_REFRESH_ATTEMPTS; attempt++) {
      await delay(DELETE_REFRESH_DELAY_MS)
      if (!mountedRef.current) return

      const latest = await load({
        silent: true,
        toastOnError: attempt === DELETE_REFRESH_ATTEMPTS - 1,
      })
      if (!latest) continue
      if (!latest.some(item => item.metadata?.name === name)) {
        markDeleting(name, false)
        return
      }
    }

    markDeleting(name, false)
    showToast(`Shared filesystem "${name}" is still being removed. Refresh again in a moment.`, {
      tone: 'info',
      durationMs: 6000,
    })
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void load()
    }
  }, [authState.isLoggedIn, authState.isLoading, load])

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  async function handleDelete(name: string) {
    if (deletingNames.has(name)) return

    setError('')
    markDeleting(name, true)
    try {
      await deleteSharedFileSystem(name)
      setDeleteTarget(null)
      showToast(`Shared filesystem "${name}" is being deleted.`, { tone: 'success' })

      const latest = await load({ silent: true, toastOnError: true })
      if (!latest || latest.some(item => item.metadata?.name === name)) {
        void waitForDeletionToDisappear(name)
        return
      }
      markDeleting(name, false)
    } catch (e) {
      if (isSilentApiError(e)) return
      markDeleting(name, false)
      showToast(e instanceof Error ? e.message : 'Delete failed', { tone: 'error' })
    }
  }

  if (authState.isLoading) {
    return (
      <DashboardLayout>
        <div className="cu-card cu-card--viewport-fill">
          <TablePanelHeader
            title={
              <>
                <IconSharedFiles />
                Shared Files
              </>
            }
            subtitle="Workspace volumes that Contexts can mount read-only into agent pods."
          />
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={SHARED_FILE_SYSTEM_COLUMNS} />
              </thead>
              <tbody>
                <SkeletonTableRows columns={SHARED_FILE_SYSTEM_COLUMNS.length} rows={5} />
              </tbody>
            </table>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  if (!authState.isLoggedIn) {
    return null
  }

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredItems = normalizedSearch
    ? items.filter(item => {
        const name = item.metadata?.name || ''
        const phase = item.status?.phase || ''
        const storageClass = item.status?.storageClassName || item.spec?.storageClassName || ''
        return [name, phase, storageClass].join(' ').toLowerCase().includes(normalizedSearch)
      })
    : items
  const isInitialLoad = loading && items.length === 0

  return (
    <DashboardLayout>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={
            <>
              <IconSharedFiles />
              {isInitialLoad ? 'Shared Files' : `Shared Files (${filteredItems.length})`}
            </>
          }
          subtitle="Workspace volumes that Contexts can mount read-only into agent pods."
          actions={
            <>
              <SectionSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search shared files"
                ariaLabel="Search shared files"
                disabled={isInitialLoad}
              />
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void load()}
                disabled={loading || isInitialLoad}
                aria-label={loading ? 'Refreshing shared files' : 'Refresh shared files'}
              >
                <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => router.push('/shared-filesystems/new')}
                disabled={isInitialLoad}
              >
                New
              </button>
            </>
          }
        />

        {error ? (
          <div className="cu-card__body">
            <div className="cu-banner cu-banner--error">{error}</div>
          </div>
        ) : null}

        {filteredItems.length === 0 && !loading ? (
          <div className="cu-card__body">
            <div className="cu-empty">
              {normalizedSearch ? (
                'No shared files match this search.'
              ) : (
                <>
                  No SharedFileSystems yet. Click <strong>New</strong> to create one
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={SHARED_FILE_SYSTEM_COLUMNS} />
              </thead>
              <tbody>
                {filteredItems.map(item => {
                  const name = item.metadata?.name || ''
                  const isDeleting = deletingNames.has(name)
                  const status = item.status || {}
                  const mountedBy = status.mountedByContexts || []
                  const phase = status.phase || 'Unknown'
                  const phaseClass =
                    phase === 'Ready'
                      ? 'cu-badge cu-badge--ok'
                      : phase === 'Failed' || phase === 'Degraded'
                        ? 'cu-badge cu-badge--error'
                        : 'cu-badge'
                  return (
                    <tr
                      key={name}
                      className="cu-table__row cu-table__row--clickable"
                      onClick={() => {
                        if (!isDeleting) {
                          router.push(`/shared-filesystems/${encodeURIComponent(name)}`)
                        }
                      }}
                      onKeyDown={e => {
                        if (isDeleting) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          router.push(`/shared-filesystems/${encodeURIComponent(name)}`)
                        }
                      }}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open shared filesystem ${name}`}
                    >
                      <td>
                        <span className="cu-link">{name}</span>
                      </td>
                      <td>
                        <span className={phaseClass}>{phase}</span>
                      </td>
                      <td>{status.capacity || item.spec?.size || '—'}</td>
                      <td>{status.storageClassName || item.spec?.storageClassName || '—'}</td>
                      <td>
                        {mountedBy.length === 0
                          ? '—'
                          : mountedBy.map(c => `${c.namespace}/${c.name}`).join(', ')}
                      </td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--danger-icon"
                          onClick={() => setDeleteTarget(name)}
                          disabled={isDeleting}
                          aria-label={
                            isDeleting ? `Deleting ${name}` : `Delete shared filesystem ${name}`
                          }
                        >
                          <IconX width={16} height={16} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget ? (
        <DeleteSharedFileSystemModal
          name={deleteTarget}
          busy={deletingNames.has(deleteTarget)}
          onCancel={() => {
            if (!deletingNames.has(deleteTarget)) setDeleteTarget(null)
          }}
          onConfirm={() => void handleDelete(deleteTarget)}
        />
      ) : null}
    </DashboardLayout>
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function DeleteSharedFileSystemModal({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ModalShell title="Delete shared filesystem" onClose={() => !busy && onCancel()}>
      <div className="cu-modal-panel__body">
        <p className="cu-modal-copy">
          Delete SharedFileSystem <strong>{name}</strong>? This removes the files controller
          Deployment and Service. Storage is kept when retainOnDelete is enabled.
        </p>
      </div>
      <div className="cu-modal-panel__foot">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </ModalShell>
  )
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="cu-modal-panel cu-modal-panel--narrow"
        role="dialog"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 className="cu-modal-panel__title">{title}</h3>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
