import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, StatusBanner } from '@components/Common'
import { IconClose, IconRefresh, IconSandboxUi } from '../components/SidebarNav/icons'
import { clickableRowProps } from '../lib/clickableRowProps'
import type { SandboxUiPageProps } from './SandboxUiPage.types'

type App = {
  appRef: string
  title?: string
  description?: string
  icon?: string
  defaultPath: string
  ready: boolean
  phase: string | null
  updatedAt: string | null
}

type PhasePillTone = 'allowed' | 'warning' | 'denied' | 'info' | 'muted'

function humanize(phase: string): string {
  if (!phase) return 'Unknown'
  const spaced = phase.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function phasePill(phase: string | null): { label: string; tone: PhasePillTone } {
  switch (phase) {
    case 'active':
      return { label: 'Ready', tone: 'allowed' }
    case 'degraded':
      return { label: 'Degraded', tone: 'warning' }
    case 'failed':
    case 'rolling-back':
    case 'rollback-failed':
      return { label: humanize(phase), tone: 'denied' }
    case 'deprecated':
      return { label: 'Deprecated', tone: 'muted' }
    case 'pending':
    case 'pending-approval':
    case 'pending-operator-input':
    case 'approved':
    case 'candidate':
    case 'deploying':
    case 'testing':
      return { label: humanize(phase), tone: 'info' }
    default:
      return { label: phase ? humanize(phase) : 'Unknown', tone: 'muted' }
  }
}

type LaunchState =
  | { kind: 'idle' }
  | { kind: 'minting'; appRef: string }
  | { kind: 'mounted'; appRef: string }
  | { kind: 'error'; appRef: string; message: string }

const PARKED_EMBED_BOUNDS = {
  x: -10_000,
  y: -10_000,
  width: 1,
  height: 1,
}

function statusFromError(err: unknown): { status: number | null; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  // SandboxUiSessionError surfaces "(404):" / "(403):" etc., while bridge
  // failures can include "403 Forbidden". Pull out either form for UX copy.
  const m = /\((\d{3})\)|\b(\d{3})\s+[A-Za-z]/.exec(message)
  return { status: m ? Number(m[1] ?? m[2]) : null, message }
}

function appLabel(app: App): string {
  if (app.title && app.title.trim().length > 0) return app.title.trim()
  return app.appRef
}

function formatLastUpdated(updatedAt: string | null): string {
  if (!updatedAt) return 'Last updated unknown'
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return 'Last updated unknown'
  return `Last updated ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)}`
}

async function waitForEmbedSlotRect(
  ref: React.RefObject<HTMLDivElement | null>
): Promise<DOMRect | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const rect = ref.current?.getBoundingClientRect() ?? null
    if (rect && rect.width > 0 && rect.height > 0) return rect
  }
  return null
}

function boundsFromRect(rect: DOMRect) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    dpr: window.devicePixelRatio,
  }
}

/**
 * Tracks the embed slot's viewport bounds and pushes them to the main
 * process whenever they change (resize, scroll, sidebar toggle). The
 * WebContentsView is layered above the DOM, so the driver needs an exact
 * pixel rectangle to keep the embed aligned with its slot div.
 */
function useEmbedBounds(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  parked: boolean,
  refreshKey: string | number
): void {
  useLayoutEffect(() => {
    if (!enabled) return
    const target = ref.current
    if (!target) return
    if (parked) return
    let raf = 0
    const push = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect()
        void window.clerum.sandboxUi.setBounds(boundsFromRect(rect))
      })
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(target)
    window.addEventListener('resize', push)
    window.addEventListener('scroll', push, true)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', push)
      window.removeEventListener('scroll', push, true)
    }
  }, [parked, ref, enabled, refreshKey])
}

const APP_PAGE_SIZE = 6

export function SandboxUiPage({
  boundsRefreshKey = 0,
  headerShellOverlayOpen = false,
  sidebarShellOverlayOpen = false,
  shortcutApp = null,
  shortcutOpenRequestId = 0,
  onEmbeddedAppOpening,
  onEmbeddedAppBack,
  onEmbeddedAppRemoved,
}: SandboxUiPageProps = {}) {
  const [apps, setApps] = useState<App[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [launch, setLaunch] = useState<LaunchState>({ kind: 'idle' })
  const [refreshError, setRefreshError] = useState<{ appRef: string; message: string } | null>(null)
  const [appsPage, setAppsPage] = useState(0)
  const [embedPreviewDataUrl, setEmbedPreviewDataUrl] = useState<string | null>(null)
  const embedSlotRef = useRef<HTMLDivElement>(null)
  const lastShortcutOpenRequestIdRef = useRef(0)
  const shellOverlayOpen = headerShellOverlayOpen || sidebarShellOverlayOpen

  const reload = useCallback(async () => {
    setError(null)
    try {
      const result = await window.clerum.sandboxUi.listApps()
      setApps(result.apps)
    } catch (err) {
      const { status, message } = statusFromError(err)
      setError(status === 403 ? null : message || 'Failed to load apps')
      setApps([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    setAppsPage(0)
  }, [apps?.length])

  // Re-render the picker if the main process tears the view down (e.g. on
  // app quit, parent window close, or partition GC).
  useEffect(() => {
    return window.clerum.sandboxUi.onClosed(() => {
      setLaunch(current =>
        current.kind === 'mounted' || current.kind === 'minting' ? { kind: 'idle' } : current
      )
      setRefreshError(null)
      onEmbeddedAppBack?.()
    })
  }, [onEmbeddedAppBack])

  // Surface refresh failures (403 / 410 / network) as an in-chrome banner.
  // The main-process timer has already stopped firing by the time we get
  // here — this is informational, not actionable beyond the user closing
  // and re-opening.
  useEffect(() => {
    return window.clerum.sandboxUi.onRefreshError(args => setRefreshError(args))
  }, [])

  // Tear down the embed when this page unmounts (user navigates away).
  useEffect(() => {
    return () => {
      void window.clerum.sandboxUi.close()
      onEmbeddedAppBack?.()
    }
  }, [onEmbeddedAppBack])

  const openApp = useCallback(
    async (app: {
      appRef: string
      label: string
      icon?: string
      defaultPath: string
      ready?: boolean
    }) => {
      if (app.ready === false) return
      const [recipeNs, recipeName] = app.appRef.split('/', 2)
      if (!recipeNs || !recipeName) return
      // Transition to 'minting' so the slot div mounts. Wait for the next
      // layout commit so getBoundingClientRect() reflects the slot's real
      // position (otherwise we'd be reading before React has rendered the
      // slot, and the fallback would mount the WebContentsView full-window —
      // covering the close button until the next ResizeObserver tick).
      setLaunch({ kind: 'minting', appRef: app.appRef })
      onEmbeddedAppOpening?.({
        appRef: app.appRef,
        label: app.label,
        icon: app.icon,
        defaultPath: app.defaultPath,
      })
      try {
        const rect = await waitForEmbedSlotRect(embedSlotRef)
        if (!rect) {
          throw new Error('Embed slot is not laid out — cannot determine bounds')
        }
        const bounds = boundsFromRect(rect)
        await window.clerum.sandboxUi.open({
          recipeNs,
          recipeName,
          defaultPath: app.defaultPath,
          bounds,
        })
        setLaunch({ kind: 'mounted', appRef: app.appRef })
      } catch (err) {
        const { status, message } = statusFromError(err)
        const userFacing =
          status === 404
            ? 'This app was removed.'
            : status === 403
              ? "You don't have access to this app."
              : status === 409
                ? 'This app is starting up — try again in a moment.'
                : message
        setLaunch({ kind: 'error', appRef: app.appRef, message: userFacing })
        onEmbeddedAppRemoved?.()
      }
    },
    [onEmbeddedAppOpening, onEmbeddedAppRemoved]
  )

  const onOpen = useCallback(
    async (app: App) => {
      await openApp({
        appRef: app.appRef,
        label: appLabel(app),
        icon: app.icon,
        defaultPath: app.defaultPath,
        ready: app.ready,
      })
    },
    [openApp]
  )

  const closeEmbed = useCallback(async () => {
    try {
      await window.clerum.sandboxUi.close()
    } catch {
      // Always return the user to the app picker even if the main-process
      // close call races with an already-closed view.
    }
    setLaunch({ kind: 'idle' })
    setRefreshError(null)
  }, [])

  const onBackToApps = useCallback(async () => {
    await closeEmbed()
    onEmbeddedAppBack?.()
  }, [closeEmbed, onEmbeddedAppBack])

  // In-place hard-reload of the embedded app — fetches freshly-arrived
  // server data (e.g. new inbox items) without tearing the view down, so the
  // user no longer has to navigate away and back to see updates.
  const onRefresh = useCallback(() => {
    void window.clerum.sandboxUi.reload()
  }, [])

  const onRemoveApp = useCallback(async () => {
    await closeEmbed()
    onEmbeddedAppRemoved?.()
  }, [closeEmbed, onEmbeddedAppRemoved])

  useEffect(() => {
    if (shortcutOpenRequestId === lastShortcutOpenRequestIdRef.current) return
    lastShortcutOpenRequestIdRef.current = shortcutOpenRequestId
    if (shortcutOpenRequestId <= 0 || !shortcutApp) return
    void openApp(shortcutApp)
  }, [openApp, shortcutApp, shortcutOpenRequestId])

  // Track bounds while mounted; also during 'minting' so onOpen can read
  // the slot's rect AFTER the layout pass that renders the slot div.
  useEmbedBounds(
    embedSlotRef,
    launch.kind === 'mounted' || launch.kind === 'minting',
    shellOverlayOpen,
    boundsRefreshKey
  )

  useLayoutEffect(() => {
    if (launch.kind !== 'mounted' && launch.kind !== 'minting') return
    if (shellOverlayOpen) return
    const rect = embedSlotRef.current?.getBoundingClientRect()
    if (rect) {
      void window.clerum.sandboxUi.setBounds(boundsFromRect(rect))
    }
    setEmbedPreviewDataUrl(null)
  }, [launch.kind, shellOverlayOpen])

  useEffect(() => {
    if (launch.kind !== 'mounted' && launch.kind !== 'minting') return
    if (!shellOverlayOpen) return

    let cancelled = false
    const parkAfterPreview = async (): Promise<void> => {
      try {
        const dataUrl = await window.clerum.sandboxUi.capturePreview()
        if (!cancelled && dataUrl) setEmbedPreviewDataUrl(dataUrl)
      } catch {
        // Keep the last successful preview until the live view is restored.
      }
      if (cancelled) return
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      void window.clerum.sandboxUi.setBounds({
        ...PARKED_EMBED_BOUNDS,
        dpr: window.devicePixelRatio,
      })
    }

    void parkAfterPreview()
    return () => {
      cancelled = true
    }
  }, [launch.kind, shellOverlayOpen])

  if (launch.kind === 'mounted' || launch.kind === 'minting') {
    const showRefreshBanner =
      refreshError && launch.kind === 'mounted' && refreshError.appRef === launch.appRef
    return (
      <section className="page">
        <div className="sandbox-ui-mounted-header">
          <Button
            color="neutral"
            variant="soft"
            size="sm"
            className="sandbox-ui-close-btn"
            aria-label="Back to apps"
            title="Back to apps"
            onClick={() => void onBackToApps()}
          >
            <IconClose />
            <span>Back to apps</span>
          </Button>
          {launch.kind === 'mounted' && (
            <Button
              color="neutral"
              variant="soft"
              size="sm"
              className="sandbox-ui-refresh-btn"
              aria-label="Refresh"
              title="Refresh app content"
              onClick={onRefresh}
            >
              <IconRefresh />
              <span>Refresh</span>
            </Button>
          )}
        </div>
        {showRefreshBanner && (
          <StatusBanner
            tone="error"
            text={`Session refresh failed: ${refreshError.message}. Close and re-open the app to continue.`}
          />
        )}
        {/* The slot div is the rectangle the WebContentsView floats above
            after the selected app completes its initial load. */}
        <div ref={embedSlotRef} className="sandbox-ui-embed-slot">
          {embedPreviewDataUrl && shellOverlayOpen && (
            <img
              className="sandbox-ui-embed-preview"
              src={embedPreviewDataUrl}
              alt=""
              data-testid="sandbox-ui-embed-preview"
            />
          )}
          {launch.kind === 'minting' && (
            <div className="sandbox-ui-loading" role="status" aria-live="polite">
              <span className="sandbox-ui-loading__mark" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="sandbox-ui-loading__text">Loading app</span>
            </div>
          )}
        </div>
      </section>
    )
  }

  if (apps === null) {
    return (
      <section className="page apps-page" aria-busy="true">
        <div className="apps-page-header">
          <div className="apps-page-header-text">
            <h2>Apps</h2>
            <p className="muted">Discover and launch tools to help you work smarter.</p>
          </div>
        </div>

        <div className="apps-page-showcase" role="status" aria-live="polite">
          <span className="visually-hidden">Fetching app catalog...</span>
          <div className="apps-page-copy apps-page-copy--skeleton" aria-hidden="true">
            <span className="apps-skeleton-line apps-skeleton-line--slogan" />
            <span className="apps-skeleton-line apps-skeleton-line--intro" />
            <span className="apps-skeleton-line apps-skeleton-line--intro-short" />
          </div>

          <div className="apps-grid apps-grid--skeleton" aria-hidden="true">
            <div className="apps-grid__card apps-grid__card--skeleton">
              <span className="apps-skeleton-icon" />
              <span className="apps-skeleton-line apps-skeleton-line--title" />
              <span className="apps-skeleton-pill" />
              <span className="apps-skeleton-line apps-skeleton-line--meta" />
              <span className="apps-skeleton-line apps-skeleton-line--body" />
              <span className="apps-skeleton-line apps-skeleton-line--body-short" />
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (apps.length === 0) {
    return (
      <section className="page apps-page">
        {error && <StatusBanner tone="error" text={error} />}

        <div className="apps-page-header">
          <div className="apps-page-header-text">
            <h2>Apps</h2>
            <p className="muted">Discover and launch tools to help you work smarter.</p>
          </div>
        </div>

        <div className="apps-page-showcase">
          <div className="apps-page-copy" role="status" aria-live="polite">
            <p className="apps-page-slogan">No available apps yet</p>
            <p className="apps-page-intro">Ask an admin if you expected to see one here.</p>
          </div>
        </div>
      </section>
    )
  }

  const appIcon = (app: App) =>
    app.icon ? <img src={app.icon} alt="" width={20} height={20} /> : <IconSandboxUi />

  const appStatusPill = (app: App) => {
    const pill = phasePill(app.phase)
    return <span className={`apps-status-pill apps-status-pill--${pill.tone}`}>{pill.label}</span>
  }

  const previewApps = apps.map(app => ({ app, key: app.appRef }))

  const totalAppPages = Math.max(1, Math.ceil(previewApps.length / APP_PAGE_SIZE))
  const visibleAppsPage = Math.min(appsPage, totalAppPages - 1)
  const visibleApps = previewApps.slice(
    visibleAppsPage * APP_PAGE_SIZE,
    visibleAppsPage * APP_PAGE_SIZE + APP_PAGE_SIZE
  )
  const showAppPagination = totalAppPages > 1

  const gridCardProps = (app: App, activatable: boolean, activate: () => void) => {
    if (!activatable) return {}
    return clickableRowProps(activate, { ariaLabel: `Open ${appLabel(app)}` })
  }

  return (
    <section className="page apps-page">
      {error && <StatusBanner tone="error" text={error} />}
      {launch.kind === 'error' && (
        <StatusBanner tone="error" text={`${launch.appRef}: ${launch.message}`} />
      )}

      <div className="apps-page-header">
        <div className="apps-page-header-text">
          <h2>Apps</h2>
          <p className="muted">Discover and launch tools to help you work smarter.</p>
        </div>
      </div>

      <div className="apps-page-showcase">
        <div className="apps-page-copy">
          <p className="apps-page-slogan">Purpose-built workspaces, right where your team works.</p>
          <p className="apps-page-intro">
            Apps are embedded workspaces your team can open inside Evenfire for focused workflows,
            quick reviews, and task-specific tools without leaving the desktop app.
          </p>
        </div>

        <div className="apps-grid">
          {visibleApps.map(({ app, key }) => {
            const activatable = app.ready
            const activate = (): void => {
              if (!activatable) return
              void onOpen(app)
            }
            return (
              <div
                key={key}
                className={`apps-grid__card${activatable ? ' apps-grid__card--clickable' : ''}`}
                aria-disabled={activatable ? undefined : true}
                {...gridCardProps(app, activatable, activate)}
              >
                <span aria-hidden="true" className="apps-grid__card-icon">
                  {appIcon(app)}
                </span>
                <span className="apps-grid__card-title">{appLabel(app)}</span>
                {appStatusPill(app)}
                <span className="apps-card-meta__updated">{formatLastUpdated(app.updatedAt)}</span>
                {app.description ? (
                  <span className="apps-grid__card-desc">{app.description}</span>
                ) : null}
              </div>
            )
          })}
        </div>

        {showAppPagination && (
          <div className="apps-pagination" aria-label="App pages">
            <button
              type="button"
              className="apps-pagination__btn apps-pagination__btn--prev"
              aria-label="Previous apps page"
              disabled={visibleAppsPage === 0}
              onClick={() => setAppsPage(page => Math.max(0, page - 1))}
            >
              <span className="apps-pagination__chevron" aria-hidden="true">
                &lsaquo;
              </span>
            </button>
            <span className="apps-pagination__label">
              {visibleAppsPage + 1} / {totalAppPages}
            </span>
            <button
              type="button"
              className="apps-pagination__btn"
              aria-label="Next apps page"
              disabled={visibleAppsPage >= totalAppPages - 1}
              onClick={() => setAppsPage(page => Math.min(totalAppPages - 1, page + 1))}
            >
              <span className="apps-pagination__chevron" aria-hidden="true">
                &rsaquo;
              </span>
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
