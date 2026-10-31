import { useEffect, useId, useRef, useState } from 'react'
import { Button, EmptyState } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { GFS_RECENT_FILES_LABEL, GFS_RECENT_FILES_VISIBLE_LIMIT } from '@constants/gfsBrowser'
import { GFS_LISTING_GRID_COLUMNS } from '@lib/gfsListingGrid'
import { formatSharedFileSize } from '@lib/sharedFiles'
import type { GfsRecentFileRow, GfsRecentFilesCardProps } from './types'

function activityTitle(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString()
}

function activityLabel(iso: string): string {
  const activity = new Date(iso)
  if (Number.isNaN(activity.getTime())) return iso
  const now = new Date()
  const sameDay =
    activity.getFullYear() === now.getFullYear() &&
    activity.getMonth() === now.getMonth() &&
    activity.getDate() === now.getDate()
  return sameDay
    ? activity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : activity.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * The "Recent files" card used by the EvenDrive overview and its own view.
 *
 * It reuses the listing's grid and row contract — the same template constant,
 * the same `.da-grid__row--clickable` behaviour, the same name/size cells — so
 * it reads as the same surface as the browser card. The only new lane is "Your
 * activity" (D11), which takes the listing's actions lane.
 *
 * The overview stays at five entries; the dedicated view can reveal more.
 */
export function GfsRecentFilesCard({
  files,
  expandable = false,
  visibleCount: savedVisibleCount,
  onVisibleCountChange,
  loading,
  fetching,
  failure,
  onRetry,
  onOpen,
}: GfsRecentFilesCardProps) {
  const descriptionPrefix = useId()
  const [localVisibleCount, setLocalVisibleCount] = useState(GFS_RECENT_FILES_VISIBLE_LIMIT)
  const visibleCount = savedVisibleCount ?? localVisibleCount
  const [announcement, setAnnouncement] = useState('')
  const [dayAnchor, setDayAnchor] = useState(() => Date.now())
  const rowsById = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocusId = useRef<string | null>(null)
  const shown = files.slice(0, expandable ? visibleCount : GFS_RECENT_FILES_VISIBLE_LIMIT)
  const hasMore = expandable && files.length > visibleCount

  useEffect(() => {
    const day = new Date(dayAnchor)
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    const timer = setTimeout(
      () => setDayAnchor(Date.now()),
      Math.max(0, nextDay.getTime() - Date.now()) + 1
    )
    return () => clearTimeout(timer)
  }, [dayAnchor])

  useEffect(() => {
    const id = pendingFocusId.current
    if (!id) return
    rowsById.current.get(id)?.focus()
    pendingFocusId.current = null
  }, [visibleCount])

  const revealMore = () => {
    const next = files.slice(visibleCount, visibleCount + GFS_RECENT_FILES_VISIBLE_LIMIT)
    if (next.length === 0) return
    pendingFocusId.current = next[0]!.resourceId
    const nextCount = visibleCount + GFS_RECENT_FILES_VISIBLE_LIMIT
    if (onVisibleCountChange) onVisibleCountChange(nextCount)
    else setLocalVisibleCount(nextCount)
    const totalShown = Math.min(nextCount, files.length)
    setAnnouncement(`${totalShown} recent ${totalShown === 1 ? 'file' : 'files'} shown.`)
  }

  return (
    <section
      className="page-card da-gfs-recent"
      aria-label={GFS_RECENT_FILES_LABEL}
      aria-busy={fetching}
    >
      <div className="page-card__header da-gfs-drive__header">
        <h3 className="da-gfs-section-title">{GFS_RECENT_FILES_LABEL}</h3>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {failure && files.length > 0 ? (
        <GfsReadFailureCard failure={failure} onRetry={onRetry} hasData />
      ) : null}
      {failure && files.length === 0 ? (
        <GfsReadFailureCard failure={failure} onRetry={onRetry} />
      ) : loading ? (
        <div
          className="da-gfs-loading"
          role="status"
          aria-label="Loading recent files"
          aria-live="polite"
        >
          <span className="da-gfs-loading__dots" aria-hidden="true">
            <span className="da-gfs-loading__dot" />
            <span className="da-gfs-loading__dot" />
            <span className="da-gfs-loading__dot" />
          </span>
          <span>Loading files…</span>
        </div>
      ) : files.length === 0 ? (
        <EmptyState
          title="No recent files"
          body="Files you or your agents open or change appear here, most recent first."
        />
      ) : (
        <>
          <div
            className="da-grid da-gfs-drive__grid"
            style={{ '--da-grid-cols': GFS_LISTING_GRID_COLUMNS }}
          >
            <div className="da-grid__head">
              <span className="da-grid__col-header" aria-hidden="true" />
              <span className="da-grid__col-header">Name</span>
              <span className="da-grid__col-header da-gfs-drive__size-column da-grid__col-header--right">
                Size
              </span>
              <span className="da-grid__col-header da-grid__col-header--right">Your activity</span>
            </div>
            <div className="da-grid__body">
              {shown.map(file => (
                <button
                  className="da-grid__row da-grid__row--clickable da-grid__row--compact"
                  key={file.resourceId}
                  type="button"
                  aria-label={`Open ${file.name}`}
                  aria-describedby={`${descriptionPrefix}-${file.resourceId}-details`}
                  ref={element => {
                    if (element) rowsById.current.set(file.resourceId, element)
                    else rowsById.current.delete(file.resourceId)
                  }}
                  onClick={() => onOpen(file)}
                >
                  <span className="da-gfs-list__icon da-grid__cell">
                    <GfsFileIcon name={file.name} />
                  </span>
                  <span className="da-gfs-list__identity da-grid__cell">
                    <span className="da-gfs-list__name">{file.name}</span>
                  </span>
                  <span className="da-gfs-drive__size da-grid__cell da-grid__cell--right">
                    {formatSharedFileSize(file.bytes)}
                  </span>
                  <time
                    className="da-grid__cell da-grid__cell--right da-gfs-recent__activity"
                    dateTime={file.lastActivityAt}
                    title={activityTitle(file.lastActivityAt)}
                  >
                    {activityLabel(file.lastActivityAt)}
                  </time>
                  <span
                    id={`${descriptionPrefix}-${file.resourceId}-details`}
                    className="visually-hidden"
                  >
                    {`Size ${formatSharedFileSize(file.bytes)}. Last activity ${activityLabel(file.lastActivityAt)}.`}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {hasMore ? (
            <div className="da-gfs-footer-actions">
              <Button onClick={revealMore} size="sm" variant="outline">
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

export type { GfsRecentFileRow, GfsRecentFilesCardProps }
