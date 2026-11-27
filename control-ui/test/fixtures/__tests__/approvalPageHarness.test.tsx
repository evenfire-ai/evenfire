import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { notifyHostChanged, subscribeHostChanged } from '../../../lib/hostApprovalDisplay'
import {
  type ApprovalClock,
  TOOLS_CHANGED_MESSAGE,
  __setApprovalClockForTests,
  getApprovalClock,
  realApprovalClock,
} from '../../../lib/hostApprovalSave'
import {
  approvalSettingsDriver,
  errorBanners,
  openApprovalSettings,
  pageMountDefaults,
  perToolSection,
  renderApprovalsTab,
  renderHostPage,
  resetApprovalTestState,
  tabLoadBanner,
  unanswered,
} from '../approvalPageHarness'
import { materializeHostResource } from '../contextResource'
import { createFakeControlApi } from '../fakeControlApi'

const FOO_DETAIL = '/api/v1/admin/hosts/foo/detail'

// control-api's production 500 for a /detail read that fails unexpectedly,
// recorded by control-api/test/routes.hostPut.fakeContract.test.ts.
const DETAIL_500 = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../control-api/test/fixtures/wire/host-detail-500.wire.json'),
    'utf8'
  )
) as { status: number; body: unknown }

function seedFake(tools?: Record<string, boolean>) {
  return createFakeControlApi({
    hosts: {
      foo: materializeHostResource({
        metadata: { name: 'foo' },
        spec: {
          host: 'foo',
          contextRef: 'ctx-a',
          secretRef: 'foo-llm',
          channels: [],
          model: { provider: 'claude', name: 'claude-sonnet-4-6' },
          ...(tools ? { approval: { tools } } : {}),
        },
      }),
    },
    crd: 'current',
    versionRule: false,
    defaults: pageMountDefaults(),
  })
}

describe('approval page harness', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => {
    // The Approvals tab subscribes to the Host-changed notice: close its channel.
    resetApprovalTestState()
    vi.unstubAllGlobals()
  })

  it("harness renders the per-tool section from the fake's stored tools", async () => {
    const fake = seedFake({ http_request: false })
    const page = renderHostPage({ fake, name: 'foo', tab: 'advanced' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    expect(driver.readView().http_request).toBe('Skip')
    expect(fake.log.filter(entry => entry.applied)).toEqual([])
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('the driver saves an edited tool through the page and the fake', async () => {
    // An agent with no approval block: the save is a first save, which the
    // driver answers with "Nobody (Desktop only)". Skip on http_request
    // loosens, so the loosening dialog asks before anything is written.
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo', tab: 'advanced' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    await driver.editTool('http_request', 'skip')
    await driver.save()
    expect(
      fake.log.filter(entry => entry.kind === 'write'),
      'writes before confirming'
    ).toEqual([])
    await driver.confirmDialog()
    await waitFor(() => expect(fake.log.filter(entry => entry.applied)).toHaveLength(1))
    expect(fake.stored('foo').spec.approval).toEqual({
      defaultPolicy: 'cli_only',
      tools: { http_request: false },
    })
    await waitFor(() => expect(driver.readView().http_request).toBe('Skip'))
    expect(page.banner()).toBeNull()
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('navigate remounts the page', async () => {
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo' })
    await screen.findByRole('heading', { name: /foo/ })
    const marker = screen.getByRole('tab', { name: 'Advanced' })
    await page.navigate('Advanced')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Advanced' })).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Advanced' })).not.toBe(marker)
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('rerenderKept keeps the instance', async () => {
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo' })
    await screen.findByRole('heading', { name: /foo/ })
    const marker = screen.getByRole('tab', { name: 'Advanced' })
    page.rerenderKept({ name: 'foo', tab: 'advanced' })
    expect(screen.getByRole('tab', { name: 'Advanced' })).toBe(marker)
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('rerenderKept keeps the tab the page shows when params omit it', async () => {
    const fake = seedFake({ http_request: false })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    page.rerenderKept({ name: 'foo' })
    expect(perToolSection()).not.toBeNull()
    expect(driver.readView().http_request).toBe('Skip')
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('navigate keeps a toast on screen: the ToastProvider outlives the page', async () => {
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo' })
    const edit = await screen.findByRole('button', { name: 'Edit agent name' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Renamed agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    await waitFor(() => expect(page.toasts('success')).toEqual(['Agent configuration saved.']))
    await page.navigate('Advanced')
    expect(page.toasts('success')).toEqual(['Agent configuration saved.'])
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Hooks' })).toBeInTheDocument())
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('toasts(tone) returns only the toasts of that tone', async () => {
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo' })
    const edit = await screen.findByRole('button', { name: 'Edit agent name' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Renamed agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    await waitFor(() => expect(page.toasts('success')).toEqual(['Agent configuration saved.']))
    expect(page.toasts('error')).toEqual([])
    expect(page.toasts()).toEqual(['Agent configuration saved.'])
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it("errorBanners() and perToolSection() match the Approvals tab's load banner and per-tool section", async () => {
    // T16 and T8 read these two in negative assertions: they must find the tab's.
    const fake = seedFake({ http_request: false })
    // The page and the tab each read the agent on mount: both fail.
    for (const nth of [1, 2]) {
      const hold = fake.hold({ method: 'GET', path: FOO_DETAIL, nth })
      void hold.arrived.then(() => hold.respondWith(DETAIL_500.status, DETAIL_500.body))
    }
    const page = renderHostPage({ fake, name: 'foo', tab: 'approval-settings' })
    await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
    expect(errorBanners(), "the tab's load banner").toContain(tabLoadBanner())
    expect(perToolSection()).toBeNull()

    await act(async () => {
      fireEvent.click(within(tabLoadBanner() as HTMLElement).getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(perToolSection()).not.toBeNull())
    expect(perToolSection()?.closest('.cu-host-approvals-tab'), 'inside the tab').not.toBeNull()
    expect(tabLoadBanner()).toBeNull()
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it("the driver's message() reads the per-tool section's save message, not a tab banner above it", async () => {
    const fake = seedFake({ json_transform: true })
    const page = renderHostPage({ fake, name: 'foo', tab: 'approval-settings' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    fake.writeExternal('foo', spec => {
      ;(spec.approval as Record<string, unknown>).tools = {
        json_transform: true,
        shell_exec: false,
      }
    })
    await driver.editTool('system_info', 'required')
    await driver.save()
    await waitFor(() => expect(driver.message()).toBe(TOOLS_CHANGED_MESSAGE))

    // A later load of the tab fails, so the tab's banner shows above the section.
    const reload = fake.hold({ method: 'GET', path: FOO_DETAIL })
    act(() => notifyHostChanged('foo'))
    await act(async () => {
      await reload.arrived
    })
    await act(async () => {
      reload.respondWith(DETAIL_500.status, DETAIL_500.body)
    })
    await waitFor(() => expect(tabLoadBanner()).not.toBeNull())

    expect(page.banner(), "the first error banner is the tab's").toBe(tabLoadBanner()?.textContent)
    expect(driver.message(), "the save's message").toBe(TOOLS_CHANGED_MESSAGE)
    expect(unanswered(fake)).toEqual([])
    page.unmount()
  })

  it('renderApprovalsTab keeps the tab instance on rerenderKept and replaces it on remount', async () => {
    const fake = seedFake({ http_request: false })
    const tab = renderApprovalsTab({ fake, host: 'foo' })
    const driver = await approvalSettingsDriver()
    const first = document.querySelector('.cu-host-approvals-tab')
    expect(first).not.toBeNull()

    tab.rerenderKept('foo')
    expect(document.querySelector('.cu-host-approvals-tab'), 'kept').toBe(first)
    tab.remount()
    await waitFor(() => expect(driver.readView().http_request).toBe('Skip'))
    expect(document.querySelector('.cu-host-approvals-tab'), 'remounted').not.toBe(first)
    tab.leave()
    expect(document.querySelector('.cu-host-approvals-tab'), 'left').toBeNull()
    expect(unanswered(fake)).toEqual([])
    tab.unmount()
  })

  it('resetApprovalTestState puts the save protocol back on the real clock', () => {
    const injected: ApprovalClock = {
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    }
    __setApprovalClockForTests(injected, () => 0.5)
    expect(getApprovalClock().clock).toBe(injected)

    resetApprovalTestState()
    expect(getApprovalClock().clock).toBe(realApprovalClock)
  })

  it('resetApprovalTestState forgets every Host-changed listener', () => {
    const before = vi.fn()
    subscribeHostChanged('foo', before)
    resetApprovalTestState()

    const after = vi.fn()
    subscribeHostChanged('foo', after)
    notifyHostChanged('foo')
    expect(before).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
    // Closes the channel this test opened.
    resetApprovalTestState()
  })
})
