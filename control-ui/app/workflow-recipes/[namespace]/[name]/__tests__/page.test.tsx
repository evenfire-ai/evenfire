import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  cancelWorkflowRun,
  formatApiError,
  getRecipe,
  getRecipeStatus,
  getWorkflowRuns,
} from '@lib/api'
import type { WorkflowRecipeResource, WorkflowRecipeStatus, WorkflowRunSummary } from '@lib/api'
import WorkflowRecipeDetailPage from '../page'

const NAMESPACE = 'sandbox-recipes'
const RECIPE_NAME = 'cancel-me'
const OPERATOR_ID = '5b0c8f0e-3a52-4f7c-8d0e-6a1b2c3d4e5f'
const USER_ID = '9ca1644a-222b-4cb6-ac42-c1b86ba08cbd'
const RUN_A = '0d4f1b52-7c1e-4a8e-9a57-2c3f4d5e6f70'
const RUN_B = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
const RUN_C = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
const RUN_DONE = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
const RUN_ARCHIVED = 'a1e2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b'

const navigation = vi.hoisted(() => ({
  params: { namespace: 'sandbox-recipes', name: 'cancel-me', tab: 'runs' as string | undefined },
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}))
const toast = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('@components/RecipeStatusContent', () => ({
  RecipeStatusContent: () => <div>live status</div>,
  GrantsReadonlyPanel: () => null,
}))
vi.mock('@components/RecipeEditor', () => ({ RecipeEditor: () => null }))
vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: toast.showToast }) }))
vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    cancelWorkflowRun: vi.fn(),
    getRecipe: vi.fn(),
    getRecipePods: vi.fn().mockResolvedValue({ pods: [] }),
    getRecipeStatus: vi.fn(),
    getWorkflowRuns: vi.fn(),
  }
})

const cancelMock = vi.mocked(cancelWorkflowRun)
const getRecipeMock = vi.mocked(getRecipe)
const getRecipeStatusMock = vi.mocked(getRecipeStatus)
const getWorkflowRunsMock = vi.mocked(getWorkflowRuns)

// A `workflow_runs` row and its admin run DTO, built the way `mapDbRun` builds it
// (`control-api/src/services/workflows/workflowRunReadService.ts`): `source: 'live'`,
// the cancel fields always present, `canceledBy` as stored for an admin reader.
type WorkflowRunsRow = {
  run_id: string
  phase: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  cancel_requested_at: string | null
  canceled_by: string | null
}

function adminRunDto(row: Partial<WorkflowRunsRow> & { run_id: string }): WorkflowRunSummary {
  const full: WorkflowRunsRow = {
    phase: 'Running',
    created_at: '2026-05-07T23:11:00.000Z',
    started_at: '2026-05-07T23:11:01.000Z',
    completed_at: null,
    cancel_requested_at: null,
    canceled_by: null,
    ...row,
  }
  return {
    id: full.run_id,
    source: 'live',
    approvalRequestId: null,
    phase: full.phase,
    triggeredAt: full.created_at,
    startedAt: full.started_at,
    completedAt: full.completed_at,
    message: null,
    cancelRequestedAt: full.cancel_requested_at,
    canceledBy: full.canceled_by,
    actor: { type: 'admin-ui', adminUserId: OPERATOR_ID },
    executionRef: { namespace: NAMESPACE, name: `${RECIPE_NAME}-${full.run_id.slice(0, 8)}` },
  }
}

// An archived run as `mapAuditRun` returns it (no cancel fields).
const archivedRun: WorkflowRunSummary = {
  id: RUN_ARCHIVED,
  source: 'audit',
  approvalRequestId: null,
  phase: 'Failed',
  triggeredAt: '2026-05-07T23:11:00.000Z',
  startedAt: '2026-05-07T23:11:01.000Z',
  completedAt: '2026-05-07T23:12:00.000Z',
  message: null,
  actor: { type: 'admin-ui', adminUserId: OPERATOR_ID },
  executionRef: null,
}

const requested = (by: string) => ({
  cancel_requested_at: '2026-05-07T23:11:30.000Z',
  canceled_by: by,
})

const runA = adminRunDto({ run_id: RUN_A })
const runB = adminRunDto({ run_id: RUN_B })
const runC = adminRunDto({ run_id: RUN_C, phase: 'Pending', started_at: null })
const runDone = adminRunDto({
  run_id: RUN_DONE,
  phase: 'Succeeded',
  completed_at: '2026-05-07T23:12:00.000Z',
})
const runAAccepted = adminRunDto({ run_id: RUN_A, ...requested(`operator:${OPERATOR_ID}`) })

const SETTLED_STATUS: WorkflowRecipeStatus = { phase: 'active' }

function recipeResource(): WorkflowRecipeResource {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: RECIPE_NAME,
      namespace: NAMESPACE,
      creationTimestamp: '2026-05-07T23:10:46.000Z',
    },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do work' }],
    },
    status: { phase: 'active' },
  }
}

function listOf(items: WorkflowRunSummary[]) {
  return { items, count: items.length }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function apiError(status: number, statusText: string, code: string): Error {
  const body = JSON.stringify({ error: code })
  return formatApiError(new Response(body, { status, statusText }), body)
}

function rowOf(runId: string): HTMLElement {
  return screen.getByRole('link', { name: `Open run ${runId.slice(0, 8)}` })
}

async function openMenu(runId: string) {
  fireEvent.click(screen.getByRole('button', { name: `Actions for run ${runId.slice(0, 8)}` }))
  return screen.findByRole('menu')
}

function closeMenu() {
  fireEvent.keyDown(document, { key: 'Escape' })
}

async function startCancel(runId: string): Promise<HTMLElement> {
  const menu = await openMenu(runId)
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Cancel run' }))
  return screen.findByRole('alertdialog')
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: 'Cancel run' })
}

async function renderPage(initial: WorkflowRunSummary[]) {
  getWorkflowRunsMock.mockResolvedValue(listOf(initial))
  const view = render(<WorkflowRecipeDetailPage />)
  await screen.findByRole('link', { name: `Open run ${initial[0].id.slice(0, 8)}` })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  navigation.params.tab = 'runs'
  getRecipeMock.mockResolvedValue(recipeResource())
  getRecipeStatusMock.mockResolvedValue(SETTLED_STATUS)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('workflow recipe runs table: cancel a run', () => {
  it('offers Cancel run only on live non-terminal rows', async () => {
    // A live execution with no matching run row adds the synthetic
    // current-execution row (`source: 'status'`, phase `Running`).
    getRecipeStatusMock.mockResolvedValue({
      phase: 'active',
      workflowExecution: { phase: 'running', startedAt: '2026-05-07T23:40:00.000Z' },
    })
    const runCanceling = adminRunDto({ run_id: RUN_B, ...requested(USER_ID) })
    await renderPage([runA, runCanceling, runDone, archivedRun])

    let menu = await openMenu(RUN_A)
    expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Cancel run' })).toBeEnabled()
    closeMenu()
    expect(within(rowOf(RUN_A)).getByText('Running')).toBeInTheDocument()

    expect(within(rowOf(RUN_B)).getByText('Running · Canceling')).toBeInTheDocument()
    for (const runId of [RUN_B, RUN_DONE, RUN_ARCHIVED]) {
      menu = await openMenu(runId)
      expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
      expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
      closeMenu()
    }

    const currentRow = screen.getByRole('link', { name: 'Open current execution status' })
    expect(within(currentRow).getByText('Running')).toBeInTheDocument()
    fireEvent.click(within(currentRow).getByRole('button', { name: 'Actions for run current-' }))
    menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
  })

  it('confirms before cancelling and sends one request', async () => {
    await renderPage([runA, runB])

    // Dismissing the confirmation sends nothing.
    let dialog = await startCancel(RUN_A)
    expect(within(dialog).getByText('Cancel run 0d4f1b52?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(cancelMock).not.toHaveBeenCalled()

    // Confirming sends exactly one request, also after a double click.
    const post = deferred<WorkflowRunSummary>()
    cancelMock.mockReturnValueOnce(post.promise)
    dialog = await startCancel(RUN_A)
    fireEvent.click(confirmButton(dialog))
    fireEvent.click(confirmButton(dialog))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1))
    expect(cancelMock).toHaveBeenCalledWith(NAMESPACE, RECIPE_NAME, RUN_A)

    // While the request is in flight the same row cannot send another.
    let menu = await openMenu(RUN_A)
    const again = within(menu).getByRole('menuitem', { name: 'Cancel run' })
    expect(again).toBeDisabled()
    fireEvent.click(again)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    closeMenu()

    const listsBefore = getWorkflowRunsMock.mock.calls.length
    await act(async () => post.resolve(runAAccepted))
    expect(await within(rowOf(RUN_A)).findByText('Running · Canceling')).toBeInTheDocument()
    expect(toast.showToast).toHaveBeenCalledWith('Cancel requested for run 0d4f1b52.', {
      tone: 'success',
    })
    await waitFor(() => expect(getWorkflowRunsMock.mock.calls.length).toBe(listsBefore + 1))
    menu = await openMenu(RUN_A)
    expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
    closeMenu()
    expect(cancelMock).toHaveBeenCalledTimes(1)

    // A request stored elsewhere (another tab, a user) answers 200 with that
    // request; the row shows Canceling.
    cancelMock.mockResolvedValueOnce(adminRunDto({ run_id: RUN_B, ...requested(USER_ID) }))
    dialog = await startCancel(RUN_B)
    fireEvent.click(confirmButton(dialog))
    expect(await within(rowOf(RUN_B)).findByText('Running · Canceling')).toBeInTheDocument()
    expect(cancelMock).toHaveBeenCalledTimes(2)
  })

  it('a failed cancel reloads the list and reports the error', async () => {
    await renderPage([runA])

    // A 409 with a reload that carries no request: the action is offered again.
    cancelMock.mockRejectedValueOnce(apiError(409, 'Conflict', 'workflow_run_not_cancellable'))
    let listsBefore = getWorkflowRunsMock.mock.calls.length
    let dialog = await startCancel(RUN_A)
    fireEvent.click(confirmButton(dialog))
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Could not cancel run 0d4f1b52: The run can no longer be canceled.',
        { tone: 'error' }
      )
    )
    await waitFor(() => expect(getWorkflowRunsMock.mock.calls.length).toBe(listsBefore + 1))
    expect(cancelMock).toHaveBeenCalledTimes(1)
    let menu = await openMenu(RUN_A)
    expect(within(menu).getByRole('menuitem', { name: 'Cancel run' })).toBeEnabled()
    closeMenu()
    expect(within(rowOf(RUN_A)).getByText('Running')).toBeInTheDocument()

    // A client timeout after the server committed: the reloaded list carries the
    // request and the row shows Canceling.
    getWorkflowRunsMock.mockResolvedValue(listOf([runAAccepted]))
    cancelMock.mockRejectedValueOnce(
      new Error('Request timed out. Check that Control API is reachable.')
    )
    listsBefore = getWorkflowRunsMock.mock.calls.length
    dialog = await startCancel(RUN_A)
    fireEvent.click(confirmButton(dialog))
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Could not cancel run 0d4f1b52: Request timed out. Check that Control API is reachable.',
        { tone: 'error' }
      )
    )
    await waitFor(() => expect(getWorkflowRunsMock.mock.calls.length).toBe(listsBefore + 1))
    expect(await within(rowOf(RUN_A)).findByText('Running · Canceling')).toBeInTheDocument()
    menu = await openMenu(RUN_A)
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
    expect(cancelMock).toHaveBeenCalledTimes(2)
  })

  it('a cancel that settles after unmount updates no state', async () => {
    for (const settle of ['resolve', 'reject'] as const) {
      vi.clearAllMocks()
      getRecipeMock.mockResolvedValue(recipeResource())
      getRecipeStatusMock.mockResolvedValue(SETTLED_STATUS)
      const post = deferred<WorkflowRunSummary>()
      cancelMock.mockReturnValueOnce(post.promise)
      const view = await renderPage([runA])
      const dialog = await startCancel(RUN_A)
      fireEvent.click(confirmButton(dialog))
      await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1))
      const listsBefore = getWorkflowRunsMock.mock.calls.length

      view.unmount()
      await act(async () => {
        if (settle === 'resolve') post.resolve(runAAccepted)
        else post.reject(apiError(500, 'Internal Server Error', 'internal_error'))
        await post.promise.catch(() => undefined)
      })

      expect(cancelMock).toHaveBeenCalledTimes(1)
      expect(toast.showToast).not.toHaveBeenCalled()
      expect(getWorkflowRunsMock.mock.calls.length).toBe(listsBefore)
    }
  })

  it('an older run list does not bring the action back', async () => {
    await renderPage([runA])
    // The reload after the 200 returns a list requested before the cancel
    // committed: run A without the request, plus a run that started meanwhile.
    getWorkflowRunsMock.mockResolvedValue(listOf([runC, runA]))
    cancelMock.mockResolvedValueOnce(runAAccepted)

    const dialog = await startCancel(RUN_A)
    fireEvent.click(confirmButton(dialog))

    // That list was applied: run C renders.
    expect(await screen.findByRole('link', { name: `Open run ${RUN_C.slice(0, 8)}` })).toBeVisible()
    expect(within(rowOf(RUN_A)).getByText('Running · Canceling')).toBeInTheDocument()
    const menu = await openMenu(RUN_A)
    expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
  })

  it('one cancel in flight disables every row', async () => {
    await renderPage([runA, runB])
    const post = deferred<WorkflowRunSummary>()
    cancelMock.mockReturnValueOnce(post.promise)

    const dialog = await startCancel(RUN_A)
    fireEvent.click(confirmButton(dialog))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1))

    // A's POST is pending: B's action is disabled and does nothing.
    let menu = await openMenu(RUN_B)
    const cancelB = within(menu).getByRole('menuitem', { name: 'Cancel run' })
    expect(cancelB).toBeDisabled()
    fireEvent.click(cancelB)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    closeMenu()
    expect(cancelMock).toHaveBeenCalledTimes(1)

    await act(async () => post.resolve(runAAccepted))
    expect(await within(rowOf(RUN_A)).findByText('Running · Canceling')).toBeInTheDocument()
    menu = await openMenu(RUN_B)
    expect(within(menu).getByRole('menuitem', { name: 'Cancel run' })).toBeEnabled()
  })

  it('a list that showed the request keeps the row canceling', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    // The first list carries the request stored elsewhere.
    await renderPage([adminRunDto({ run_id: RUN_A, ...requested(USER_ID) })])
    expect(within(rowOf(RUN_A)).getByText('Running · Canceling')).toBeInTheDocument()

    // The next poll applies a list requested earlier, without the request, plus
    // a run that started meanwhile.
    getWorkflowRunsMock.mockResolvedValue(listOf([runC, runA]))
    const poll = setIntervalSpy.mock.calls.find(call => call[1] === 5000)?.[0]
    expect(poll).toBeTypeOf('function')
    await act(async () => (poll as () => void)())

    expect(await screen.findByRole('link', { name: `Open run ${RUN_C.slice(0, 8)}` })).toBeVisible()
    expect(within(rowOf(RUN_A)).getByText('Running · Canceling')).toBeInTheDocument()
    const menu = await openMenu(RUN_A)
    expect(within(menu).getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel run' })).toBeNull()
  })
})
