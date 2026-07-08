// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessageActivity, TaskProgress } from '../../uiTypes'
import { resolveTaskActionState } from '../AgentsPage.helpers'

const makeProgress = (overrides: Partial<TaskProgress> = {}): TaskProgress => ({
  status: 'active',
  steps: [],
  currentIteration: 0,
  ...overrides,
})

const makeActivity = (overrides: Partial<AgentMessageActivity> = {}): AgentMessageActivity => ({
  status: 'streaming',
  events: [],
  redactionCount: 0,
  ...overrides,
})

describe('resolveTaskActionState', () => {
  it('falls back to progress.taskId when activity.taskId is missing', () => {
    const onCancelTask = vi.fn()

    const result = resolveTaskActionState(
      makeActivity(),
      makeProgress({ taskId: 'task-from-progress' }),
      'chatllm',
      onCancelTask
    )

    expect(result.taskId).toBe('task-from-progress')
    expect(result.canCancel).toBe(true)
  })

  it('prefers activity.taskId when both activity and progress have a task id', () => {
    const onCancelTask = vi.fn()

    const result = resolveTaskActionState(
      makeActivity({ taskId: 'task-from-activity' }),
      makeProgress({ taskId: 'task-from-progress' }),
      'chatllm',
      onCancelTask
    )

    expect(result.taskId).toBe('task-from-activity')
    expect(result.canCancel).toBe(true)
  })

  it('allows approval actions when suspended progress has a task id from progress state', () => {
    const result = resolveTaskActionState(
      makeActivity(),
      makeProgress({
        taskId: 'approval-task',
        status: 'suspended',
        suspendedInfo: {
          requestId: 'req-1',
          displayName: 'browser_open',
        },
      }),
      'chatllm'
    )

    expect(result.taskId).toBe('approval-task')
    expect(result.canAct).toBe(true)
  })
})
