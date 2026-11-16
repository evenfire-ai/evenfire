/**
 * Caller match and cancel decision for host runtime tasks.
 *
 * Channel-reader access fails closed unless channelType, channelId, and sender
 * match the pending result or the lifecycle record. Other callers keep the
 * fail-open submittedBy check.
 */
import type { CancelResult, RuntimeCallerContext } from '../server/types'
import type { TaskLifecycle } from './taskLifecycle'

export interface RuntimeSourceIdentity {
  channelType?: string | null
  channelId?: string | null
  sender?: string | null
}

export interface RuntimeEventLogger {
  info(fields: Record<string, unknown>, msg: string): void
  warn(fields: Record<string, unknown>, msg: string): void
  error(fields: Record<string, unknown>, msg: string): void
}

export interface RuntimeCallerDeps {
  pendingSource(taskId: string): RuntimeSourceIdentity | undefined
  lifecycle: TaskLifecycle | null
  logger: RuntimeEventLogger
}

export function sourceMatchesRuntimeCaller(
  source: RuntimeSourceIdentity,
  caller?: RuntimeCallerContext
): boolean {
  if (!caller) return false

  if (caller.caller === 'rpc-proxy') {
    return source.channelType === 'rpc' && !!caller.userId && source.sender === caller.userId
  }

  return (
    source.channelType === caller.channelType &&
    source.channelId === caller.channelId &&
    source.sender === caller.sender
  )
}

export function logRuntimeOwnershipMismatch(
  log: RuntimeEventLogger,
  route: string,
  taskId: string,
  caller: RuntimeCallerContext,
  source: RuntimeSourceIdentity
): void {
  log.warn(
    {
      event: 'runtime_task_ownership_mismatch',
      route,
      taskId,
      caller: caller.caller,
      callerUserId: caller.userId ?? null,
      callerChannelType: caller.channelType ?? null,
      callerChannelId: caller.channelId ?? null,
      callerSender: caller.sender ?? null,
      taskChannelType: source.channelType ?? null,
      taskChannelId: source.channelId ?? null,
      taskSender: source.sender ?? null,
    },
    'Host runtime event'
  )
}

export function runtimeCallerCanReadTask(
  taskId: string,
  caller: RuntimeCallerContext | undefined,
  route: string,
  deps: RuntimeCallerDeps
): boolean {
  if (!caller) return false

  const pending = deps.pendingSource(taskId)
  if (pending) {
    const matches = sourceMatchesRuntimeCaller(pending, caller)
    if (!matches) logRuntimeOwnershipMismatch(deps.logger, route, taskId, caller, pending)
    return matches
  }

  const record = deps.lifecycle?.get(taskId)
  if (!record) return false

  const source = {
    channelType: record.submittedChannelType,
    channelId: record.submittedChannelId,
    sender: record.submittedBy,
  }
  const matches = sourceMatchesRuntimeCaller(source, caller)
  if (!matches) logRuntimeOwnershipMismatch(deps.logger, route, taskId, caller, source)
  return matches
}

/**
 * Channel-reader cancels must match the pending source or the lifecycle record.
 * Other callers keep the fail-open submittedBy check, then transition to cancelled.
 */
export function handleRuntimeCancel(
  taskId: string,
  requesterUserId: string | undefined,
  caller: RuntimeCallerContext | undefined,
  deps: RuntimeCallerDeps
): CancelResult {
  if (
    caller?.caller === 'channel-reader' &&
    !runtimeCallerCanReadTask(taskId, caller, 'task_cancel', deps)
  ) {
    return 'not_found'
  }
  deps.logger.info(
    {
      event: 'cancel_requested',
      taskId,
      requesterUserId: requesterUserId ?? null,
      // HTTP-initiated cancels are always user-originated. Shutdown drain logs
      // 'system' from stateMachine.stop().
      origin: 'user',
    },
    'Host runtime event'
  )

  // Ownership check: if the record carries a submittedBy identity AND the
  // requester identity is provided, they must match.
  // Fail-open when either side is absent for back-compat — internal tasks have no
  // submitter, and older rpc-proxy versions didn't pass userId. New rpc-proxy always
  // passes userId so this narrows over time.
  const existing = deps.lifecycle!.get(taskId)
  if (
    existing &&
    existing.submittedBy &&
    requesterUserId &&
    existing.submittedBy !== requesterUserId
  ) {
    deps.logger.warn(
      {
        event: 'cancel_ownership_mismatch',
        taskId,
        submittedBy: existing.submittedBy,
        requester: requesterUserId,
      },
      'Host runtime event'
    )
    // Do NOT leak task existence to unauthorized requesters
    return 'not_found'
  }

  const outcome = deps.lifecycle!.transition(taskId, 'cancelled', 'user_requested')

  if (outcome.kind === 'applied') {
    deps.logger.info(
      {
        event: 'cancel_applied',
        taskId,
        from_state: outcome.from,
        reason: outcome.reason,
      },
      'Host runtime event'
    )
    return 'cancelled'
  }
  if (outcome.kind === 'already_terminal') {
    deps.logger.info(
      {
        event: 'already_terminal',
        taskId,
        current_state: outcome.state,
        requested_transition: 'cancelled',
      },
      'Host runtime event'
    )
    return 'already_terminal'
  }
  if (outcome.kind === 'not_found') {
    return 'not_found'
  }
  // kind === 'illegal' — should never happen for cancel
  deps.logger.error({ outcome: outcome }, '[cancel] illegal transition')
  return 'not_found'
}
