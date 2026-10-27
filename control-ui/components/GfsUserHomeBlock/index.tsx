'use client'

import { useEffect, useState } from 'react'
import {
  type GfsUserHome,
  type GfsUserHomeConflict,
  type GfsUserHomeConflictAccess,
  type GfsUserHomeConflictDetail,
  getGfsUserHome,
  restoreGfsUserHomeOwner,
  retryGfsUserHome,
} from '@lib/api'
import type { ApiRequestError } from '@lib/api.types'

const POLL_INTERVAL_MS = 5_000
const POLL_WINDOW_MS = 60_000
const OWNER_PERMISSIONS = ['read', 'write', 'delete', 'share', 'manage_acl']

const CONFLICT_CAUSES: Record<GfsUserHomeConflict, string> = {
  path_conflict: 'Another item already exists at the reserved home path.',
  ancestor_grant_conflict:
    'An inherited grant or share on the drive root or Users folder exposes home folders.',
  ownership_conflict: 'The owner’s access was removed or reduced by an operator.',
}

function errorMessage(error: unknown): string {
  const requestError = error as ApiRequestError
  if (requestError?.code === 'invalid_name') {
    return 'Enter a valid folder name. Use a name accepted by the home folder naming policy.'
  }
  return error instanceof Error ? error.message : 'Could not load or update the home folder.'
}

function ConflictAccess({ access }: { access: GfsUserHomeConflictAccess }) {
  return (
    <>
      {access.relation === 'grant' ? 'Grant' : 'Share'} — {access.subjectType}
      {access.subjectLabel ? `: ${access.subjectLabel}` : ''}
      {access.subjectId ? ` (${access.subjectId})` : ''}
      {'; '}Permissions: {access.permissions.length ? access.permissions.join(', ') : 'none'}
      {'; '}Includes contents: {access.inherit ? 'yes' : 'no'}
    </>
  )
}

function ConflictDetails({
  detail,
  code,
}: {
  detail: GfsUserHomeConflictDetail | null
  code: GfsUserHomeConflict
}) {
  if (!detail || detail.code !== code) {
    return <p role="status">Conflict details are unavailable. Refresh the page to check again.</p>
  }
  if (detail.code === 'path_conflict') {
    return (
      <section aria-label="Path conflict details">
        {detail.resource ? (
          <dl>
            <dt>Conflicting path</dt>
            <dd>{detail.resource.path}</dd>
            <dt>Resource ID</dt>
            <dd>{detail.resource.resourceId}</dd>
            <dt>Kind</dt>
            <dd>{detail.resource.kind}</dd>
            <dt>Created</dt>
            <dd>{detail.resource.createdAt}</dd>
          </dl>
        ) : (
          <p>The conflicting item no longer exists.</p>
        )}
        <h3>Access to the conflicting item</h3>
        {detail.access.length ? (
          <ul>
            {detail.access.map((access, index) => (
              <li key={`${access.relation}:${access.subjectType}:${access.subjectId}:${index}`}>
                <ConflictAccess access={access} />
              </li>
            ))}
          </ul>
        ) : (
          <p>No grants or shares were returned for this item.</p>
        )}
      </section>
    )
  }
  if (detail.code === 'ancestor_grant_conflict') {
    return (
      <section aria-label="Ancestor access conflict details">
        {detail.entries.length ? (
          <ul>
            {detail.entries.map((entry, index) => (
              <li
                key={`${entry.resourceId}:${entry.relation}:${entry.subjectType}:${entry.subjectId}:${index}`}
              >
                <p>
                  Path: {entry.path}; resource ID: {entry.resourceId}
                </p>
                <p>
                  <ConflictAccess access={entry} />
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No conflicting entries were returned. Refresh the page to check again.</p>
        )}
      </section>
    )
  }
  const missing = OWNER_PERMISSIONS.filter(
    permission => !detail.ownerGrant?.permissions.includes(permission)
  )
  return (
    <section aria-label="Owner access conflict details">
      {detail.ownerGrant ? (
        <p>
          Current permissions:{' '}
          {detail.ownerGrant.permissions.length ? detail.ownerGrant.permissions.join(', ') : 'none'}
          . Includes contents: {detail.ownerGrant.inherit ? 'yes' : 'no'}.
        </p>
      ) : (
        <p>The owner grant is missing.</p>
      )}
      <p>Missing permissions: {missing.length ? missing.join(', ') : 'none'}.</p>
      {!detail.ownerGrant?.inherit ? <p>Access does not include the folder contents.</p> : null}
    </section>
  )
}

export function GfsUserHomeBlock({ userId }: { userId: string }) {
  const [home, setHome] = useState<GfsUserHome | null>(null)
  const [conflictDetail, setConflictDetail] = useState<GfsUserHomeConflictDetail | null>(null)
  const [folderName, setFolderName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [stillPending, setStillPending] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setHome(null)
    setConflictDetail(null)
    setStillPending(false)
    setPolling(false)
    void getGfsUserHome(userId, controller.signal)
      .then(({ home: loaded }) => {
        if (controller.signal.aborted) return
        setHome(loaded)
        setConflictDetail(loaded.conflictDetail)
        setFolderName(loaded.storageUsername ?? '')
      })
      .catch(caught => {
        if (!controller.signal.aborted) setError(errorMessage(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [userId])

  useEffect(() => {
    if (!polling) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => {
      controller.abort()
      setStillPending(true)
      setPolling(false)
    }, POLL_WINDOW_MS)

    function schedule() {
      timer = setTimeout(() => {
        void getGfsUserHome(userId, controller.signal)
          .then(({ home: loaded }) => {
            if (controller.signal.aborted) return
            setHome(loaded)
            setConflictDetail(loaded.conflictDetail)
            if (loaded.state === 'pending') {
              schedule()
            } else {
              setFolderName(loaded.storageUsername ?? '')
              setStillPending(false)
              setPolling(false)
            }
          })
          .catch(caught => {
            if (controller.signal.aborted) return
            setError(errorMessage(caught))
            setPolling(false)
          })
      }, POLL_INTERVAL_MS)
    }
    schedule()
    return () => {
      controller.abort()
      clearTimeout(deadline)
      if (timer) clearTimeout(timer)
    }
  }, [polling, userId])

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const { home: loaded } = await getGfsUserHome(userId)
      setHome(loaded)
      setConflictDetail(loaded.conflictDetail)
      setFolderName(loaded.storageUsername ?? '')
      if (loaded.state !== 'pending') setStillPending(false)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    setBusy(true)
    setError('')
    try {
      const name = home?.storageUsername === null && folderName === '' ? undefined : folderName
      const { home: updated } = await retryGfsUserHome(userId, name)
      setHome(updated)
      setConflictDetail(null)
      setStillPending(false)
      setPolling(updated.state === 'pending')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function restoreOwner() {
    setBusy(true)
    setError('')
    try {
      const { home: updated } = await restoreGfsUserHomeOwner(userId)
      setHome(updated)
      setConflictDetail(null)
      setStillPending(false)
      setPolling(updated.state === 'pending')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const retryable =
    home?.state === 'conflict' &&
    (home.conflictCode === 'path_conflict' || home.conflictCode === 'ancestor_grant_conflict')
  const ownerConflict = home?.state === 'conflict' && home.conflictCode === 'ownership_conflict'

  return (
    <section aria-labelledby="user-home-title" className="cu-card">
      <div className="cu-card__body">
        <h2 id="user-home-title">Home folder</h2>
        {loading ? <p role="status">Loading home folder…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {home ? (
          <>
            <dl>
              <dt>State</dt>
              <dd>{home.state}</dd>
              <dt>Path</dt>
              <dd>{home.path ?? 'Not available'}</dd>
              <dt>Drive</dt>
              <dd>{home.drive ?? 'Not assigned'}</dd>
              <dt>Resource ID</dt>
              <dd data-testid="home-resource-id">{home.resourceId ?? 'Not available'}</dd>
            </dl>
            {home.driveMismatch ? <p role="status">This home is on a different drive.</p> : null}
            {home.state === 'conflict' && home.conflictCode ? (
              <>
                <p role="alert">{CONFLICT_CAUSES[home.conflictCode]}</p>
                <ConflictDetails detail={conflictDetail} code={home.conflictCode} />
              </>
            ) : null}
            {retryable ? (
              <div className="cu-field">
                <label htmlFor="user-home-folder-name">Folder name</label>
                <input
                  className="cu-input"
                  id="user-home-folder-name"
                  value={folderName}
                  onChange={event => setFolderName(event.currentTarget.value)}
                  disabled={busy}
                />
                <button
                  className="cu-btn cu-btn--primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void retry()}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {ownerConflict ? (
              <button
                className="cu-btn cu-btn--primary"
                type="button"
                disabled={busy}
                onClick={() => void restoreOwner()}
              >
                Restore owner access
              </button>
            ) : null}
            {home.state === 'pending' ? (
              <div>
                {stillPending ? <p role="status">Still pending</p> : null}
                {polling ? (
                  <p role="status">Checking home folder status…</p>
                ) : (
                  <button
                    className="cu-btn cu-btn--ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    Refresh
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : !loading ? (
          <button
            className="cu-btn cu-btn--ghost"
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        ) : null}
      </div>
    </section>
  )
}
