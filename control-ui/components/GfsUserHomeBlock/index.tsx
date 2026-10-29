'use client'

import { useEffect, useRef, useState } from 'react'
import { SingleValueEditDialog } from '@clerum/frontend-components'
import { Button, Field, TextInput } from '@components/ui'
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
  'A bound home folder cannot be moved or renamed from Control UI, so this needs a database correction by an administrator with cluster access. If another item is at the reserved path, first move or rename it in EvenDrive. After the correction, press Retry.'

const CONFLICT_CAUSES: Record<GfsUserHomeConflict, string> = {
  path_conflict: 'An item was found at the reserved home path.',
  ancestor_grant_conflict:
    'An inherited grant or share on the drive root or Users folder exposed home folders.',
  ownership_conflict: 'The owner’s access was removed or reduced by an operator.',
}

function isHomeNotFound(error: unknown): boolean {
  return (error as ApiRequestError)?.code === 'home_not_found'
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

/** The value line: what the operator needs at a glance, never internal identifiers. */
function homeStatusLine(home: GfsUserHome, stillPending: boolean): string {
  if (home.state === 'pending') return stillPending ? 'Still pending' : 'Being created…'
  if (home.state === 'retired') return 'Retired — files kept for operators'
  if (home.resourceId === null) return 'Not created'
  return home.path ?? 'Not available'
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
    return (
      <p className="cu-user-home__detail" role="status">
        Conflict details are unavailable. Refresh the page to check again.
      </p>
    )
  }
  if (detail.code === 'path_conflict') {
    return (
      <section aria-label="Path conflict details" className="cu-user-home__detail">
        {detail.resource ? (
          <p>
            Conflicting {detail.resource.kind}: {detail.resource.path ?? 'path not available'}
          </p>
        ) : (
          <p>The conflicting item no longer exists.</p>
        )}
        {detail.access.length ? (
          <ul aria-label="Access to the conflicting item">
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
      <section aria-label="Ancestor access conflict details" className="cu-user-home__detail">
        {detail.entries.length ? (
          <ul>
            {detail.entries.map((entry, index) => (
              <li
                key={`${entry.resourceId}:${entry.relation}:${entry.subjectType}:${entry.subjectId}:${index}`}
              >
                {entry.path ?? 'Path not available'} — <ConflictAccess access={entry} />
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
    <section aria-label="Owner access conflict details" className="cu-user-home__detail">
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
      <section aria-label="Path conflict recovery" className="cu-user-home__detail">
        <span className="cu-chip">Home moved</span>
        <p>Current home path: {home.path ?? 'Not available'}</p>
        <p>Reserved home path: {reservedPath ?? 'Not available'}</p>
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
    <section aria-label="Path conflict recovery" className="cu-user-home__detail">
      <p>{conflictDescription}</p>
      <p>
        If an item is still at the reserved path, rename or move it in EvenDrive, then press Retry.
        Or press Retry with another name.
      </p>
    </section>
  )
}

export function GfsUserHomeBlock({ userId }: { userId: string }) {
  const [home, setHome] = useState<GfsUserHome | null>(null)
  const [conflictDetail, setConflictDetail] = useState<GfsUserHomeConflictDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [stillPending, setStillPending] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [renameValid, setRenameValid] = useState(true)
  const statusRef = useRef<HTMLElement>(null)
  const focusStatusAfterRename = useRef(false)

  useEffect(() => {
    if (renameOpen || !focusStatusAfterRename.current) return
    focusStatusAfterRename.current = false
    statusRef.current?.focus()
  }, [renameOpen])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setMissing(false)
    setHome(null)
    setConflictDetail(null)
    setStillPending(false)
    setPolling(false)
    void getGfsUserHome(userId, controller.signal)
      .then(({ home: loaded }) => {
        if (controller.signal.aborted) return
        setHome(loaded)
        setConflictDetail(loaded.conflictDetail)
        setPolling(loaded.state === 'pending')
      })
      .catch(caught => {
        if (controller.signal.aborted) return
        if (isHomeNotFound(caught)) setMissing(true)
        else setError(errorMessage(caught))
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
              setStillPending(false)
              setPolling(false)
            }
          })
          .catch(caught => {
            if (controller.signal.aborted) return
            if (isHomeNotFound(caught)) showMissing()
            else setError(errorMessage(caught))
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

  /** The registry has no row for this member: no stale home, conflict or pending line stays. */
  function showMissing() {
    setHome(null)
    setConflictDetail(null)
    setStillPending(false)
    setMissing(true)
  }

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const { home: loaded } = await getGfsUserHome(userId)
      setMissing(false)
      setHome(loaded)
      setConflictDetail(loaded.conflictDetail)
      setStillPending(false)
      // A pending home found by Refresh gets a new polling window, so "Being created…"
      // is only shown while the field is really checking.
      setPolling(loaded.state === 'pending')
    } catch (caught) {
      if (isHomeNotFound(caught)) showMissing()
      else setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A bound home keeps its folder name; an unbound one retries its reserved name or a new
   * one. Returns the failure message, or null when the retry was accepted.
   */
  async function runRetry(newName?: string): Promise<string | null> {
    setBusy(true)
    setError('')
    try {
      const name = bound ? undefined : (newName ?? home?.storageUsername ?? undefined)
      const { home: updated } = await retryGfsUserHome(userId, name)
      setHome(updated)
      setConflictDetail(null)
      setStillPending(false)
      setPolling(updated.state === 'pending')
      return null
    } catch (caught) {
      const requestError = caught as ApiRequestError
      if (requestError?.status === 409 && requestError.code === 'home_not_retryable') {
        return boundPathConflict
          ? `This home could not be retried. If the home is bound: ${BOUND_HOME_RECOVERY}`
          : errorMessage(caught)
      }
      return errorMessage(caught)
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    const failure = await runRetry()
    if (failure) setError(failure)
  }

  async function retryWithName(name: string) {
    setRenameError('')
    const failure = await runRetry(name)
    if (failure) {
      setRenameError(failure)
      return
    }
    // The accepted retry ends the conflict, which removes the button that opened the
    // dialog, so the dialog cannot return focus to it; the status line takes it instead.
    focusStatusAfterRename.current = true
    setRenameOpen(false)
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
  const renameable = home?.state === 'conflict' && home.conflictCode === 'path_conflict' && !bound

  const statusLine = loading
    ? 'Loading…'
    : home
      ? homeStatusLine(home, stillPending)
      : missing
        ? 'No home folder yet'
        : 'Not available'

  return (
    <section aria-labelledby="user-home-title" className="cu-field cu-user-home">
      <div className="cu-field__label" id="user-home-title">
        Home folder
      </div>
      <strong className={loading || missing ? 'cu-muted' : undefined} ref={statusRef} tabIndex={-1}>
        {statusLine}
      </strong>

      {home?.state === 'conflict' && home.conflictCode ? (
        <p className="cu-banner cu-banner--warn" role="status">
          {boundPathConflict
            ? 'The home is not at its reserved path.'
            : CONFLICT_CAUSES[home.conflictCode]}
        </p>
      ) : null}

      {error ? (
        <p className="cu-banner cu-banner--error" role="alert">
          {error}
        </p>
      ) : null}

      {/* The actions sit right under the cause so they stay in view; the longer recovery
          text and the conflict details follow them. */}
      {retryable ||
      ownerConflict ||
      (home?.state === 'pending' && !polling) ||
      (!home && !loading) ? (
        <div className="cu-user-home__actions">
          {retryable ? (
            <Button disabled={busy} onClick={() => void retry()} size="sm" variant="primary">
              Retry
            </Button>
          ) : null}
          {renameable ? (
            <Button
              disabled={busy}
              onClick={() => {
                setRenameError('')
                setRenameValid(Boolean(home?.storageUsername?.trim()))
                setRenameOpen(true)
              }}
              size="sm"
              variant="secondary"
            >
              Retry with another name…
            </Button>
          ) : null}
          {ownerConflict ? (
            <Button disabled={busy} onClick={() => void restoreOwner()} size="sm" variant="primary">
              Restore owner access
            </Button>
          ) : null}
          {(home?.state === 'pending' && !polling) || (!home && !loading) ? (
            <Button disabled={busy} onClick={() => void refresh()} size="sm" variant="ghost">
              Refresh
            </Button>
          ) : null}
        </div>
      ) : null}

      {home?.state === 'conflict' && home.conflictCode ? (
        <>
          {home.conflictCode === 'path_conflict' ? (
            <PathConflictRecovery home={home} detail={conflictDetail} />
          ) : null}
          <ConflictDetails detail={conflictDetail} code={home.conflictCode} />
        </>
      ) : null}

      <SingleValueEditDialog
        discardLabel="Cancel"
        error={renameError || undefined}
        initialValue={home?.storageUsername ?? ''}
        isValid={renameValid}
        onDismiss={() => {
          if (busy) return
          setRenameOpen(false)
          setRenameError('')
        }}
        onSave={value => void retryWithName(value)}
        open={renameOpen}
        pending={busy}
        renderEditor={({ value, onChange, disabled }) => (
          <Field htmlFor="user-home-folder-name" label="Folder name">
            <TextInput
              disabled={disabled}
              id="user-home-folder-name"
              onChange={event => {
                setRenameValid(Boolean(event.target.value.trim()))
                onChange(event.target.value)
              }}
              value={value}
            />
          </Field>
        )}
        saveLabel="Retry"
        title="Retry with another name"
      />
    </section>
  )
}
