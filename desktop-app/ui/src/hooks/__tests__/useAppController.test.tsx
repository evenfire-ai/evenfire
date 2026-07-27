// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleAfterFirstPaint } from '../scheduleAfterFirstPaint'
import {
  loadWorkflowRunsWithArtifactsForApprovalRefresh,
  loadWorkflowRunsWithArtifactsForWorkflowTarget,
  scheduleAfterFirstPaintForSession,
} from '../useAppController'

function installWorkflowHarness(runsResult: unknown) {
  const runs = vi.fn(async () => runsResult)
  const listRunArtifacts = vi.fn(async () => ({
    artifacts: [{ filename: 'result.json', url: '/download/result.json' }],
  }))

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      workflows: {
        runs,
        listRunArtifacts,
      },
    },
  })

  return { runs, listRunArtifacts }
}

describe('loadWorkflowRunsWithArtifactsForApprovalRefresh', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('skips artifact lookup for approval-refreshed runs that have no executionRef', async () => {
    const { runs, listRunArtifacts } = installWorkflowHarness({
      items: [
        {
          id: 'run-without-execution-ref',
          phase: 'Succeeded',
          executionRef: null,
        },
      ],
      count: 1,
    })

    const result = await loadWorkflowRunsWithArtifactsForApprovalRefresh({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
    })

    expect(runs).toHaveBeenCalledWith('sandbox-recipes', 'r1', 20)
    expect(listRunArtifacts).not.toHaveBeenCalled()
    expect(result.items).toEqual([
      {
        id: 'run-without-execution-ref',
        phase: 'Succeeded',
        executionRef: null,
      },
    ])
  })

  it('loads artifacts for approval-refreshed runs that have an executionRef', async () => {
    const { listRunArtifacts } = installWorkflowHarness({
      items: [
        {
          id: 'run-with-execution-ref',
          phase: 'Succeeded',
          executionRef: { namespace: 'sandbox-recipes', name: 'child-run' },
        },
      ],
      count: 1,
    })

    const result = await loadWorkflowRunsWithArtifactsForApprovalRefresh({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
    })

    expect(listRunArtifacts).toHaveBeenCalledWith('sandbox-recipes', 'r1', 'run-with-execution-ref')
    expect(result.items[0]).toMatchObject({
      id: 'run-with-execution-ref',
      artifacts: [{ filename: 'result.json', url: '/download/result.json' }],
    })
  })
})

describe('loadWorkflowRunsWithArtifactsForWorkflowTarget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('loads artifacts through the selected workflow target', async () => {
    const { runs, listRunArtifacts } = installWorkflowHarness({
      items: [
        {
          id: 'completed-run',
          phase: 'Succeeded',
          executionRef: { namespace: 'sandbox-recipes', name: 'child-run' },
        },
      ],
      count: 1,
    })

    const result = await loadWorkflowRunsWithArtifactsForWorkflowTarget({
      namespace: 'sandbox-recipes',
      name: 'due-diligence-package',
    })

    expect(runs).toHaveBeenCalledWith('sandbox-recipes', 'due-diligence-package', 20)
    expect(listRunArtifacts).toHaveBeenCalledWith(
      'sandbox-recipes',
      'due-diligence-package',
      'completed-run'
    )
    expect(result.items[0]).toMatchObject({
      id: 'completed-run',
      artifacts: [{ filename: 'result.json', url: '/download/result.json' }],
    })
  })
})

describe('scheduleAfterFirstPaint', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('waits for two animation frames before running deferred startup work', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const task = vi.fn(async () => undefined)

    scheduleAfterFirstPaint(task)
    expect(task).not.toHaveBeenCalled()

    frames.shift()?.(1)
    expect(task).not.toHaveBeenCalled()

    frames.shift()?.(2)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('falls back to a timeout when animation frames are throttled', async () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const task = vi.fn(async () => undefined)

    scheduleAfterFirstPaint(task)
    expect(task).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(frames).toHaveLength(1)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('runs session-bound deferred startup work when identity is unchanged', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const identityRef = { current: 'user-1:team-1' }
    const task = vi.fn(async () => undefined)

    scheduleAfterFirstPaintForSession(identityRef, 'user-1:team-1', task)
    frames.shift()?.(1)
    frames.shift()?.(2)

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('skips session-bound deferred startup work after logout or identity change', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const identityRef = { current: 'user-1:team-1' }
    const task = vi.fn(async () => undefined)

    scheduleAfterFirstPaintForSession(identityRef, 'user-1:team-1', task)
    identityRef.current = null
    frames.shift()?.(1)
    frames.shift()?.(2)

    expect(task).not.toHaveBeenCalled()
  })
})
