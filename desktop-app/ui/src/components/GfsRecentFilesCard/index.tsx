import { Button, EmptyState } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { GFS_RECENT_FILES_LABEL, GFS_RECENT_FILES_VISIBLE_LIMIT } from '@constants/gfsBrowser'
import { isEventFromNestedInteractive } from '@lib/clickableRowProps'
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
 * Both views show only the five newest entries. The backend retains its
 * existing history.
 */
export function GfsRecentFilesCard({
  files,
  loading,
  fetching,
  failure,
  onRetry,
  onOpen,
}: GfsRecentFilesCardProps) {
  const shown = files.slice(0, GFS_RECENT_FILES_VISIBLE_LIMIT)

  return (
    <section
      className="page-card da-gfs-recent"
      aria-label={GFS_RECENT_FILES_LABEL}
      aria-busy={fetching}
    >
      <div className="page-card__header">
        <h3>{GFS_RECENT_FILES_LABEL}</h3>
      </div>
      {failure ? (
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
                <div
                  className="da-grid__row da-grid__row--clickable da-grid__row--compact"
                  key={file.resourceId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${file.name}`}
                  onClick={event => {
                    // A nested control (the name button) owns its own click; the
                    // row owns everything else.
                    if (event.target !== event.currentTarget && isEventFromNestedInteractive(event))
                      return
                    onOpen(file)
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    if (event.target !== event.currentTarget && isEventFromNestedInteractive(event))
                      return
                    event.preventDefault()
                    onOpen(file)
                  }}
                >
                  <span className="da-gfs-list__icon da-grid__cell">
                    <GfsFileIcon name={file.name} />
                  </span>
                  <span className="da-gfs-list__identity da-grid__cell">
                    <span className="da-gfs-list__name">
                      <Button align="start" block onClick={() => onOpen(file)} variant="text">
                        {file.name}
                      </Button>
                    </span>
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
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export type { GfsRecentFileRow, GfsRecentFilesCardProps }
