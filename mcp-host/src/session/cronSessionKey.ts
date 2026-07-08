import type { Task } from '../queue/types'
import type { SessionKey } from './types'

/**
 * Deterministic session identity for cron-fired tasks.
 * Origin-backed jobs reuse the channel tuple; origin-less jobs isolate per cronJobId.
 */
export function resolveCronTaskSessionKey(task: Task): SessionKey {
  const msg = task.sourceMessage
  if (msg) {
    return {
      userId: msg.sender,
      channelType: msg.channelType,
      channelId: msg.channelId,
      threadId: msg.threadId,
    }
  }

  return {
    userId: 'system',
    channelType: 'cron',
    // MessageQueue always provides cronJobId for cron tasks; fall back to the
    // always-unique task.id so an origin-less task without a cronJobId still
    // isolates instead of colliding on a shared 'unknown' session key.
    channelId: task.cronJobId ?? task.id,
    threadId: undefined,
  }
}
