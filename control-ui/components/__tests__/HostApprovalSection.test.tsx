/**
 * The per-tool approval section (spec §6.4, §6.11, §6.12): its read and edit
 * views, the `{ stored, base, draft, editing }` hook with its edit-session
 * token, single-flight while saving, and a visible state for every outcome of
 * the versioned save.
 *
 * Section tests render the section alone over the fake control-api, with only
 * `fetch` replaced (spec A6). T32 needs a page instance kept across agents, so
 * it runs on the page harness, whose kept instance keeps the section mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type HostResource, formatApiError } from '../../lib/api'
import { CRON_MANAGE_CONDITIONS } from '../../lib/approvalToolCatalog'
import {
  APPROVAL_CREATED_ELSEWHERE_MESSAGE,
  TOOLS_CHANGED_MESSAGE,
  notStoredMessage,
} from '../../lib/hostApprovalSave'
import {
  openApprovalSettings,
  pageMountDefaults,
  perToolSection,
  renderHostPage,
  resetApprovalTestState,
} from '../../test/fixtures/approvalPageHarness'
import {
  FOO_PATH,
  clickEdit,
  clickSave,
  createSectionFake,
  propsFromStore,
  reads,
  renderSection,
  resetSectionTestState,
  rowSelect,
  section,
  sectionButton,
  sectionMessage,
  seedHost,
  setRow,
  settle,
  shownOverrides,
  shownRows,
  writes,
} from '../../test/fixtures/approvalSection'
import { createFakeControlApi } from '../../test/fixtures/fakeControlApi'
import { HostApprovalSection } from '../HostApprovalSection'
import {
  CLUSTER_DEFAULT_TEXT,
  NATIVE_TOOLS,
  NO_OVERRIDES_TEXT,
  TOOL_PARITY_EXCLUSIONS,
} from '../HostApprovalSection/constants'
import { useApprovalToolsSection } from '../HostApprovalSection/hooks'

const controlUiCss = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

type WireAnswer = { status: number; body: unknown }

function readWire(path: string): WireAnswer {
  return JSON.parse(readFileSync(resolve(__dirname, path), 'utf8')) as WireAnswer
}

// control-api's answers, recorded by control-api/test/routes.hostPut.fakeContract.test.ts.
const HOST_PUT_403 = readWire('../../../control-api/test/fixtures/wire/host-put-403.wire.json')
const CONTROL_API_500 = readWire(
  '../../../control-api/test/fixtures/wire/host-detail-500.wire.json'
)

// Spec §6.4 steps 8 and 13, verbatim.
const GAVE_UP = 'The agent kept changing while saving. Try again.'
const MAYBE = 'The save may not have applied. Reload to check.'

function host(name: string, approval?: Record<string, unknown>): HostResource {
  return seedHost(name, approval === undefined ? {} : { approval }) as HostResource
}

function rowNode(name: string): HTMLElement {
  const node = section().querySelector<HTMLElement>(`[data-tool-row="${name}"]`)
  if (!node) throw new Error(`No row for ${name}`)
  return node
}

describe('HostApprovalSection — constants', () => {
  it('lists every tool chat registers except the bridge, and not the retired workflow names', () => {
    const names = NATIVE_TOOLS.map(t => t.name)
    const wire = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../mcp-host/test/fixtures/wire/mcp-host-tool-approval.json'),
        'utf8'
      )
    ) as { tools: Record<string, unknown> }
    const excluded = new Set(TOOL_PARITY_EXCLUSIONS.map(entry => entry.name))
    const expected = Object.keys(wire.tools)
      .filter(name => !excluded.has(name))
      .sort()
    expect(names).toEqual(expected)
    expect(names).toContain('shell_exec')
    expect(names).toContain('cron_manage')
    expect(names).toContain('workflow_trigger')
    expect(names).not.toContain('clerum__tool_call')
    expect(names).not.toContain('clerum__list_workflows')
    expect(names).not.toContain('clerum__trigger_workflow')
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

  it('attaches a riskHint only to tools whose codeDefault is "required"', () => {
    // A hint explains a Skip override of a tool that asks by default. Whether
    // an override loosens is decided by lib/approvalLoosening, not by the hint:
    // browser_open, cron_manage and the other Required-default tools without
    // one are still marked and still confirmed in the dialog.
    const expectedRisky = ['http_request', 'shell_exec']
    for (const name of expectedRisky) {
      const tool = NATIVE_TOOLS.find(t => t.name === name)
      expect(tool, `${name} must be in NATIVE_TOOLS`).toBeDefined()
      expect(tool!.codeDefault, `${name} must have codeDefault 'required'`).toBe('required')
      expect(tool!.riskHint, `${name} needs a riskHint`).toBeTruthy()
    }

    const skipDefaultTools = NATIVE_TOOLS.filter(t => t.codeDefault === 'skip')
    for (const tool of skipDefaultTools) {
      expect(
        tool.riskHint,
        `${tool.name} should not have a riskHint (codeDefault is 'skip')`
      ).toBeUndefined()
    }
  })
})

describe('HostApprovalSection — useApprovalToolsSection', () => {
  function renderSectionHook(stored: HostResource | null, inherited: boolean) {
    return renderHook(
      (props: { stored: HostResource | null; inherited: boolean }) =>
        useApprovalToolsSection(props.stored, props.inherited),
      { initialProps: { stored, inherited } }
    )
  }

  it('starts in the read view with the stored tools as base and draft', () => {
    const stored = host('foo', { tools: { http_request: false, shell_exec: true } })
    const { result } = renderSectionHook(stored, false)

    expect(result.current.state).toEqual({
      stored: { host: stored, inherited: false },
      base: { tools: { http_request: false, shell_exec: true }, inherited: false },
      draft: { http_request: false, shell_exec: true },
      editing: false,
      editSession: 0,
    })
    expect(result.current.isDirty).toBe(false)
  })

  it('an inheriting Host has no base tools, and its base marks the save as a first save', () => {
    const stored = host('foo')
    const { result } = renderSectionHook(stored, true)

    expect(result.current.state.base).toEqual({ tools: undefined, inherited: true })
    expect(result.current.state.draft).toEqual({})
    expect(result.current.isDirty).toBe(false)
  })

  it('each Edit starts a new edit session', () => {
    const { result } = renderSectionHook(host('foo', { tools: {} }), false)
    act(() => result.current.edit())
    expect(result.current.state).toMatchObject({ editing: true, editSession: 1 })
    act(() => result.current.cancel())
    expect(result.current.state).toMatchObject({ editing: false, editSession: 1 })
    act(() => result.current.edit())
    expect(result.current.state).toMatchObject({ editing: true, editSession: 2 })
  })

  it('setRow, addCustom and removeCustom edit the draft, and isDirty compares it with the base on effective values', () => {
    const { result } = renderSectionHook(
      host('foo', { tools: { http_request: false, custom_lookup: true } }),
      false
    )
    act(() => result.current.edit())

    act(() => result.current.setRow('http_request', 'required'))
    expect(result.current.state.draft).toEqual({ http_request: true, custom_lookup: true })
    expect(result.current.isDirty).toBe(true)
    // A→B→A is unchanged.
    act(() => result.current.setRow('http_request', 'skip'))
    expect(result.current.isDirty).toBe(false)

    act(() => result.current.addCustom('added_tool', 'skip'))
    expect(result.current.state.draft).toEqual({
      http_request: false,
      custom_lookup: true,
      added_tool: false,
    })
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.removeCustom('added_tool'))
    expect(result.current.isDirty).toBe(false)

    act(() => result.current.removeCustom('custom_lookup'))
    act(() => result.current.setRow('http_request', 'default'))
    expect(result.current.state.draft).toEqual({})
    expect(result.current.isDirty).toBe(true)
    // The base the save compares against is still the stored tools.
    expect(result.current.state.base.tools).toEqual({ http_request: false, custom_lookup: true })
  })

  it('cancel discards the draft and leaves the edit view', () => {
    const { result } = renderSectionHook(host('foo', { tools: { http_request: false } }), false)
    act(() => result.current.edit())
    act(() => result.current.setRow('http_request', 'required'))
    act(() => result.current.cancel())

    expect(result.current.state).toMatchObject({
      editing: false,
      draft: { http_request: false },
    })
    expect(result.current.isDirty).toBe(false)
  })

  it('close ends only the edit session it names', () => {
    const { result } = renderSectionHook(host('foo', { tools: {} }), false)
    act(() => result.current.edit())
    act(() => result.current.setRow('system_info', 'required'))

    act(() => result.current.close(0))
    expect(result.current.state, 'an older session').toMatchObject({ editing: true })
    expect(result.current.state.draft).toEqual({ system_info: true })

    act(() => result.current.close(1))
    expect(result.current.state).toMatchObject({ editing: false, draft: {} })
  })

  it('another Host, or no data, leaves the edit view with that data', () => {
    const { result, rerender } = renderSectionHook(host('foo', { tools: {} }), false)
    act(() => result.current.edit())
    act(() => result.current.setRow('system_info', 'required'))

    const other = host('b', { tools: { file_write: true } })
    rerender({ stored: other, inherited: false })
    expect(result.current.state).toMatchObject({
      stored: { host: other, inherited: false },
      base: { tools: { file_write: true }, inherited: false },
      draft: { file_write: true },
      editing: false,
    })

    act(() => result.current.edit())
    rerender({ stored: null, inherited: false })
    expect(result.current.state).toMatchObject({
      stored: { host: null },
      draft: {},
      editing: false,
    })
  })
})

describe('HostApprovalSection — read view', () => {
  beforeEach(() => resetSectionTestState())
  afterEach(() => {
    cleanup()
    resetSectionTestState()
    vi.unstubAllGlobals()
  })

  it('keeps approval rows in a horizontal shared layout', () => {
    const rowRule = controlUiCss.match(/(?:^|\n)\.cu-access-row\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(rowRule).toMatch(/display:\s*flex/)
    expect(rowRule).toMatch(/align-items:\s*center/)
    expect(rowRule).toMatch(/justify-content:\s*space-between/)
  })

  it('lists only the overrides, with Edit', () => {
    renderSection(createSectionFake({ tools: { http_request: false, file_write: false } }))

    expect(shownRows()).toEqual({ file_write: 'Skip', http_request: 'Skip' })
    expect(within(section()).queryByRole('combobox')).toBeNull()
    expect(sectionButton('Edit')).toBeEnabled()
  })

  it('shows the empty state when there are no overrides', () => {
    renderSection(createSectionFake({ modeCeiling: 'auto' }))

    expect(within(section()).getByText(NO_OVERRIDES_TEXT)).toBeInTheDocument()
    expect(shownRows()).toEqual({})
    expect(within(section()).queryByText(CLUSTER_DEFAULT_TEXT)).toBeNull()
  })

  it('shows the cluster default on an inheriting Host', () => {
    renderSection(createSectionFake(undefined))

    expect(within(section()).getByText(CLUSTER_DEFAULT_TEXT)).toBeInTheDocument()
    expect(within(section()).queryByText(NO_OVERRIDES_TEXT)).toBeNull()
    expect(sectionButton('Edit')).toBeEnabled()
  })

  it('explicit Required on shell_exec reads "Required (explicit): Auto asks on every shell command"', () => {
    renderSection(
      createSectionFake({ tools: { file_write: true, http_request: true, shell_exec: true } })
    )

    expect(rowNode('shell_exec')).toHaveTextContent(
      'Required (explicit): Auto asks on every shell command'
    )
    expect(rowNode('http_request')).toHaveTextContent(
      'Required (explicit): Auto asks on every HTTP request'
    )
    // Elsewhere an explicit Required asks the same as the default does.
    expect(rowNode('file_write')).toHaveTextContent(/Required$/)
    expect(rowNode('file_write')).not.toHaveTextContent('explicit')
    expect(shownRows()).toEqual({
      file_write: 'Required',
      http_request: 'Required',
      shell_exec: 'Required',
    })
  })

  it('marks an override that lets calls run without a card where the tool asks by default', () => {
    renderSection(
      createSectionFake({
        tools: {
          browser_open: false,
          custom_lookup: false,
          file_write: false,
          http_request: false,
          shell_exec: true,
        },
      })
    )
    const mark = (name: string) =>
      within(rowNode(name)).queryByRole('img', { name: /./ })?.getAttribute('aria-label') ?? null

    expect(mark('http_request')).toMatch(/CLERUM_HTTP_ALLOWLIST/)
    // No riskHint: the loosening function still marks it.
    expect(mark('browser_open')).toBe('Set to Skip: calls can run without an approval card.')
    expect(mark('custom_lookup')).toMatch(/its default is not known here/)
    expect(mark('file_write'), 'a tool that never asks by default').toBeNull()
    expect(mark('shell_exec'), 'Required never loosens').toBeNull()
  })
})

describe('HostApprovalSection — edit view', () => {
  beforeEach(() => resetSectionTestState())
  afterEach(() => {
    cleanup()
    resetSectionTestState()
    vi.unstubAllGlobals()
  })

  it('Edit shows every native row with its default, and the desktop-only and conditional notes', () => {
    renderSection(createSectionFake({ tools: {} }))
    clickEdit()

    for (const tool of NATIVE_TOOLS) expect(rowSelect(tool.name).value).toBe('default')
    const defaultOption = (name: string) =>
      Array.from(rowSelect(name).options).find(option => option.value === 'default')?.textContent
    expect(defaultOption('http_request')).toBe('Default (Required)')
    expect(defaultOption('file_write')).toBe('Default (Skip)')
    expect(defaultOption('cron_manage')).toBe('Default (varies)')
    expect(defaultOption('workflow_trigger')).toBe('Default (varies)')
    expect(within(rowNode('cron_manage')).getByText(CRON_MANAGE_CONDITIONS)).toBeInTheDocument()
    expect(within(rowNode('browser_open')).getByText('Desktop only')).toBeInTheDocument()
    expect(within(rowNode('http_request')).queryByText('Desktop only')).toBeNull()
  })

  it('shows Unsaved changes only while the draft differs from the base', () => {
    renderSection(createSectionFake({ tools: { json_transform: true } }))
    clickEdit()
    expect(within(section()).queryByText('Unsaved changes')).toBeNull()
    expect(sectionButton('Save')).toBeDisabled()

    setRow('system_info', 'required')
    expect(within(section()).getByText('Unsaved changes')).toBeInTheDocument()
    expect(sectionButton('Save')).toBeEnabled()

    setRow('system_info', 'default')
    expect(within(section()).queryByText('Unsaved changes')).toBeNull()
    expect(sectionButton('Save')).toBeDisabled()
  })

  it('Cancel discards the draft and returns to the read view', () => {
    renderSection(createSectionFake({ tools: { json_transform: true } }))
    clickEdit()
    setRow('http_request', 'skip')
    fireEvent.click(sectionButton('Cancel'))

    expect(within(section()).queryByRole('combobox')).toBeNull()
    expect(shownRows()).toEqual({ json_transform: 'Required' })
  })

  it('rejects invalid custom names with an inline error', () => {
    renderSection(createSectionFake({ tools: { custom_lookup: false } }))
    clickEdit()
    fireEvent.click(sectionButton('Add a tool by name'))
    const input = within(section()).getByLabelText('Tool name')
    const add = sectionButton('Add')

    fireEvent.change(input, { target: { value: 'BadName' } })
    expect(within(section()).getByText(/lower snake_case/i)).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(input, { target: { value: 'http_request' } })
    expect(within(section()).getByText(/already in the tool list above/i)).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(input, { target: { value: 'custom_lookup' } })
    expect(within(section()).getByText(/already in your custom rows/i)).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(input, { target: { value: 'custom_memory_lookup' } })
    expect(add).toBeEnabled()
    fireEvent.click(add)
    expect(shownOverrides()).toEqual({ custom_lookup: 'Skip', custom_memory_lookup: 'Required' })
  })

  it('Review Focus 3: renders and removes a stored off-pattern tool key', async () => {
    // Keys the editor would refuse, written with kubectl.
    const fake = createSectionFake({
      tools: { Bash: false, 'my-server__tool': true, json_transform: true },
    })
    const { onSettled } = renderSection(fake)
    expect(shownRows()).toEqual({
      Bash: 'Skip',
      json_transform: 'Required',
      'my-server__tool': 'Required',
    })

    clickEdit()
    expect(shownOverrides()).toEqual({
      Bash: 'Skip',
      json_transform: 'Required',
      'my-server__tool': 'Required',
    })
    fireEvent.click(sectionButton('Remove Bash'))
    expect(within(section()).queryByRole('button', { name: 'Remove Bash' })).toBeNull()
    expect(sectionButton('Remove my-server__tool')).toBeInTheDocument()
    // Removing a Skip row loosens nothing: no dialog.
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(fake.stored('foo').spec.approval).toEqual({
      tools: { 'my-server__tool': true, json_transform: true },
    })
  })

  it('a clean section takes new stored data; a dirty one keeps its draft', () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { rerenderSection } = renderSection(fake)
    const write = (tools: Record<string, boolean>) => {
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = tools
      })
      rerenderSection(propsFromStore(fake))
    }

    write({ json_transform: true, file_write: true })
    expect(shownRows(), 'the read view').toEqual({
      file_write: 'Required',
      json_transform: 'Required',
    })

    clickEdit()
    write({ json_transform: false, file_write: true })
    expect(rowSelect('json_transform').value, 'a clean edit view').toBe('skip')
    expect(within(section()).queryByText('Unsaved changes')).toBeNull()

    setRow('system_info', 'required')
    write({ memory_write: true })
    expect(shownOverrides(), 'the dirty draft').toEqual({
      file_write: 'Required',
      json_transform: 'Skip',
      system_info: 'Required',
    })
    expect(within(section()).getByText('Unsaved changes')).toBeInTheDocument()

    // The stored data moved on underneath; Cancel shows it.
    fireEvent.click(sectionButton('Cancel'))
    expect(shownRows()).toEqual({ memory_write: 'Required' })
  })
})

describe('HostApprovalSection — saving', () => {
  beforeEach(() => resetSectionTestState())
  afterEach(() => {
    cleanup()
    resetSectionTestState()
    vi.unstubAllGlobals()
  })

  it('T6 Save, Cancel and edits are disabled while saving; a raced second click sends one PUT', async () => {
    const fake = createSectionFake({ tools: { json_transform: true, custom_lookup: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const save = sectionButton('Save')
    expect(save).toBeEnabled()
    expect(sectionButton('Cancel')).toBeEnabled()
    expect(rowSelect('http_request')).toBeEnabled()

    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    // Both activations in one tick, before React renders Save as disabled.
    await act(async () => {
      save.click()
      save.click()
    })
    await act(async () => {
      await put.arrived
    })

    expect(sectionButton('Save'), 'Save while saving').toBeDisabled()
    expect(sectionButton('Cancel'), 'Cancel while saving').toBeDisabled()
    expect(rowSelect('http_request'), 'a row while saving').toBeDisabled()
    expect(rowSelect('system_info'), 'the edited row while saving').toBeDisabled()
    expect(sectionButton('Remove custom_lookup'), 'a custom row while saving').toBeDisabled()
    expect(sectionButton('Add a tool by name'), 'adding a row while saving').toBeDisabled()

    await act(async () => {
      put.deliverNow()
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    await settle()

    expect(
      writes(fake).map(entry => entry.applied),
      'PUTs'
    ).toEqual([true])
    expect(reads(fake), "the save's own read, once").toHaveLength(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
  })

  it('a saved outcome closes the edit view of the session that started it, with no message', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({
      kind: 'saved',
      stored: fake.stored('foo'),
      via: 'response',
    })
    expect(within(section()).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(sectionButton('Edit')).toBeEnabled()
    expect(sectionMessage()).toBeNull()
  })

  it('Save stays disabled while the newest load is pending; Cancel and edits do not wait for it', () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { rerenderSection } = renderSection(fake, { loadPending: true })
    clickEdit()
    setRow('system_info', 'required')

    expect(sectionButton('Save'), 'Save while a load is pending').toBeDisabled()
    expect(sectionButton('Cancel')).toBeEnabled()
    expect(rowSelect('http_request')).toBeEnabled()

    rerenderSection({ loadPending: false })
    expect(sectionButton('Save'), 'Save once the load has settled').toBeEnabled()
  })

  it('a conflict keeps the draft and shows the message, with focus on it', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    fake.writeExternal('foo', spec => {
      ;(spec.approval as Record<string, unknown>).tools = {
        json_transform: true,
        shell_exec: false,
      }
    })
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'conflict' })
    expect(sectionMessage()?.textContent).toBe(TOOLS_CHANGED_MESSAGE)
    expect(document.activeElement, 'focus moves to the message').toBe(sectionMessage())
    expect(writes(fake)).toEqual([])
    expect(rowSelect('system_info').value, 'the draft').toBe('required')
    expect(sectionButton('Save')).toBeEnabled()
  })

  it('a block created or removed elsewhere stops the save with its message and keeps the draft', async () => {
    const fake = createSectionFake({})
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    fake.writeExternal('foo', spec => {
      delete spec.approval
    })
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'created_elsewhere' })
    expect(sectionMessage()?.textContent).toBe(APPROVAL_CREATED_ELSEWHERE_MESSAGE)
    expect(writes(fake)).toEqual([])
    expect(rowSelect('system_info').value, 'the draft').toBe('required')
  })

  it("a refused save shows each field's message and keeps the draft", async () => {
    // A model with no provider: the general Host PUT validates the whole spec.
    const fake = createSectionFake(
      { tools: { json_transform: true } },
      { spec: { model: { name: 'claude-sonnet-4-6' } } }
    )
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    const { errors } = writes(fake)[0].response?.body as {
      errors: Array<{ field: string; message: string }>
    }
    expect(errors.length).toBeGreaterThan(0)
    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'refused', errors })
    for (const { field, message } of errors) {
      expect(sectionMessage()).toHaveTextContent(`${field}: ${message}`)
    }
    expect(rowSelect('system_info').value, 'the draft').toBe('required')
  })

  it('an error keeps the draft and shows the message with Retry, which saves again', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    await clickSave()
    await act(async () => {
      await put.arrived
    })
    await act(async () => {
      put.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    const text = JSON.stringify(HOST_PUT_403.body)
    const formatted = formatApiError(
      new Response(text, { status: 403, statusText: 'Forbidden' }),
      text
    ).message
    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'error', message: formatted })
    expect(sectionMessage()).toHaveTextContent(formatted)
    expect(rowSelect('system_info').value, 'the draft').toBe('required')

    await act(async () => {
      fireEvent.click(within(sectionMessage()!).getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2))
    expect(onSettled.mock.calls[1][0]).toMatchObject({ kind: 'saved' })
    expect(writes(fake).map(entry => entry.response?.status)).toEqual([403, 200])
    expect(sectionMessage()).toBeNull()
  })

  it('Retry saves the draft as it is now, as Save does, and waits for the Save release', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled, rerenderSection } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    await clickSave()
    await act(async () => {
      await put.arrived
    })
    await act(async () => {
      put.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    const retry = () =>
      within(sectionMessage()!).getByRole('button', { name: 'Retry' }) as HTMLButtonElement

    // The rows are usable again after the error; the admin changes another one.
    setRow('memory_write', 'required')
    rerenderSection({ loadPending: true })
    expect(retry(), 'Retry while the newest load is pending').toBeDisabled()
    expect(sectionButton('Save'), 'Save while the newest load is pending').toBeDisabled()
    rerenderSection({ loadPending: false })
    expect(retry(), 'Retry once the load has settled').toBeEnabled()

    await act(async () => {
      fireEvent.click(retry())
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2))
    expect(onSettled.mock.calls[1][0]).toMatchObject({ kind: 'saved' })
    expect(fake.stored('foo').spec.approval, 'both rows, not the draft of the first Save').toEqual({
      tools: { json_transform: true, memory_write: true, system_info: true },
    })
  })

  it('a save that may not have applied closes its edit session and keeps the message', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    const reread = fake.hold({ method: 'GET', path: FOO_PATH, nth: 2 })
    await clickSave()
    await act(async () => {
      await put.arrived
    })
    await act(async () => {
      put.dropResponse()
    })
    await act(async () => {
      await reread.arrived
    })
    await act(async () => {
      reread.respondWith(CONTROL_API_500.status, CONTROL_API_500.body)
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'maybe', message: MAYBE })
    expect(sectionMessage()?.textContent).toBe(MAYBE)
    // No retry from the old base: the next Edit starts from what the tab loads.
    expect(within(section()).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(sectionButton('Edit')).toBeEnabled()
  })

  it('a field the cluster did not store is named with what is stored now, in the edit view', async () => {
    const fake = createSectionFake(
      { modeCeiling: 'auto', tools: { json_transform: true } },
      { crd: 'v0.12.1' }
    )
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({
      kind: 'not_stored',
      fields: ['modeCeiling'],
      live: { modeCeiling: 'manual' },
    })
    expect(sectionMessage()).toHaveTextContent(notStoredMessage(['modeCeiling']))
    expect(sectionMessage()).toHaveTextContent('Stored now: modeCeiling: manual')
    expect(rowSelect('system_info').value, 'still in the edit view').toBe('required')
  })

  it('a save that kept meeting changes gives up with its message and keeps the draft', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const puts = [1, 2, 3].map(nth => fake.hold({ method: 'PUT', path: FOO_PATH, nth }))
    await clickSave()
    for (const put of puts) {
      await act(async () => {
        await put.arrived
      })
      fake.bumpVersion('foo', 'status')
      await act(async () => {
        put.deliverNow()
      })
    }
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0]).toEqual({ kind: 'gave_up', message: GAVE_UP })
    expect(sectionMessage()?.textContent).toBe(GAVE_UP)
    expect(writes(fake).map(entry => entry.response?.status)).toEqual([409, 409, 409])
    expect(rowSelect('system_info').value, 'the draft').toBe('required')
  })
})

describe('HostApprovalSection — another agent', () => {
  beforeEach(() => resetSectionTestState())
  afterEach(() => {
    cleanup()
    resetSectionTestState()
    vi.unstubAllGlobals()
  })

  const others = () => ({ b: seedHost('b', { approval: { tools: { file_write: true } } }) })

  it('a message belongs to the agent it was raised for', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } }, { others: others() })
    const { onSettled, rerenderSection } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    fake.writeExternal('foo', spec => {
      ;(spec.approval as Record<string, unknown>).tools = { shell_exec: false }
    })
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(sectionMessage()?.textContent, "foo's message").toBe(TOOLS_CHANGED_MESSAGE)

    rerenderSection(propsFromStore(fake, 'b'))
    expect(sectionMessage(), "on b's page").toBeNull()
    expect(shownRows(), "b's read view").toEqual({ file_write: 'Required' })
  })

  it('a save that settles after the section moved to another agent is reported and shown nowhere', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } }, { others: others() })
    const { onSettled, rerenderSection } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    await clickSave()
    await act(async () => {
      await put.arrived
    })
    rerenderSection(propsFromStore(fake, 'b'))
    await act(async () => {
      put.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(onSettled.mock.calls[0][0], 'reported to the tab').toMatchObject({ kind: 'error' })
    expect(sectionMessage(), "on b's page").toBeNull()
    expect(shownRows(), "b's read view").toEqual({ file_write: 'Required' })
    expect(sectionButton('Edit')).toBeEnabled()
  })
})

describe('HostApprovalSection — edit session on a kept page (harness)', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => {
    resetApprovalTestState()
    vi.unstubAllGlobals()
  })

  it('T32 a save that settles after a new edit session started does not close it', async () => {
    const fake = createFakeControlApi({
      hosts: {
        foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
        b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }),
      },
      crd: 'current',
      versionRule: false,
      defaults: pageMountDefaults(),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    const sectionAtStart = perToolSection()
    await driver.edit()
    await driver.editTool('system_info', 'required')
    const put = fake.hold({ method: 'PUT', path: FOO_PATH })
    await driver.save()
    await act(async () => {
      await put.arrived
    })

    // To another agent and back, in the kept instance, while foo's PUT is out.
    page.rerenderKept({ name: 'b' })
    await waitFor(() => expect(driver.readView()).toEqual({ clerum__generate_pdf: 'Required' }))
    page.rerenderKept({ name: 'foo' })
    await waitFor(() => expect(driver.readView()).toEqual({ json_transform: 'Required' }))
    // A new edit session, started while the save is still out.
    await driver.edit()
    expect(within(perToolSection()!).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

    await act(async () => {
      put.deliverNow()
    })
    await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))
    await settle()

    expect(perToolSection(), 'the same section instance throughout').toBe(sectionAtStart)
    expect(writes(fake)[0].applied, 'the save landed').toBe(true)
    expect(fake.stored('foo').spec.approval).toEqual({
      tools: { json_transform: true, system_info: true },
    })
    expect(
      within(perToolSection()!).getByRole('button', { name: 'Cancel' }),
      'the newer edit session is still open'
    ).toBeEnabled()
    expect(within(perToolSection()!).queryByRole('button', { name: 'Edit' })).toBeNull()
    page.unmount()
  })
})

describe('HostApprovalSection — no data', () => {
  afterEach(() => cleanup())

  it('shows a loading state and no Edit while it has no Host to show', () => {
    render(
      <HostApprovalSection
        host="foo"
        stored={null}
        inherited={false}
        ceiling="manual"
        onSettled={vi.fn()}
      />
    )

    expect(screen.getByRole('status', { name: 'Loading approval tools' })).toBeInTheDocument()
    expect(within(section()).queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
