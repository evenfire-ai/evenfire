/**
 * The per-tool section's dialogs (spec §6.6, §7 A6 "Dialog gating"): the
 * loosening dialog, which stands between Save and the write, and the policy
 * dialog of the first save on an inheriting Host.
 *
 * The section runs over the real save protocol with only `fetch` replaced by
 * the fake control-api, so "nothing was sent" is read from the fake's log. The
 * item texts are asserted as literal copy: each says what the change lets run
 * without a person (spec §6.6), and a test that built them with the section's
 * own function would prove nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import {
  FOO_PATH,
  clickEdit,
  clickSave,
  createSectionFake,
  dialogByName,
  propsFromStore,
  renderSection,
  resetSectionTestState,
  rowSelect,
  section,
  sectionButton,
  setRow,
  settle,
  writes,
} from '../../test/fixtures/approvalSection'
import { FIRST_SAVE_DIALOG_TITLE, LOOSENING_DIALOG_TITLE } from '../HostApprovalSection/constants'

/** The loosening dialog's items as `label → text`, in the order shown. */
function listedItems(dialog: HTMLElement): Array<[string, string]> {
  return Array.from(dialog.querySelectorAll<HTMLElement>('[data-loosening-item]')).map(item => [
    item.dataset.looseningItem ?? '',
    item.querySelector('[data-loosening-text]')?.textContent ?? '',
  ])
}

async function confirmLoosening(): Promise<void> {
  const dialog = dialogByName('alertdialog', LOOSENING_DIALOG_TITLE)
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save these changes' }))
  })
}

function policySelect(): HTMLSelectElement {
  const dialog = dialogByName('dialog', FIRST_SAVE_DIALOG_TITLE)
  return within(dialog).getByLabelText('Who can approve from a channel') as HTMLSelectElement
}

function firstSaveButton(): HTMLButtonElement {
  const dialog = dialogByName('dialog', FIRST_SAVE_DIALOG_TITLE)
  return within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement
}

describe('HostApprovalSection dialogs (spec §6.6)', () => {
  beforeEach(() => resetSectionTestState())
  afterEach(() => {
    cleanup()
    resetSectionTestState()
    vi.unstubAllGlobals()
  })

  it('T18 a loosening draft shows the dialog and sends no PUT until confirmed', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('http_request', 'skip')
    await clickSave()
    await settle()

    const dialog = dialogByName('alertdialog', LOOSENING_DIALOG_TITLE)
    expect(listedItems(dialog)).toEqual([
      ['http_request', 'Set to Skip: calls can run without an approval card.'],
    ])
    // The dialog comes before the protocol: not even the save's read was sent.
    expect(fake.log, 'requests before the admin confirms').toEqual([])
    expect(onSettled).not.toHaveBeenCalled()

    await confirmLoosening()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved', via: 'response' })
    expect(writes(fake).map(entry => entry.applied)).toEqual([true])
    expect(fake.stored('foo').spec.approval).toEqual({
      tools: { json_transform: true, http_request: false },
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a non-loosening draft writes with no dialog', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    // system_info never asks by default, so Required tightens it.
    setRow('system_info', 'required')
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(writes(fake).map(entry => entry.applied)).toEqual([true])
    expect(fake.stored('foo').spec.approval).toEqual({
      tools: { json_transform: true, system_info: true },
    })
  })

  it('a raced second Confirm in the loosening dialog sends one PUT', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('http_request', 'skip')
    await clickSave()
    const confirm = within(dialogByName('alertdialog', LOOSENING_DIALOG_TITLE)).getByRole(
      'button',
      { name: 'Save these changes' }
    ) as HTMLButtonElement
    // Both activations in one tick, before React closes the dialog.
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    await settle()

    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(
      writes(fake).map(entry => entry.applied),
      'PUTs'
    ).toEqual([true])
    expect(fake.stored('foo').spec.approval).toEqual({
      tools: { json_transform: true, http_request: false },
    })
  })

  it('going back from the loosening dialog sends nothing and keeps the draft', async () => {
    const fake = createSectionFake({ tools: { json_transform: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('shell_exec', 'skip')
    await clickSave()
    const dialog = dialogByName('alertdialog', LOOSENING_DIALOG_TITLE)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to editing' }))
    await settle()

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fake.log).toEqual([])
    expect(onSettled).not.toHaveBeenCalled()
    expect(rowSelect('shell_exec').value, 'the draft').toBe('skip')
    expect(sectionButton('Save')).toBeEnabled()
  })

  it('T21 a ceiling raised between the dialog and the write shows the dialog again with the new list', async () => {
    // shell_exec set to Required by an admin. Back to Default loosens only
    // above Manual, and the section's ceiling is Manual, so Save shows no
    // dialog. Another writer then raises the ceiling before the write.
    const fake = createSectionFake({ modeCeiling: 'manual', tools: { shell_exec: true } })
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('shell_exec', 'default')
    fake.writeExternal('foo', spec => {
      ;(spec.approval as Record<string, unknown>).modeCeiling = 'auto'
    })
    await clickSave()
    const dialog = await screen.findByRole('alertdialog', { name: LOOSENING_DIALOG_TITLE })

    expect(listedItems(dialog)).toEqual([
      [
        'shell_exec',
        'Back to Default: in Auto, shell commands can run after a model check instead of asking every time.',
      ],
    ])
    // The write's own read found the new item: one read, no PUT.
    expect(fake.log.map(entry => [entry.method, entry.path])).toEqual([['GET', FOO_PATH]])
    expect(onSettled, 'nothing settled while the dialog asks again').not.toHaveBeenCalled()

    await confirmLoosening()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(writes(fake).map(entry => entry.applied)).toEqual([true])
    expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'auto', tools: {} })
  })

  it('lists every loosening item with the text of its rule', async () => {
    const fake = createSectionFake({
      modeCeiling: 'auto',
      tools: { cron_manage: true, custom_lookup: true, file_write: true, shell_exec: true },
    })
    renderSection(fake)
    clickEdit()
    setRow('http_request', 'skip')
    setRow('file_write', 'default')
    setRow('shell_exec', 'default')
    setRow('cron_manage', 'default')
    fireEvent.click(within(section()).getByRole('button', { name: 'Remove custom_lookup' }))
    fireEvent.click(within(section()).getByRole('button', { name: 'Add a tool by name' }))
    fireEvent.change(within(section()).getByLabelText('Tool name'), {
      target: { value: 'added_tool' },
    })
    fireEvent.change(within(section()).getByLabelText('Approval state for the new custom tool'), {
      target: { value: 'skip' },
    })
    fireEvent.click(within(section()).getByRole('button', { name: 'Add' }))
    await clickSave()

    const unknownDefault =
      'This tool has no row in the list, so its default is not known here: calls may run without an approval card.'
    expect(listedItems(dialogByName('alertdialog', LOOSENING_DIALOG_TITLE))).toEqual([
      ['added_tool', `Set to Skip. ${unknownDefault}`],
      [
        'cron_manage',
        'Back to Default, which does not always ask. By default it runs without a card on a stateless Host that has not allowed cron management, and in tasks fired by a schedule. It asks otherwise.',
      ],
      ['custom_lookup', `Required removed. ${unknownDefault}`],
      ['file_write', 'Back to Default, which never asks: calls can run without an approval card.'],
      ['http_request', 'Set to Skip: calls can run without an approval card.'],
      [
        'shell_exec',
        'Back to Default: in Auto, shell commands can run after a model check instead of asking every time.',
      ],
    ])
    expect(fake.log).toEqual([])
  })

  it('first save offers two policies and keeps Save disabled until one is chosen', async () => {
    const fake = createSectionFake(undefined)
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()

    const dialog = dialogByName('dialog', FIRST_SAVE_DIALOG_TITLE)
    expect(
      within(dialog).getByText(
        'The cluster rules stop applying for this agent and may have been stricter than the values shown.'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Channel approval cards may change their wording (with no approval settings anywhere, cards tell people to approve through the CLI).'
      )
    ).toBeInTheDocument()
    const options = Array.from(policySelect().options)
      .filter(option => option.value !== '')
      .map(option => [option.value, option.textContent])
    expect(options).toEqual([
      ['channel_users', 'Any channel user'],
      ['cli_only', 'Nobody (Desktop only)'],
    ])
    expect(policySelect().value, 'no policy is chosen for the admin').toBe('')
    expect(firstSaveButton(), 'Save before a policy is chosen').toBeDisabled()
    fireEvent.click(firstSaveButton())
    await settle()
    expect(fake.log, 'requests before a policy is chosen').toEqual([])

    fireEvent.change(policySelect(), { target: { value: 'cli_only' } })
    expect(firstSaveButton(), 'Save once a policy is chosen').toBeEnabled()
    await act(async () => {
      fireEvent.click(firstSaveButton())
    })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    // "Nobody (Desktop only)" loosens nothing, so no loosening dialog stood in between.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(fake.stored('foo').spec.approval).toEqual({
      defaultPolicy: 'cli_only',
      tools: { system_info: true },
    })
  })

  it('an open policy on a first save is a loosening item confirmed before the write', async () => {
    const fake = createSectionFake(undefined)
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()
    fireEvent.change(policySelect(), { target: { value: 'channel_users' } })
    await act(async () => {
      fireEvent.click(firstSaveButton())
    })

    expect(screen.queryByRole('dialog', { name: FIRST_SAVE_DIALOG_TITLE })).toBeNull()
    expect(listedItems(dialogByName('alertdialog', LOOSENING_DIALOG_TITLE))).toEqual([
      [
        'Policy',
        'Any channel user can approve tool calls from a channel, and raise the mode where the channel allows it. The cluster default this replaces may have been stricter.',
      ],
    ])
    expect(fake.log).toEqual([])

    await confirmLoosening()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(onSettled.mock.calls[0][0]).toMatchObject({ kind: 'saved' })
    expect(fake.stored('foo').spec.approval).toEqual({
      defaultPolicy: 'channel_users',
      tools: { system_info: true },
    })
  })

  it('a Host with an empty approval block saves with no policy dialog', async () => {
    // `{}` is a block of its own: not inheriting (plan Review Focus 1).
    const fake = createSectionFake({})
    expect(propsFromStore(fake).inherited).toBe(false)
    const { onSettled } = renderSection(fake)
    clickEdit()
    setRow('system_info', 'required')
    await clickSave()
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('dialog', { name: FIRST_SAVE_DIALOG_TITLE })).toBeNull()
    expect(fake.stored('foo').spec.approval).toEqual({ tools: { system_info: true } })
  })
})
