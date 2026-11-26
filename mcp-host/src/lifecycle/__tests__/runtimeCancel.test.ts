/**
 * Real cancel decision. The HTTP contract test only checks that the edge
 * forwards a channel-reader sender; this drives TaskLifecycle.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '../../queue/types'
import type { RuntimeCallerContext } from '../../server/types'
import {
  type RuntimeCallerDeps,
  type RuntimeSourceIdentity,
  handleRuntimeCancel,
  runtimeCallerCanReadTask,
} from '../runtimeCancel'
import { TaskLifecycle } from '../taskLifecycle'

const logger: RuntimeCallerDeps['logger'] = {
  info() {},
  warn() {},
  error() {},
}

function slackTask(
  id: string,
  sender: string,
  channelId: string,
  channelType: 'slack' | 'telegram' = 'slack'
): Task {
  return {
    id,
    source: 'channel',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
    sourceMessage: {
      sender,
      channelType,
      channelId,
      messageId: `m-${id}`,
      content: 'hello',
      timestamp: new Date().toISOString(),
      hostRef: 'chatllm',
    },
  }
}

function deps(lifecycle: TaskLifecycle, pending?: RuntimeSourceIdentity): RuntimeCallerDeps {
  return {
    pendingSource: () => pending,
    lifecycle,
    logger,
  }
}

const owner: RuntimeCallerContext = {
  caller: 'channel-reader',
  channelType: 'slack',
  channelId: 'D123',
  sender: 'U123',
}

describe('handleRuntimeCancel', () => {
  it('cancels when the channel-reader matches the lifecycle record', () => {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(slackTask('task-long', 'U123', 'D123'))

    const result = handleRuntimeCancel('task-long', 'U123', owner, deps(lifecycle))

    expect(result).toBe('cancelled')
    expect(lifecycle.get('task-long')?.status).toBe('cancelled')
  })

  it('returns not_found and does not cancel a different sender or channel', () => {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(slackTask('task-sender', 'U999', 'D123'))
    lifecycle.register(slackTask('task-channel', 'U123', 'D999'))
    lifecycle.register(slackTask('task-type', 'U123', 'D123', 'telegram'))

    expect(handleRuntimeCancel('task-sender', 'U123', owner, deps(lifecycle))).toBe('not_found')
    expect(lifecycle.get('task-sender')?.status).toBe('pending')

    expect(handleRuntimeCancel('task-channel', 'U123', owner, deps(lifecycle))).toBe('not_found')
    expect(lifecycle.get('task-channel')?.status).toBe('pending')

    expect(handleRuntimeCancel('task-type', 'U123', owner, deps(lifecycle))).toBe('not_found')
    expect(lifecycle.get('task-type')?.status).toBe('pending')
  })

  it('fails closed when the caller or the channel-reader sender is missing', () => {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(slackTask('task-open', 'U123', 'D123'))
    const internal: Task = {
      id: 'task-null-sender',
      source: 'internal',
      priority: 'normal',
      status: 'pending',
      conversationHistory: [],
      createdAt: new Date(),
    }
    lifecycle.register(internal)
    expect(lifecycle.get('task-null-sender')?.submittedBy).toBeNull()

    expect(runtimeCallerCanReadTask('task-open', undefined, 'task_cancel', deps(lifecycle))).toBe(
      false
    )
    expect(lifecycle.get('task-open')?.status).toBe('pending')

    const missingSender = handleRuntimeCancel(
      'task-open',
      undefined,
      { caller: 'channel-reader', channelType: 'slack', channelId: 'D123' },
      deps(lifecycle)
    )
    expect(missingSender).toBe('not_found')
    expect(lifecycle.get('task-open')?.status).toBe('pending')

    // null submittedBy does not match an undefined caller sender.
    const nullSender = handleRuntimeCancel(
      'task-null-sender',
      undefined,
      { caller: 'channel-reader' },
      deps(lifecycle)
    )
    expect(nullSender).toBe('not_found')
    expect(lifecycle.get('task-null-sender')?.status).toBe('pending')
  })

  it('fails closed when the pending source does not match', () => {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(slackTask('task-pending', 'U123', 'D123'))

    const result = handleRuntimeCancel(
      'task-pending',
      'U123',
      owner,
      deps(lifecycle, { channelType: 'slack', channelId: 'D999', sender: 'U123' })
    )

    expect(result).toBe('not_found')
    expect(lifecycle.get('task-pending')?.status).toBe('pending')
  })

  it('keeps the fail-open submittedBy check for rpc-proxy', () => {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(slackTask('task-proxy', 'U123', 'D123'))
    lifecycle.register(slackTask('task-other', 'U123', 'D123'))
    lifecycle.register(slackTask('task-legacy', 'U123', 'D123'))

    expect(
      handleRuntimeCancel(
        'task-proxy',
        'U123',
        { caller: 'rpc-proxy', userId: 'U123' },
        deps(lifecycle)
      )
    ).toBe('cancelled')
    expect(lifecycle.get('task-proxy')?.status).toBe('cancelled')

    expect(
      handleRuntimeCancel(
        'task-other',
        'U999',
        { caller: 'rpc-proxy', userId: 'U999' },
        deps(lifecycle)
      )
    ).toBe('not_found')
    expect(lifecycle.get('task-other')?.status).toBe('pending')

    expect(
      handleRuntimeCancel('task-legacy', undefined, { caller: 'rpc-proxy' }, deps(lifecycle))
    ).toBe('cancelled')
    expect(lifecycle.get('task-legacy')?.status).toBe('cancelled')
  })
})
