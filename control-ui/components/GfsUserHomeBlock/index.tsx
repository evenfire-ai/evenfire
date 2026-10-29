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
const BOUND_HOME_RECOVERY =
  'A bound home folder cannot be moved or renamed from Control UI, so this needs a database correction by an administrator with cluster access. If another item is at the reserved path, first move or rename it in the Control UI GFS browser on drive main. After the correction, press Retry.'

const CONFLICT_CAUSES: Record<GfsUserHomeConflict, string> = {
  path_conflict: 'An item was found at the reserved home path.',
  ancestor_grant_conflict:
    'An inherited grant or share on the drive root or Users folder exposed home folders.',
  ownership_conflict: 'The owner’s access was removed or reduced by an operator.',
}

function errorMessage(error: unknown): string {
  const requestError = error as ApiRequestError
  if (requestError?.code === 'invalid_name') {
    return 'Enter a valid folder name. Use a name accepted by the home folder naming policy.'
  }
  if (requestError?.code === 'home_not_retryable') {
    return 'This home changed since the page loaded and cannot be retried as shown. Refresh to see its current state.'
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
            <dd>{detail.resource.path ?? 'Not available'}</dd>
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
                  Path: {entry.path ?? 'Not available'}; resource ID: {entry.resourceId}
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

function PathConflictRecovery({
  home,
  detail,
}: {
  home: GfsUserHome
  detail: GfsUserHomeConflictDetail | null
}) {
  const reservedPath = home.storageUsername === null ? null : `/Users/${home.storageUsername}`
  if (home.resourceId !== null) {
    return (
      <section aria-label="Path conflict recovery">
        <span className="cu-chip">Home moved</span>
        <dl>
          <dt>Current home path</dt>
          <dd>{home.path ?? 'Not available'}</dd>
          <dt>Reserved home path</dt>
          <dd>{reservedPath ?? 'Not available'}</dd>
        </dl>
        <p>{BOUND_HOME_RECOVERY}</p>
      </section>
    )
  }

  const resource = detail?.code === 'path_conflict' ? detail.resource : undefined
  const pathLabel = reservedPath ?? 'the reserved home path'
  const conflictDescription =
    resource === null
      ? `The item that occupied ${pathLabel} no longer exists.`
      : resource?.path && resource.path === reservedPath
        ? `Another item occupies ${pathLabel}.`
        : `An item was found at ${pathLabel}.`
  return (
    <section aria-label="Path conflict recovery">
      <p>{conflictDescription}</p>
      <p>
        In the Control UI GFS browser on drive main, if an item is still at the reserved path,
        rename or move it, then press Retry. Or enter a different folder name and press Retry.
      </p>
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
        setPolling(loaded.state === 'pending')
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
            setHome(previous =>
              JSON.stringify(previous) === JSON.stringify(loaded) ? previous : loaded
            )
            setConflictDetail(previous =>
              JSON.stringify(previous) === JSON.stringify(loaded.conflictDetail)
                ? previous
                : loaded.conflictDetail
            )
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
      const name =
        bound || (home?.storageUsername === null && folderName === '') ? undefined : folderName
      const { home: updated } = await retryGfsUserHome(userId, name)
      setHome(updated)
      setConflictDetail(null)
      setStillPending(false)
      setPolling(updated.state === 'pending')
    } catch (caught) {
      const requestError = caught as ApiRequestError
      if (requestError?.status === 409 && requestError.code === 'home_not_retryable') {
        setError(
          boundPathConflict
            ? `This home could not be retried. If the home is bound: ${BOUND_HOME_RECOVERY}`
            : errorMessage(caught)
        )
      } else {
        setError(errorMessage(caught))
      }
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
  const bound = home?.resourceId != null
  const boundPathConflict =
    home?.state === 'conflict' && home.conflictCode === 'path_conflict' && home.resourceId !== null

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
            {home.state === 'conflict' && home.conflictCode ? (
              <>
                <p role="alert">
                  {boundPathConflict
                    ? 'The home is not at its reserved path.'
                    : CONFLICT_CAUSES[home.conflictCode]}
                </p>
                {home.conflictCode === 'path_conflict' ? (
                  <PathConflictRecovery home={home} detail={conflictDetail} />
                ) : null}
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
                  readOnly={bound}
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
