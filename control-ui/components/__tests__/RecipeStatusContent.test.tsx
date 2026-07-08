import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  deleteWorkflowRunArtifact,
  deleteWorkflowRunArtifacts,
  getRecipe,
  getRecipeStatus,
  getWorkflowRunArtifactDownloadUrl,
  listWorkflowApprovalAllowedTeams,
  listWorkflowGrants,
  listWorkflowTeamGrants,
} from '../../lib/api'
import type { WorkflowRecipeStatus } from '../../lib/api'
import { RecipeStatusContent } from '../RecipeStatusContent'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getRecipeStatus: vi.fn(),
  // `getRecipe` is hit by every render: once on mount to load the
  // declared `spec.steps[]` list (so the progress bar denominator is the
  // canonical step total, not the auto-incrementing runtime list), and
  // again as the runtime fetcher whenever a runId is provided. Default
  // resolves to an empty recipe so tests that don't care about the spec
  // path still render cleanly.
  getRecipe: vi.fn().mockResolvedValue({}),
  deleteWorkflowRunArtifact: vi.fn(),
  deleteWorkflowRunArtifacts: vi.fn(),
  getWorkflowRunArtifactDownloadUrl: vi.fn(() => 'http://localhost/run-download'),
  // Grants wrapper used by the read-only panel.
  listWorkflowGrants: vi.fn().mockResolvedValue({ items: [] }),
  listWorkflowTeamGrants: vi.fn().mockResolvedValue({ items: [] }),
  listWorkflowApprovalAllowedTeams: vi.fn().mockResolvedValue({ items: [] }),
}))

const mockGetStatus = vi.mocked(getRecipeStatus)
const mockGetRecipe = vi.mocked(getRecipe)
const mockListGrants = vi.mocked(listWorkflowGrants)
const mockListTeamGrants = vi.mocked(listWorkflowTeamGrants)
const mockListApprovalAllowedTeams = vi.mocked(listWorkflowApprovalAllowedTeams)
const mockDeleteWorkflowRunArtifact = vi.mocked(deleteWorkflowRunArtifact)
const mockDeleteWorkflowRunArtifacts = vi.mocked(deleteWorkflowRunArtifacts)
const mockGetWorkflowRunArtifactDownloadUrl = vi.mocked(getWorkflowRunArtifactDownloadUrl)
const DEFAULT_PROPS = { name: 'test-recipe', namespace: 'sandbox-recipes' }

function render(children: ReactNode) {
  const result = rtlRender(<ToastProvider>{children}</ToastProvider>)
  return {
    ...result,
    rerender: (nextChildren: ReactNode) =>
      result.rerender(<ToastProvider>{nextChildren}</ToastProvider>),
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// ─── Render: workload recipe (no workflow execution) ──────────────────────────
describe('RecipeStatusContent — workload recipe', () => {
  it('shows loading state initially', () => {
    mockGetStatus.mockReturnValue(new Promise(() => {}))
    mockListGrants.mockReturnValueOnce(new Promise(() => {}))
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    expect(screen.getByText('Loading status…')).toBeInTheDocument()
  })

  it('shows error message on fetch failure', async () => {
    mockGetStatus.mockRejectedValue(new Error('API timeout'))
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('API timeout')).toBeInTheDocument())
  })

  it('shows empty state when status has no keys', async () => {
    mockGetStatus.mockResolvedValue({})
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText(/No status reported yet/)).toBeInTheDocument())
  })

  it('shows workload phase badge', async () => {
    mockGetStatus.mockResolvedValue({ phase: 'active' })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Workload Phase:')).toBeInTheDocument())
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('shows workloads list with Ready/Not Ready', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workloads: [
        { id: 'my-mcp-server', ready: true, replicas: 2 },
        { id: 'redis', ready: false },
      ],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('my-mcp-server')).toBeInTheDocument())
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Not Ready')).toBeInTheDocument()
    expect(screen.getByText('×2')).toBeInTheDocument()
  })

  it('shows message section with copy button', async () => {
    mockGetStatus.mockResolvedValue({ phase: 'failed', message: 'Pod CrashLoopBackOff' })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Pod CrashLoopBackOff')).toBeInTheDocument())
    expect(screen.getByText('Message')).toBeInTheDocument()
  })

  it('shows Raw JSON section with copy button', async () => {
    mockGetStatus.mockResolvedValue({ phase: 'active' })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Raw JSON')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeInTheDocument()
  })
})

// ─── Render: agentic workflow recipe ─────────────────────────────────────────
describe('RecipeStatusContent — agentic workflow recipe', () => {
  const WF_STATUS = {
    phase: 'active',
    workflowExecution: { phase: 'running', attempt: 1, startedAt: new Date().toISOString() },
    steps: [
      {
        id: 'research',
        phase: 'completed',
        output: 'Found 10 results about AI agents.',
        modelUsed: 'glm-4.7',
      },
      { id: 'summarize', phase: 'running' },
    ],
  } satisfies WorkflowRecipeStatus

  it('shows Workflow Execution section', async () => {
    mockGetStatus.mockResolvedValue(WF_STATUS)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Workflow Execution')).toBeInTheDocument())
  })

  it('shows workflow execution phase badge', async () => {
    mockGetStatus.mockResolvedValue(WF_STATUS)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => {
      const phaseBadges = screen.getAllByText('running')
      expect(phaseBadges.length).toBeGreaterThan(0)
    })
  })

  it('shows Live badge when workflow is running', async () => {
    mockGetStatus.mockResolvedValue(WF_STATUS)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('● Live')).toBeInTheDocument())
  })

  it('shows steps list with phases and model used', async () => {
    mockGetStatus.mockResolvedValue(WF_STATUS)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Steps (2)')).toBeInTheDocument())
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getByText('summarize')).toBeInTheDocument()
    expect(screen.getByText('completed')).toBeInTheDocument()
    expect(screen.getByText('glm-4.7')).toBeInTheDocument()
  })

  it('shows step output with copy button', async () => {
    mockGetStatus.mockResolvedValue(WF_STATUS)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() =>
      expect(screen.getByText('Found 10 results about AI agents.')).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save .md' })).toBeInTheDocument()
    expect(screen.queryByText(/truncated status preview/i)).not.toBeInTheDocument()
  })

  it('warns when a step output preview is truncated', async () => {
    mockGetStatus.mockResolvedValue({
      ...WF_STATUS,
      steps: [
        {
          id: 'research',
          phase: 'completed',
          output: 'Preview only',
          outputTruncated: true,
          outputLength: 50_000,
          outputPreviewMaxChars: 32_768,
        },
      ],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByText(/Step output is a truncated status preview/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/32,768 of 50,000 characters/i)).toBeInTheDocument()
    expect(screen.getByText(/Download run artifacts for the complete file/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save preview .md' })).toBeInTheDocument()
  })

  it('does NOT show Live badge when workflow is completed', async () => {
    mockGetStatus.mockResolvedValue({
      ...WF_STATUS,
      workflowExecution: { phase: 'completed' },
      steps: [
        { id: 'research', phase: 'completed' },
        { id: 'summarize', phase: 'completed' },
      ],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Workflow Execution')).toBeInTheDocument())
    expect(screen.queryByText('● Live')).not.toBeInTheDocument()
  })

  it('does not present a completed workflow as succeeded while declared steps are still open', async () => {
    mockGetStatus.mockResolvedValue({
      ...WF_STATUS,
      workflowExecution: { phase: 'completed' },
      steps: [
        { id: 'research', phase: 'completed' },
        { id: 'summarize', phase: 'running' },
      ],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() =>
      expect(screen.getByTestId('wf-execution-phase')).toHaveTextContent('inconsistent')
    )
    expect(
      screen.getByText('Workflow completion is inconsistent: declared steps are still open.')
    ).toBeInTheDocument()
    expect(screen.getByText('● Live')).toBeInTheDocument()
  })
})

// ─── Auto-refresh polling ─────────────────────────────────────────────────────
describe('RecipeStatusContent — auto-refresh', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls every 3s when workflow is running', async () => {
    const running = {
      phase: 'active',
      workflowExecution: { phase: 'running' },
      steps: [{ id: 'step1', phase: 'running' }],
    } satisfies WorkflowRecipeStatus
    mockGetStatus.mockResolvedValue(running)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(3)
  })

  it('stops polling when workflow completes', async () => {
    const completed = {
      phase: 'active',
      workflowExecution: { phase: 'completed' },
      steps: [{ id: 'step1', phase: 'completed' }],
    } satisfies WorkflowRecipeStatus
    mockGetStatus.mockResolvedValue(completed)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(9_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
  })

  it('stops polling when workflow is cancelled', async () => {
    const cancelled = {
      phase: 'failed',
      workflowExecution: { phase: 'cancelled' },
      steps: [{ id: 'step1', phase: 'cancelled' }],
    } satisfies WorkflowRecipeStatus
    mockGetStatus.mockResolvedValue(cancelled)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(9_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
  })

  // Regression: PR #122 — on GCP-dev, status opened right after installRecipe
  // while WRC had not yet set workflowExecution.phase='running'. Old code only
  // polled when phase==='running' at initial fetch → polling never started →
  // status stayed frozen → e2e hit WORKFLOW_TIMEOUT. Fix: poll unless terminal.
  it('polls when initial fetch has no workflowExecution yet (pre-run window)', async () => {
    const preRun = {
      phase: 'active',
      workloads: [{ id: 'web-search', ready: true }],
    } satisfies WorkflowRecipeStatus
    mockGetStatus.mockResolvedValue(preRun)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(3)
  })

  it('keeps polling when phase transitions pending → running (any non-terminal)', async () => {
    const pending = {
      phase: 'active',
      workflowExecution: { phase: 'pending' },
    } satisfies WorkflowRecipeStatus
    mockGetStatus.mockResolvedValue(pending)
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })
    expect(mockGetStatus).toHaveBeenCalledTimes(2)
  })
})

// ─── Failure analysis ─────────────────────────────────────────────────────────
describe('RecipeStatusContent — failure analysis', () => {
  it('shows INFRA failure analysis for fetch failed', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message: 'fetch failed: ECONNREFUSED',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() =>
      expect(screen.getByText('Network / Infrastructure Error')).toBeInTheDocument()
    )
    expect(screen.getByText('Debug commands:')).toBeInTheDocument()
  })

  it('shows CONFIG failure analysis for model-config-failed', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message: 'model-config-failed: provider zai returned 401',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Model Configuration Error')).toBeInTheDocument())
  })

  it('shows TIMEOUT failure analysis for step-timeout', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message: 'step-timeout after 300s',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Step Timeout')).toBeInTheDocument())
  })

  it('shows AUTH failure analysis for 401', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'failed' },
      message: 'WRC rejected token: 401 unauthorized',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Authentication Error')).toBeInTheDocument())
  })

  it('shows INFRA 404 failure for not found', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'failed' },
      message: 'WRC returned 404 on GET status',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Resource Not Found (404)')).toBeInTheDocument())
  })

  it('shows template-resolution analysis before coordinator runtime debugging', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message:
        'spec.workloads[1].env[DB_MODE].value: Unresolved template reference: "computed.db_mode"',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByText('WorkflowRecipe Template Resolution Failed')).toBeInTheDocument()
    )
    expect(screen.getByText(/WRC rejected the WorkflowRecipe/)).toBeInTheDocument()
    expect(
      screen.getByText((content, element) => {
        return (
          element?.tagName.toLowerCase() === 'pre' &&
          content.includes('kubectl get workflowrecipe -n sandbox-recipes test-recipe -o yaml') &&
          content.includes('clerum.io/parent-recipe=test-recipe') &&
          !content.includes('clerum-test')
        )
      })
    ).toBeInTheDocument()
    expect(screen.queryByText('Workflow Execution Failed')).not.toBeInTheDocument()
    expect(screen.queryByText(/coordinator and mcp-host logs/)).not.toBeInTheDocument()
  })

  it('shows generic failure analysis for unknown error', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message: 'something went wrong',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Workflow Execution Failed')).toBeInTheDocument())
  })

  it('shows failure analysis with copy button for debug commands', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'failed',
      workflowExecution: { phase: 'failed' },
      message: 'fetch failed: connection refused',
      steps: [],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Debug commands:')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0)
  })

  it('does NOT show failure analysis when workflow succeeded', async () => {
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'completed' },
      steps: [{ id: 's1', phase: 'completed' }],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Workflow Execution')).toBeInTheDocument())
    expect(screen.queryByText('Debug commands:')).not.toBeInTheDocument()
  })
})

// ─── Read-only grants panel ─────────────────────────────────────────────────
describe('RecipeStatusContent — GrantsReadonlyPanel', () => {
  beforeEach(() => {
    mockGetStatus.mockResolvedValue({ phase: 'active' })
  })

  it('renders trigger users when listWorkflowGrants returns a non-empty set', async () => {
    mockListGrants.mockResolvedValueOnce({
      items: [
        { id: 'u1', email: 'alice@example.com', name: 'Alice', displayName: 'Alice A.' },
        { id: 'u2', email: 'bob@example.com', name: null, displayName: null },
      ],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Trigger users (2)')).toBeInTheDocument())
    expect(screen.getByText('Alice A.')).toBeInTheDocument()
    expect(screen.getByText('bob@example.com')).toBeInTheDocument()
    expect(screen.getByText('Open the Users tab to modify')).toBeInTheDocument()
  })

  it('shows empty-state copy when listWorkflowGrants returns an empty set', async () => {
    mockListGrants.mockResolvedValueOnce({ items: [] })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Trigger users (0)')).toBeInTheDocument())
    expect(screen.getByText(/No users authorized to trigger this recipe yet/i)).toBeInTheDocument()
  })

  it('renders trigger teams and approval target teams independently', async () => {
    mockListTeamGrants.mockResolvedValueOnce({
      items: [{ id: 'team-trigger', name: 'Trigger Team' }],
    })
    mockListApprovalAllowedTeams.mockResolvedValueOnce({
      items: [{ id: 'team-approval', name: 'Approval Team', createdAt: '2026-05-21T00:00:00Z' }],
    })

    render(<RecipeStatusContent {...DEFAULT_PROPS} />)

    await waitFor(() => expect(screen.getByText('Trigger teams (1)')).toBeInTheDocument())
    expect(screen.getByText('Approval target teams (1)')).toBeInTheDocument()
    expect(screen.getByText('Trigger Team')).toBeInTheDocument()
    expect(screen.getByText('Approval Team')).toBeInTheDocument()
    expect(screen.queryByText('team-trigger')).not.toBeInTheDocument()
    expect(screen.queryByText('team-approval')).not.toBeInTheDocument()
  })

  it('ignores stale grants responses after switching recipes', async () => {
    const first = createDeferred<Awaited<ReturnType<typeof listWorkflowGrants>>>()
    const second = createDeferred<Awaited<ReturnType<typeof listWorkflowGrants>>>()
    mockGetStatus.mockResolvedValue({ phase: 'active' })
    mockListGrants.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const { rerender } = render(<RecipeStatusContent {...DEFAULT_PROPS} name="recipe-a" />)
    rerender(<RecipeStatusContent {...DEFAULT_PROPS} name="recipe-b" />)

    await act(async () => {
      second.resolve({
        items: [{ id: 'b', email: 'bob@example.com', name: 'Bob', displayName: 'Bob B.' }],
      })
      await second.promise
    })
    await waitFor(() => expect(screen.getByText('Bob B.')).toBeInTheDocument())

    await act(async () => {
      first.resolve({
        items: [{ id: 'a', email: 'alice@example.com', name: 'Alice', displayName: 'Alice A.' }],
      })
      await first.promise
    })

    expect(screen.getByText('Bob B.')).toBeInTheDocument()
    expect(screen.queryByText('Alice A.')).not.toBeInTheDocument()
  })
})

// ─── runId-based child resolution ────────────────────────────────────────────
//
// When a runId is supplied, the run-detail page passes it down so the view
// shows the EXACT child recipe for that run, not whatever the parent's
// `/status` endpoint resolves to (the latest run). The child recipe name is
// `<parent>-<runId.toLowerCase().slice(0, 8)>` (RUN_ID_SHORT_LEN = 8 in
// workflow-recipes/src/workflow/childRecipeFactory.ts).
describe('RecipeStatusContent — runId child resolution', () => {
  it('fetches the child recipe when runId is provided', async () => {
    // The status object on a child WorkflowRecipe holds workflow-execution
    // fields (workflowExecution, steps, ...) that the narrow K8s status
    // type in @lib/api intentionally doesn't model — the component reads
    // it as Record<string, unknown>. Cast through unknown for the mock.
    mockGetRecipe.mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test-recipe-abcd1234', namespace: 'sandbox-recipes' },
      // The component fires both a one-shot getRecipe to load spec.steps
      // and a polling getRecipe to read status. Same payload satisfies
      // both — the spec block here is irrelevant because the runtime
      // status.steps already covers what this test asserts.
      status: {
        phase: 'active',
        workflowExecution: { phase: 'completed' },
        steps: [{ id: 'research', phase: 'completed', output: 'child-output' }],
      },
    } as unknown as Awaited<ReturnType<typeof getRecipe>>)
    render(<RecipeStatusContent {...DEFAULT_PROPS} runId="ABCD1234-aaaa-bbbb-cccc-dddddddddddd" />)
    await waitFor(() => expect(mockGetRecipe).toHaveBeenCalledWith('test-recipe-abcd1234'))
    // Parent /status endpoint must NOT be touched when runId is set —
    // otherwise we'd re-introduce the "stale parent status" bug.
    expect(mockGetStatus).not.toHaveBeenCalled()
    expect(await screen.findByText('child-output')).toBeInTheDocument()
  })

  it('falls back to /status (latest run) when runId is omitted', async () => {
    mockGetStatus.mockResolvedValue({ phase: 'active' })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('test-recipe'))
    // `getRecipe` is still hit once on mount with the parent name to load
    // the declared spec.steps list, but the runtime fetcher must NOT take
    // the child-recipe path (otherwise the stale-parent-status bug returns).
    expect(mockGetRecipe).toHaveBeenCalledWith('test-recipe')
    expect(mockGetRecipe).not.toHaveBeenCalledWith(expect.stringMatching(/-[0-9a-f]{8}$/))
  })

  it('renders a friendly message (not a 404 banner) when the child recipe is missing', async () => {
    // First call: spec one-shot — child fetch fails with 404.
    // Second call: spec one-shot fallback to parent — also empty (best-effort).
    // Third call: runtime status fetcher with childName — also 404.
    mockGetRecipe.mockRejectedValue(new Error('404 Not Found'))
    render(<RecipeStatusContent {...DEFAULT_PROPS} runId="ABCD1234-aaaa-bbbb-cccc-dddddddddddd" />)
    await waitFor(() =>
      expect(screen.getByText(/This run isn.t in the cluster/i)).toBeInTheDocument()
    )
    // The raw "404 Not Found" must NOT bubble up as the error banner.
    expect(screen.queryByText('404 Not Found')).not.toBeInTheDocument()
  })

  it('downloads artifacts through the run-scoped admin URL when runId is provided', async () => {
    mockGetRecipe.mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test-recipe-abcd1234', namespace: 'sandbox-recipes' },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'completed' },
        steps: [{ id: 'emit', phase: 'completed' }],
        artifacts: [
          {
            name: 'custom-sdk-result.json',
            format: 'json',
            sizeBytes: 42,
            createdAt: '2026-05-06T00:00:00.000Z',
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof getRecipe>>)
    mockGetWorkflowRunArtifactDownloadUrl.mockReturnValue('http://localhost/run-download')
    const fetchMock = vi.fn().mockResolvedValue(new Response('artifact-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:workflow-run'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    let downloadName = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloadName = this.download
    })

    render(<RecipeStatusContent {...DEFAULT_PROPS} runId="ABCD1234-aaaa-bbbb-cccc-dddddddddddd" />)
    await screen.findByText('custom-sdk-result.json')

    fireEvent.click(screen.getByTestId('artifact-download'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://localhost/run-download', {
        credentials: 'include',
      })
    })
    expect(mockGetWorkflowRunArtifactDownloadUrl).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      'ABCD1234-aaaa-bbbb-cccc-dddddddddddd',
      'custom-sdk-result.json'
    )
    expect(downloadName).toBe('ABCD1234-custom-sdk-result.json')
    expect(screen.getByText('Clear All')).toBeInTheDocument()
    expect(screen.getByTitle('Delete custom-sdk-result.json')).toBeInTheDocument()
    expect(click).toHaveBeenCalled()
  })

  it('deletes artifacts through the run-scoped admin URL when runId is provided', async () => {
    mockGetRecipe.mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test-recipe-abcd1234', namespace: 'sandbox-recipes' },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'completed' },
        steps: [{ id: 'emit', phase: 'completed' }],
        artifacts: [
          {
            name: 'custom-sdk-result.json',
            format: 'json',
            sizeBytes: 42,
            createdAt: '2026-05-06T00:00:00.000Z',
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof getRecipe>>)

    render(<RecipeStatusContent {...DEFAULT_PROPS} runId="ABCD1234-aaaa-bbbb-cccc-dddddddddddd" />)
    await screen.findByText('custom-sdk-result.json')

    fireEvent.click(screen.getByTitle('Delete custom-sdk-result.json'))
    expect(mockDeleteWorkflowRunArtifact).not.toHaveBeenCalled()
    expect(await screen.findByRole('alertdialog', { name: 'Delete Artifact' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(mockDeleteWorkflowRunArtifact).toHaveBeenCalledWith(
        'sandbox-recipes',
        'test-recipe',
        'ABCD1234-aaaa-bbbb-cccc-dddddddddddd',
        'custom-sdk-result.json'
      )
    )
  })

  it('clears all artifacts through the run-scoped admin URL when runId is provided', async () => {
    mockGetRecipe.mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test-recipe-abcd1234', namespace: 'sandbox-recipes' },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'completed' },
        steps: [{ id: 'emit', phase: 'completed' }],
        artifacts: [
          {
            name: 'custom-sdk-result.json',
            format: 'json',
            sizeBytes: 42,
            createdAt: '2026-05-06T00:00:00.000Z',
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof getRecipe>>)

    render(<RecipeStatusContent {...DEFAULT_PROPS} runId="ABCD1234-aaaa-bbbb-cccc-dddddddddddd" />)
    await screen.findByText('custom-sdk-result.json')

    fireEvent.click(screen.getByText('Clear All'))
    expect(mockDeleteWorkflowRunArtifacts).not.toHaveBeenCalled()
    expect(
      await screen.findByRole('alertdialog', { name: 'Delete All Artifacts' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))

    await waitFor(() =>
      expect(mockDeleteWorkflowRunArtifacts).toHaveBeenCalledWith(
        'sandbox-recipes',
        'test-recipe',
        'ABCD1234-aaaa-bbbb-cccc-dddddddddddd'
      )
    )
  })
})

// ─── Declared step count from spec.steps[] ──────────────────────────────────
//
// Regression: the progress bar used to read the runtime status.steps[]
// (incrementally populated as steps execute) for its denominator, so a
// 5-step workflow with 1 step in flight rendered "Steps (1)" until more
// runtime entries arrived. Now the canonical list comes from spec.steps[]
// so the count is stable across the run.
describe('RecipeStatusContent — declared step count', () => {
  const RECIPE_WITH_SPEC = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
    spec: {
      steps: [
        { id: 'research', instruction: '…' },
        { id: 'analyze', instruction: '…' },
        { id: 'generate-report', instruction: '…' },
      ],
    },
  }

  it('renders all declared steps with pending state when none have started yet', async () => {
    // mockResolvedValueOnce so this test's payload does not leak into the
    // next test (vi.clearAllMocks does not reset implementations).
    mockGetRecipe.mockResolvedValueOnce(
      RECIPE_WITH_SPEC as unknown as Awaited<ReturnType<typeof getRecipe>>
    )
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'pending' },
      // Runtime status.steps not populated yet
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Steps (3)')).toBeInTheDocument())
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getByText('analyze')).toBeInTheDocument()
    expect(screen.getByText('generate-report')).toBeInTheDocument()
  })

  it('keeps Steps (3) when only 1 of 3 declared steps has runtime state', async () => {
    mockGetRecipe.mockResolvedValueOnce(
      RECIPE_WITH_SPEC as unknown as Awaited<ReturnType<typeof getRecipe>>
    )
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'running' },
      steps: [{ id: 'research', phase: 'running' }],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Steps (3)')).toBeInTheDocument())
    expect(screen.getByText(/Progress: 0\/3 steps/)).toBeInTheDocument()
  })

  it('falls back to runtime steps when spec.steps fetch returns no spec', async () => {
    // Default `getRecipe` mock resolves to {} → no spec.steps → use runtime.
    mockGetStatus.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'running' },
      steps: [{ id: 's1', phase: 'completed' }],
    })
    render(<RecipeStatusContent {...DEFAULT_PROPS} />)
    await waitFor(() => expect(screen.getByText('Steps (1)')).toBeInTheDocument())
  })
})
