import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { WorkflowRunModal } from '../WorkflowRunModal'
import type { InputContractProperties } from '../WorkflowRunModal/types'

vi.mock('../../lib/api', () => ({
  triggerWorkflow: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const NAMESPACE = 'sandbox-recipes'
const NAME = 'market-report'

describe('WorkflowRunModal — empty inputs', () => {
  it('test_workflowRunModal_operatorCopy_showsOperatorRunTitleAndAction', () => {
    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={vi.fn()} onStarted={vi.fn()} />
    )

    expect(screen.getByRole('heading', { name: `Run ${NAME} as operator` })).toBeInTheDocument()
    expect(screen.getByText(/Starts an on-demand operator run/i)).toHaveTextContent(
      'Usage is attributed to Control UI.'
    )
    expect(screen.getByRole('button', { name: /^run as operator$/i })).toBeInTheDocument()
  })

  it('test_workflowRunModal_requiresApproval_showsDesktopApprovalOperatorNote', () => {
    render(
      <WorkflowRunModal
        name={NAME}
        namespace={NAMESPACE}
        requiresApproval
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'This recipe requires Desktop approval for end-user runs. Control UI runs execute as operator runs and are billed to control-plane-admin-ui.'
    )
  })

  it('test_workflowRunModal_noInputs_showsDefaultMessageAndTriggersWithEmptyBody', async () => {
    vi.mocked(api.triggerWorkflow).mockResolvedValue({
      runId: 'run-1',
      recipeNamespace: NAMESPACE,
      recipeName: NAME,
      triggeredAt: '2026-05-03T12:00:00Z',
    })
    const onClose = vi.fn()
    const onStarted = vi.fn()

    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={onClose} onStarted={onStarted} />
    )

    expect(screen.getByText(/recipe declares no inputs/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => {
      expect(api.triggerWorkflow).toHaveBeenCalledTimes(1)
    })

    const [ns, name, body, idempotencyKey] = vi.mocked(api.triggerWorkflow).mock.calls[0]
    expect(ns).toBe(NAMESPACE)
    expect(name).toBe(NAME)
    expect(body).toEqual({})
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('teamId')
    expect(body).not.toHaveProperty('approvalRequestId')
    expect(body).not.toHaveProperty('actor_type')
    expect(body).not.toHaveProperty('actor')
    expect(typeof idempotencyKey).toBe('string')
    expect(idempotencyKey.length).toBeGreaterThan(0)
    expect(onStarted).toHaveBeenCalledWith({
      recipeName: NAME,
      namespace: NAMESPACE,
      runId: 'run-1',
    })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('WorkflowRunModal — declared inputs', () => {
  const inputs: InputContractProperties = {
    topic: { type: 'string', default: 'AI orchestration' },
    items: { type: 'number', default: 5 },
    publish: { type: 'boolean', default: true },
  }

  it('test_workflowRunModal_inputsRendered_passesValuesAsTypedPayload', async () => {
    vi.mocked(api.triggerWorkflow).mockResolvedValue({
      runId: 'run-2',
      recipeNamespace: NAMESPACE,
      recipeName: NAME,
      triggeredAt: '2026-05-03T12:00:00Z',
    })
    const onStarted = vi.fn()

    render(
      <WorkflowRunModal
        name={NAME}
        namespace={NAMESPACE}
        inputs={inputs}
        onClose={vi.fn()}
        onStarted={onStarted}
      />
    )

    const topic = screen.getByLabelText('topic') as HTMLInputElement
    const items = screen.getByLabelText('items') as HTMLInputElement
    const publish = screen.getByLabelText(/publish/i) as HTMLInputElement
    expect(topic.value).toBe('AI orchestration')
    expect(items.value).toBe('5')
    expect(publish.checked).toBe(true)

    fireEvent.change(topic, { target: { value: 'edge AI' } })
    fireEvent.change(items, { target: { value: '12' } })
    fireEvent.click(publish)

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => expect(api.triggerWorkflow).toHaveBeenCalledTimes(1))

    const [, , body] = vi.mocked(api.triggerWorkflow).mock.calls[0]
    expect(body).toEqual({
      inputs: { topic: 'edge AI', items: 12, publish: false },
    })
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('teamId')
    expect(body).not.toHaveProperty('approvalRequestId')
    expect(body).not.toHaveProperty('actor_type')
    expect(body).not.toHaveProperty('actor')
  })

  it('test_workflowRunModal_emptyOptionalString_skippedFromPayload', async () => {
    vi.mocked(api.triggerWorkflow).mockResolvedValue({
      runId: 'run-3',
      recipeNamespace: NAMESPACE,
      recipeName: NAME,
      triggeredAt: '2026-05-03T12:00:00Z',
    })

    const sparseInputs: InputContractProperties = {
      topic: { type: 'string' },
    }

    render(
      <WorkflowRunModal
        name={NAME}
        namespace={NAMESPACE}
        inputs={sparseInputs}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => expect(api.triggerWorkflow).toHaveBeenCalledTimes(1))
    // Empty string strips to no inputs at all so server defaults take over.
    const [, , body] = vi.mocked(api.triggerWorkflow).mock.calls[0]
    expect(body).toEqual({})
  })
})

describe('WorkflowRunModal — error handling', () => {
  it('test_workflowRunModal_apiError_showsErrorBannerAndKeepsModalOpen', async () => {
    vi.mocked(api.triggerWorkflow).mockRejectedValue(
      new Error('403 Forbidden - Not authorized to trigger this recipe')
    )
    const onClose = vi.fn()
    const onStarted = vi.fn()

    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={onClose} onStarted={onStarted} />
    )

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Not authorized/i)
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('test_workflowRunModal_oldControlApiRequiresUserSessionError_mapsToOperatorMessage', async () => {
    vi.mocked(api.triggerWorkflow).mockRejectedValue(
      new Error('403 Forbidden - {"error":"on_demand_approval_requires_user_session"}')
    )

    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={vi.fn()} onStarted={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This cluster is still running an older Control API that blocks operator runs for approval-gated workflows. Redeploy control-api and retry.'
      )
    })
  })

  it('test_workflowRunModal_runtimeNotReadyError_mapsToRetryMessage', async () => {
    vi.mocked(api.triggerWorkflow).mockRejectedValue(
      new Error('409 Conflict - {"error":"workflow_runtime_not_ready"}')
    )

    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={vi.fn()} onStarted={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: /^run as operator$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Workflow runtime infrastructure is still preparing. Wait for the recipe workload, MCP server, connector access, and ready endpoints, then retry.'
      )
    })
  })

  it('test_workflowRunModal_cancelClick_invokesOnClose', () => {
    const onClose = vi.fn()
    render(
      <WorkflowRunModal name={NAME} namespace={NAMESPACE} onClose={onClose} onStarted={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
