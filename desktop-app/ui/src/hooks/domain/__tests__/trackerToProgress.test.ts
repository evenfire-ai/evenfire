import { describe, expect, it } from 'vitest'
import type { TaskState } from '@contexts/AgentTaskTrackerContext'
import { mapTrackerStatusToProgress, trackerStateToTaskProgress } from '../trackerToProgress'

const baseState: TaskState = {
  taskId: 'task-1',
  userMessageId: 'msg-1',
  status: 'streaming',
  startedAt: 1,
  lastEventAt: 2,
  steps: [],
  currentIteration: 3,
  llmElapsedMs: 1200,
}

describe('mapTrackerStatusToProgress', () => {
  it('maps every tracker status to a ProgressStepper status', () => {
    expect(mapTrackerStatusToProgress('connecting')).toBe('connecting')
    expect(mapTrackerStatusToProgress('streaming')).toBe('active')
    expect(mapTrackerStatusToProgress('suspended')).toBe('suspended')
    expect(mapTrackerStatusToProgress('completed')).toBe('completed')
    expect(mapTrackerStatusToProgress('cancelled')).toBe('cancelled')
    expect(mapTrackerStatusToProgress('failed')).toBe('error')
  })
})

describe('trackerStateToTaskProgress', () => {
  it('carries taskId, steps, iteration and elapsed', () => {
    const p = trackerStateToTaskProgress(baseState)
    expect(p).toMatchObject({
      taskId: 'task-1',
      status: 'active',
      currentIteration: 3,
      llmElapsedMs: 1200,
    })
    expect(p.suspendedInfo).toBeUndefined()
  })

  it('maps a pending approval into suspendedInfo', () => {
    const p = trackerStateToTaskProgress({
      ...baseState,
      status: 'suspended',
      pendingApproval: { requestId: 'req-1', displayName: 'Unknown Tool' },
    })
    expect(p.status).toBe('suspended')
    expect(p.suspendedInfo).toEqual({
      requestId: 'req-1',
      displayName: 'Unknown Tool',
    })
  })

  it('surfaces a cancel reason from a cancelled terminal', () => {
    const p = trackerStateToTaskProgress({
      ...baseState,
      status: 'cancelled',
      terminalResult: { kind: 'cancelled', reason: 'Cancelled by user.' },
    })
    expect(p.status).toBe('cancelled')
    expect(p.cancelReason).toBe('Cancelled by user.')
  })
})
