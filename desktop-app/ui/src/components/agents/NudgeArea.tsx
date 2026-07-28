import { useEffect, useState } from 'react'
import { type TaskState, makeTaskKey, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { Button, StatusBanner } from '@components/Common'
import { useBrowserWindowState } from '@hooks/useBrowserWindowState'
import { useTaskTier } from '@hooks/useTaskTier'
import type { ProgressStep } from '../../uiTypes'

interface Props {
  agentRef: string
  chatId: string
  /** Starts a fresh chat with the same agent (the running task keeps tracking). */
  onStartNewChat: () => void
  /** Re-reconciles the chat with the server without resetting the task age. */
  onRefreshState: () => void | Promise<void>
}

function MiniSummary({ steps }: { steps: ProgressStep[] }) {
  const lastTool = steps[steps.length - 1]
  return (
    <div className="nudge-mini-summary">
      <span>Iteration {lastTool?.iteration ?? 0}</span>
      {lastTool ? <span>Last tool: {lastTool.displayName}</span> : null}
    </div>
  )
}

/**
 * D.5b time-aware nudges. Subscribes to the active chat's tracked task and, as
 * the wait grows (tiers from `useTaskTier`), proactively tells the user they can
 * step away — closing the "fire & forget + come back" loop. Renders nothing for
 * T1/T2 (short waits) and for no/terminal task. Covers both locally-started and
 * rejoined tasks (rendered as a sibling of the thread, not inside the placeholder).
 *
 * Suspended tasks render NO nudge at all. Every T3+ nudge asserts the agent is
 * working ("still working", "taking longer than usual", "might be stuck") — all
 * false while the task is parked on an approval gate, where the blocker is the
 * user, not the agent. §AC3 freezes the tier timer at `pausedAt` so the wait
 * itself can't escalate, but a task that genuinely ran >2min BEFORE suspending
 * still enters the gate already at T3/T4/T5, so the freeze alone can't suppress
 * the misleading copy — this guard does. No replacement "waiting for your
 * approval" banner: the approval card rendered above is already that affordance,
 * and duplicating it would just add noise under it.
 */
export function NudgeArea({ agentRef, chatId, onStartNewChat, onRefreshState }: Props) {
  const tracker = useAgentTaskTracker()
  const key = makeTaskKey(agentRef, chatId)
  const [state, setState] = useState<TaskState | undefined>(() => tracker.get(key))
  const { isWindowVisible } = useBrowserWindowState()
  const tier = useTaskTier(state)

  // Reset to the new key's state (or `undefined`) BEFORE subscribing: when the
  // key changes (chat switch), `subscribe`'s sync-up only emits if the new key
  // has a task, so without this seed the local state would retain the previous
  // chat's task — leaking another chat's nudge into this one.
  useEffect(() => {
    setState(tracker.get(key))
    return tracker.subscribe(key, setState)
  }, [tracker, key])

  if (!state) return null
  if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed')
    return null
  // Approval gate open → the approval card owns the surface (see the block
  // above). Also guard on `pendingApproval` alone: after a rejoin the FSM
  // projection can paint the gate before the sticky `suspended` replay flips
  // this tracker entry's status, and the nudge must stay out through that
  // window too.
  if (state.status === 'suspended' || state.pendingApproval) return null
  if (tier === 'T1' || tier === 'T2') return null

  if (tier === 'T3') {
    return (
      <div className="nudge-area" data-tier="T3">
        <StatusBanner tone="info" compact>
          This task is taking longer than usual. You can keep working in another chat — we'll let
          you know here when it's done.
        </StatusBanner>
        <Button
          className="nudge-area-action"
          variant="soft"
          color="primary"
          size="sm"
          onClick={onStartNewChat}
        >
          Start a new chat
        </Button>
      </div>
    )
  }

  if (tier === 'T4') {
    const text = isWindowVisible
      ? "Your agent is still working. It's safe to close this window — you'll see the result when you reopen."
      : 'Your agent is still working. Your system will notify you when it finishes.'
    return (
      <div className="nudge-area" data-tier="T4">
        <StatusBanner tone="info" compact>
          {text}
        </StatusBanner>
        <MiniSummary steps={state.steps} />
      </div>
    )
  }

  // T5
  return (
    <div className="nudge-area" data-tier="T5">
      <StatusBanner tone="warn" compact>
        Your agent is still working. If you think something might be stuck, you can refresh the
        state.
      </StatusBanner>
      <MiniSummary steps={state.steps} />
      <Button
        className="nudge-area-action"
        variant="soft"
        size="sm"
        onClick={() => void onRefreshState()}
      >
        Refresh state
      </Button>
    </div>
  )
}
