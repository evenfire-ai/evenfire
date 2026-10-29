import { useCallback, useEffect, useState } from 'react'
import { type TaskState, makeTaskKey, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { Alert, Button, Flex, Typography } from 'antd'
import { IconClose } from '@components/SidebarNav/icons'
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
    <Flex gap="middle" wrap>
      <Typography.Text>Iteration {lastTool?.iteration ?? 0}</Typography.Text>
      {lastTool ? <Typography.Text>Last tool: {lastTool.displayName}</Typography.Text> : null}
    </Flex>
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
 *
 * TASK-228: every tier renders a dismiss (×) button. A dismissal is keyed by
 * task identity and suppresses all later tiers of that same task; a new task
 * (same chat or another) starts fresh. Tier timing/thresholds are untouched.
 */
export function NudgeArea({ agentRef, chatId, onStartNewChat, onRefreshState }: Props) {
  const tracker = useAgentTaskTracker()
  const key = makeTaskKey(agentRef, chatId)
  const [state, setState] = useState<TaskState | undefined>(() => tracker.get(key))
  // TASK-228: tasks the user explicitly dismissed. Keyed by task identity so a
  // dismissal hides every later tier of the SAME task (tracker updates keep
  // arriving) while a NEW task in the same chat starts fresh with its nudges.
  const [dismissedTaskIds, setDismissedTaskIds] = useState<ReadonlySet<string>>(() => new Set())
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

  const dismissNudge = useCallback((taskIdentity: string) => {
    setDismissedTaskIds(previous => {
      if (previous.has(taskIdentity)) return previous
      const next = new Set(previous)
      next.add(taskIdentity)
      return next
    })
  }, [])

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
  // Degenerate-taskId fallback (PR #859 review): keying an id-less task's
  // dismissal to the CHAT key would suppress every future task in the chat,
  // contradicting "a new task starts fresh". `startedAt` stays per-task.
  const taskIdentity = state.taskId || `${key}@${state.startedAt}`
  if (dismissedTaskIds.has(taskIdentity)) return null

  const dismissButton = (
    <Button
      type="text"
      aria-label="Dismiss this suggestion"
      title="Dismiss this suggestion"
      icon={<IconClose aria-hidden="true" width={16} height={16} />}
      onClick={() => dismissNudge(taskIdentity)}
    />
  )

  if (tier === 'T3') {
    return (
      <Flex vertical gap="small" data-tier="T3">
        <Flex align="start" gap="small">
          <Alert
            type="info"
            showIcon
            title="This task is taking longer than usual. You can keep working in another chat — we'll let you know here when it's done."
          />
          {dismissButton}
        </Flex>
        <Button type="primary" onClick={onStartNewChat}>
          Start a new chat
        </Button>
      </Flex>
    )
  }

  if (tier === 'T4') {
    const text = isWindowVisible
      ? "Your agent is still working. It's safe to close this window — you'll see the result when you reopen."
      : 'Your agent is still working. Your system will notify you when it finishes.'
    return (
      <Flex vertical gap="small" data-tier="T4">
        <Flex align="start" gap="small">
          <Alert type="info" showIcon title={text} />
          {dismissButton}
        </Flex>
        <MiniSummary steps={state.steps} />
      </Flex>
    )
  }

  // T5
  return (
    <Flex vertical gap="small" data-tier="T5">
      <Flex align="start" gap="small">
        <Alert
          type="warning"
          showIcon
          title="Your agent is still working. If you think something might be stuck, you can refresh the state."
        />
        {dismissButton}
      </Flex>
      <MiniSummary steps={state.steps} />
      <Button onClick={() => void onRefreshState()}>Refresh state</Button>
    </Flex>
  )
}
