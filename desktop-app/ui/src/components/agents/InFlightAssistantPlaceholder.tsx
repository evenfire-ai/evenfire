import { useEffect, useMemo, useState } from 'react'
import { type TaskState, makeTaskKey, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import type { ApprovalDecisionTarget } from '@hooks/domain/approvalDecision'
import { trackerStateToTaskProgress } from '@hooks/domain/trackerToProgress'
import { ProgressStepper } from '../ProgressStepper'

interface Props {
  agentRef: string
  chatId: string
  /** Message ids already rendered in the thread — if the task's originating
   *  message is among them, its own ProgressStepper shows it, so we render nothing. */
  localMessageIds: Set<string>
  onCancelTask?: (taskId: string) => void
  /** §4.7.4: central approval decider (in-flight placeholder = surface d). */
  decideApproval: (target: ApprovalDecisionTarget) => Promise<void>
  /**
   * §8-R2 optimistic paint: the FSM projection's pending approval for this chat.
   * `seedSuspended` is gone, so on a rejoin the approve/deny gate is driven by the
   * reconcile's `SERVER_SNAPSHOT` (this prop) until the rejoined SSE replays the
   * sticky `suspended` (V2) into the tracker. The tracker's own `pendingApproval`
   * (live/replayed suspended) still wins when present.
   */
  pendingApproval?: {
    requestId: string
    displayName: string
    // U5: carried through the FSM projection so the optimistic-paint fallback can
    // also drive the "Connect <server>" prompt before the tracker's live
    // suspended replays.
    reason?: string
    mcpServerName?: string
  }
}

/**
 * D.5 in-flight placeholder: a synthetic assistant bubble that renders the live
 * ProgressStepper for a running/rejoined task that has NO local message bubble
 * (e.g. a task rejoined via D.4 Phase 3 after reload / from another device).
 * Locally-started tasks already render progress on their own user message, so
 * this stays hidden for them. Subscribes to the tracker so SSE updates re-render.
 */
export function InFlightAssistantPlaceholder({
  agentRef,
  chatId,
  localMessageIds,
  onCancelTask,
  decideApproval,
  pendingApproval,
}: Props) {
  const tracker = useAgentTaskTracker()
  const key = makeTaskKey(agentRef, chatId)
  const [state, setState] = useState<TaskState | undefined>(() => tracker.get(key))

  // Reset to the new key's state (or `undefined`) BEFORE subscribing: when the
  // key changes (chat switch), `subscribe`'s sync-up only emits if the new key
  // has a task, so without this seed the local state would retain the previous
  // chat's task — leaking another chat's in-flight stepper into this one.
  useEffect(() => {
    setState(tracker.get(key))
    return tracker.subscribe(key, setState)
  }, [tracker, key])

  const progress = useMemo(() => (state ? trackerStateToTaskProgress(state) : undefined), [state])

  // Hide once terminal/acked, or when a real message bubble already represents
  // this task (avoids a duplicate stepper for locally-started sends).
  if (!state || !progress) return null
  if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed')
    return null
  if (localMessageIds.has(state.userMessageId)) return null

  // Tracker-held approval wins; else the FSM optimistic paint (§8-R2).
  const si = progress.suspendedInfo ?? pendingApproval
  const taskId = state.taskId

  return (
    <section className="chat-group assistant" data-task-id={taskId}>
      <div className="chat-bubble assistant chat-message--in-flight">
        <ProgressStepper
          progress={progress}
          hostRef={agentRef}
          onApprove={
            si
              ? () => {
                  // Surface (d), §4.7.4: funnel through the central decider.
                  void decideApproval({
                    agentRef,
                    chatId,
                    taskId,
                    requestId: si.requestId,
                    decision: 'approve',
                    source: 'placeholder',
                  })
                }
              : undefined
          }
          onDeny={
            si
              ? () => {
                  void decideApproval({
                    agentRef,
                    chatId,
                    taskId,
                    requestId: si.requestId,
                    decision: 'deny',
                    source: 'placeholder',
                  })
                }
              : undefined
          }
          onCancel={onCancelTask ? () => onCancelTask(taskId) : undefined}
          onConnect={
            // U5: connect_required suspension → open the provider OAuth flow,
            // host-bound to this conversation's agent (hostRef ≡ agentRef).
            si?.reason === 'connect_required' && si.mcpServerName
              ? () => {
                  void window.clerum.rpc.connectMcpServer(si.mcpServerName!, agentRef)
                }
              : undefined
          }
        />
      </div>
    </section>
  )
}
