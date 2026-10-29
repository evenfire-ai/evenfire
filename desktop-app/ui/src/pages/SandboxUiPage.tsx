import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Pagination,
  Row,
  Skeleton,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { IconCopy, IconRefresh, IconSandboxUi } from '@components/SidebarNav/icons'
import { useEmbedOwnership } from '@hooks/useEmbedOwnership'
import { embedFailureMessage, embedViewState, httpStatusOf } from '@lib/embedOwnershipView'
import SandboxCurrentContentSearch from '../components/SandboxCurrentContentSearch'
import type { AppFindState } from '../components/SandboxCurrentContentSearch/types'
import { toActiveSandboxUiApp } from '../lib/sandboxUiAppSelection'
import type { SandboxUiAppListing } from '../lib/sandboxUiAppSelection.types'
import type { SandboxUiPageProps } from './SandboxUiPage.types'

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

// Past this, the overlay hides the native view without a preview: a brief flash
// of the empty slot is better than a view that never gets out of the way.
const CAPTURE_PREVIEW_TIMEOUT_MS = 500

function statusFromError(err: unknown): { status: number | null; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  return { status: httpStatusOf(message), message }
}

function previewWithin(timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  const capture = Promise.resolve()
    .then(() => window.clerum.sandboxUi.capturePreview())
    .catch(() => null)
  return Promise.race([capture, timedOut]).finally(() => clearTimeout(timer))
}

function appLabel(app: SandboxUiAppListing): string {
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
  refreshKey: string | number,
  onBoundsApplied?: () => void,
  onSlotTopChange?: (topPx: number) => void,
  onSlotRightChange?: (rightPx: number) => void
): void {
  // Dedupe the emitted slot-top across pushes AND across effect re-runs, so a
  // resize/scroll storm (or a dep change) never churns the parent's state when
  // the measured top is unchanged.
  const lastEmittedTopRef = useRef<number | null>(null)
  const lastEmittedRightRef = useRef<number | null>(null)
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
        if (onSlotTopChange) {
          const top = Math.round(rect.top)
          if (lastEmittedTopRef.current !== top) {
            lastEmittedTopRef.current = top
            onSlotTopChange(top)
          }
        }
        if (onSlotRightChange) {
          const right = Math.round(rect.right)
          if (lastEmittedRightRef.current !== right) {
            lastEmittedRightRef.current = right
            onSlotRightChange(right)
          }
        }
        void window.clerum.sandboxUi
          .setBounds(boundsFromRect(rect))
          .then(() => onBoundsApplied?.())
          .catch(() => undefined)
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
  }, [parked, ref, enabled, onBoundsApplied, onSlotTopChange, onSlotRightChange, refreshKey])
}

const APP_PAGE_SIZE = 6
let nextSandboxFindClientRequestId = 0

// Icon-only app action rendered into the native title bar's leading slot. The
// label is surfaced through IconButton's native `title` (from `label`) plus
// `aria-label` for assistive tech. The native `title` is deliberate here: the
// mounted app is a native WebContentsView that always paints above the renderer
// DOM regardless of CSS, so a DOM tooltip would render BEHIND the app view and
// be unreadable. The OS composes the native `title` tooltip over that native
// view, so it is the only label affordance that can actually be seen.
function TitlebarLeadingAction({
  label,
  pressed,
  onClick,
  icon,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <Button
      className="titlebar-leading-action__btn"
      type="text"
      size="small"
      icon={icon}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    />
  )
}

export function SandboxUiPage({
  embed,
  activeAppRef = null,
  refreshError = null,
  boundsRefreshKey = 0,
  currentTeamId = '',
  headerShellOverlayOpen = false,
  sidebarShellOverlayOpen = false,
  toastShellOverlayOpen = false,
  deepLinkShellOverlayOpen = false,
  localSearchRequestId = 0,
  titlebarLeadingContainer = null,
  onLaunchApp,
  onRefresh,
  onRelaunch,
  onEmbedBoundsApplied,
  onEmbedSlotTopChange,
  onEmbedSlotRightChange,
  onNotify,
}: SandboxUiPageProps) {
  const view = embedViewState(useEmbedOwnership(embed))
  const [apps, setApps] = useState<SandboxUiAppListing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [appsPage, setAppsPage] = useState(0)
  const [embedPreviewDataUrl, setEmbedPreviewDataUrl] = useState<string | null>(null)
  const [localSearchOpen, setLocalSearchOpen] = useState(false)
  const [localSearchQuery, setLocalSearchQuery] = useState('')
  const [localSearchState, setLocalSearchState] = useState<AppFindState>({ status: 'idle' })
  const embedSlotRef = useRef<HTMLDivElement>(null)
  const activeFindClientRequestIdRef = useRef<number | null>(null)
  const localSearchStateRef = useRef<AppFindState>({ status: 'idle' })
  const lastLocalSearchRequestIdRef = useRef(
    view.kind === 'mounted' || view.kind === 'minting' ? localSearchRequestId : 0
  )
  const localSearchPreviousFocusRef = useRef<HTMLElement | null>(null)
  // The deep-link confirm/error dialogs render as renderer DOM at the App
  // shell level; like the other shell overlays they must hide the native
  // WebContentsView, which always paints above the DOM, to be visible at all.
  const shellOverlayOpen =
    headerShellOverlayOpen ||
    sidebarShellOverlayOpen ||
    toastShellOverlayOpen ||
    deepLinkShellOverlayOpen

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

  // A launch waits for a registered measurer before anything is sent to main,
  // so the slot it opens into is the one this page lays out. The slot only
  // renders while a launch owns the tab; a measurement that never finds it laid
  // out reports `null` and the launch fails before reaching main.
  useLayoutEffect(
    () =>
      embed.registerMeasurer(async () => {
        const rect = await waitForEmbedSlotRect(embedSlotRef)
        return rect ? boundsFromRect(rect) : null
      }),
    [embed]
  )

  useEffect(() => {
    return window.clerum.sandboxUi.onFindResult(result => {
      if (result.clientRequestId !== activeFindClientRequestIdRef.current) return
      if (!result.finalUpdate) return
      const next: AppFindState =
        result.matches > 0
          ? { status: 'results', current: result.activeMatchOrdinal, total: result.matches }
          : { status: 'empty' }
      localSearchStateRef.current = next
      setLocalSearchState(next)
    })
  }, [])

  const stopLocalSearch = useCallback(() => {
    const previous = localSearchPreviousFocusRef.current
    activeFindClientRequestIdRef.current = null
    setLocalSearchOpen(false)
    setLocalSearchQuery('')
    localSearchStateRef.current = { status: 'idle' }
    setLocalSearchState({ status: 'idle' })
    void window.clerum.sandboxUi
      .stopFindInPage()
      .then(() => window.clerum.sandboxUi.focusActive())
      .then(focused => {
        if (!focused) {
          requestAnimationFrame(() => {
            if (previous?.isConnected) previous.focus()
          })
        }
      })
      .catch(() => undefined)
  }, [])

  const runLocalSearch = useCallback(
    async (query: string, operation: 'start' | 'next' | 'previous') => {
      if (!query.trim()) {
        activeFindClientRequestIdRef.current = null
        localSearchStateRef.current = { status: 'idle' }
        setLocalSearchState({ status: 'idle' })
        await window.clerum.sandboxUi.stopFindInPage()
        return
      }
      if (operation !== 'start' && localSearchStateRef.current.status !== 'results') return
      const clientRequestId =
        operation === 'start'
          ? ++nextSandboxFindClientRequestId
          : activeFindClientRequestIdRef.current
      if (clientRequestId === null) return
      activeFindClientRequestIdRef.current = clientRequestId
      localSearchStateRef.current = { status: 'pending' }
      setLocalSearchState({ status: 'pending' })
      try {
        const response = await window.clerum.sandboxUi.findInPage(query, {
          operation,
          clientRequestId,
        })
        if (clientRequestId !== activeFindClientRequestIdRef.current) return
        if (response.status === 'unavailable') {
          const next: AppFindState = {
            status: 'unavailable',
            reason:
              response.reason === 'document-loading'
                ? 'App is still loading'
                : 'Search is not available',
          }
          localSearchStateRef.current = next
          setLocalSearchState(next)
        }
      } catch (error) {
        if (clientRequestId !== activeFindClientRequestIdRef.current) return
        const next: AppFindState = {
          status: 'error',
          message: error instanceof Error ? error.message : 'Search failed',
        }
        localSearchStateRef.current = next
        setLocalSearchState(next)
      }
    },
    []
  )

  useEffect(() => {
    if (localSearchRequestId <= lastLocalSearchRequestIdRef.current || view.kind !== 'mounted') {
      return
    }
    lastLocalSearchRequestIdRef.current = localSearchRequestId
    localSearchPreviousFocusRef.current = document.activeElement as HTMLElement | null
    setLocalSearchOpen(true)
  }, [view.kind, localSearchRequestId])

  useEffect(() => {
    if (view.kind === 'mounted' || !localSearchOpen) return
    stopLocalSearch()
  }, [view.kind, localSearchOpen, stopLocalSearch])

  const onCopyDeepLink = useCallback(async () => {
    try {
      await window.clerum.sandboxUi.copyDeepLink(currentTeamId || undefined)
      onNotify?.('App link copied to clipboard.', 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onNotify?.(`Could not copy app link: ${message}`, 'error')
    }
  }, [currentTeamId, onNotify])

  const embedLive = view.kind === 'mounted' || view.kind === 'minting'
  // Main only honours setVisible/setBounds for a view it has already attached,
  // and attaches a freshly opened one visible. Re-running the visibility effect
  // per mounted view re-applies a hide requested while it was still opening.
  const mountedLaunchId = view.kind === 'mounted' ? view.launch.launchId : null

  // Track bounds while mounted; also while minting so the slot is placed by
  // the time the open reads it.
  useEmbedBounds(
    embedSlotRef,
    embedLive,
    shellOverlayOpen,
    boundsRefreshKey,
    onEmbedBoundsApplied,
    onEmbedSlotTopChange,
    onEmbedSlotRightChange
  )

  // Native WebContentsView content always paints above renderer DOM. Capture
  // and mount its preview before hiding it so the overlay transition reveals
  // an identical frame instead of briefly flashing the empty embed slot.
  useLayoutEffect(() => {
    let cancelled = false
    const updateVisibility = async (): Promise<void> => {
      if (shellOverlayOpen) {
        const dataUrl = await previewWithin(CAPTURE_PREVIEW_TIMEOUT_MS)
        if (cancelled) return
        if (dataUrl) {
          setEmbedPreviewDataUrl(dataUrl)
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          if (cancelled) return
        }
        try {
          await window.clerum.sandboxUi.setVisible(false)
        } catch {
          // The native view may already have been torn down while opening.
        }
        return
      }

      if (embedLive) {
        const rect = embedSlotRef.current?.getBoundingClientRect()
        if (rect) {
          try {
            await window.clerum.sandboxUi.setBounds(boundsFromRect(rect))
          } catch {
            // The native view may already have been torn down while closing.
          }
        }
      }
      if (cancelled) return
      try {
        await window.clerum.sandboxUi.setVisible(true)
      } catch {
        // The native view may already have been torn down while closing.
      }
      if (!cancelled) setEmbedPreviewDataUrl(null)
    }

    void updateVisibility()
    return () => {
      cancelled = true
    }
  }, [embedLive, mountedLaunchId, shellOverlayOpen])

  if (view.kind === 'mounted' || view.kind === 'minting') {
    const showRefreshBanner =
      refreshError !== null &&
      view.kind === 'mounted' &&
      refreshError.launchId === view.launch.launchId
    const hasLeadingActions = view.kind === 'mounted'
    return (
      <Flex vertical flex={1} data-testid="sandbox-ui-mounted">
        {titlebarLeadingContainer && hasLeadingActions
          ? createPortal(
              <div className="window-titlebar__leading-actions">
                <TitlebarLeadingAction
                  label="Refresh app content"
                  icon={<IconRefresh aria-hidden="true" width={16} height={16} />}
                  onClick={() => onRefresh?.()}
                />
                <TitlebarLeadingAction
                  label="Copy current app link"
                  icon={<IconCopy aria-hidden="true" width={16} height={16} />}
                  onClick={() => void onCopyDeepLink()}
                />
              </div>,
              titlebarLeadingContainer
            )
          : null}
        {showRefreshBanner ? (
          <Alert
            type="error"
            showIcon
            title={`Session refresh failed: ${refreshError.message}.`}
            action={<Button onClick={() => onRelaunch?.()}>Retry</Button>}
          />
        ) : null}
        {localSearchOpen ? (
          <SandboxCurrentContentSearch
            focusRequestId={localSearchRequestId}
            onClose={stopLocalSearch}
            onMove={operation => void runLocalSearch(localSearchQuery, operation)}
            onQueryChange={query => {
              setLocalSearchQuery(query)
              void runLocalSearch(query, 'start')
            }}
            query={localSearchQuery}
            state={localSearchState}
          />
        ) : null}
        {/* This slot remains the measured rectangle owned by Electron's native WebContentsView. */}
        <div ref={embedSlotRef} className="sandbox-ui-embed-slot">
          {embedPreviewDataUrl ? (
            <img
              className="sandbox-ui-embed-preview"
              src={embedPreviewDataUrl}
              alt=""
              data-testid="sandbox-ui-embed-preview"
            />
          ) : null}
          {view.kind === 'minting' ? (
            <Flex align="center" justify="center" role="status" aria-live="polite">
              <Spin size="small" />
              <Typography.Text>Loading app</Typography.Text>
            </Flex>
          ) : null}
        </div>
      </Flex>
    )
  }

  const failure = view.kind === 'failed' ? view.failure : null
  const failureBanner =
    failure === null ? null : failure.kind === 'crashed' ? (
      <Alert
        type="error"
        showIcon
        title={embedFailureMessage(failure)}
        action={<Button onClick={() => onRelaunch?.()}>Reopen</Button>}
      />
    ) : (
      <Alert
        type="error"
        showIcon
        title={`${activeAppRef ?? 'App'}: ${embedFailureMessage(failure)}`}
      />
    )

  const pageHeader = (
    <Flex vertical>
      <Typography.Title level={2}>Apps</Typography.Title>
      <Typography.Paragraph type="secondary">
        Discover and launch tools to help you work smarter.
      </Typography.Paragraph>
    </Flex>
  )

  if (apps === null) {
    return (
      <Flex vertical gap="large" aria-busy="true">
        {pageHeader}
        <Flex vertical gap="large" role="status" aria-live="polite">
          <Typography.Text>Fetching app catalog...</Typography.Text>
          <Skeleton active title paragraph={{ rows: 4 }} />
          <Skeleton active title paragraph={{ rows: 4 }} />
        </Flex>
      </Flex>
    )
  }

  if (apps.length === 0) {
    return (
      <Flex vertical gap="large">
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {failureBanner}
        {pageHeader}
        <Empty
          image={<IconSandboxUi aria-hidden="true" />}
          description={
            <Flex vertical>
              <Typography.Text>No available apps yet</Typography.Text>
              <Typography.Text type="secondary">
                Ask an admin if you expected to see one here.
              </Typography.Text>
            </Flex>
          }
        />
      </Flex>
    )
  }

  const appIcon = (app: SandboxUiAppListing) =>
    app.icon ? <img src={app.icon} alt="" width={20} height={20} /> : <IconSandboxUi />

  const appStatusTag = (app: SandboxUiAppListing) => {
    const status = phasePill(app.phase ?? null)
    const color =
      status.tone === 'allowed'
        ? 'success'
        : status.tone === 'warning'
          ? 'warning'
          : status.tone === 'denied'
            ? 'error'
            : status.tone === 'info'
              ? 'processing'
              : 'default'
    return <Tag color={color}>{status.label}</Tag>
  }

  const totalAppPages = Math.max(1, Math.ceil(apps.length / APP_PAGE_SIZE))
  const visibleAppsPage = Math.min(appsPage, totalAppPages - 1)
  const visibleApps = apps.slice(
    visibleAppsPage * APP_PAGE_SIZE,
    visibleAppsPage * APP_PAGE_SIZE + APP_PAGE_SIZE
  )

  return (
    <Flex vertical gap="large">
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {failureBanner}
      {pageHeader}
      <Flex vertical gap="middle">
        <Typography.Title level={4}>
          Purpose-built workspaces, right where your team works.
        </Typography.Title>
        <Typography.Paragraph>
          Apps are embedded workspaces your team can open inside Evenfire for focused workflows,
          quick reviews, and task-specific tools without leaving the desktop app.
        </Typography.Paragraph>
      </Flex>
      <Row>
        {visibleApps.map(app => {
          const activatable = app.ready
          const activate = (): void => {
            if (activatable) onLaunchApp(toActiveSandboxUiApp(app))
          }
          const actionProps = activatable
            ? {
                role: 'button' as const,
                tabIndex: 0,
                'aria-label': `Open ${appLabel(app)}`,
                onClick: activate,
                onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activate()
                  }
                },
              }
            : { 'aria-disabled': true }
          return (
            <Col key={app.appRef} xs={24} sm={12} md={8} lg={8}>
              <Card
                hoverable={activatable}
                aria-disabled={activatable ? undefined : true}
                {...actionProps}
              >
                <Flex vertical gap="small">
                  <Flex align="center" gap="small" wrap>
                    {appIcon(app)}
                    <Typography.Text strong>{appLabel(app)}</Typography.Text>
                  </Flex>
                  {appStatusTag(app)}
                  <Typography.Text type="secondary">
                    {formatLastUpdated(app.updatedAt ?? null)}
                  </Typography.Text>
                  {app.description ? (
                    <Typography.Paragraph>{app.description}</Typography.Paragraph>
                  ) : null}
                </Flex>
              </Card>
            </Col>
          )
        })}
      </Row>
      {totalAppPages > 1 ? (
        <Pagination
          aria-label="App pages"
          current={visibleAppsPage + 1}
          pageSize={APP_PAGE_SIZE}
          showSizeChanger={false}
          showTotal={() => `${visibleAppsPage + 1} / ${totalAppPages}`}
          total={apps.length}
          onChange={page => setAppsPage(page - 1)}
        />
      ) : null}
    </Flex>
  )
}
