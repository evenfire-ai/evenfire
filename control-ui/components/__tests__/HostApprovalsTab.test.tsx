/**
 * The Approvals tab (spec §6.2, §6.5, §6.10, §6.12), named after the spec §7
 * A3 rows it settles: R7, R8 (T8c, Ruling 14), R8r, R9s, R14 (T16), R15 (T17)
 * and R18, and the A5 changes C7, C10, C11, C13 and C18.
 *
 * Most tests render the tab alone over the fake control-api
 * (`renderApprovalsTab`): only `fetch` is replaced, so the real `lib/api`
 * client, the save protocol and the display state run (spec A6). Tests about
 * the page (its tab link, its remounts, a kept page) render the page
 * (`renderHostPage`). The fake runs as control-api does since spec §6.8
 * (`versionRule: true`). The expected copy is written out here from the spec,
 * not imported from the component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIRST_SAVE_DIALOG_TITLE } from '../../components/HostApprovalSection/constants'
import { neverAskTools } from '../../lib/approvalToolCatalog'
import { notifyHostChanged, subscribeHostChanged } from '../../lib/hostApprovalDisplay'
import { subscribeRootToast } from '../../lib/rootToast'
import {
  approvalSettingsDriver,
  errorBanners,
  openApprovalSettings,
  overrides,
  pageMountDefaults,
  perToolSection,
  reads,
  renderApprovalsTab,
  renderHostPage,
  resetApprovalTestState,
  settle,
  tabLoadBanner,
  unanswered,
  writes,
} from '../../test/fixtures/approvalPageHarness'
import { seedHost } from '../../test/fixtures/approvalSection'
import {
  type FakeControlApi,
  type HostObject,
  createFakeControlApi,
} from '../../test/fixtures/fakeControlApi'

const FOO = '/api/v1/admin/hosts/foo'
const FOO_DETAIL = `${FOO}/detail`
const B_DETAIL = '/api/v1/admin/hosts/b/detail'

type WireAnswer = { status: number; body: unknown }

function controlApiWire(name: string): WireAnswer {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../../../control-api/test/fixtures/wire/${name}`), 'utf8')
  ) as WireAnswer
}

// control-api's production 500 for a /detail read that fails unexpectedly, and
// its 403 for a Host PUT the cluster refuses, both recorded by
// control-api/test/routes.hostPut.fakeContract.test.ts.
const DETAIL_500 = controlApiWire('host-detail-500.wire.json')
const PUT_403 = controlApiWire('host-put-403.wire.json')

// Spec §6.2, verbatim.
const INHERITING_BANNER =
  'This agent has no approval settings of its own. It uses the cluster default, which this page cannot show. Your first save here replaces it for this agent.'
const AUTO_DESCRIPTION =
  'Read-only shell runs after a model check. http_request runs with no card; unless your platform team set an HTTP allowlist, it can reach any public address.'
const ALLOW_ALL_DESCRIPTION =
  "Gated calls run with no card, including tools set to Required. cron_manage asks whenever Manual would; guardrail 'ask' rules still ask. For single-user agents."
const EMAIL_APPROVER_NOTE = 'Anyone who can send mail as this address counts.'
// Spec §6.10, verbatim.
const JUDGE_NOTE = 'Which model judges shell commands in Auto.'
// Spec §6.6, as the per-tool section capitalises it.
const CLUSTER_DEFAULT = 'Set by the cluster default (not shown here).'
// Spec §6.4 step 13, verbatim.
const MAYBE_MESSAGE = 'The save may not have applied. Reload to check.'
// Spec §6.4 step 4, verbatim.
const CHANGED_SINCE_OPENED =
  'These settings changed since you opened them. Reload to see the latest.'

// The success toast of a save, in the tab that ran it and as a continuation
// (C18: only the continuation names the agent, so T7 tells them apart).
const SAVED_IN_TAB = 'Per-tool overrides saved.'
const savedFor = (agent: string) => `Per-tool overrides saved for agent ${agent}.`

const SAVED_TOOLS = { json_transform: true, system_info: true }
const SAVED_VIEW = { json_transform: 'Required', system_info: 'Required' }
const B_VIEW = { clerum__generate_pdf: 'Required' }

/** The fake as control-api runs since spec §6.8, holding foo with `approval` (none when undefined). */
function tabFake(
  approval: Record<string, unknown> | null | undefined,
  others: Record<string, HostObject> = {}
): FakeControlApi {
  return createFakeControlApi({
    hosts: { ...others, foo: seedHost('foo', approval === undefined ? {} : { approval }) },
    crd: 'current',
    versionRule: true,
  })
}

/** The same, answering the page's mount reads. */
function pageFake(hosts: Record<string, HostObject>): FakeControlApi {
  return createFakeControlApi({
    hosts,
    crd: 'current',
    versionRule: true,
    defaults: pageMountDefaults(),
  })
}

function approvalOf(host: HostObject): unknown {
  return host.spec.approval
}

/** Answers the next `count` GETs of `path` with control-api's recorded 500, each as it arrives. */
function failReads(fake: FakeControlApi, path: string, count: number): void {
  for (let nth = 1; nth <= count; nth += 1) {
    const hold = fake.hold({ method: 'GET', path, nth })
    void hold.arrived.then(() => hold.respondWith(DETAIL_500.status, DETAIL_500.body))
  }
}

function failNextRead(fake: FakeControlApi, path: string): void {
  failReads(fake, path, 1)
}

/** The value cell (`dd`) of the read-view row labelled `label`, or null. */
function readRow(label: string): HTMLElement | null {
  const term = Array.from(document.querySelectorAll('.cu-host-approvals-tab dt')).find(
    node => node.textContent === label
  )
  return (term?.nextElementSibling as HTMLElement | null) ?? null
}

/** A read-view row's value, the first thing in its cell. */
function rowValue(label: string): string | null {
  return readRow(label)?.querySelector('.cu-host-approvals-tab__value')?.textContent ?? null
}

/** A read-view row's notes, in order. */
function rowNotes(label: string): string[] {
  const cell = readRow(label)
  if (!cell) return []
  return Array.from(cell.querySelectorAll('.cu-host-approvals-tab__note')).map(
    node => node.textContent ?? ''
  )
}

function sectionButton(name: string): HTMLButtonElement {
  const section = perToolSection()
  if (!section) throw new Error('The per-tool approval section is not rendered')
  return within(section).getByRole('button', { name }) as HTMLButtonElement
}

describe('HostApprovalsTab', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => {
    // The tab subscribes to the Host-changed notice: close its channel (Task 18).
    resetApprovalTestState()
    vi.unstubAllGlobals()
  })

  describe('loads (spec §6.5, §6.12)', () => {
    it('T16 a failed first load shows Retry and no section', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      failNextRead(fake, FOO_DETAIL)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())

      const banner = tabLoadBanner() as HTMLElement
      expect(errorBanners(), 'the load banner is an error banner').toContain(banner)
      expect(banner.textContent, 'the load error').toContain('500 Internal Server Error')
      expect(perToolSection(), 'no per-tool section').toBeNull()
      expect(screen.queryByRole('heading', { name: 'Approval modes' }), 'no read view').toBeNull()

      // Retry loads again; this time the read answers and the tab shows the agent.
      await act(async () => {
        fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
      })
      const driver = await approvalSettingsDriver()
      expect(overrides(driver.readView())).toEqual({ json_transform: 'Required' })
      expect(screen.getByRole('heading', { name: 'Approval modes' })).toBeInTheDocument()
      expect(tabLoadBanner(), 'the banner after the read answered').toBeNull()
      expect(reads(fake, FOO_DETAIL).map(entry => entry.response?.status)).toEqual([500, 200])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('Retry keeps the focus while it loads: the banner stays, with Retry disabled (review R45(6))', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      failNextRead(fake, FOO_DETAIL)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
      const retry = within(tabLoadBanner() as HTMLElement).getByRole('button', { name: 'Retry' })
      act(() => retry.focus())
      expect(retry).toHaveFocus()

      const second = fake.hold({ method: 'GET', path: FOO_DETAIL })
      await act(async () => {
        fireEvent.click(retry)
      })
      await act(async () => {
        await second.arrived
      })
      expect(tabLoadBanner(), 'the banner while Retry loads').not.toBeNull()
      expect(retry, 'the same Retry, still on screen').toBeInTheDocument()
      expect(retry, 'Retry while it loads').toHaveAttribute('aria-disabled', 'true')
      expect(retry, 'the focus while Retry loads').toHaveFocus()
      // A press while it loads starts no other load.
      fireEvent.click(retry)
      expect(reads(fake, FOO_DETAIL), 'reads of the agent').toHaveLength(2)

      // The read fails again: the banner stays, and Retry is usable, with the focus.
      await act(async () => {
        second.respondWith(DETAIL_500.status, DETAIL_500.body)
      })
      await waitFor(() => expect(retry).not.toHaveAttribute('aria-disabled'))
      expect(tabLoadBanner(), 'the banner after the read failed again').not.toBeNull()
      expect(retry, 'the focus after the read failed again').toHaveFocus()
      expect(perToolSection(), 'still no section').toBeNull()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('after a Retry whose load applies, the focus moves to the Approval modes heading (Ruling 46)', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      failNextRead(fake, FOO_DETAIL)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
      const retry = within(tabLoadBanner() as HTMLElement).getByRole('button', { name: 'Retry' })
      act(() => retry.focus())
      expect(retry).toHaveFocus()

      await act(async () => {
        fireEvent.click(retry)
      })
      const heading = await screen.findByRole('heading', { name: 'Approval modes' })
      await waitFor(() => expect(heading).toHaveFocus())
      expect(heading).toHaveAttribute('tabindex', '-1')
      expect(tabLoadBanner(), 'the banner and its Retry are gone').toBeNull()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a load the admin did not retry moves no focus (Ruling 46 partner)', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      // The first load applied: the heading is there, and the focus stays where it was.
      expect(screen.getByRole('heading', { name: 'Approval modes' })).not.toHaveFocus()
      expect(document.activeElement).toBe(document.body)

      // A load the notice starts shows another admin's change, and moves no focus either.
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'manual'
      })
      act(() => notifyHostChanged('foo'))
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      expect(document.activeElement).toBe(document.body)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a Retry whose load applies after the admin moved the focus leaves it there (Ruling 46 partner)', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      failNextRead(fake, FOO_DETAIL)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
      const retry = within(tabLoadBanner() as HTMLElement).getByRole('button', { name: 'Retry' })
      const second = fake.hold({ method: 'GET', path: FOO_DETAIL })
      await act(async () => {
        fireEvent.click(retry)
      })
      await act(async () => {
        await second.arrived
      })
      // While it loads, the admin moves to "Set to Manual now".
      const switchButton = screen.getByRole('button', { name: 'Set to Manual now' })
      act(() => switchButton.focus())

      await act(async () => {
        second.deliverNow()
      })
      expect(await screen.findByRole('heading', { name: 'Approval modes' })).not.toHaveFocus()
      await settle()
      expect(switchButton).toHaveFocus()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('T17 through the tab: a failed refresh after a save keeps the saved tools, shows the error and releases Save', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const refresh = fake.hold({ method: 'GET', path: FOO_DETAIL })
      await driver.save()
      await act(async () => {
        await refresh.arrived
      })

      // The refresh is out: the PUT's answer shows at once (L1), and Save waits.
      expect(overrides(driver.readView()), 'the tools before the refresh').toEqual(SAVED_VIEW)
      await driver.edit()
      await driver.editTool('clerum__generate_pdf', 'required')
      expect(sectionButton('Save'), 'Save while the refresh is out').toBeDisabled()

      await act(async () => {
        refresh.respondWith(DETAIL_500.status, DETAIL_500.body)
      })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
      expect(tabLoadBanner()?.textContent, 'the refresh error').toContain(
        '500 Internal Server Error'
      )
      expect(sectionButton('Save'), 'Save once the refresh failed').toBeEnabled()
      expect(overrides(driver.readView()), 'the draft on the saved tools').toEqual({
        ...SAVED_VIEW,
        clerum__generate_pdf: 'Required',
      })

      await driver.save()
      await waitFor(() => expect(writes(fake).filter(entry => entry.applied)).toHaveLength(2))
      await waitFor(() => expect(tabLoadBanner(), 'after a refresh that answered').toBeNull())
      expect(approvalOf(fake.stored('foo'))).toEqual({
        tools: { ...SAVED_TOOLS, clerum__generate_pdf: true },
      })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('the newest load wins when an older one lands after it', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()

      // An older load takes the tools as they are now, and is held.
      const older = fake.hold({ method: 'GET', path: FOO_DETAIL })
      act(() => notifyHostChanged('foo'))
      await act(async () => {
        await older.arrived
      })
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = { clerum__generate_pdf: true }
      })
      // A newer load takes the change and lands first.
      act(() => notifyHostChanged('foo'))
      await waitFor(() => expect(overrides(driver.readView())).toEqual(B_VIEW))

      await act(async () => {
        older.deliverNow()
      })
      await settle()
      expect(
        reads(fake, FOO_DETAIL).filter(entry => entry.delivered),
        'loads delivered'
      ).toHaveLength(3)
      expect(overrides(driver.readView()), 'after the older load landed').toEqual(B_VIEW)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it("a save's answer seeds only the per-tool keys: the ceiling of a newer load stays", async () => {
      const fake = tabFake({ modeCeiling: 'auto', tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      expect(rowValue('Highest mode')).toBe('Auto')
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })
      put.applyNow()
      await waitFor(() => expect(writes(fake)[0].applied).toBe(true))

      // After the write, another admin lowers the ceiling, and their tab's
      // notice loads it here before this PUT's answer arrives.
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'manual'
      })
      act(() => notifyHostChanged('foo'))
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))

      // The PUT's answer still carries Auto. The loads after it are held.
      const after = fake.hold({ method: 'GET', path: FOO_DETAIL })
      await act(async () => {
        put.deliverNow()
      })
      await act(async () => {
        await after.arrived
      })
      expect(tab.toasts('success'), 'the save settled').toEqual([SAVED_IN_TAB])
      expect(rowValue('Highest mode'), 'the ceiling after the answer').toBe('Manual')
      expect(overrides(driver.readView()), 'the tools the answer seeded').toEqual(SAVED_VIEW)

      await act(async () => {
        after.deliverNow()
      })
      await settle()
      expect(rowValue('Highest mode')).toBe('Manual')
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a save that settles after a kept tab went to b and back seeds the state shown now, though its refresh fails (review R45(7))', async () => {
      const fake = tabFake(
        { tools: { json_transform: true } },
        { b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }) }
      )
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      tab.rerenderKept('b')
      await waitFor(() => expect(overrides(driver.readView())).toEqual(B_VIEW))
      tab.rerenderKept('foo')
      // foo again, in a new display state, loaded before the write landed.
      await waitFor(() =>
        expect(overrides(driver.readView())).toEqual({ json_transform: 'Required' })
      )
      // Every load of foo from here fails: only the save's answer can show the write.
      const loadsBefore = reads(fake, FOO_DETAIL).length
      failReads(fake, FOO_DETAIL, 3)

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())

      expect(overrides(driver.readView()), 'the saved tools, in the state shown now').toEqual(
        SAVED_VIEW
      )
      expect(tab.toasts('success')).toEqual([SAVED_IN_TAB])
      const later = reads(fake, FOO_DETAIL).slice(loadsBefore)
      expect(later.length, 'the refresh ran').toBeGreaterThan(0)
      expect(
        later.map(entry => entry.response?.status),
        'no load of foo answered after the write'
      ).toEqual(later.map(() => 500))
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a kept tab shows nothing of the previous agent while the next one loads', async () => {
      const fake = tabFake(
        { modeCeiling: 'auto', tools: { json_transform: true } },
        { b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }) }
      )
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      expect(rowValue('Highest mode')).toBe('Auto')

      const bLoad = fake.hold({ method: 'GET', path: B_DETAIL })
      tab.rerenderKept('b')
      await act(async () => {
        await bLoad.arrived
      })
      expect(readRow('Highest mode'), "foo's ceiling while b loads").toBeNull()
      expect(
        screen.getByRole('status', { name: 'Loading approval settings' }),
        'the read views load'
      ).toBeInTheDocument()
      expect(perToolSection(), 'the section stays mounted (C10)').not.toBeNull()
      expect(driver.readView(), "foo's tools while b loads").toEqual({})

      await act(async () => {
        bLoad.deliverNow()
      })
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      expect(overrides(driver.readView())).toEqual(B_VIEW)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('continuations and the Host-changed notice (spec §6.5, C18)', () => {
    it('the success toast in the tab that saved does not name the agent', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      await driver.save()

      // The exact text: it names no agent, unlike a continuation's (C18).
      await waitFor(() => expect(tab.toasts('success')).toEqual([SAVED_IN_TAB]))
      expect(overrides(driver.readView())).toEqual(SAVED_VIEW)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a throw while a per-tool save reports its outcome still fires the notice, is reported, and leaves no unhandled rejection (Ruling 51)', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })
      const notices = vi.fn()
      subscribeHostChanged('foo', notices)
      const reported = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rejections: unknown[] = []
      const onRejection = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on('unhandledRejection', onRejection)
      // A root-toast listener that throws, subscribed after the page's own:
      // the save's continuation toast throws out of the step that reports it.
      const failure = new Error('a toast listener failed')
      const unsubscribe = subscribeRootToast(() => {
        throw failure
      })
      try {
        tab.leave()
        await act(async () => {
          put.deliverNow()
        })
        await waitFor(() => expect(notices, 'the Host-changed notice').toHaveBeenCalledTimes(1))
        await waitFor(() =>
          expect(reported, 'the error, reported').toHaveBeenCalledWith(
            expect.stringContaining('Per-tool save'),
            failure
          )
        )
        // Node reports an unhandled rejection once the microtasks have run.
        await settle()
        expect(rejections, 'unhandled rejections').toEqual([])
        // The page's listener came first, so its toast still shows.
        expect(tab.toasts('success')).toEqual([savedFor('foo')])
        expect(approvalOf(fake.stored('foo')), 'the write landed').toEqual({ tools: SAVED_TOOLS })
      } finally {
        unsubscribe()
        process.off('unhandledRejection', onRejection)
      }
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a save that settles after the tab was left reports in the root toast, naming the agent', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      tab.leave()
      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(writes(fake)[0].delivered).toBe(true))
      await settle()

      expect(approvalOf(fake.stored('foo')), 'the write landed').toEqual({ tools: SAVED_TOOLS })
      expect(tab.toasts('success'), 'the root toast').toEqual([savedFor('foo')])
      expect(fooNotices, 'the Host-changed notice').toHaveBeenCalledTimes(1)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a save that stops after the tab was left reports its error in the root toast, naming the agent', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      const emitted: Array<[string, unknown]> = []
      const unsubscribe = subscribeRootToast((message, options) => {
        emitted.push([message, options])
      })
      try {
        tab.leave()
        await act(async () => {
          put.respondWith(PUT_403.status, PUT_403.body)
        })
        await waitFor(() => expect(tab.toasts('error')).toHaveLength(1))
      } finally {
        unsubscribe()
      }

      const [toast] = tab.toasts('error')
      expect(toast).toMatch(/^Per-tool overrides for agent foo were not saved\. /)
      expect(toast, "control-api's refusal").toContain('is forbidden')
      expect(tab.toasts('success')).toEqual([])
      // Minor 5's partner: a per-tool continuation problem stays 8 s; only the
      // switch's failure, which carries the kubectl fallback, stays longer.
      expect(emitted).toEqual([[toast, { tone: 'error', durationMs: 8000 }]])
      expect(approvalOf(fake.stored('foo')), 'nothing written').toEqual({
        tools: { json_transform: true },
      })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a reconfirm that settles after the tab was left says in the root toast that nothing was sent', async () => {
      // As in T21: shell_exec set to Required by an admin, at Manual, so Back
      // to Default shows no dialog. Another writer raises the ceiling first,
      // and the save's own read finds an item no dialog confirmed.
      const fake = tabFake({ modeCeiling: 'manual', tools: { shell_exec: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('shell_exec', 'default')
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'auto'
      })
      const read = fake.hold({ method: 'GET', path: FOO })
      await driver.save()
      await act(async () => {
        await read.arrived
      })

      tab.leave()
      await act(async () => {
        read.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('error')).toHaveLength(1))

      expect(tab.toasts('error')).toEqual([
        "Per-tool overrides for agent foo: The save was not sent: this agent's approval settings changed while it was saving, so its changes need confirming again. Make the changes again and save.",
      ])
      expect(writes(fake), 'nothing sent').toEqual([])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a stop that settles after a kept tab dropped the section that ran it goes to the root toast, naming the agent (review I1)', async () => {
      const fake = tabFake(
        { tools: { json_transform: true } },
        { b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }) }
      )
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      // b's first load fails, so the tab drops the section running foo's save (C13).
      failNextRead(fake, B_DETAIL)
      tab.rerenderKept('b')
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())
      expect(perToolSection(), 'no section after b failed').toBeNull()
      // Back on foo, a new section shows foo, and knows nothing of the save.
      tab.rerenderKept('foo')
      const again = await approvalSettingsDriver()
      expect(overrides(again.readView()), "foo's tools before the write").toEqual({
        json_transform: 'Required',
      })
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      await act(async () => {
        put.respondWith(PUT_403.status, PUT_403.body)
      })
      await waitFor(() => expect(writes(fake)[0].delivered).toBe(true))
      await waitFor(() => expect(tab.toasts('error')).toHaveLength(1))

      const [toast] = tab.toasts('error')
      expect(toast).toMatch(/^Per-tool overrides for agent foo were not saved\. /)
      expect(toast, "control-api's refusal").toContain('is forbidden')
      expect(fooNotices, "foo's Host-changed notice").toHaveBeenCalledTimes(1)
      expect(again.message(), 'the new section shows no message of it').toBeNull()
      expect(approvalOf(fake.stored('foo')), 'nothing written').toEqual({
        tools: { json_transform: true },
      })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a save that may not have applied loads the tab again, and the stored tools show (review I2)', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      // The PUT is applied but its answer is lost, and the re-read fails too
      // (spec §6.4 step 13): the outcome is `maybe`.
      const reread = fake.hold({ method: 'GET', path: FOO })
      await act(async () => {
        put.dropResponse()
      })
      await act(async () => {
        await reread.arrived
      })
      const loadsBefore = reads(fake, FOO_DETAIL).length
      await act(async () => {
        reread.dropResponse()
      })

      await waitFor(() => expect(driver.message()).toBe(MAYBE_MESSAGE))
      await waitFor(() => expect(overrides(driver.readView())).toEqual(SAVED_VIEW))
      expect(reads(fake, FOO_DETAIL).length, 'a load after the outcome').toBeGreaterThan(
        loadsBefore
      )
      expect(approvalOf(fake.stored('foo')), 'the write landed').toEqual({ tools: SAVED_TOOLS })
      expect(tab.toasts(), 'no toast: the section shows the outcome').toEqual([])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a save that may not have applied after the tab was left warns in the root toast, naming the agent (review I2)', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      tab.leave()
      const reread = fake.hold({ method: 'GET', path: FOO })
      await act(async () => {
        put.dropResponse()
      })
      await act(async () => {
        await reread.arrived
      })
      await act(async () => {
        reread.dropResponse()
      })
      await waitFor(() => expect(tab.toasts('warning')).toHaveLength(1))

      expect(tab.toasts('warning')).toEqual([`Per-tool overrides for agent foo: ${MAYBE_MESSAGE}`])
      expect(fooNotices, "foo's Host-changed notice").toHaveBeenCalledTimes(1)
      expect(approvalOf(fake.stored('foo')), 'the write landed').toEqual({ tools: SAVED_TOOLS })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a stop that wrote nothing still fires the Host-changed notice, in the tab (review R45(8))', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = {
          json_transform: true,
          shell_exec: false,
        }
      })
      await driver.editTool('system_info', 'required')
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      await driver.save()
      await waitFor(() => expect(driver.message()).toBe(CHANGED_SINCE_OPENED))
      expect(writes(fake), 'nothing written').toEqual([])
      expect(fooNotices, "foo's Host-changed notice").toHaveBeenCalledTimes(1)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a stop that wrote nothing still fires the Host-changed notice, after the tab was left (review R45(8))', async () => {
      const fake = tabFake({ tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).tools = {
          json_transform: true,
          shell_exec: false,
        }
      })
      await driver.editTool('system_info', 'required')
      const read = fake.hold({ method: 'GET', path: FOO })
      await driver.save()
      await act(async () => {
        await read.arrived
      })
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      tab.leave()
      await act(async () => {
        read.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('error')).toHaveLength(1))
      expect(tab.toasts('error')).toEqual([
        `Per-tool overrides for agent foo were not saved. ${CHANGED_SINCE_OPENED}`,
      ])
      expect(writes(fake), 'nothing written').toEqual([])
      expect(fooNotices, "foo's Host-changed notice").toHaveBeenCalledTimes(1)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('T8r a remounted tab reloads on the Host-changed notice', async () => {
      const fake = pageFake({
        foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
      })
      const page = renderHostPage({ fake, name: 'foo' })
      const driver = await openApprovalSettings(page)
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      // E9: the admin leaves the tab and comes back while the PUT is out. The
      // shipped build remounts the page each time.
      await page.navigate('Overview')
      await page.navigate('Approvals')
      const again = await approvalSettingsDriver()
      expect(overrides(again.readView()), 'loaded before the write landed').toEqual({
        json_transform: 'Required',
      })
      const loadsBefore = reads(fake, FOO_DETAIL).length

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(overrides(again.readView())).toEqual(SAVED_VIEW))
      expect(reads(fake, FOO_DETAIL).length, 'a load after the notice').toBeGreaterThan(loadsBefore)
      expect(page.toasts('success'), "the first tab's outcome").toEqual([savedFor('foo')])
      expect(unanswered(fake)).toEqual([])
      page.unmount()
    })

    it('T8c a save that settles after a kept page moved to another agent goes to the root toast, seeds nothing and fires the notice (Ruling 14)', async () => {
      const fake = pageFake({
        foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
        b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }),
      })
      const page = renderHostPage({ fake, name: 'foo' })
      const driver = await openApprovalSettings(page)
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const put = fake.hold({ method: 'PUT', path: FOO })
      await driver.save()
      await act(async () => {
        await put.arrived
      })

      page.rerenderKept({ name: 'b' })
      await waitFor(() => expect(overrides(driver.readView())).toEqual(B_VIEW))
      // The edit session foo's save started in ended with the move; b opens its own.
      await driver.edit()
      expect(sectionButton('Cancel'), "b's edit session").toBeInTheDocument()
      const fooNotices = vi.fn()
      subscribeHostChanged('foo', fooNotices)

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(writes(fake)[0].delivered).toBe(true))
      await settle()

      expect(approvalOf(fake.stored('foo')), "foo's write landed").toEqual({ tools: SAVED_TOOLS })
      expect(page.toasts('success'), 'the root toast names foo').toEqual([savedFor('foo')])
      expect(fooNotices, "foo's Host-changed notice").toHaveBeenCalledTimes(1)
      expect(overrides(driver.readView()), "b's tools, not foo's").toEqual(B_VIEW)
      expect(sectionButton('Cancel'), "b's edit session stays open").toBeEnabled()
      expect(unanswered(fake)).toEqual([])
      page.unmount()
    })
  })

  describe('the inheriting banner (Ruling 42, Review Focus 1)', () => {
    it('shows no inheriting banner for an empty approval block', async () => {
      const fake = tabFake({})
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()

      expect(rowValue('Highest mode'), 'the read view of the empty block').toBe('Manual')
      expect(screen.queryByText(INHERITING_BANNER)).toBeNull()
      // Not a first save either: no policy dialog, and the PUT goes out.
      await driver.edit()
      await driver.editTool('system_info', 'required')
      await act(async () => {
        fireEvent.click(sectionButton('Save'))
      })
      expect(screen.queryByRole('dialog', { name: FIRST_SAVE_DIALOG_TITLE })).toBeNull()
      await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
      expect(approvalOf(fake.stored('foo'))).toEqual({ tools: { system_info: true } })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('shows it for an absent block', async () => {
      const fake = tabFake(undefined)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(screen.getByText(INHERITING_BANNER)).toBeInTheDocument()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('shows it for a null block', async () => {
      const fake = tabFake(null)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(screen.getByText(INHERITING_BANNER)).toBeInTheDocument()
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('read views (spec §6.2, §6.10)', () => {
    it('shows Auto with its description and the shell judge row with the provider and "default"', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Highest mode')).toBe('Auto')
      expect(rowNotes('Highest mode')).toEqual([AUTO_DESCRIPTION])
      expect(rowValue('Shell judge')).toBe('Anthropic · default')
      expect(rowNotes('Shell judge')).toEqual([JUDGE_NOTE])
      tab.unmount()
    })

    it('shows Allow all with its description and the stored judge model', async () => {
      const fake = tabFake({ modeCeiling: 'allow_all', shellClassifierModel: 'gpt-5.5' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Highest mode')).toBe('Allow all')
      expect(rowNotes('Highest mode')).toEqual([ALLOW_ALL_DESCRIPTION])
      expect(rowValue('Shell judge')).toBe('Anthropic · gpt-5.5')
      tab.unmount()
    })

    it('shows Manual with the Skip overrides and the tools that never ask, and no judge row', async () => {
      const fake = tabFake({
        modeCeiling: 'manual',
        shellClassifierModel: 'gpt-5.5',
        tools: { http_request: false, json_transform: true, custom_lookup: false },
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Highest mode')).toBe('Manual')
      expect(rowNotes('Highest mode')).toEqual([
        'Gated tool calls ask, except tools set to Skip (custom_lookup, http_request), tools that never ask (listed below), and approvals chats already gave.',
      ])
      const neverAsk = neverAskTools()
      const list = screen.getByText(`Tools that never ask (${neverAsk.length})`).closest('details')
      expect(list, 'the never-ask list').not.toBeNull()
      expect(
        Array.from((list as HTMLElement).querySelectorAll('li code')).map(node => node.textContent)
      ).toEqual(neverAsk.map(tool => tool.name))
      expect(readRow('Shell judge'), 'no judge row in Manual').toBeNull()
      tab.unmount()
    })

    it('names the cluster default in the Manual description of an agent without its own settings', async () => {
      const fake = tabFake(undefined)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Highest mode')).toBe('Manual')
      expect(rowNotes('Highest mode')).toEqual([
        'Gated tool calls ask, except tools set to Skip (any the cluster default sets to Skip, not shown here), tools that never ask (listed below), and approvals chats already gave.',
      ])
      tab.unmount()
    })

    it('lists the channels that may change the mode, with each default', async () => {
      const fake = tabFake({
        channels: { telegram: { allowModeChange: false }, email: { allowModeChange: true } },
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Channels that may change the mode')).toBe(
        'Desktop always · Telegram off · Slack on · Teams on · Email on'
      )
      tab.unmount()

      const defaults = tabFake({})
      const again = renderApprovalsTab({ fake: defaults, host: 'foo' })
      await approvalSettingsDriver()
      expect(rowValue('Channels that may change the mode')).toBe(
        'Desktop always · Telegram on · Slack on · Teams on · Email off'
      )
      again.unmount()
    })

    it('shows who can raise the mode: the policy and each channel with its approvers', async () => {
      const fake = tabFake({
        defaultPolicy: 'designated_approvers',
        channels: {
          telegram: { approvers: ['123456789'] },
          email: { enabled: false, approvers: ['ana@example.com'] },
        },
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(
        screen.getByRole('heading', { name: 'Who can raise the mode from a channel' })
      ).toBeInTheDocument()
      expect(rowValue('Policy')).toBe('Listed approvers only')
      expect([rowValue('Telegram'), rowNotes('Telegram')]).toEqual(['on', ['123456789']])
      expect([rowValue('Slack'), rowNotes('Slack')]).toEqual(['on', ['No approvers listed']])
      expect([rowValue('Teams'), rowNotes('Teams')]).toEqual(['on', ['No approvers listed']])
      expect([rowValue('Email'), rowNotes('Email')]).toEqual([
        'off',
        ['ana@example.com', EMAIL_APPROVER_NOTE],
      ])
      tab.unmount()
    })

    it.each([
      [undefined, 'Any channel user'],
      ['channel_users', 'Any channel user'],
      ['cli_only', 'Nobody (Desktop only)'],
      ['someone_else', 'Unknown policy "someone_else": nobody can approve from a channel'],
    ])('names the policy %s as "%s"', async (policy, label) => {
      const fake = tabFake(policy === undefined ? {} : { defaultPolicy: policy })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(rowValue('Policy')).toBe(label)
      tab.unmount()
    })

    it('shows the cluster default for the policy, approvers and channels on or off of an agent without its own settings', async () => {
      const fake = tabFake(undefined)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      // Spec §6.6: policy, approvers and `enabled`, each named (review R45(9b)).
      expect(rowValue('Policy')).toBe(CLUSTER_DEFAULT)
      expect(rowValue('Approvers')).toBe(CLUSTER_DEFAULT)
      expect(rowValue('Channels on or off')).toBe(CLUSTER_DEFAULT)
      expect(readRow('Telegram'), 'no channel rows of its own').toBeNull()
      tab.unmount()
    })
  })

  describe('agent names (Review Focus 2)', () => {
    it.each([
      ['9-ops', '9-ops'],
      ['a b', 'a%20b'],
    ])('links and loads the Approvals tab for an agent named %s', async (agent, segment) => {
      const fake = pageFake({
        [agent]: seedHost(agent, { approval: { tools: { json_transform: true } } }),
      })
      const page = renderHostPage({ fake, name: agent })
      expect(await screen.findByRole('tab', { name: 'Approvals' })).toHaveAttribute(
        'href',
        `/agents/${segment}/approval-settings`
      )

      const driver = await openApprovalSettings(page)
      expect(overrides(driver.readView())).toEqual({ json_transform: 'Required' })
      expect(rowValue('Highest mode')).toBe('Manual')
      const hostPath = `/api/v1/admin/hosts/${segment}`
      expect(reads(fake, `${hostPath}/detail`).some(entry => entry.delivered)).toBe(true)

      // A save's requests name the agent the same way.
      await driver.edit()
      await driver.editTool('system_info', 'required')
      await driver.save()
      await waitFor(() => expect(writes(fake, hostPath).some(entry => entry.applied)).toBe(true))
      expect(fake.stored(agent).spec.approval).toEqual({ tools: SAVED_TOOLS })
      await waitFor(() => expect(page.toasts('success')).toEqual([SAVED_IN_TAB]))
      expect(unanswered(fake)).toEqual([])
      page.unmount()
    })
  })
})
