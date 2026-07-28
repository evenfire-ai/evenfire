import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HostApprovalSection } from '../HostApprovalSection'
import { NATIVE_TOOLS } from '../HostApprovalSection/constants'
import { useApprovalToolsDraft } from '../HostApprovalSection/hooks'

describe('HostApprovalSection — constants', () => {
  it('contains exactly the 12 always-on native tools verified during the back-end smoke', () => {
    const expected = [
      'clerum__generate_docx',
      'clerum__generate_markdown',
      'clerum__generate_pdf',
      'clerum__generate_xlsx',
      'clerum__list_workflows',
      'clerum__trigger_workflow',
      'file_read',
      'file_write',
      'http_request',
      'json_transform',
      'shell_exec',
      'system_info',
    ]
    expect(NATIVE_TOOLS.map(t => t.name)).toEqual(expected)
  })

  it('is sorted alphabetically', () => {
    const names = NATIVE_TOOLS.map(t => t.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })

  it('every entry has name, codeDefault, and description', () => {
    for (const t of NATIVE_TOOLS) {
      expect(t.name).toBeTruthy()
      expect(['required', 'skip']).toContain(t.codeDefault)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it('attaches a riskHint only to tools whose codeDefault is "required" (loosenable)', () => {
    // Only http_request and shell_exec actually return true from
    // requiresApproval() in mcp-host (verified against the live source).
    // Tools whose code default is already 'skip' have no "loosening"
    // direction, so a riskHint on them would be misleading.
    const expectedRisky = ['http_request', 'shell_exec']
    for (const name of expectedRisky) {
      const tool = NATIVE_TOOLS.find(t => t.name === name)
      expect(tool, `${name} must be in NATIVE_TOOLS`).toBeDefined()
      expect(tool!.codeDefault, `${name} must have codeDefault 'required'`).toBe('required')
      expect(tool!.riskHint, `${name} needs a riskHint`).toBeTruthy()
    }

    // Conversely, every tool whose codeDefault is 'skip' must NOT carry a
    // riskHint — the `isRisky` predicate would never fire for them anyway,
    // and a stray hint would be dead documentation that decays.
    const skipDefaultTools = NATIVE_TOOLS.filter(t => t.codeDefault === 'skip')
    for (const tool of skipDefaultTools) {
      expect(
        tool.riskHint,
        `${tool.name} should not have a riskHint (codeDefault is 'skip')`
      ).toBeUndefined()
    }
  })
})

describe('HostApprovalSection — useApprovalToolsDraft', () => {
  it('initializes empty when initialTools is undefined', () => {
    const { result } = renderHook(() => useApprovalToolsDraft(undefined))
    expect(result.current.draft.rows).toEqual({})
    expect(result.current.draft.customRows).toEqual([])
    expect(result.current.isDirty).toBe(false)
  })

  it('translates initial tools map into row states', () => {
    const { result } = renderHook(() =>
      useApprovalToolsDraft({ http_request: false, shell_exec: true })
    )
    expect(result.current.draft.rows).toEqual({
      http_request: 'skip',
      shell_exec: 'required',
    })
    expect(result.current.draft.customRows).toEqual([])
    expect(result.current.isDirty).toBe(false)
  })

  it('separates known tools from custom rows on load', () => {
    const { result } = renderHook(() =>
      useApprovalToolsDraft({
        http_request: false,
        memory_search: true,
        desktop_screenshot: false,
      })
    )
    expect(result.current.draft.rows).toEqual({ http_request: 'skip' })
    expect(result.current.draft.customRows).toEqual([
      { name: 'desktop_screenshot', state: 'skip' },
      { name: 'memory_search', state: 'required' },
    ])
  })

  it('flips isDirty when a row state changes', () => {
    const { result } = renderHook(() => useApprovalToolsDraft({ http_request: false }))
    expect(result.current.isDirty).toBe(false)
    act(() => result.current.setRowState('http_request', 'required'))
    expect(result.current.isDirty).toBe(true)
    expect(result.current.draft.rows.http_request).toBe('required')
  })

  it('flips isDirty when a custom row is added', () => {
    const { result } = renderHook(() => useApprovalToolsDraft(undefined))
    expect(result.current.isDirty).toBe(false)
    act(() => result.current.addCustomRow('memory_search', 'skip'))
    expect(result.current.isDirty).toBe(true)
    expect(result.current.draft.customRows).toEqual([{ name: 'memory_search', state: 'skip' }])
  })

  it('removes custom rows by index and updates dirty', () => {
    const { result } = renderHook(() =>
      useApprovalToolsDraft({ memory_search: true, cron_list: false })
    )
    expect(result.current.draft.customRows).toHaveLength(2)
    act(() => result.current.removeCustomRow(0))
    expect(result.current.draft.customRows).toHaveLength(1)
    expect(result.current.isDirty).toBe(true)
  })

  it('reset returns to initial state', () => {
    const { result } = renderHook(() => useApprovalToolsDraft({ http_request: false }))
    act(() => result.current.setRowState('http_request', 'required'))
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.reset())
    expect(result.current.isDirty).toBe(false)
    expect(result.current.draft.rows.http_request).toBe('skip')
  })

  it('toToolsMap omits default rows and includes custom rows', () => {
    const { result } = renderHook(() => useApprovalToolsDraft(undefined))
    act(() => {
      result.current.setRowState('http_request', 'skip')
      result.current.setRowState('shell_exec', 'required')
      result.current.addCustomRow('memory_search', 'skip')
    })
    expect(result.current.toToolsMap()).toEqual({
      http_request: false,
      shell_exec: true,
      memory_search: false,
    })
  })

  it('toToolsMap returns empty object when nothing is overridden', () => {
    const { result } = renderHook(() => useApprovalToolsDraft({ http_request: false }))
    act(() => result.current.setRowState('http_request', 'default'))
    expect(result.current.toToolsMap()).toEqual({})
  })
})

describe('HostApprovalSection — component', () => {
  let onSave: ReturnType<typeof vi.fn> & ((tools: Record<string, boolean>) => Promise<void>)

  beforeEach(() => {
    onSave = vi.fn().mockResolvedValue(undefined) as typeof onSave
  })

  afterEach(() => cleanup())

  describe('read-only — no overrides', () => {
    it('renders the empty state and an Edit button when canWrite=true', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      expect(screen.getByText(/no per-tool overrides configured/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
      expect(screen.queryByText('Per-tool approval')).not.toBeInTheDocument()
    })

    it('hides the Edit button when canWrite=false', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={false}
        />
      )
      expect(screen.getByText(/no per-tool overrides configured/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    })
  })

  describe('read-only — overrides exist', () => {
    it('renders one row per overridden tool, not all 12', () => {
      render(
        <HostApprovalSection
          initialTools={{ http_request: false, file_write: false }}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      // Both overrides shown
      expect(screen.getByText('http_request')).toBeInTheDocument()
      expect(screen.getByText('file_write')).toBeInTheDocument()
      // Tools with no override are NOT rendered
      expect(screen.queryByText('shell_exec')).not.toBeInTheDocument()
      expect(screen.queryByText('clerum__generate_pdf')).not.toBeInTheDocument()
    })

    it('shows the warning icon next to risky overrides only', () => {
      render(
        <HostApprovalSection
          initialTools={{ http_request: false }}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      // http_request: code default is 'required' + state is 'skip' → risky
      expect(screen.getByTitle(/CLERUM_HTTP_ALLOWLIST/i)).toBeInTheDocument()
    })

    it('does NOT show the warning icon when overriding a Skip-default tool to Skip', () => {
      // file_write defaults to Skip in the code (verified). Setting Skip here
      // is a no-op confirmation — no security loosening — so no warning.
      render(
        <HostApprovalSection
          initialTools={{ file_write: false }}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      // No CLERUM_HTTP_ALLOWLIST tooltip; no other risk-related title.
      expect(screen.queryByTitle(/Skipping approval/i)).not.toBeInTheDocument()
      // The override row is still rendered.
      expect(screen.getByText('file_write')).toBeInTheDocument()
    })
  })

  describe('edit mode', () => {
    it('clicking Edit reveals all 12 always-on rows alphabetically', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))

      // First always-on tool alphabetically is clerum__generate_docx
      expect(screen.getByText('clerum__generate_docx')).toBeInTheDocument()
      // Last is system_info
      expect(screen.getByText('system_info')).toBeInTheDocument()
      // shell_exec is in there too
      expect(screen.getByText('shell_exec')).toBeInTheDocument()
    })

    it("annotates each row's Default option with the resolved code default", () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))

      // http_request defaults to Required in mcp-host (verified)
      const httpSelect = screen.getByLabelText(/http_request/i) as HTMLSelectElement
      const httpDefaultOpt = Array.from(httpSelect.options).find(o => o.value === 'default')
      expect(httpDefaultOpt?.textContent).toMatch(/Default\s*\(\s*Required\s*\)/)

      // file_write defaults to Skip
      const fwSelect = screen.getByLabelText(/file_write/i) as HTMLSelectElement
      const fwDefaultOpt = Array.from(fwSelect.options).find(o => o.value === 'default')
      expect(fwDefaultOpt?.textContent).toMatch(/Default\s*\(\s*Skip\s*\)/)

      // shell_exec defaults to Required
      const shellSelect = screen.getByLabelText(/shell_exec/i) as HTMLSelectElement
      const shellDefaultOpt = Array.from(shellSelect.options).find(o => o.value === 'default')
      expect(shellDefaultOpt?.textContent).toMatch(/Default\s*\(\s*Required\s*\)/)
    })

    it('Save button disabled until a row state changes', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      const saveBtn = screen.getByRole('button', { name: /^save/i })
      expect(saveBtn).toBeDisabled()
      const actions = saveBtn.closest('.cu-host-approval-section__actions')
      expect(actions).not.toBeNull()
      expect(actions?.previousElementSibling).toHaveClass('cu-host-approval-section__content')

      // Change http_request to Skip
      const httpSelect = screen.getByLabelText(/http_request/i) as HTMLSelectElement
      fireEvent.change(httpSelect, { target: { value: 'skip' } })
      expect(saveBtn).not.toBeDisabled()
    })

    it('warning icon appears on a Skip override of a Required-default tool', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))

      // Initially no warning icons
      expect(screen.queryAllByTitle(/CLERUM_HTTP_ALLOWLIST/i)).toHaveLength(0)

      const httpSelect = screen.getByLabelText(/http_request/i) as HTMLSelectElement
      fireEvent.change(httpSelect, { target: { value: 'skip' } })
      expect(screen.getAllByTitle(/CLERUM_HTTP_ALLOWLIST/i)).toHaveLength(1)
    })

    it('Cancel exits edit mode and discards changes without confirmation', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      const httpSelect = screen.getByLabelText(/http_request/i) as HTMLSelectElement
      fireEvent.change(httpSelect, { target: { value: 'skip' } })

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      // Back to read-only empty state
      expect(screen.getByText(/no per-tool overrides configured/i)).toBeInTheDocument()
    })

    it('Save calls onSave with the correct map (default rows omitted)', async () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      fireEvent.change(screen.getByLabelText(/http_request/i), {
        target: { value: 'skip' },
      })
      fireEvent.change(screen.getByLabelText(/shell_exec/i), {
        target: { value: 'required' },
      })

      // handleSave is async (await onSave; setEditing(false)), so wrap the
      // click in act(async) so the post-await state update settles inside React's act window.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save/i }))
      })

      expect(onSave).toHaveBeenCalledWith({
        http_request: false,
        shell_exec: true,
      })
    })

    it('keeps the operator in edit mode when onSave throws (draft preserved)', async () => {
      const failingSave: typeof onSave = vi
        .fn()
        .mockRejectedValue(new Error('422 Unprocessable Entity')) as typeof onSave
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={failingSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      fireEvent.change(screen.getByLabelText(/http_request/i), {
        target: { value: 'skip' },
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save/i }))
      })

      // onSave was called, but because it threw, the section stays in edit
      // mode so the operator can correct and retry. The dropdown still shows
      // their selection.
      expect(failingSave).toHaveBeenCalled()
      const httpSelect = screen.getByLabelText(/http_request/i) as HTMLSelectElement
      expect(httpSelect.value).toBe('skip')
      // Sticky Save / Cancel toolbar remains present (still in edit mode).
      expect(screen.getByRole('button', { name: /^save/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })
  })

  describe('advanced disclosure — custom tools', () => {
    it('the disclosure starts collapsed in edit mode', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      expect(screen.queryByLabelText(/^tool name$/i)).not.toBeInTheDocument()
      expect(screen.getByText(/advanced.*conditional tools/i)).toBeInTheDocument()
    })

    it('expanding the disclosure reveals the custom-tool input', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      fireEvent.click(screen.getByText(/advanced.*conditional tools/i))
      expect(screen.getByLabelText(/^tool name$/i)).toBeInTheDocument()
    })

    it('rejects invalid custom tool names with an inline error', () => {
      render(
        <HostApprovalSection
          initialTools={undefined}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      fireEvent.click(screen.getByText(/advanced.*conditional tools/i))

      const input = screen.getByLabelText(/^tool name$/i) as HTMLInputElement
      const addBtn = screen.getByRole('button', { name: /^add$/i })

      // Uppercase rejected
      fireEvent.change(input, { target: { value: 'BadName' } })
      expect(screen.getByText(/lower snake_case/i)).toBeInTheDocument()
      expect(addBtn).toBeDisabled()

      // Collision with known tool rejected
      fireEvent.change(input, { target: { value: 'http_request' } })
      expect(screen.getByText(/collide/i)).toBeInTheDocument()
      expect(addBtn).toBeDisabled()

      // Valid name accepted
      fireEvent.change(input, { target: { value: 'memory_search' } })
      expect(addBtn).not.toBeDisabled()
    })

    it('rejects a custom name that collides with an existing custom row', () => {
      // initialTools contains a custom row "memory_search" already.
      render(
        <HostApprovalSection
          initialTools={{ memory_search: false }}
          onSave={onSave}
          busy={false}
          canWrite={true}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      fireEvent.click(screen.getByText(/advanced.*conditional tools/i))

      const input = screen.getByLabelText(/^tool name$/i) as HTMLInputElement
      const addBtn = screen.getByRole('button', { name: /^add$/i })

      // Re-typing the same name as the existing custom row → rejected
      fireEvent.change(input, { target: { value: 'memory_search' } })
      expect(screen.getByText(/already in your custom rows/i)).toBeInTheDocument()
      expect(addBtn).toBeDisabled()
    })
  })
})
