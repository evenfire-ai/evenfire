import { AgentStateMachine } from './agent'
import { MessageQueue, Task } from './queue'
import type { HostActivityEvent } from './server'

type PublishFn = (input: {
  task?: Task
  type: HostActivityEvent['type']
  title: string
  severity?: HostActivityEvent['severity']
  meta?: Record<string, unknown>
}) => void

/**
 * Wire agent and queue events to the activity hub.
 * Extracted from initializeAgent() to reduce main.ts size.
 */
export function wireActivityEvents(
  agent: AgentStateMachine,
  messageQueue: MessageQueue,
  publishActivity: PublishFn
): void {
  // Agent events
  agent.on('task:completed', event => {
    const { task, result } = event.data as { task: Task; result: unknown }
    console.log(`[Main] Task completed: ${task.id}`)
    publishActivity({
      task,
      type: 'task.completed',
      title: `Task completed (${task.id})`,
      meta: { resultType: typeof result },
    })
  })

  agent.on('task:failed', event => {
    const { task, error } = event.data as {
      task: Task
      error: { code?: string; message?: string } | string
    }
    const errMsg = typeof error === 'string' ? error : (error?.message ?? 'unknown')
    const errCode = typeof error === 'string' ? undefined : error?.code
    console.error(`[Main] Task failed: ${task.id} - ${errCode ?? 'ERROR'}: ${errMsg}`)
    publishActivity({
      task,
      type: 'task.failed',
      title: `Task failed (${task.id})`,
      severity: 'error',
      meta: { errorMessage: errMsg.slice(0, 120), ...(errCode && { errorCode: errCode }) },
    })
  })

  agent.on('state:changed', event => {
    const { oldState, newState } = event.data as { oldState: string; newState: string }
    console.log(`[Main] Agent state: ${oldState} -> ${newState}`)
    publishActivity({
      type: 'agent.state.changed',
      title: `Agent state changed: ${oldState} -> ${newState}`,
      meta: { oldState, newState },
    })
  })

  // Queue events
  messageQueue.on('task:added', event => {
    const stats = messageQueue.getStats()
    console.log(`[Main] Queue: ${stats.pending} pending, ${stats.processing} processing`)
    const task = event.task
    if (task) {
      publishActivity({
        task,
        type: 'task.queued',
        title: `Task queued (${task.id})`,
        meta: { source: task.source, queuePending: stats.pending },
      })
    }
    publishActivity({
      type: 'queue.depth.changed',
      title: `Queue depth changed: ${stats.pending} pending`,
      meta: { pending: stats.pending, processing: stats.processing },
    })
  })

  messageQueue.on('task:started', event => {
    const task = event.task
    if (!task) return
    publishActivity({
      task,
      type: 'task.started',
      title: `Task started (${task.id})`,
      meta: { source: task.source },
    })
  })

  // Core events (from SimpleEventEmitter)
  const coreEvents = agent.getCoreEvents()

  coreEvents.on('tool:called', event => {
    const task = event.data.task as Task | undefined
    const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : 'tool'
    publishActivity({
      task,
      type: 'tool.call.started',
      title: `Tool call started: ${toolName}`,
      meta: { toolName },
    })
  })

  coreEvents.on('tool:completed', event => {
    const task = event.data.task as Task | undefined
    const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : 'tool'
    publishActivity({
      task,
      type: 'tool.call.completed',
      title: `Tool call completed: ${toolName}`,
      meta: { toolName },
    })
  })

  coreEvents.on('tool:approval_needed', event => {
    const taskId = typeof event.data.taskId === 'string' ? event.data.taskId : undefined
    publishActivity({
      type: 'approval.requested',
      title: 'Approval requested for tool execution',
      severity: 'warn',
      meta: { taskId, toolName: event.data.toolName },
    })
  })

  coreEvents.on('tool:approval_granted', event => {
    publishActivity({
      type: 'approval.approved',
      title: 'Approval granted',
      meta: { requestId: event.data.request_id },
    })
  })

  coreEvents.on('tool:approval_denied', event => {
    publishActivity({
      type: 'approval.denied',
      title: 'Approval denied',
      severity: 'warn',
      meta: { requestId: event.data.request_id },
    })
  })

  coreEvents.on('safety:input_blocked', event => {
    const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : 'tool'
    const errors = Array.isArray(event.data.errors) ? event.data.errors : []
    publishActivity({
      type: 'safety.input_blocked',
      title: `Safety blocked tool input: ${toolName}`,
      severity: 'warn',
      meta: {
        toolName,
        errorCount: errors.length,
        reasons: errors.join('; ').slice(0, 160),
      },
    })
  })

  coreEvents.on('safety:output_sanitized', event => {
    const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : 'tool'
    publishActivity({
      type: 'safety.output_sanitized',
      title: `Tool output sanitized: ${toolName}`,
      severity: 'warn',
      meta: {
        toolName,
        originalLength:
          typeof event.data.originalLength === 'number' ? event.data.originalLength : 0,
        sanitizedLength:
          typeof event.data.sanitizedLength === 'number' ? event.data.sanitizedLength : 0,
      },
    })
  })

  coreEvents.on('loop:iteration', _event => {
    publishActivity({
      type: 'llm.requested',
      title: 'LLM request started',
    })
  })

  // IronClaw invariant #1 (P.3): surface the skipped compaction so operators
  // can correlate "context not compacted" with "user has a pending approval".
  coreEvents.on('compaction:skipped', event => {
    const reason = typeof event.data.reason === 'string' ? event.data.reason : 'unknown'
    const phase = typeof event.data.phase === 'string' ? event.data.phase : 'unknown'
    const iteration = typeof event.data.iteration === 'number' ? event.data.iteration : undefined
    publishActivity({
      type: 'compaction.skipped',
      title: `Context compaction skipped (${reason})`,
      meta: { reason, phase, ...(iteration !== undefined && { iteration }) },
    })
  })

  // T1.2: surfaces how much the deterministic pre-prune reclaimed before any
  // tier ran. Operators read `savingsRatio` to validate the rollout.
  coreEvents.on('compaction:pre_prune_executed', event => {
    const preTokens = typeof event.data.preTokens === 'number' ? event.data.preTokens : undefined
    const postTokens = typeof event.data.postTokens === 'number' ? event.data.postTokens : undefined
    const savingsTokens =
      typeof event.data.savingsTokens === 'number' ? event.data.savingsTokens : undefined
    const savingsRatio =
      typeof event.data.savingsRatio === 'number' ? event.data.savingsRatio : undefined
    const passesApplied = Array.isArray(event.data.passesApplied)
      ? (event.data.passesApplied as string[])
      : []
    publishActivity({
      type: 'compaction.pre_prune_executed',
      title: `Pre-prune reclaimed ${savingsTokens ?? '?'} tokens`,
      meta: {
        ...(preTokens !== undefined && { preTokens }),
        ...(postTokens !== undefined && { postTokens }),
        ...(savingsTokens !== undefined && { savingsTokens }),
        ...(savingsRatio !== undefined && { savingsRatio }),
        passesApplied,
      },
    })
  })

  // T1.4: emitted exactly once per task when consecutive compactions stop
  // yielding savings. The hub redaction layer strips sensitive keys; our meta
  // is numeric so it survives intact.
  coreEvents.on('compaction:thrashing', event => {
    const lastRatio = typeof event.data.lastRatio === 'number' ? event.data.lastRatio : undefined
    const consecutiveCount =
      typeof event.data.consecutiveCount === 'number' ? event.data.consecutiveCount : undefined
    publishActivity({
      type: 'compaction.thrashing',
      title: 'Compaction disabled — no progress',
      severity: 'warn',
      meta: {
        ...(lastRatio !== undefined && { lastRatio }),
        ...(consecutiveCount !== undefined && { consecutiveCount }),
      },
    })
  })

  coreEvents.on('loop:completed', event => {
    const hasError = Boolean(event.data.error)
    publishActivity({
      type: hasError ? 'llm.failed' : 'llm.responded',
      title: hasError ? 'LLM request failed' : 'LLM response received',
      severity: hasError ? 'error' : 'info',
    })
  })
}
