'use client'

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HostApprovalSection } from '@components/HostApprovalSection'
import { useToast } from '@components/Toast'
import { IconInfoCircle } from '@components/icons'
import { Button } from '@components/ui'
import { type HostResource, getHostDetailBundle } from '@lib/api'
import { approvalBlockOf, effectiveApproval } from '@lib/approvalEffective'
import {
  type ApprovalLoadToken,
  createApprovalTabState,
  notifyHostChanged,
  subscribeHostChanged,
} from '@lib/hostApprovalDisplay'
import type { ToolsSaveOutcome } from '@lib/hostApprovalSave'
import { emitRootToast } from '@lib/rootToast'
import { ApprovalModesView, WhoCanRaiseView } from './ReadViews'
import {
  INHERITING_BANNER_TEXT,
  LOADING_LABEL,
  NOT_THIS_AGENT_MESSAGE,
  TOOLS_SAVED_TOAST,
  continuationToast,
  loadErrorText,
} from './constants'
import type {
  ApprovalsTabView,
  HostApprovalsTabProps,
  LoadErrorBannerProps,
  LoadResult,
} from './types'

/** A new view of `host`: a new display state, loading its first load. */
function viewOf(host: string): ApprovalsTabView {
  return {
    host,
    state: createApprovalTabState(host),
    snapshot: null,
    loadPending: true,
    loadError: null,
  }
}

/** A thrown value's message (a DOMException is not an `Error` in every realm). */
function messageOf(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/**
 * The newest load's failure, with Retry. While a load runs, the banner stays
 * and Retry is disabled with `aria-disabled`, not `disabled`: a disabled
 * element can lose the focus, and the admin who pressed Retry keeps it.
 */
function LoadErrorBanner({ message, pending, onRetry }: LoadErrorBannerProps) {
  return (
    <div className="cu-banner cu-banner--error cu-host-approvals-tab__error" role="alert">
      <span>{loadErrorText(message)}</span>
      <Button
        aria-disabled={pending || undefined}
        size="sm"
        variant="ghost"
        onClick={pending ? undefined : onRetry}
      >
        Retry
      </Button>
    </div>
  )
}

/** Spec §6.2: the agent has no `spec.approval` of its own (absent or null; `{}` is its own). */
function InheritingBanner() {
  return (
    <div className="cu-banner cu-banner--info cu-host-approvals-tab__banner">
      <IconInfoCircle aria-hidden height={16} width={16} />
      <span>{INHERITING_BANNER_TEXT}</span>
    </div>
  )
}

function ReadViewsSkeleton() {
  return (
    <div aria-label={LOADING_LABEL} className="cu-host-approvals-tab__skeleton" role="status">
      <div className="cu-skeleton cu-skeleton--text" />
      <div className="cu-skeleton cu-skeleton--text-sm" />
      <div className="cu-skeleton cu-skeleton--text" />
    </div>
  )
}

/**
 * The Approvals tab of one agent (spec §6.2, §6.5, §6.12). It owns its loads,
 * its error and loading state and its mounted flag, and reads nothing of the
 * page's. It shows the read views of the approval settings and the per-tool
 * section.
 *
 * **Loads.** Each load reads `/detail` with its own signal, so it never joins an
 * older read (R9), and takes a new epoch in the agent's display state
 * (lib/hostApprovalDisplay). A load applies to the display state the tab shows
 * when it lands, only if it is that state's newest load and holds that agent's
 * Host. The newest load's settling, applied or failed, releases Save; its
 * failure shows in the tab's banner with Retry, and stays there while a newer
 * load runs, so Retry keeps the focus. A first load that fails shows
 * no section (C13); once the tab has shown an agent, the section stays mounted,
 * so a save in flight keeps its section (C10, R27).
 *
 * **Saves.** The per-tool section reports every save that ends through
 * `onSettled`, with the callback of the render where Save was pressed. While
 * the tab is mounted, shows that agent and still shows the section that ran
 * the save, a saved answer seeds the tools group of the display state it shows
 * now, and the tab shows the success toast; the section shows every other
 * outcome. Otherwise the save writes nothing to the tab and reports through
 * the root toast, naming the agent (spec §6.5 "After unmount"). That includes
 * a save whose section the tab dropped meanwhile (a kept page whose next
 * agent's first load failed): a section shown again is a new one, which knows
 * nothing of the save. Every save that ends fires the Host-changed notice,
 * which loads again every Approvals tab of that agent, this one included.
 *
 * **Another agent.** A kept instance given another agent starts a new view in
 * the same render, so nothing of the previous agent shows; the section ends its
 * edit session when its agent changes, and a save of the previous agent that
 * settles later closes only the edit session it started in.
 */
export function HostApprovalsTab({ host }: HostApprovalsTabProps) {
  const { showToast } = useToast()
  const [view, setView] = useState(() => viewOf(host))
  // Whether this instance has shown an agent's settings. From then on the
  // per-tool section stays mounted, so a save in flight keeps its section.
  const [shownOnce, setShownOnce] = useState(false)
  if (view.host !== host) setView(viewOf(host))

  // The tab drops the section while the agent it shows has nothing to show and
  // its newest load failed (C13). Each time it shows the section again, the
  // section is a new instance, with a new generation.
  const failedWithNothingShown = view.snapshot === null && view.loadError !== null
  const showSection = shownOnce && !failedWithNothingShown
  const [section, setSection] = useState({ shown: false, generation: 0 })
  if (section.shown !== showSection) {
    setSection({
      shown: showSection,
      generation: showSection ? section.generation + 1 : section.generation,
    })
  }

  const mountedRef = useRef(false)
  const controllersRef = useRef(new Set<AbortController>())
  // What continuations check: the view the tab shows, and the generation of
  // the section it shows (null while none). Written when a render commits, so
  // a render React never commits does not move them (Ruling 41(1)).
  const viewRef = useRef(view)
  const shownSectionRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    viewRef.current = view
    shownSectionRef.current = section.shown ? section.generation : null
  }, [view, section])

  useEffect(() => {
    mountedRef.current = true
    const controllers = controllersRef.current
    return () => {
      mountedRef.current = false
      // Nothing will show these reads' answers once the tab is gone.
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [])

  const settleLoad = useCallback((token: ApprovalLoadToken, result: LoadResult): void => {
    // The tab is gone, and it aborted its reads when it went: nothing shows an
    // answer or a failure now.
    if (!mountedRef.current) return
    const current = viewRef.current
    const applied =
      result.kind === 'answered' && current.state.applyLoad(token, result.host as HostResource)
    // A load that is not the newest of the display state the tab shows (an
    // older one, or one of an agent the tab no longer shows) decides nothing.
    if (!current.state.isNewestLoad(token)) return
    if (applied) {
      const snapshot = current.state.snapshot()
      setView(shown =>
        shown.state === current.state
          ? { ...shown, snapshot, loadPending: false, loadError: null }
          : shown
      )
      setShownOnce(true)
      return
    }
    // The newest load failed, or answered with no Host of this agent: the
    // banner says so, and Save is released all the same (C10, A4 L2).
    const message = result.kind === 'failed' ? messageOf(result.error) : NOT_THIS_AGENT_MESSAGE
    setView(shown =>
      shown.state === current.state ? { ...shown, loadPending: false, loadError: message } : shown
    )
  }, [])

  const load = useCallback(
    (target: ApprovalsTabView): void => {
      const token = target.state.startLoad()
      const controller = new AbortController()
      controllersRef.current.add(controller)
      // The last failure stays shown until this load settles (review R45(6)).
      setView(shown =>
        shown.state !== target.state || shown.loadPending ? shown : { ...shown, loadPending: true }
      )
      void (async () => {
        let result: LoadResult
        try {
          // Spec §6.5: its own signal, so the read never joins an older one.
          const detail = await getHostDetailBundle(target.host, { signal: controller.signal })
          result = { kind: 'answered', host: detail?.host }
        } catch (error) {
          // Not dropped: settleLoad shows the newest load's failure in the
          // tab's banner, and says there why it drops any other.
          result = { kind: 'failed', error }
        } finally {
          controllersRef.current.delete(controller)
        }
        settleLoad(token, result)
      })()
    },
    [settleLoad]
  )

  useEffect(() => {
    // The view this render committed: its agent and display state never
    // change, so one first load and one subscription serve it.
    const target = view
    load(target)
    // Spec §6.5: an approval write for this agent that settles, in this
    // document or another, loads the tab again.
    return subscribeHostChanged(target.host, () => load(target))
    // The other fields of `view` change with every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.state, load])

  const settleSave = useCallback(
    (savedHost: string, savedSection: number, outcome: ToolsSaveOutcome): void => {
      const current = viewRef.current
      // Spec §6.5 "After unmount": a save whose tab is gone, or now shows
      // another agent, writes nothing to the tab and reports through the root
      // toast, naming the agent. So does a save whose section the tab dropped
      // meanwhile (review I1): no section on screen can show its outcome.
      if (
        !mountedRef.current ||
        current.host !== savedHost ||
        shownSectionRef.current !== savedSection
      ) {
        const toast = continuationToast(savedHost, outcome)
        emitRootToast(toast.message, toast.options)
        notifyHostChanged(savedHost)
        return
      }
      if (outcome.kind === 'saved') {
        // The stored Host seeds the tools group of the display state the tab
        // shows now, which a kept instance may have made since the save
        // started. A stored Host of another name seeds nothing: the load the
        // notice starts shows what is stored.
        if (current.state.applyWrite('tools', outcome.stored)) {
          const snapshot = current.state.snapshot()
          setView(shown => (shown.state === current.state ? { ...shown, snapshot } : shown))
        }
        showToast(TOOLS_SAVED_TOAST, { tone: 'success' })
      }
      // The section that ran the save shows every other outcome itself. The
      // notice loads this tab again too, in this same call, so Save waits for
      // that load.
      notifyHostChanged(savedHost)
    },
    [showToast]
  )

  // The section calls the `onSettled` of the render where Save was pressed,
  // so `host` and `generation` here are the save's agent and section.
  const { generation } = section
  function handleSettled(outcome: ToolsSaveOutcome): void {
    settleSave(host, generation, outcome)
  }

  const block = approvalBlockOf(view.snapshot)
  return (
    <div className="cu-host-approvals-tab">
      {view.loadError !== null ? (
        <LoadErrorBanner
          message={view.loadError}
          pending={view.loadPending}
          onRetry={() => load(view)}
        />
      ) : null}
      {view.snapshot !== null ? (
        <>
          {block === undefined ? <InheritingBanner /> : null}
          <ApprovalModesView host={view.snapshot} />
          <WhoCanRaiseView host={view.snapshot} />
        </>
      ) : view.loadPending ? (
        <ReadViewsSkeleton />
      ) : null}
      {showSection ? (
        <HostApprovalSection
          ceiling={effectiveApproval(block).modeCeiling}
          host={host}
          inherited={block === undefined}
          loadPending={view.loadPending}
          stored={view.snapshot}
          onSettled={handleSettled}
        />
      ) : null}
    </div>
  )
}
