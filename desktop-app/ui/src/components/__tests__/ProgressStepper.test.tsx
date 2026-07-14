// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProgressStep, TaskProgress } from '../../uiTypes'
import { ProgressStepper } from '../ProgressStepper'

// ── CSS import stub ───────────────────────────────────────────────────────────

vi.mock('../ProgressStepper.css', () => ({}))
vi.mock('../ArtifactsBadge.css', () => ({}))

afterEach(() => {
  cleanup()
})

// ── Mock ArtifactsBadge to isolate ProgressStepper ────────────────────────────

vi.mock('../ArtifactsBadge', () => ({
  ArtifactsBadge: ({ hostRef, artifactNames }: { hostRef: string; artifactNames?: string[] }) => (
    <div data-testid="artifacts-badge">
      Artifacts for {hostRef}: {(artifactNames || []).join(', ')}
    </div>
  ),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<ProgressStep> = {}): ProgressStep {
  return {
    toolCallId: 'tc-1',
    toolName: 'mongodb__find',
    displayName: 'MongoDB',
    intentSummary: 'Query users collection',
    iteration: 0,
    stepIndex: 0,
    totalSteps: 3,
    state: 'completed',
    durationMs: 150,
    ...overrides,
  }
}

function makeProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    status: 'active',
    steps: [],
    currentIteration: 0,
    ...overrides,
  }
}

function expandDetails() {
  fireEvent.click(screen.getByText('More details'))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProgressStepper — null/empty states', () => {
  it('returns null when progress is undefined', () => {
    const { container } = render(<ProgressStepper progress={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('returns null when completed with zero steps', () => {
    const { container } = render(
      <ProgressStepper progress={makeProgress({ status: 'completed', steps: [] })} />
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('ProgressStepper — connecting status', () => {
  it('renders connecting indicator', () => {
    render(<ProgressStepper progress={makeProgress({ status: 'connecting' })} />)
    expect(screen.getByTestId('progress-stepper')).toBeDefined()
    expect(screen.getByText('Connecting')).toBeDefined()
  })
})

describe('ProgressStepper — error status', () => {
  it('renders error message', () => {
    render(<ProgressStepper progress={makeProgress({ status: 'error' })} />)
    expect(screen.getByText('Progress stream error')).toBeDefined()
  })
})

describe('ProgressStepper — active status with steps', () => {
  it('hides step list by default behind More details toggle', () => {
    const step = makeStep({ state: 'running', stepIndex: 1, totalSteps: 5 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expect(screen.getByText('More details')).toBeDefined()
    expect(screen.queryByText('MongoDB')).toBeNull()
  })

  it('uses the current running step as the visible progress headline', () => {
    const step = makeStep({ state: 'running', intentSummary: 'Query users collection' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expect(screen.getByText('Using MongoDB')).toBeDefined()
    expect(screen.queryByText('Agent is thinking')).toBeNull()
  })

  it('falls back to LLM elapsed time before a tool step arrives', () => {
    render(
      <ProgressStepper
        progress={makeProgress({ status: 'active', steps: [], llmElapsedMs: 45_000 })}
      />
    )
    expect(screen.getByText('Thinking 45s')).toBeDefined()
  })

  it('keeps the latest step in the headline while waiting on the next LLM turn', () => {
    const step = makeStep({ state: 'completed', intentSummary: 'Query users collection' })
    render(
      <ProgressStepper
        progress={makeProgress({ status: 'active', steps: [step], llmElapsedMs: 45_000 })}
      />
    )
    expect(screen.getByText('Thinking after MongoDB (45s)')).toBeDefined()
  })

  it('shows only one action phrase for the latest completed step', () => {
    const step = makeStep({
      state: 'completed',
      displayName: 'Mcp-fred',
      intentSummary: 'Using Mcp-fred to inspect project files',
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expect(screen.getByText('Finished Mcp-fred')).toBeDefined()
    expect(screen.queryByText(/Finished Mcp-fred: Using Mcp-fred/)).toBeNull()
  })

  it('renders tool name after expanding details', () => {
    const step = makeStep({ state: 'running', stepIndex: 1, totalSteps: 5 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.queryByText('Step 2/5')).toBeNull()
    expect(screen.getByText('MongoDB')).toBeDefined()
  })

  it('shows running indicator for active step after expanding', () => {
    const step = makeStep({ state: 'running' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('running...')).toBeDefined()
  })

  it('shows duration for completed step after expanding', () => {
    const step = makeStep({ state: 'completed', durationMs: 1500 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('1.5s')).toBeDefined()
  })

  it('shows error summary for errored step after expanding', () => {
    const step = makeStep({ state: 'error', errorSummary: 'Connection refused' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('Connection refused')).toBeDefined()
  })

  it('extracts MCP function name from double-underscore toolName after expanding', () => {
    const step = makeStep({ toolName: 'mongodb__find_documents', displayName: 'MongoDB' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('find_documents')).toBeDefined()
  })
})

describe('ProgressStepper — completed status', () => {
  it('shows summary with tool count and expand button', () => {
    const steps = [
      makeStep({ toolCallId: 'tc-1', displayName: 'MongoDB', durationMs: 100 }),
      makeStep({
        toolCallId: 'tc-2',
        displayName: 'Redis',
        durationMs: 200,
        toolName: 'redis__get',
      }),
    ]
    render(<ProgressStepper progress={makeProgress({ status: 'completed', steps })} />)
    expect(screen.getByText(/More details/)).toBeDefined()
    expect(screen.getByText(/2 tools/)).toBeDefined()
    expect(screen.getByTestId('progress-expand-btn')).toBeDefined()
  })

  it('toggles expanded step list on button click', () => {
    const steps = [makeStep({ toolCallId: 'tc-1' })]
    render(<ProgressStepper progress={makeProgress({ status: 'completed', steps })} />)
    const btn = screen.getByTestId('progress-expand-btn')
    expect(screen.getByText(/More details/)).toBeDefined()

    fireEvent.click(btn)
    expect(screen.getByText('Hide details')).toBeDefined()
    expect(screen.getByText('MongoDB')).toBeDefined()

    fireEvent.click(btn)
    expect(screen.getByText(/More details/)).toBeDefined()
  })

  it('shows ArtifactsBadge inside expanded details for completed runs when hostRef is provided', () => {
    const steps = [
      makeStep({
        toolCallId: 'tc-1',
        toolName: 'clerum__generate_pdf',
        outputPreview: {
          headLines: ['Generated report.pdf'],
          tailLines: [],
          totalLines: 1,
          truncated: false,
        },
      }),
    ]
    render(
      <ProgressStepper progress={makeProgress({ status: 'completed', steps })} hostRef="chatllm" />
    )
    expect(screen.queryByTestId('artifacts-badge')).toBeNull()
    fireEvent.click(screen.getByTestId('progress-expand-btn'))
    expect(screen.getByTestId('artifacts-badge')).toBeDefined()
    expect(screen.getByText(/Artifacts for chatllm: report\.pdf/)).toBeDefined()
  })

  it('does not show ArtifactsBadge without filenames in progress output', () => {
    const steps = [makeStep({ toolCallId: 'tc-1', toolName: 'mongodb__find' })]
    render(
      <ProgressStepper progress={makeProgress({ status: 'completed', steps })} hostRef="chatllm" />
    )
    expect(screen.queryByTestId('artifacts-badge')).toBeNull()
  })

  it('does NOT show ArtifactsBadge when hostRef is not provided', () => {
    const steps = [makeStep({ toolCallId: 'tc-1', toolName: 'clerum__generate_pdf' })]
    render(<ProgressStepper progress={makeProgress({ status: 'completed', steps })} />)
    expect(screen.queryByTestId('artifacts-badge')).toBeNull()
  })
})

describe('ProgressStepper — suspended status (approval flow)', () => {
  it("shows 'Waiting for approval...' when suspended without suspendedInfo", () => {
    render(<ProgressStepper progress={makeProgress({ status: 'suspended' })} />)
    expect(screen.getByText('Waiting for approval...')).toBeDefined()
  })

  it('shows tool display name when suspendedInfo is populated', () => {
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Dangerous Tool',
          },
        })}
      />
    )
    expect(screen.getByText('Dangerous Tool requires approval')).toBeDefined()
  })

  it('shows the internal tool function name when approval display name is generic', () => {
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            toolName: 'clerum__plot_pnl',
            displayName: 'Clerum',
          },
        })}
      />
    )
    expect(screen.getByText('Clerum plot_pnl requires approval')).toBeDefined()
  })

  it('renders Approve button when suspendedInfo and onApprove are provided', () => {
    const onApprove = vi.fn()
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
        onApprove={onApprove}
      />
    )
    const btn = screen.getByTestId('approval-approve-btn')
    expect(btn).toBeDefined()
    expect(btn.textContent).toBe('Approve')
  })

  it('renders Deny button when suspendedInfo and onDeny are provided', () => {
    const onDeny = vi.fn()
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
        onDeny={onDeny}
      />
    )
    const btn = screen.getByTestId('approval-deny-btn')
    expect(btn).toBeDefined()
    expect(btn.textContent).toBe('Deny')
  })

  it('does NOT render Approve/Deny buttons when suspendedInfo is missing', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <ProgressStepper
        progress={makeProgress({ status: 'suspended' })}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    )
    expect(screen.queryByTestId('approval-approve-btn')).toBeNull()
    expect(screen.queryByTestId('approval-deny-btn')).toBeNull()
  })

  it('does NOT render Approve/Deny buttons when callbacks are not provided', () => {
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
      />
    )
    expect(screen.queryByTestId('approval-approve-btn')).toBeNull()
    expect(screen.queryByTestId('approval-deny-btn')).toBeNull()
  })

  it("calls onApprove callback and shows 'Approving...' on click", () => {
    const onApprove = vi.fn()
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
        onApprove={onApprove}
      />
    )

    const btn = screen.getByTestId('approval-approve-btn')
    fireEvent.click(btn)

    expect(onApprove).toHaveBeenCalledOnce()
    expect(btn.textContent).toBe('Approving...')
  })

  it('calls onDeny callback and disables buttons on click', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    )

    const denyBtn = screen.getByTestId('approval-deny-btn')
    fireEvent.click(denyBtn)

    expect(onDeny).toHaveBeenCalledOnce()
    // After clicking, both buttons should be disabled
    const approveBtn = screen.getByTestId('approval-approve-btn')
    expect(approveBtn.hasAttribute('disabled')).toBe(true)
    expect(denyBtn.hasAttribute('disabled')).toBe(true)
  })

  it('renders step list when suspended with existing steps after expanding details', () => {
    const steps = [makeStep({ toolCallId: 'tc-1', state: 'completed', displayName: 'MongoDB' })]
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'suspended',
          steps,
          suspendedInfo: {
            requestId: 'req-1',
            displayName: 'Tool X',
          },
        })}
        onApprove={vi.fn()}
      />
    )
    expect(screen.getByTestId('approval-approve-btn')).toBeDefined()
    expandDetails()
    expect(screen.getByText('MongoDB')).toBeDefined()
  })
})

describe('ProgressStepper — iteration dividers', () => {
  it("shows 'Thinking further...' divider between different iterations after expanding", () => {
    const steps = [
      makeStep({ toolCallId: 'tc-1', iteration: 0, displayName: 'Step A' }),
      makeStep({ toolCallId: 'tc-2', iteration: 1, displayName: 'Step B' }),
    ]
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps })} />)
    expandDetails()
    expect(screen.getByText('Thinking further...')).toBeDefined()
  })
})

describe('ProgressStepper — duration formatting', () => {
  it('formats milliseconds < 1000 as ms', () => {
    const step = makeStep({ state: 'completed', durationMs: 42 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('42ms')).toBeDefined()
  })

  it('formats milliseconds >= 1000 as seconds', () => {
    const step = makeStep({ state: 'completed', durationMs: 2345 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('2.3s')).toBeDefined()
  })
})

describe('ProgressStepper — per-step token usage', () => {
  it('renders duration · compact token count with a breakdown tooltip (no cache → 2 figures)', () => {
    const step = makeStep({
      state: 'completed',
      durationMs: 1500,
      tokens: { input: 12_000, output: 300 },
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const span = screen.getByText('1.5s · 12.3k')
    // Compute the expected separator via toLocaleString so the assertion is
    // locale-agnostic (same convention as sessionTokensIndicator.test.tsx).
    expect(span.getAttribute('title')).toBe(`Input ${(12_000).toLocaleString()} · Output 300`)
  })

  it('includes cache read/write in the tooltip when the provider reported cache (4 figures)', () => {
    const step = makeStep({
      state: 'completed',
      durationMs: 1500,
      tokens: { input: 12_000, output: 300, cacheRead: 9_000, cacheWrite: 0 },
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const span = screen.getByText('1.5s · 12.3k')
    expect(span.getAttribute('title')).toBe(
      `Input ${(12_000).toLocaleString()} · Output 300 · Cache read ${(9_000).toLocaleString()} · Cache write 0`
    )
  })

  it('renders only the duration when the step carries no tokens (post-approval steps)', () => {
    const step = makeStep({ state: 'completed', durationMs: 1500, tokens: undefined })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const span = screen.getByText('1.5s')
    expect(span.textContent).toBe('1.5s')
    expect(span.getAttribute('title')).toBeNull()
  })

  it('does not render tokens on errored steps even when present', () => {
    const step = makeStep({
      state: 'error',
      errorSummary: 'Connection refused',
      tokens: { input: 12_000, output: 300 },
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('Connection refused')).toBeDefined()
    expect(screen.queryByText(/12\.3k/)).toBeNull()
  })
})

describe('ProgressStepper — inputPreview', () => {
  it('renders inputPreview inline in active step row after expanding', () => {
    const step = makeStep({
      state: 'running',
      toolName: 'shell_exec',
      displayName: 'Shell',
      inputPreview: 'git status',
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('git status')).toBeDefined()
  })

  it('renders inputPreview in completed step row after expanding', () => {
    const step = makeStep({
      state: 'completed',
      toolName: 'shell_exec',
      displayName: 'Shell',
      inputPreview: 'npm run build',
      durationMs: 9200,
    })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('npm run build')).toBeDefined()
  })

  it('does not render inputPreview span when not present after expanding', () => {
    const step = makeStep({ state: 'completed', inputPreview: undefined })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.queryByTestId('step-input-preview')).toBeNull()
  })
})

describe('ProgressStepper — outputPreview expand', () => {
  const outputPreview = {
    headLines: ['stdout:', 'On branch master', 'Changes not staged:'],
    tailLines: ['modified: file.ts', 'modified: other.ts', 'no changes added'],
    totalLines: 15,
    truncated: true,
  }

  it('does not show output panel before expanding details', () => {
    const step = makeStep({ state: 'completed', outputPreview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expect(screen.queryByTestId('step-output-panel')).toBeNull()
  })

  it('expands output panel on row click after expanding details', () => {
    const step = makeStep({ state: 'completed', outputPreview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const row = screen.getByTestId('step-row-tc-1')
    fireEvent.click(row)
    const panel = screen.getByTestId('step-output-panel')
    expect(panel).toBeDefined()
    expect(panel.textContent).toContain('no changes added')
    expect(panel.textContent).toContain('modified: file.ts')
    expect(panel.textContent).not.toContain('stdout:')
    expect(screen.queryByText(/lines hidden/)).toBeNull()
  })

  it('collapses output panel on second click', () => {
    const step = makeStep({ state: 'completed', outputPreview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const row = screen.getByTestId('step-row-tc-1')
    fireEvent.click(row)
    expect(screen.getByTestId('step-output-panel')).toBeDefined()
    fireEvent.click(row)
    expect(screen.queryByTestId('step-output-panel')).toBeNull()
  })

  it('auto-expands error rows with outputPreview after expanding details', () => {
    const step = makeStep({ state: 'error', outputPreview, errorSummary: 'Failed' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByTestId('step-output-panel')).toBeDefined()
  })

  it('does not render output panel for running steps after expanding details', () => {
    const step = makeStep({ state: 'running', outputPreview: undefined })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.queryByTestId('step-output-panel')).toBeNull()
  })

  it('shows expand chevron on expandable rows after expanding details', () => {
    const step = makeStep({ state: 'completed', outputPreview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const row = screen.getByTestId('step-row-tc-1')
    expect(row.querySelector('.stepper-step-chevron')).toBeDefined()
  })

  it('error output panel has error styling after expanding details', () => {
    const step = makeStep({ state: 'error', outputPreview, errorSummary: 'Failed' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const panel = screen.getByTestId('step-output-panel')
    expect(panel.classList.contains('stepper-step-output--error')).toBe(true)
  })

  it('renders non-truncated output without hidden lines indicator', () => {
    const smallPreview = {
      headLines: ['line1', 'line2'],
      tailLines: [],
      totalLines: 2,
      truncated: false,
    }
    const step = makeStep({ state: 'completed', outputPreview: smallPreview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const row = screen.getByTestId('step-row-tc-1')
    fireEvent.click(row)
    const panel = screen.getByTestId('step-output-panel')
    expect(panel.textContent).toContain('line1')
    expect(panel.textContent).toContain('line2')
    expect(screen.queryByText(/lines hidden/)).toBeNull()
  })
})

describe('ProgressStepper — cancel button', () => {
  it('does NOT render cancel button when onCancel is not provided', () => {
    render(<ProgressStepper progress={makeProgress({ status: 'active' })} />)
    expect(screen.queryByTestId('progress-cancel-btn')).toBeNull()
  })

  it('renders cancel button on active status when onCancel is provided', () => {
    const onCancel = vi.fn()
    render(<ProgressStepper progress={makeProgress({ status: 'active' })} onCancel={onCancel} />)
    const btn = screen.getByTestId('progress-cancel-btn')
    expect(btn).toBeDefined()
    expect(btn.getAttribute('aria-label')).toBe('Stop agent')
    expect(btn.textContent).toBe('■')
  })

  it('renders cancel button on connecting status when onCancel is provided', () => {
    const onCancel = vi.fn()
    render(
      <ProgressStepper progress={makeProgress({ status: 'connecting' })} onCancel={onCancel} />
    )
    expect(screen.getByTestId('progress-cancel-btn')).toBeDefined()
  })

  it('renders cancel button on suspended status when onCancel is provided', () => {
    const onCancel = vi.fn()
    render(<ProgressStepper progress={makeProgress({ status: 'suspended' })} onCancel={onCancel} />)
    expect(screen.getByTestId('progress-cancel-btn')).toBeDefined()
  })

  it('calls onCancel and toggles stop button state on click', () => {
    const onCancel = vi.fn()
    render(<ProgressStepper progress={makeProgress({ status: 'active' })} onCancel={onCancel} />)
    const btn = screen.getByTestId('progress-cancel-btn')
    fireEvent.click(btn)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(btn.getAttribute('aria-label')).toBe('Stopping agent')
    expect(btn.textContent).toBe('■')
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})

describe('ProgressStepper — cancelled terminal state', () => {
  it('renders Cancelled badge', () => {
    render(<ProgressStepper progress={makeProgress({ status: 'cancelled' })} />)
    expect(screen.getByText('Cancelled')).toBeDefined()
  })

  it('shows cancelReason when present', () => {
    render(
      <ProgressStepper
        progress={makeProgress({
          status: 'cancelled',
          cancelReason: 'User requested cancellation',
        })}
      />
    )
    expect(screen.getByText('User requested cancellation')).toBeDefined()
  })

  it('does not show cancel button in cancelled state even when onCancel is provided', () => {
    const onCancel = vi.fn()
    render(<ProgressStepper progress={makeProgress({ status: 'cancelled' })} onCancel={onCancel} />)
    expect(screen.queryByTestId('progress-cancel-btn')).toBeNull()
  })

  it('renders partial steps that ran before cancellation after expanding details', () => {
    const steps = [makeStep({ toolCallId: 'tc-1', displayName: 'MongoDB', state: 'completed' })]
    render(<ProgressStepper progress={makeProgress({ status: 'cancelled', steps })} />)
    expandDetails()
    expect(screen.getByText('MongoDB')).toBeDefined()
  })
})

describe('ProgressStepper — running step with elapsed + live output', () => {
  it('shows "running..." fallback when elapsedMs is absent after expanding', () => {
    const step = makeStep({ state: 'running' })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('running...')).toBeDefined()
  })

  it('shows elapsed time when elapsedMs is present (seconds-only) after expanding', () => {
    const step = makeStep({ state: 'running', elapsedMs: 45_000 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('running · 45s')).toBeDefined()
  })

  it('shows elapsed time formatted as minutes+seconds (mmMsss) after expanding', () => {
    const step = makeStep({ state: 'running', elapsedMs: 150_000 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    expect(screen.getByText('running · 2m30s')).toBeDefined()
  })

  it('running step is NOT expandable when liveOutputPreview is absent after expanding details', () => {
    const step = makeStep({ state: 'running', elapsedMs: 1000 })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    // No step-level chevron should be rendered (details-toggle chevron is separate).
    expect(screen.queryByTestId('step-row-tc-1')?.querySelector('.stepper-step-chevron')).toBeNull()
  })

  it('running step IS expandable when liveOutputPreview is present after expanding details', () => {
    const preview = {
      headLines: ['npm install starting'],
      tailLines: ['done'],
      totalLines: 10,
      truncated: true,
    }
    const step = makeStep({ state: 'running', elapsedMs: 1000, liveOutputPreview: preview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()
    const row = screen.getByTestId('step-row-tc-1')
    expect(row.querySelector('.stepper-step-chevron')).toBeDefined()
  })

  it('clicking the chevron on a running step expands the OutputPanel with liveOutputPreview', () => {
    const preview = {
      headLines: ['npm install starting'],
      tailLines: ['installing openclaw@1.0.0'],
      totalLines: 42,
      truncated: true,
    }
    const step = makeStep({ state: 'running', elapsedMs: 1000, liveOutputPreview: preview })
    render(<ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />)
    expandDetails()

    const row = screen.getByTestId(`step-row-${step.toolCallId}`)
    fireEvent.click(row)

    const panel = screen.getByTestId('step-output-panel')
    expect(panel.textContent).toContain('installing openclaw@1.0.0')
    expect(panel.textContent).not.toContain('npm install starting')
  })

  it('open OutputPanel auto-refreshes when liveOutputPreview updates on subsequent tool_progress events', () => {
    const initialPreview = {
      headLines: ['line-1'],
      tailLines: ['line-5'],
      totalLines: 5,
      truncated: false,
    }
    const step = makeStep({ state: 'running', elapsedMs: 5000, liveOutputPreview: initialPreview })
    const { rerender } = render(
      <ProgressStepper progress={makeProgress({ status: 'active', steps: [step] })} />
    )
    expandDetails()

    fireEvent.click(screen.getByTestId(`step-row-${step.toolCallId}`))
    let panel = screen.getByTestId('step-output-panel')
    expect(panel.textContent).toContain('line-5')
    expect(panel.textContent).not.toContain('line-10')

    const updatedPreview = {
      headLines: ['line-1'],
      tailLines: ['line-10'],
      totalLines: 10,
      truncated: true,
    }
    const updatedStep = { ...step, elapsedMs: 10000, liveOutputPreview: updatedPreview }
    rerender(
      <ProgressStepper progress={makeProgress({ status: 'active', steps: [updatedStep] })} />
    )

    panel = screen.getByTestId('step-output-panel')
    expect(panel.textContent).toContain('line-10')
    expect(panel.textContent).not.toContain('line-1\n')
    expect(panel.textContent).not.toContain('lines hidden')
  })
})
