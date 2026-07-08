// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkflowRecipeResource } from '../../../../src/types'
import type { WorkflowSummary } from '../../workflows.types'
import { useWorkflowController } from '../domain/useWorkflowController'

const WORKFLOW: WorkflowSummary = {
  namespace: 'sandbox-recipes',
  name: 'stateful-workflow',
  status: 'Active',
  createdAt: '2026-05-18T00:00:00Z',
  triggerableByUser: true,
}

const WORKFLOW_RESOURCE: WorkflowRecipeResource = {
  metadata: {
    namespace: WORKFLOW.namespace,
    name: WORKFLOW.name,
    creationTimestamp: WORKFLOW.createdAt,
  },
  spec: {
    triggers: {
      onDemand: {
        allowedActors: ['user'],
      },
    },
    inputContract: {
      properties: {
        topic: {
          type: 'string',
          default: 'initial topic',
        },
      },
    },
  },
  status: {
    phase: WORKFLOW.status,
  },
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function createRunsResult() {
  return {
    items: [
      {
        id: 'run-1',
        source: 'live',
        phase: 'Succeeded',
        triggeredAt: '2026-05-18T00:00:00Z',
        startedAt: '2026-05-18T00:00:01Z',
        completedAt: '2026-05-18T00:00:02Z',
        message: null,
        actor: null,
        executionRef: null,
      },
    ],
    count: 1,
  }
}

function installClerumHarness(
  options: {
    runsResult?: ReturnType<typeof createRunsResult> | Promise<ReturnType<typeof createRunsResult>>
  } = {}
) {
  const read = vi.fn(async () => WORKFLOW_RESOURCE)
  const runs = vi.fn(async () => options.runsResult ?? createRunsResult())
  const trigger = vi.fn(async () => undefined)

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      workflows: {
        list: vi.fn(async () => ({ items: [WORKFLOW_RESOURCE], count: 1 })),
        read,
        runs,
        trigger,
        listRunArtifacts: vi.fn(async () => ({ artifacts: [] })),
      },
    },
  })

  return { read, runs, trigger }
}

function HookHarness() {
  const controller = useWorkflowController({ setStatus: vi.fn() })
  const topic = String(controller.workflowInputValues.topic ?? '')

  return (
    <div>
      <div data-testid="selected-workflow">{controller.selectedWorkflow?.name ?? 'none'}</div>
      <div data-testid="topic">{topic}</div>
      <div data-testid="run-count">{controller.workflowRuns.length}</div>
      <div data-testid="runs-loading">{String(controller.workflowRunsLoading)}</div>
      <button type="button" onClick={() => void controller.handleSelectWorkflow(WORKFLOW)}>
        Select workflow
      </button>
      <button
        type="button"
        onClick={() =>
          controller.setWorkflowInputValues({
            ...controller.workflowInputValues,
            topic: 'updated topic',
          })
        }
      >
        Update input
      </button>
      <button
        type="button"
        onClick={() => void controller.handleTriggerWorkflow(WORKFLOW.namespace, WORKFLOW.name)}
      >
        Trigger workflow
      </button>
    </div>
  )
}

function renderHarness(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <HookHarness />
    </QueryClientProvider>
  )
}

describe('useWorkflowController', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('preserves selected workflow state across hook remounts without refetching detail or runs', async () => {
    const clerum = installClerumHarness()
    const queryClient = createQueryClient()
    const firstRender = renderHarness(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Select workflow' }))

    await waitFor(() =>
      expect(screen.getByTestId('selected-workflow').textContent).toBe(WORKFLOW.name)
    )
    await waitFor(() => expect(screen.getByTestId('topic').textContent).toBe('initial topic'))
    await waitFor(() => expect(screen.getByTestId('run-count').textContent).toBe('1'))

    fireEvent.click(screen.getByRole('button', { name: 'Update input' }))
    await waitFor(() => expect(screen.getByTestId('topic').textContent).toBe('updated topic'))

    firstRender.unmount()
    renderHarness(queryClient)

    expect(screen.getByTestId('selected-workflow').textContent).toBe(WORKFLOW.name)
    expect(screen.getByTestId('topic').textContent).toBe('updated topic')
    expect(screen.getByTestId('run-count').textContent).toBe('1')
    expect(clerum.read).toHaveBeenCalledTimes(1)
    expect(clerum.runs).toHaveBeenCalledTimes(1)
  })

  it('keeps workflow runs loading while selected workflow runs have not resolved', async () => {
    const deferredRuns = createDeferred<ReturnType<typeof createRunsResult>>()
    installClerumHarness({ runsResult: deferredRuns.promise })
    const queryClient = createQueryClient()
    renderHarness(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Select workflow' }))

    await waitFor(() =>
      expect(screen.getByTestId('selected-workflow').textContent).toBe(WORKFLOW.name)
    )
    expect(screen.getByTestId('runs-loading').textContent).toBe('true')
    expect(screen.getByTestId('run-count').textContent).toBe('0')

    await act(async () => {
      deferredRuns.resolve(createRunsResult())
    })

    await waitFor(() => expect(screen.getByTestId('runs-loading').textContent).toBe('false'))
    expect(screen.getByTestId('run-count').textContent).toBe('1')
  })

  it('passes raw input values to the direct workflow trigger path', async () => {
    const clerum = installClerumHarness()
    const queryClient = createQueryClient()
    renderHarness(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Select workflow' }))
    await waitFor(() => expect(screen.getByTestId('topic').textContent).toBe('initial topic'))

    fireEvent.click(screen.getByRole('button', { name: 'Update input' }))
    await waitFor(() => expect(screen.getByTestId('topic').textContent).toBe('updated topic'))

    fireEvent.click(screen.getByRole('button', { name: 'Trigger workflow' }))

    await waitFor(() =>
      expect(clerum.trigger).toHaveBeenCalledWith(
        'sandbox-recipes',
        'stateful-workflow',
        { topic: 'updated topic' },
        expect.any(String)
      )
    )
  })
})
