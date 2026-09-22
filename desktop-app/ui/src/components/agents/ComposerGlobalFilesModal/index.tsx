import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, StatusBanner } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { IconChevronRight, IconClose, IconContexts } from '@components/SidebarNav/icons'
import {
  type GfsDiscoveryFailure,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError, isRateLimited, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { formatSharedFileSize } from '@lib/sharedFiles'
import type { ComposerGlobalFileReference } from '@/uiTypes'
import type { ComposerGlobalFileSelection, ComposerGlobalFilesModalProps } from './types'

function referenceId(drive: string, resourceId: string): string {
  return `global-file:${drive}:${resourceId}`
}

export function ComposerGlobalFilesModal({ onAdd, onClose }: ComposerGlobalFilesModalProps) {
  const ctrl = useGfsBrowserController()
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [selected, setSelected] = useState<ComposerGlobalFileSelection>({})

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const toggleFile = useCallback((file: ComposerGlobalFileReference) => {
    setSelected(previous => {
      if (previous[file.id]) {
        const next = { ...previous }
        delete next[file.id]
        return next
      }
      return { ...previous, [file.id]: file }
    })
  }, [])

  const selectedFiles = useMemo(() => Object.values(selected), [selected])
  const entries = ctrl.current ? ctrl.items : ctrl.accessibleResources
  const loading = ctrl.current ? ctrl.loading : ctrl.loadingAccessible
  // Present the verdict, never the transport. Until discovery failures were
  // classified by signal, every rejection of the `gfs:listAccessible` channel
  // became a friendly notice here; now only a 404 does, so a 429 would have
  // put the raw "Error invoking remote method …" string in front of the user.
  const rawError = ctrl.current ? ctrl.error : ctrl.accessibleError
  const error = rawError ? describeGfsReadError(rawError).message : null
  const hasMore = ctrl.current ? ctrl.hasMore : ctrl.hasMoreAccessible
  const loadingMore = ctrl.current ? ctrl.isFetchingMore : ctrl.isFetchingMoreAccessible
  const loadMore = ctrl.current ? ctrl.loadMore : ctrl.loadMoreAccessible
  // A refused read is not an empty picker. Without this the modal answered a
  // 429 with "No shared files yet" — a claim about the user's library that the
  // rejected request never established — and offered nothing to retry, so the
  // only exit was to close the modal and reopen it, spending another request
  // against the budget that had just refused one.
  //
  // `unsupported` stays out: that server cannot list at all, and a Retry button
  // would promise an endpoint that will not appear. The existing info banner
  // already explains it, and the empty state below is what the user gets.
  const blockingFailure = useMemo<{
    failure: GfsDiscoveryFailure
    retry: () => void
  } | null>(() => {
    if (entries.length > 0) return null
    if (!ctrl.current) {
      return ctrl.discoveryFailure && ctrl.discoveryFailure.kind !== 'unsupported'
        ? { failure: ctrl.discoveryFailure, retry: ctrl.retryDiscovery }
        : null
    }
    if (!ctrl.error) return null
    const kind = isRateLimited(ctrl.error) ? 'rate-limited' : 'failed'
    const retryAfterSeconds = parseRetryAfterSeconds(ctrl.error)
    return {
      failure: {
        kind,
        message: ctrl.error,
        retryAfterSeconds,
        retryAvailableAt:
          kind === 'rate-limited' && retryAfterSeconds !== null
            ? ctrl.errorUpdatedAt + retryAfterSeconds * 1000
            : null,
      },
      retry: ctrl.retryChildren,
    }
  }, [
    ctrl.current,
    ctrl.discoveryFailure,
    ctrl.error,
    ctrl.errorUpdatedAt,
    ctrl.retryChildren,
    ctrl.retryDiscovery,
    entries.length,
  ])

  return (
    <div
      className="composer-global-files-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="composer-global-files-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-global-files-title"
      >
        <header className="composer-global-files-header">
          <span className="composer-global-files-heading-icon" aria-hidden="true">
            <IconContexts />
          </span>
          <span className="composer-global-files-heading">
            <span className="composer-global-files-eyebrow">Global File System</span>
            <h3 id="composer-global-files-title">Choose files for this message</h3>
            <span className="muted">Browse shared folders and select multiple files.</span>
          </span>
          <IconButton
            ref={closeButtonRef}
            label="Close global file picker"
            onClick={onClose}
            size="sm"
            variant="ghost"
          >
            <IconClose />
          </IconButton>
        </header>

        <nav className="composer-global-files-breadcrumbs" aria-label="Global file path">
          <Button
            className="composer-global-files-crumb"
            color="neutral"
            onClick={ctrl.reset}
            size="xs"
            variant="text"
          >
            Shared files
          </Button>
          {ctrl.crumbs.map((crumb, index) => (
            <span className="composer-global-files-crumb-group" key={crumb.resourceId}>
              <IconChevronRight aria-hidden="true" />
              <Button
                className="composer-global-files-crumb"
                color="neutral"
                disabled={index === ctrl.crumbs.length - 1}
                onClick={() => ctrl.goToCrumb(index)}
                size="xs"
                variant="text"
              >
                {crumb.name}
              </Button>
            </span>
          ))}
        </nav>

        <div className="composer-global-files-browser">
          {ctrl.accessibleNotice ? <StatusBanner tone="info" text={ctrl.accessibleNotice} /> : null}
          {/* The banner is the non-blocking half of the same failure the card
              takes over, so it stands down when the card is up rather than
              stating the error twice. */}
          {error && !blockingFailure ? <StatusBanner tone="error" text={error} /> : null}

          {blockingFailure ? (
            <GfsReadFailureCard
              failure={blockingFailure.failure}
              onRetry={() => {
                void blockingFailure.retry()
              }}
            />
          ) : loading ? (
            <div className="composer-global-files-loading" role="status">
              <span className="composer-send-spinner" aria-hidden="true" />
              Loading files…
            </div>
          ) : entries.length ? (
            <div className="composer-global-files-list">
              {entries.map(entry => {
                const id = referenceId(entry.drive, entry.resourceId)
                if (entry.kind === 'directory') {
                  return (
                    <Button
                      align="start"
                      block
                      className="composer-global-files-row composer-global-files-row--folder"
                      color="neutral"
                      key={entry.resourceId}
                      onClick={() =>
                        ctrl.current ? ctrl.openChild(entry) : ctrl.openResource(entry)
                      }
                      variant="ghost"
                    >
                      <span className="composer-global-files-entry-icon" aria-hidden="true">
                        <IconContexts />
                      </span>
                      <span className="composer-global-files-entry-copy">
                        <strong>{entry.name}</strong>
                        <small>Folder</small>
                      </span>
                      <IconChevronRight className="composer-global-files-row-chevron" />
                    </Button>
                  )
                }

                const file: ComposerGlobalFileReference = {
                  id,
                  type: 'global_file',
                  resourceId: entry.resourceId,
                  drive: entry.drive,
                  gfsUri: entry.gfsUri,
                  label: entry.name,
                }
                const checked = Boolean(selected[id])
                return (
                  <label
                    className={`composer-global-files-row composer-global-files-row--file${checked ? ' composer-global-files-row--selected' : ''}`}
                    key={entry.resourceId}
                  >
                    <input
                      className="composer-global-files-checkbox"
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleFile(file)}
                    />
                    <span className="composer-global-files-entry-icon" aria-hidden="true">
                      <GfsFileIcon name={entry.name} />
                    </span>
                    <span className="composer-global-files-entry-copy">
                      <strong>{entry.name}</strong>
                      <small>{formatSharedFileSize(entry.bytes)}</small>
                    </span>
                    <span className="composer-global-files-selected-label">
                      {checked ? 'Selected' : 'Select'}
                    </span>
                  </label>
                )
              })}
              {hasMore ? (
                <Button
                  className="composer-global-files-load-more"
                  color="neutral"
                  loading={loadingMore}
                  onClick={loadMore}
                  size="sm"
                  variant="outline"
                >
                  Load more
                </Button>
              ) : null}
            </div>
          ) : (
            <EmptyState
              title={ctrl.current ? 'This folder is empty' : 'No shared files yet'}
              body={
                ctrl.current
                  ? 'Choose another folder to continue browsing.'
                  : 'Files shared with you through the Global File System will appear here.'
              }
            />
          )}
        </div>

        <footer className="composer-global-files-footer">
          <span className="composer-global-files-selection-summary">
            <strong>{selectedFiles.length}</strong>
            <span>{selectedFiles.length === 1 ? 'file selected' : 'files selected'}</span>
          </span>
          <span className="action-row">
            <Button color="neutral" onClick={onClose} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!selectedFiles.length}
              onClick={() => {
                onAdd(selectedFiles)
                onClose()
              }}
              size="sm"
            >
              {selectedFiles.length ? `Attach ${selectedFiles.length}` : 'Attach files'}
            </Button>
          </span>
        </footer>
      </section>
    </div>
  )
}
