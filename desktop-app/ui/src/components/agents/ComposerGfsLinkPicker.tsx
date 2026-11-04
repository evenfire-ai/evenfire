import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Button, MenuItem } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { IconChevronRight, IconContexts } from '@components/SidebarNav/icons'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import type {
  ComposerGfsAuthorityFailureHandler,
  ComposerGfsLinkSelection,
} from './ComposerGfsLinkPicker.types'
import { useComposerGfsAuthority } from './useComposerGfsAuthority'

export function ComposerGfsLinkPicker({
  sessionId,
  onInsert,
  onSessionScope,
  onEscapeRoot,
}: {
  sessionId: number
  onInsert: (
    selection: ComposerGfsLinkSelection,
    sessionScope: string,
    sessionId: number,
    sessionGeneration: number | null,
    handleAuthorityFailure: ComposerGfsAuthorityFailureHandler
  ) => void | Promise<void>
  onSessionScope: (
    sessionId: number,
    sessionScope: string,
    sessionGeneration: number | null
  ) => void
  onEscapeRoot: () => void
}) {
  const ctrl = useGfsBrowserController({ pickerAuthorityManaged: true })
  const menuRef = useRef<HTMLDivElement | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const entries = ctrl.current ? ctrl.items : ctrl.accessibleResources
  const handlePassiveAuthorityFailure = useCallback(
    (message: string) =>
      ctrl.handleAuthorityFailure(message, 'operation', ctrl.sessionScope, ctrl.sessionGeneration),
    [ctrl.handleAuthorityFailure, ctrl.sessionGeneration, ctrl.sessionScope]
  )
  const authority = useComposerGfsAuthority(
    entries,
    sessionId,
    ctrl.sessionScope,
    ctrl.sessionGeneration,
    ctrl.accessState === 'active',
    ctrl.isSessionAuthorityActive,
    handlePassiveAuthorityFailure
  )
  const handleDirectAuthorityFailure = useCallback(
    (message: string) => {
      const handled = ctrl.handleAuthorityFailure(
        message,
        'operation',
        ctrl.sessionScope,
        ctrl.sessionGeneration
      )
      if (handled) authority.invalidate()
      return handled
    },
    [authority.invalidate, ctrl.handleAuthorityFailure, ctrl.sessionGeneration, ctrl.sessionScope]
  )
  const visibleEntries = useMemo(
    () =>
      entries.filter(entry => authority.authorityByResourceId.get(entry.resourceId) === 'allowed'),
    [authority.authorityByResourceId, entries]
  )
  const permissionRetryIds = useMemo(
    () =>
      entries
        .filter(entry => {
          const status = authority.authorityByResourceId.get(entry.resourceId)
          return status === 'denied' || status === 'error' || status === 'paused'
        })
        .map(entry => entry.resourceId),
    [authority.authorityByResourceId, entries]
  )
  const currentResourceId = ctrl.current?.resourceId ?? null
  const previousCurrentResourceIdRef = useRef(currentResourceId)
  const loading = ctrl.current ? ctrl.loading : ctrl.loadingAccessible
  const error = ctrl.current ? ctrl.error : ctrl.accessibleError
  const failure = ctrl.current ? null : ctrl.discoveryFailure
  const hasMore = ctrl.current ? ctrl.hasMore : ctrl.hasMoreAccessible
  const loadingMore = ctrl.current ? ctrl.isFetchingMore : ctrl.isFetchingMoreAccessible

  useEffect(() => {
    onSessionScope(sessionId, ctrl.sessionScope, ctrl.sessionGeneration)
  }, [ctrl.sessionGeneration, ctrl.sessionScope, onSessionScope, sessionId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (ctrl.crumbs.length > 1) ctrl.goToCrumb(ctrl.crumbs.length - 2)
      else if (ctrl.crumbs.length === 1) ctrl.reset()
      else onEscapeRoot()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [ctrl.crumbs.length, ctrl.goToCrumb, ctrl.reset, onEscapeRoot])

  useEffect(() => {
    const previousResourceId = previousCurrentResourceIdRef.current
    previousCurrentResourceIdRef.current = currentResourceId
    if (currentResourceId) {
      backRef.current?.focus()
      return
    }
    if (
      previousResourceId !== null ||
      document.activeElement?.closest('.composer-reference-menu-panel')
    ) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    }
  }, [currentResourceId, visibleEntries[0]?.resourceId])

  const insert = (entry: GfsBrowserChild) => {
    // This ref-backed check is synchronous, so an event-fenced stale committed
    // row cannot activate before React publishes the next disabled/hidden view.
    if (!authority.isCurrentlyAllowed(entry.resourceId)) return
    onInsert(
      {
        label: sanitizeAppTabTitle(entry.name) || 'Unnamed',
        uri: entry.gfsUri,
        resourceId: entry.resourceId,
      },
      ctrl.sessionScope,
      sessionId,
      ctrl.sessionGeneration,
      handleDirectAuthorityFailure
    )
  }

  const retry = () => {
    if (ctrl.current) void ctrl.retryChildren()
    else void ctrl.retryDiscovery()
  }

  return (
    <div
      ref={menuRef}
      className="composer-gfs-picker"
      role="menu"
      aria-label="EvenDrive links"
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const menuItems = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)'
          )
        )
        if (menuItems.length === 0) return
        event.preventDefault()
        const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement)
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? menuItems.length - 1
              : event.key === 'ArrowDown'
                ? (currentIndex + 1 + menuItems.length) % menuItems.length
                : (currentIndex - 1 + menuItems.length) % menuItems.length
        menuItems[nextIndex]?.focus()
      }}
    >
      <div className="composer-gfs-picker-path">
        {ctrl.current ? (
          <>
            <MenuItem
              ref={backRef}
              aria-label="Back to shared files"
              leadingIcon={<span aria-hidden="true">‹</span>}
              onClick={() =>
                ctrl.crumbs.length > 1 ? ctrl.goToCrumb(ctrl.crumbs.length - 2) : ctrl.reset()
              }
              role="menuitem"
            >
              Back
            </MenuItem>
            <span
              className="composer-gfs-picker-current"
              title={sanitizeAppTabTitle(ctrl.current.name) || 'Unnamed'}
            >
              {sanitizeAppTabTitle(ctrl.current.name) || 'Unnamed'}
            </span>
          </>
        ) : (
          <span className="composer-gfs-picker-current">Shared files</span>
        )}
      </div>

      {ctrl.accessibleNotice ? (
        <p className="composer-reference-menu-empty">{ctrl.accessibleNotice}</p>
      ) : null}
      {error && visibleEntries.length > 0 ? (
        <p className="composer-reference-menu-empty composer-gfs-picker-error">
          {describeGfsReadError(error).message}
        </p>
      ) : null}

      {loading ? (
        <div className="composer-reference-menu-empty" role="status">
          Loading EvenDrive…
        </div>
      ) : entries.length > 0 && visibleEntries.length === 0 && permissionRetryIds.length === 0 ? (
        <div className="composer-reference-menu-empty" role="status">
          Checking exact read permission…
        </div>
      ) : visibleEntries.length > 0 ? (
        <div className="composer-gfs-picker-list">
          {visibleEntries.map(entry => {
            const displayName = sanitizeAppTabTitle(entry.name) || 'Unnamed'
            return (
              <div className="composer-gfs-picker-row" key={`${entry.drive}:${entry.resourceId}`}>
                {entry.kind === 'directory' ? (
                  <MenuItem
                    aria-label={`Open folder ${displayName}`}
                    className="composer-gfs-picker-open"
                    leadingIcon={<IconContexts />}
                    onClick={() =>
                      ctrl.current ? ctrl.openChild(entry) : ctrl.openResource(entry)
                    }
                    role="menuitem"
                    trailingIcon={<IconChevronRight aria-hidden="true" />}
                  >
                    {displayName}
                  </MenuItem>
                ) : null}
                <MenuItem
                  aria-label={`Insert link to ${displayName}`}
                  className="composer-gfs-picker-insert"
                  leadingIcon={
                    entry.kind === 'file' ? <GfsFileIcon name={displayName} /> : undefined
                  }
                  onClick={() => insert(entry)}
                  role="menuitem"
                >
                  {entry.kind === 'directory' ? 'Insert link' : displayName}
                </MenuItem>
              </div>
            )
          })}
          {hasMore ? (
            <Button
              block
              className="composer-gfs-picker-more"
              color="neutral"
              disabled={loadingMore}
              onClick={() => (ctrl.current ? ctrl.loadMore() : ctrl.loadMoreAccessible())}
              size="xs"
              variant="text"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
      ) : failure && failure.kind !== 'unsupported' ? (
        <GfsReadFailureCard failure={failure} onRetry={retry} />
      ) : error ? (
        <GfsReadFailureCard
          failure={{ kind: 'failed', message: error, retryAvailableAt: null }}
          onRetry={retry}
        />
      ) : (
        <p className="composer-reference-menu-empty">
          {ctrl.current ? 'This folder has no readable items.' : 'No shared EvenDrive files.'}
        </p>
      )}
      {permissionRetryIds.length > 0 ? (
        <Button
          block
          className="composer-gfs-picker-permission-retry"
          color="neutral"
          onClick={() => permissionRetryIds.forEach(resourceId => authority.retry(resourceId))}
          size="xs"
          variant="text"
        >
          Retry resource permission checks
        </Button>
      ) : null}
    </div>
  )
}
