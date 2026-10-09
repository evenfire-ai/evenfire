// @vitest-environment jsdom
/**
 * #1044 — the **Retry model step** notice: what each checkpoint status renders,
 * and that pressing the button drives the continuation POST at the version the
 * view holds instead of Resend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { parseModelStepCheckpointView } from '../../../../../src/modelStepCheckpointWire'
import {
  type MockClerum,
  installMockClerum,
  uninstallMockClerum,
} from '../../../hooks/domain/__tests__/__fixtures__/mockClerum'
import {
  CHECKPOINT_ID,
  CONTINUATION_TASK_ID,
  checkpointView,
  continueAnswer,
  modelStepFixture,
  sendAndFail,
} from '../../../hooks/domain/__tests__/__fixtures__/modelStepCheckpoint'
import { ModelStepRetryNotice } from '../ModelStepRetryNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ModelStepRetryNotice (#1044)', () => {
  it('offers Retry model step for a resumable checkpoint and reports the kept tool calls', () => {
    const onRetry = vi.fn()
    render(
      <ModelStepRetryNotice
        checkpoint={checkpointView('session-view.resumable.json')}
        retry={null}
        onRetry={onRetry}
      />
    )

    expect(screen.getByTestId('model-step-retry-notice').dataset.status).toBe('resumable')
    expect(
      screen.getByText(/21 tool calls already completed and will not run again\./)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry model step' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the request error beside the button', () => {
    render(
      <ModelStepRetryNotice
        checkpoint={checkpointView('session-view.resumable.json')}
        retry={{ pending: false, error: 'Host is draining (503)' }}
        onRetry={vi.fn()}
      />
    )

    expect(screen.getByRole('alert').textContent).toBe('Host is draining (503)')
    expect(screen.getByTestId('model-step-retry-btn')).toBeTruthy()
  })

  it('names the blocked reason, offers no button and points at sending again', () => {
    render(
      <ModelStepRetryNotice
        checkpoint={checkpointView('session-view.blocked.json')}
        retry={null}
        onRetry={vi.fn()}
      />
    )

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('blocked')
    expect(notice.textContent).toContain('This turn cannot continue.')
    expect(notice.textContent).toContain('The model this turn used is no longer available.')
    expect(notice.textContent).toContain('Send the message again to start a new turn.')
    expect(screen.queryByTestId('model-step-retry-btn')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says an attached file is no longer kept when its bytes expired, and points at sending again', () => {
    // The C0 blocked view with the reason PR 1 added (addendum A7), read through
    // the main-process wire parser so an unmirrored reason fails here.
    const wire = modelStepFixture('session-view.blocked.json') as Record<string, unknown>
    const checkpoint = parseModelStepCheckpointView({
      ...wire,
      blockedReason: 'attachment_expired',
    })
    expect(checkpoint.blockedReason).toBe('attachment_expired')
    expect(() =>
      parseModelStepCheckpointView({ ...wire, blockedReason: 'attachment_gone' })
    ).toThrow('Invalid model step checkpoint.blockedReason')

    render(<ModelStepRetryNotice checkpoint={checkpoint} retry={null} onRetry={vi.fn()} />)

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('blocked')
    expect(notice.textContent).toContain(
      'This turn cannot continue. A file attached to this turn is no longer kept on the Host.'
    )
    expect(notice.textContent).toContain('Send the message again to start a new turn.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says the step is no longer available after a not_found answer', () => {
    const { container, rerender } = render(
      <ModelStepRetryNotice
        checkpoint={null}
        retry={{ pending: false, error: null, unavailable: true }}
        onRetry={vi.fn()}
      />
    )

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('unavailable')
    expect(notice.textContent).toContain(
      'This model step can no longer be retried. Send the message again to start a new turn.'
    )
    expect(screen.queryByRole('button')).toBeNull()

    // Without the not_found answer there is nothing to say.
    rerender(<ModelStepRetryNotice checkpoint={null} retry={null} onRetry={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing while a continuation is claimed', () => {
    const { container, rerender } = render(
      <ModelStepRetryNotice
        checkpoint={checkpointView('session-view.resumable.json')}
        retry={null}
        onRetry={vi.fn()}
      />
    )
    // Witness: the same element renders the notice for a resumable view.
    expect(screen.getByTestId('model-step-retry-notice')).toBeTruthy()

    rerender(
      <ModelStepRetryNotice
        checkpoint={checkpointView('session-view.claimed.json')}
        retry={null}
        onRetry={vi.fn()}
      />
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('Retry model step wired to the controller (#1044)', () => {
  let clerum: MockClerum
  let uuidCounter = 0

  beforeEach(() => {
    uuidCounter = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
    )
    clerum = installMockClerum()
  })

  afterEach(() => {
    uninstallMockClerum()
  })

  it('pressing the button calls continueModelStep with the version and never Resend', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    const checkpoint = result.current.modelStepCheckpoint
    expect(checkpoint?.retryAvailable).toBe(true)
    expect(result.current.failedAgentSend).toBeNull()
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))

    render(
      <ModelStepRetryNotice
        checkpoint={checkpoint!}
        retry={result.current.modelStepRetry}
        onRetry={() => void result.current.handleRetryModelStep()}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry model step' }))
    })

    // Witness: the continuation POST went out once, at the view's version.
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      result.current.activeChatId,
      CHECKPOINT_ID,
      1
    )
    // Resend would re-send the user message; only the original send went out.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true)
  })
})
