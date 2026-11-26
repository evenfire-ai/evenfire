/**
 * "Set to Manual now" in the Approvals tab (spec §6.3, §6.12, Task 21c), named
 * after the spec §7 A3 rows it settles in the tab: R4 (T4's page-data case,
 * the UI twin of C6), R14's partner (T16-partner, C13), R19 (T19), R24 (T30),
 * and T20 of the dialog-gating rows; and C18's continuations.
 *
 * The tab renders over the fake control-api (`renderApprovalsTab`): only
 * `fetch` is replaced, so the real `lib/api` client, the switch protocol and
 * the display state run (spec A6). The fake runs as control-api does since
 * spec §6.8 (`versionRule: true`). The protocol runs on a virtual clock that
 * no test advances, so a run a test leaves unfinished never wakes in a later
 * one. An answer that stands for another component's is that component's:
 * control-api's 403, 422 and 500 (control-api/test/fixtures/wire), and the
 * Hosts a manifest applied or the Control UI edited (test/fixtures/wire).
 * The expected copy is written out here, not imported from the component.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { resolve } from 'node:path'
import { HostApprovalsTab } from '../../components/HostApprovalsTab'
import { ToastProvider } from '../../components/Toast'
import { formatApiError, getHost, setControlUIReadPrincipal } from '../../lib/api'
import { neverAskTools } from '../../lib/approvalToolCatalog'
import { subscribeHostChanged } from '../../lib/hostApprovalDisplay'
import { __setApprovalClockForTests } from '../../lib/hostApprovalSave'
import { subscribeRootToast } from '../../lib/rootToast'
import {
  type VirtualClock,
  createVirtualClock,
  seededRandom,
} from '../../test/fixtures/approvalClock'
import {
  approvalSettingsDriver,
  clickSetToManual,
  offSwitchResult,
  overrides,
  perToolSection,
  reads,
  renderApprovalsTab,
  resetApprovalTestState,
  setToManualButton,
  settle,
  tabLoadBanner,
  unanswered,
  writes,
} from '../../test/fixtures/approvalPageHarness'
import { seedHost } from '../../test/fixtures/approvalSection'
import {
  type FakeControlApi,
  type FakeLogEntry,
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

// control-api's answers, recorded by control-api/test/routes.hostPut.fakeContract.test.ts:
// the production 500 of a /detail read, and the 403 and 422 of a Host PUT.
const DETAIL_500 = controlApiWire('host-detail-500.wire.json')
const PUT_403 = controlApiWire('host-put-403.wire.json')
const PUT_422 = controlApiWire('host-put-422.wire.json')

/** The message the real client gives a request answered with `answer` (formatApiError). */
function clientMessage(answer: WireAnswer): string {
  const text = JSON.stringify(answer.body)
  const response = new Response(text, {
    status: answer.status,
    statusText: STATUS_CODES[answer.status],
  })
  return formatApiError(response, text).message
}

// ── Copy ────────────────────────────────────────────────────────────────────

const SET_MANUAL = 'Set to Manual now'
// Spec §6.3 step 1.
const SETTING_MANUAL = 'Setting Manual…'
// Spec §6.2 and §6.10 (PR A), verbatim: the static line under the switch.
const APPROVALS_OFF_NOTE =
  'Has no effect if your platform team turned approvals off for the cluster.'
const HOW_TO =
  'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/configure-approvals.md'
const PER_TOOL_ANCHOR = 'approval-per-tool-overrides'

/**
 * Spec §6.3 step 7, verbatim, around its lists. The "It was already Manual"
 * clause shows only when no attempt of the run may have written. The
 * cluster-default clause shows only for an agent with no approval settings of
 * its own (`inherited`), which it names itself (Ruling 48(a)). The never-ask
 * list is "listed below", in a disclosure as in the read view (Ruling 48(b)).
 */
function manualMessage(parts: { already: boolean; skip: string; inherited?: boolean }): string {
  const clusterDefault = parts.inherited
    ? '; on an agent without its own settings, also any the cluster default sets to Skip, not shown here'
    : ''
  return (
    `Manual is saved.${parts.already ? ' It was already Manual.' : ''} Running chats apply it at their next tool call. ` +
    `Still running without a card: tools set to Skip (${parts.skip}${clusterDefault}); ` +
    'tools that never ask (listed below); ' +
    "approvals chats already gave: 'Always allow' for every tool except shell, in every chat; 'Always allow' for shell and approvals for the rest of a task on shell_exec and http_request, in chats that were already in Manual; cron_manage approvals, in every chat; and scheduled tasks (on stateless agents they still ask before creating or enabling another schedule). " +
    'This has no effect if your platform team turned approvals off for the cluster.'
  )
}

/** The Skip list of a Host with no Skip override (the read view's word for it). */
const NO_SKIP = 'none'

// Spec §6.7 with Ruling 47: the manifest warning the result adds, as the banner words it.
function manifestWarning(values: string): string {
  return `A deployment manifest also sets these settings. The next deploy puts back: ${values}. Change the manifest too.`
}
const MANIFEST_WARNING_NO_VALUES =
  'A deployment manifest also sets these settings. The next deploy puts them back; they are set by a manifest (values not shown). Change the manifest too.'

// Spec §6.3 step 6, verbatim: the how-to's fallback.
function fallback(namespace: string, name: string): string {
  return `kubectl -n ${namespace} patch host ${name} --type=json -p '[{"op":"replace","path":"/spec/approval/modeCeiling","value":"manual"}]'`
}

// New copy (Task 21c, for the owner's sign-off): a failure in the tab that ran
// the switch, and the root toasts. As in the per-tool save (C18), only a
// continuation's toast names the agent. The error ends in a full stop; these
// tests' errors have none of their own.
const failedText = (message: string) => `Manual was not saved. ${message}.`
const FALLBACK_INTRO = 'To set Manual by hand, run:'
// Review I-1 (new copy, for the owner's sign-off): a continuation's success
// says what still runs without a card, every kind step 7 lists, and adds the
// manifest warning when a manifest sets the agent's settings.
const STILL_RUNNING_TOAST =
  "Still running without a card: tools set to Skip, tools that never ask, approvals chats already gave and scheduled tasks; the agent's Approvals tab lists the tools."
const savedFor = (agent: string, warning?: string) =>
  `Manual is saved for agent ${agent}. Running chats apply it at their next tool call. ${STILL_RUNNING_TOAST}` +
  (warning ? ` ${warning}` : '')
const alreadyFor = (agent: string, warning?: string) =>
  `Manual is saved for agent ${agent}. It was already Manual. Running chats apply it at their next tool call. ${STILL_RUNNING_TOAST}` +
  (warning ? ` ${warning}` : '')
const failedFor = (agent: string, message: string, command: string) =>
  `Manual was not saved for agent ${agent}. ${message}. To set Manual by hand, run: ${command}`

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The fake as control-api runs since spec §6.8, holding foo with `approval` (none when undefined). */
function tabFake(
  approval: Record<string, unknown> | undefined,
  others: Record<string, HostObject> = {}
): FakeControlApi {
  return createFakeControlApi({
    hosts: { ...others, foo: seedHost('foo', approval === undefined ? {} : { approval }) },
    crd: 'current',
    versionRule: true,
  })
}

type Wire = HostObject & { _source?: unknown }

/** A recorded Host (test/fixtures/wire), stored as agent `foo`. */
function fooFrom(name: string): HostObject {
  const { _source, ...host } = JSON.parse(
    readFileSync(resolve(__dirname, `../../test/fixtures/wire/${name}.wire.json`), 'utf8')
  ) as Wire
  void _source
  return { ...host, metadata: { ...host.metadata, name: 'foo' } }
}

/** Answers the next GET of `path` with control-api's recorded 500, as it arrives. */
function failNextRead(fake: FakeControlApi, path: string): void {
  const hold = fake.hold({ method: 'GET', path })
  void hold.arrived.then(() => hold.respondWith(DETAIL_500.status, DETAIL_500.body))
}

function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The paragraphs of the switch's result in the tab, in order. */
function resultParagraphs(scope: ParentNode = document): string[] {
  const result = scope.querySelector('.cu-host-approvals-tab__switch-result')
  return Array.from(result?.querySelectorAll('p') ?? []).map(text)
}

/**
 * The switch's polite live region (review finding 1), found by its role inside
 * the switch's own area: the skeleton and the toasts are status regions too.
 */
function switchLiveRegion(): HTMLElement {
  const area = document.querySelector<HTMLElement>('.cu-host-approvals-tab__switch')
  if (!area) throw new Error('the off switch is not rendered')
  return within(area).getByRole('status')
}

/** The kubectl command the failure shows. */
function fallbackShown(): string {
  return text(offSwitchResult()?.querySelector('pre'))
}

/** A read-view row's value, by its label, in `scope`. */
function rowValue(label: string, scope: ParentNode = document): string | null {
  const term = Array.from(scope.querySelectorAll('.cu-host-approvals-tab dt')).find(
    node => node.textContent === label
  )
  const cell = term?.nextElementSibling
  return cell?.querySelector('.cu-host-approvals-tab__value')?.textContent ?? null
}

/** The `spec.approval` a logged PUT sent. */
function sentApproval(entry: FakeLogEntry): unknown {
  return (entry.body as { spec: Record<string, unknown> }).spec.approval
}

/** The version of the Host a logged read answered. */
function versionRead(entry: FakeLogEntry): string | undefined {
  return (entry.response?.body as HostObject).metadata.resourceVersion
}

async function clickAndSettle(): Promise<void> {
  await clickSetToManual()
  await waitFor(() => expect(offSwitchResult()).not.toBeNull())
}

let clock: VirtualClock

describe('HostApprovalsTab — Set to Manual now', () => {
  beforeEach(() => {
    resetApprovalTestState()
    clock = createVirtualClock()
    __setApprovalClockForTests(clock, seededRandom(21))
  })
  afterEach(() => {
    resetApprovalTestState()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('in every state of the tab (spec §6.3, §6.12, C13)', () => {
    it('T16-partner the switch is shown after a failed first load', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      failNextRead(fake, FOO_DETAIL)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await waitFor(() => expect(tabLoadBanner()).not.toBeNull())

      expect(perToolSection(), 'no per-tool section (T16)').toBeNull()
      const button = screen.getByRole('button', { name: SET_MANUAL })
      expect(button).toBeEnabled()
      expect(button).not.toHaveAttribute('aria-disabled')
      expect(screen.getByText(APPROVALS_OFF_NOTE), 'the static line').toBeInTheDocument()

      // It needs no loaded data: its own read, then one PUT.
      await clickAndSettle()
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [true, 200],
      ])
      expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'manual' })
      expect(resultParagraphs()).toEqual([manualMessage({ already: false, skip: NO_SKIP })])

      // The notice loads the tab again; this time the read answers, and the result stays.
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      expect(tabLoadBanner(), 'the banner after the load answered').toBeNull()
      expect(setToManualButton(), 'the same switch').toBe(button)
      expect(resultParagraphs()).toEqual([manualMessage({ already: false, skip: NO_SKIP })])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('the switch is shown while the first load runs, and its result stays when the load lands', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const first = fake.hold({ method: 'GET', path: FOO_DETAIL })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await act(async () => {
        await first.arrived
      })
      expect(screen.getByRole('status', { name: 'Loading approval settings' })).toBeInTheDocument()
      const button = screen.getByRole('button', { name: SET_MANUAL })

      await clickAndSettle()
      expect(resultParagraphs()).toEqual([manualMessage({ already: false, skip: NO_SKIP })])
      expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'manual' })

      // The notice's load shows the stored ceiling; the first load, which took
      // the Host before the switch wrote, lands after it and changes nothing.
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      await act(async () => {
        first.deliverNow()
      })
      await settle()
      expect(rowValue('Highest mode')).toBe('Manual')
      expect(setToManualButton(), 'the same switch').toBe(button)
      expect(resultParagraphs()).toEqual([manualMessage({ already: false, skip: NO_SKIP })])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('shows the static line and the How to change these link beside the switch (Ruling 43(c))', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()

      expect(screen.getByText(APPROVALS_OFF_NOTE)).toBeInTheDocument()
      const link = screen.getByRole('link', { name: 'How to change these' })
      expect(link).toHaveAttribute('href', `${HOW_TO}#approval-modes`)
      expect(link).toHaveAttribute('target', '_blank')
      expect(setToManualButton()).toHaveTextContent(SET_MANUAL)
      tab.unmount()
    })
  })

  describe('the decision is the switch’s own (R4, C6)', () => {
    it('T4 page data says Manual, the Host says Auto: it writes, and lists what its own read holds', async () => {
      const fake = tabFake({ modeCeiling: 'manual' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      expect(rowValue('Highest mode'), 'what the page shows').toBe('Manual')
      const button = setToManualButton()
      expect(button, 'never disabled from the page').toBeEnabled()
      expect(button).not.toHaveAttribute('aria-disabled')
      expect(button).toHaveTextContent(SET_MANUAL)

      // Another admin raises the ceiling and sets a tool to Skip. No notice
      // reaches this tab: it still shows Manual and no Skip.
      fake.writeExternal('foo', spec => {
        spec.approval = { modeCeiling: 'auto', tools: { http_request: false } }
      })
      await clickAndSettle()

      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [true, 200],
      ])
      expect(sentApproval(writes(fake)[0])).toEqual({
        modeCeiling: 'manual',
        tools: { http_request: false },
      })
      expect(fake.stored('foo').spec.approval).toEqual({
        modeCeiling: 'manual',
        tools: { http_request: false },
      })
      expect(resultParagraphs(), 'saved, with the Skip tool of its own read').toEqual([
        manualMessage({ already: false, skip: 'http_request' }),
      ])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('T20 Set to Manual now opens no dialog and sends one PUT on an auto Host', async () => {
      const fake = tabFake({ modeCeiling: 'auto', tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const notices = vi.fn()
      subscribeHostChanged('foo', notices)
      // The load the notice starts waits, so what the switch's answer seeds shows.
      const reload = fake.hold({ method: 'GET', path: FOO_DETAIL })
      const loadsBefore = reads(fake, FOO_DETAIL).length
      const button = setToManualButton()

      // Two presses in one tick: the second is ignored (spec §6.3 step 1).
      await act(async () => {
        fireEvent.click(button)
        fireEvent.click(button)
      })
      expect(screen.queryByRole('dialog'), 'no dialog').toBeNull()
      expect(screen.queryByRole('alertdialog'), 'no confirmation').toBeNull()
      await waitFor(() => expect(offSwitchResult()).not.toBeNull())
      // A bounded wait for that load: without a notice it fails here, rather
      // than in an act scope that never ends and stalls the tests after it.
      await waitFor(() =>
        expect(
          reads(fake, FOO_DETAIL)
            .slice(loadsBefore)
            .map(entry => entry.arrived)
        ).toEqual([true])
      )

      expect(reads(fake), "the switch's one read").toHaveLength(1)
      expect(writes(fake), 'one PUT').toHaveLength(1)
      expect(writes(fake)[0].versionSent, "its read's version").toBe(versionRead(reads(fake)[0]))
      expect(sentApproval(writes(fake)[0])).toEqual({
        modeCeiling: 'manual',
        tools: { json_transform: true },
      })
      expect(fake.stored('foo').spec.approval).toEqual({
        modeCeiling: 'manual',
        tools: { json_transform: true },
      })
      // Spec §6.5: the answer seeds the ceiling while the load is out, and the
      // settled switch tells every Approvals tab of foo to load again.
      expect(rowValue('Highest mode'), 'the seeded ceiling').toBe('Manual')
      expect(notices, 'the Host-changed notice').toHaveBeenCalledTimes(1)
      expect(tab.toasts(), 'no toast: the tab shows the outcome').toEqual([])
      expect(setToManualButton()).toHaveTextContent(SET_MANUAL)

      await act(async () => {
        reload.deliverNow()
      })
      await settle()
      expect(rowValue('Highest mode')).toBe('Manual')
      expect(notices).toHaveBeenCalledTimes(1)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('the per-tool section (spec §6.3 step 8)', () => {
    it('closes nothing: an open per-tool draft stays through the switch and the load after it', async () => {
      const fake = tabFake({ modeCeiling: 'auto', tools: { json_transform: true } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      const driver = await approvalSettingsDriver()
      await driver.edit()
      await driver.editTool('system_info', 'required')
      const loadsBefore = reads(fake, FOO_DETAIL).length

      await clickAndSettle()
      // The notice's load lands while the section is still being edited.
      await waitFor(() =>
        expect(
          reads(fake, FOO_DETAIL)
            .slice(loadsBefore)
            .some(entry => entry.delivered)
        ).toBe(true)
      )
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      await settle()

      expect(overrides(driver.readView()), 'the draft').toEqual({
        json_transform: 'Required',
        system_info: 'Required',
      })
      const section = perToolSection() as HTMLElement
      expect(within(section).getByRole('button', { name: 'Save' }), 'still dirty').toBeEnabled()
      expect(writes(fake), "the switch's PUT only").toHaveLength(1)
      expect(fake.stored('foo').spec.approval).toEqual({
        modeCeiling: 'manual',
        tools: { json_transform: true },
      })
      tab.unmount()
    })
  })

  describe('the message (spec §6.3 step 7)', () => {
    it('the success message lists Skip overrides, never-ask tools and the survival rules verbatim', async () => {
      const fake = tabFake({
        modeCeiling: 'auto',
        tools: { http_request: false, shell_exec: true, custom_lookup: false },
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([
        manualMessage({ already: false, skip: 'custom_lookup, http_request' }),
      ])
      // Linked: the Skip tools to the per-tool section, what keeps running to
      // the how-to's kill-switch section.
      const result = offSwitchResult() as HTMLElement
      expect(within(result).getByRole('link', { name: 'tools set to Skip' })).toHaveAttribute(
        'href',
        `#${PER_TOOL_ANCHOR}`
      )
      expect(document.getElementById(PER_TOOL_ANCHOR)).toContainElement(perToolSection())
      expect(
        within(result).getByRole('link', { name: 'Still running without a card' })
      ).toHaveAttribute('href', `${HOW_TO}#kill-switch`)
      tab.unmount()
    })

    it('announces the message from a live region there before the press, with the disclosure and the manifest warning outside it (finding 1)', async () => {
      const fake = createFakeControlApi({
        hosts: { foo: fooFrom('host-kubectl-applied') },
        crd: 'current',
        versionRule: true,
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      // Mounted before any run, and empty: a polite region inserted with its
      // text already in it is not reliably announced.
      const live = switchLiveRegion()
      expect(live).toHaveAttribute('aria-live', 'polite')
      expect(live).toBeEmptyDOMElement()

      await clickAndSettle()
      expect(switchLiveRegion(), 'the same region gains the message').toBe(live)
      expect(text(live)).toBe(manualMessage({ already: false, skip: NO_SKIP }))
      // Only the message: opening the disclosure re-reads nothing.
      const result = offSwitchResult() as HTMLElement
      const details = within(result)
        .getByText(/^Tools that never ask \(/)
        .closest('details') as HTMLElement
      const warning = within(result).getByText(
        manifestWarning('Highest mode: Allow all; Policy: Any channel user')
      )
      expect(result).toContainElement(details)
      expect(result).toContainElement(warning)
      expect(live).not.toContainElement(details)
      expect(live).not.toContainElement(warning)
      tab.unmount()
    })

    it('lists the tools that never ask in a disclosure below the message: its count, closed, then every tool with its conditions (Ruling 48(b))', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      // The producer fixture's list (spec §6.11), as in the read view (Ruling 44(d)).
      const neverAsk = neverAskTools()
      const result = offSwitchResult() as HTMLElement
      const summary = within(result).getByText(`Tools that never ask (${neverAsk.length})`)
      const details = summary.closest('details') as HTMLDetailsElement
      expect(result, 'the disclosure is part of the result').toContainElement(details)
      expect(resultParagraphs()[0], 'the message points at it').toContain(
        'tools that never ask (listed below)'
      )

      // Closed by default: no tool shows.
      expect(details.open).toBe(false)
      const items = Array.from(details.querySelectorAll('li'))
      expect(items, 'one row per tool').toHaveLength(neverAsk.length)
      for (const item of items) expect(item).not.toBeVisible()

      // Opened, it shows every tool, each with its conditions.
      fireEvent.click(summary)
      expect(details.open).toBe(true)
      for (const item of items) expect(item).toBeVisible()
      expect(items.map(item => item.querySelector('code')?.textContent)).toEqual(
        neverAsk.map(tool => tool.name)
      )
      expect(items.map(item => item.textContent)).toEqual(
        neverAsk.map(tool => `${tool.name}${tool.conditions ?? ''}`)
      )
      expect(
        neverAsk.filter(tool => tool.conditions).length,
        'tools whose rows carry conditions'
      ).toBeGreaterThan(0)
      tab.unmount()
    })

    it('already Manual on an inheriting Host mentions cluster-default Skip tools', async () => {
      const fake = tabFake(undefined)
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([
        manualMessage({ already: true, skip: NO_SKIP, inherited: true }),
      ])
      expect(reads(fake), "the switch's own read").toHaveLength(1)
      expect(writes(fake), 'nothing written').toEqual([])
      expect(fake.stored('foo').spec, 'no block created').not.toHaveProperty('approval')
      tab.unmount()
    })

    it('an agent with its own settings, even an empty block, gets the message without the cluster-default clause (Ruling 48(a))', async () => {
      // `{}` is a block of the agent's own (Review Focus 1): mcp-host reads no
      // cluster default for it.
      const fake = tabFake({})
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([manualMessage({ already: true, skip: NO_SKIP })])
      expect(resultParagraphs()[0]).not.toContain('cluster default')
      expect(writes(fake), 'nothing written').toEqual([])
      tab.unmount()
    })

    it('already Manual on a Host with its own settings says so, with its Skip overrides', async () => {
      const fake = tabFake({ modeCeiling: 'manual', tools: { shell_exec: false } })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([manualMessage({ already: true, skip: 'shell_exec' })])
      expect(reads(fake), "the switch's own read").toHaveLength(1)
      expect(writes(fake), 'nothing written').toEqual([])
      tab.unmount()
    })

    it('Review Focus 3: lists a stored off-pattern Skip key as still running', async () => {
      // Keys the editor would not accept, written with kubectl.
      const fake = tabFake({
        modeCeiling: 'auto',
        tools: { Bash: false, 'my-server__tool': false, json_transform: true },
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([
        manualMessage({ already: false, skip: 'Bash, my-server__tool' }),
      ])
      expect(fake.stored('foo').spec.approval).toEqual({
        modeCeiling: 'manual',
        tools: { Bash: false, 'my-server__tool': false, json_transform: true },
      })
      tab.unmount()
    })

    it.each([
      [
        'host-kubectl-applied',
        manifestWarning('Highest mode: Allow all; Policy: Any channel user'),
      ],
      ['host-server-side-applied', MANIFEST_WARNING_NO_VALUES],
    ])(
      'T28 on %s the message adds that the next deploy puts the manifest back',
      async (fixture, warning) => {
        const fake = createFakeControlApi({
          hosts: { foo: fooFrom(fixture) },
          crd: 'current',
          versionRule: true,
        })
        const tab = renderApprovalsTab({ fake, host: 'foo' })
        await approvalSettingsDriver()
        await clickAndSettle()

        expect(
          writes(fake).map(entry => entry.applied),
          'the switch wrote'
        ).toEqual([true])
        expect(resultParagraphs()).toEqual([
          manualMessage({ already: false, skip: NO_SKIP }),
          warning,
        ])
        tab.unmount()
      }
    )

    it("security m-4: the warning comes from the switch's own read when the answer shows no Apply ownership", async () => {
      // The apiserver moves a field's ownership to the manager whose Update
      // changed it, so control-api's replace can take `f:approval` from the
      // Apply entry. The answer here is the recorded Control UI-edited Host
      // (its managedFields hold Update entries only), at Manual.
      const fake = createFakeControlApi({
        hosts: { foo: fooFrom('host-server-side-applied') },
        crd: 'current',
        versionRule: true,
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })
      const edited = fooFrom('host-control-ui-edited')
      await act(async () => {
        put.respondWith(200, {
          ...edited,
          spec: {
            ...edited.spec,
            approval: {
              ...(edited.spec.approval as Record<string, unknown>),
              modeCeiling: 'manual',
            },
          },
        })
      })
      await waitFor(() => expect(offSwitchResult()).not.toBeNull())

      expect(resultParagraphs()).toEqual([
        manualMessage({ already: false, skip: NO_SKIP }),
        MANIFEST_WARNING_NO_VALUES,
      ])
      tab.unmount()
    })

    it('T28 partner: a Host edited through the Control UI gets no manifest warning', async () => {
      const fake = createFakeControlApi({
        hosts: { foo: fooFrom('host-control-ui-edited') },
        crd: 'current',
        versionRule: true,
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      await clickAndSettle()

      expect(
        writes(fake).map(entry => entry.applied),
        'the switch wrote'
      ).toEqual([true])
      expect(resultParagraphs()).toEqual([manualMessage({ already: false, skip: NO_SKIP })])
      tab.unmount()
    })
  })

  describe('failure (spec §6.3 step 6)', () => {
    it.each([
      ['403', PUT_403, clientMessage(PUT_403)],
      [
        '422',
        PUT_422,
        // The protocol's step-6 text: each `field: message` of the 422.
        'spec.model.provider: spec.model.provider is required when spec.model.name is set',
      ],
    ])(
      'a failure shows the kubectl fallback and a root toast (%s on the PUT)',
      async (_status, answer, message) => {
        const fake = tabFake({ modeCeiling: 'auto' })
        const tab = renderApprovalsTab({ fake, host: 'foo' })
        await approvalSettingsDriver()
        const notices = vi.fn()
        subscribeHostChanged('foo', notices)
        const put = fake.hold({ method: 'PUT', path: FOO })
        await clickSetToManual()
        await act(async () => {
          await put.arrived
        })
        await act(async () => {
          put.respondWith(answer.status, answer.body)
        })
        await waitFor(() => expect(offSwitchResult()).not.toBeNull())

        expect(offSwitchResult()).toHaveAttribute('role', 'alert')
        expect(resultParagraphs()).toEqual([failedText(message), FALLBACK_INTRO])
        expect(fallbackShown()).toBe(fallback('mcp-host', 'foo'))
        expect(tab.toasts('error'), 'the root toast').toEqual([failedText(message)])
        expect(notices, 'the Host-changed notice').toHaveBeenCalledTimes(1)
        expect(fake.stored('foo').spec.approval, 'nothing stored').toEqual({ modeCeiling: 'auto' })
        expect(setToManualButton(), 'it can be pressed again').toHaveTextContent(SET_MANUAL)
        expect(unanswered(fake)).toEqual([])
        tab.unmount()
      }
    )

    it("the fallback names the namespace the tab loaded when the switch's read failed", async () => {
      const host = seedHost('foo', { approval: { modeCeiling: 'auto' } })
      host.metadata.namespace = 'tenant-a'
      const fake = createFakeControlApi({ hosts: { foo: host }, crd: 'current', versionRule: true })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const read = fake.hold({ method: 'GET', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await read.arrived
      })
      // Ruling 35: a 4xx on the switch's read ends the run. control-api's 403
      // envelope, recorded on a PUT.
      await act(async () => {
        read.respondWith(PUT_403.status, PUT_403.body)
      })
      await waitFor(() => expect(offSwitchResult()).not.toBeNull())

      // The message the real client gives the same read.
      const oracle = fake.hold({ method: 'GET', path: FOO })
      const message = getHost('foo', { signal: new AbortController().signal }).then(
        () => 'no error',
        (error: unknown) => (error as Error).message
      )
      await act(async () => {
        await oracle.arrived
      })
      oracle.respondWith(PUT_403.status, PUT_403.body)
      expect(await message).not.toBe('no error')

      expect(fallbackShown()).toBe(fallback('tenant-a', 'foo'))
      expect(resultParagraphs()).toEqual([failedText(await message), FALLBACK_INTRO])
      expect(writes(fake), 'no PUT').toEqual([])
      tab.unmount()
    })

    it('a run that throws shows its error as a failure, with the fallback and a root toast', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      // A message that ends its own sentence gets no second full stop.
      const failure = new Error('The clock failed.')
      __setApprovalClockForTests(
        {
          ...clock,
          setTimeout: () => {
            throw failure
          },
        },
        seededRandom(21)
      )
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
      await clickAndSettle()

      expect(resultParagraphs()).toEqual([
        'Manual was not saved. The clock failed.',
        FALLBACK_INTRO,
      ])
      expect(fallbackShown()).toBe(fallback('mcp-host', 'foo'))
      expect(tab.toasts('error')).toEqual(['Manual was not saved. The clock failed.'])
      expect(reported).toHaveBeenCalledWith(expect.stringContaining('Set to Manual now'), failure)
      expect(setToManualButton(), 'the run ended').toHaveTextContent(SET_MANUAL)
      expect(writes(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('every tab that shows the agent (R19) and continuations (C18)', () => {
    it('T19 every mounted tab shows Setting Manual… while it runs; only the tab that ran it shows the outcome', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      vi.stubGlobal('fetch', fake.fetch)
      setControlUIReadPrincipal('unit-test-admin', 'admin')
      const view = render(
        <ToastProvider>
          <section aria-label="first">
            <HostApprovalsTab host="foo" />
          </section>
          <section aria-label="second">
            <HostApprovalsTab host="foo" />
          </section>
        </ToastProvider>
      )
      const first = screen.getByRole('region', { name: 'first' })
      const second = screen.getByRole('region', { name: 'second' })
      await waitFor(() => expect(rowValue('Highest mode', second)).toBe('Auto'))
      await waitFor(() => expect(rowValue('Highest mode', first)).toBe('Auto'))
      const put = fake.hold({ method: 'PUT', path: FOO })

      await act(async () => {
        fireEvent.click(within(first).getByRole('button', { name: SET_MANUAL }))
      })
      await act(async () => {
        await put.arrived
      })
      for (const tab of [first, second]) {
        expect(within(tab).getByRole('button', { name: SETTING_MANUAL })).toHaveAttribute(
          'aria-disabled',
          'true'
        )
      }
      // A press in the other tab while it runs starts nothing.
      await act(async () => {
        fireEvent.click(within(second).getByRole('button', { name: SETTING_MANUAL }))
      })
      expect(reads(fake), 'one read').toHaveLength(1)
      expect(writes(fake), 'one PUT').toHaveLength(1)

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(resultParagraphs(first)).toHaveLength(1))
      expect(resultParagraphs(first)).toEqual([manualMessage({ already: false, skip: NO_SKIP })])
      expect(resultParagraphs(second), 'the tab that did not run it').toEqual([])
      for (const tab of [first, second]) {
        expect(within(tab).getByRole('button', { name: SET_MANUAL })).not.toHaveAttribute(
          'aria-disabled'
        )
        // Both load again on the notice.
        await waitFor(() => expect(rowValue('Highest mode', tab)).toBe('Manual'))
      }
      expect(reads(fake)).toHaveLength(1)
      expect(writes(fake)).toHaveLength(1)
      expect(unanswered(fake)).toEqual([])
      view.unmount()
    })

    it('T19 a remounted tab shows Setting Manual…, and the outcome of the tab that is gone goes to the root toast', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })

      // E19: the admin leaves the tab and comes back; the shipped build remounts it.
      tab.remount()
      await approvalSettingsDriver()
      expect(setToManualButton()).toHaveTextContent(SETTING_MANUAL)
      expect(setToManualButton()).toHaveAttribute('aria-disabled', 'true')
      await clickSetToManual()
      expect(reads(fake), 'the press while it runs read nothing').toHaveLength(1)

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('success')).toEqual([savedFor('foo')]))
      expect(offSwitchResult(), 'the new tab did not run it').toBeNull()
      expect(setToManualButton()).toHaveTextContent(SET_MANUAL)
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Manual'))
      expect(writes(fake)).toHaveLength(1)
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('a switch that settles after the tab was left reports in the root toast, naming the agent, and fires the notice', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })
      const notices = vi.fn()
      subscribeHostChanged('foo', notices)

      tab.leave()
      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('success')).toEqual([savedFor('foo')]))
      expect(notices, 'the Host-changed notice').toHaveBeenCalledTimes(1)
      expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'manual' })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it('an Already Manual that settles after the tab was left reports in the root toast, naming the agent (finding 2)', async () => {
      const fake = tabFake({ modeCeiling: 'manual' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const read = fake.hold({ method: 'GET', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await read.arrived
      })
      const notices = vi.fn()
      subscribeHostChanged('foo', notices)

      tab.leave()
      await act(async () => {
        read.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('success')).toEqual([alreadyFor('foo')]))
      expect(notices, 'the Host-changed notice').toHaveBeenCalledTimes(1)
      expect(reads(fake), "the switch's one read").toHaveLength(1)
      expect(writes(fake), 'nothing written').toEqual([])
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })

    it.each([
      [
        'host-kubectl-applied',
        manifestWarning('Highest mode: Allow all; Policy: Any channel user'),
      ],
      ['host-server-side-applied', MANIFEST_WARNING_NO_VALUES],
    ])(
      'I-1 on %s a switch that settles after the tab was left adds the manifest warning to the root toast',
      async (fixture, warning) => {
        const fake = createFakeControlApi({
          hosts: { foo: fooFrom(fixture) },
          crd: 'current',
          versionRule: true,
        })
        const tab = renderApprovalsTab({ fake, host: 'foo' })
        await approvalSettingsDriver()
        const put = fake.hold({ method: 'PUT', path: FOO })
        await clickSetToManual()
        await act(async () => {
          await put.arrived
        })

        tab.leave()
        await act(async () => {
          put.deliverNow()
        })
        await waitFor(() => expect(tab.toasts('success')).toEqual([savedFor('foo', warning)]))
        expect(
          writes(fake).map(entry => entry.applied),
          'the switch wrote'
        ).toEqual([true])
        expect(unanswered(fake)).toEqual([])
        tab.unmount()
      }
    )

    it("I-1 with security m-4: the root toast takes the manifest warning from the switch's own read when the answer shows no Apply ownership", async () => {
      // As in the in-tab m-4 test: the answer is the recorded Control
      // UI-edited Host (Update entries only), at Manual.
      const fake = createFakeControlApi({
        hosts: { foo: fooFrom('host-server-side-applied') },
        crd: 'current',
        versionRule: true,
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })

      tab.leave()
      const edited = fooFrom('host-control-ui-edited')
      await act(async () => {
        put.respondWith(200, {
          ...edited,
          spec: {
            ...edited.spec,
            approval: {
              ...(edited.spec.approval as Record<string, unknown>),
              modeCeiling: 'manual',
            },
          },
        })
      })
      await waitFor(() =>
        expect(tab.toasts('success')).toEqual([savedFor('foo', MANIFEST_WARNING_NO_VALUES)])
      )
      tab.unmount()
    })

    it('I-1 an Already Manual on an agent a manifest sets adds the manifest warning to the root toast', async () => {
      // The ceiling was lowered by hand; the manifest still says Allow all.
      const applied = fooFrom('host-kubectl-applied')
      const fake = createFakeControlApi({
        hosts: {
          foo: {
            ...applied,
            spec: {
              ...applied.spec,
              approval: {
                ...(applied.spec.approval as Record<string, unknown>),
                modeCeiling: 'manual',
              },
            },
          },
        },
        crd: 'current',
        versionRule: true,
      })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const read = fake.hold({ method: 'GET', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await read.arrived
      })

      tab.leave()
      await act(async () => {
        read.deliverNow()
      })
      await waitFor(() =>
        expect(tab.toasts('success')).toEqual([
          alreadyFor('foo', manifestWarning('Highest mode: Allow all; Policy: Any channel user')),
        ])
      )
      expect(writes(fake), 'nothing written').toEqual([])
      tab.unmount()
    })

    it('a throw while it reports its outcome still fires the notice and is reported (finding 4)', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })
      const notices = vi.fn()
      subscribeHostChanged('foo', notices)
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
      // A root-toast listener that throws, subscribed after the page's own:
      // the continuation's toast throws out of the step that reports it.
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
            expect.stringContaining('Set to Manual now'),
            failure
          )
        )
        // The page's listener came first, so its toast still shows.
        expect(tab.toasts('success')).toEqual([savedFor('foo')])
        expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'manual' })
      } finally {
        unsubscribe()
      }
      tab.unmount()
    })

    it('a failure after the tab was left goes to the root toast once, naming the agent, with the fallback, for 30 s (minor 5)', async () => {
      const fake = tabFake({ modeCeiling: 'auto' })
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })
      // What the root toast was asked to show, with its options.
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
        await settle()
      } finally {
        unsubscribe()
      }
      const failed = failedFor('foo', clientMessage(PUT_403), fallback('mcp-host', 'foo'))
      expect(tab.toasts('error')).toEqual([failed])
      expect(tab.toasts('success')).toEqual([])
      // Minor 5: it carries the kubectl fallback, so it stays 30 s, not the 8 s
      // of other problems.
      expect(emitted).toEqual([[failed, { tone: 'error', durationMs: 30_000 }]])
      tab.unmount()
    })

    it('a switch that settles after a kept tab moved to another agent goes to the root toast and shows nothing on that agent', async () => {
      const fake = tabFake(
        { modeCeiling: 'auto' },
        { b: seedHost('b', { approval: { modeCeiling: 'auto' } }) }
      )
      const tab = renderApprovalsTab({ fake, host: 'foo' })
      await approvalSettingsDriver()
      const put = fake.hold({ method: 'PUT', path: FOO })
      await clickSetToManual()
      await act(async () => {
        await put.arrived
      })

      tab.rerenderKept('b')
      await waitFor(() => expect(reads(fake, B_DETAIL).some(entry => entry.delivered)).toBe(true))
      await waitFor(() => expect(rowValue('Highest mode')).toBe('Auto'))
      expect(setToManualButton(), 'no switch runs for b').toHaveTextContent(SET_MANUAL)

      await act(async () => {
        put.deliverNow()
      })
      await waitFor(() => expect(tab.toasts('success')).toEqual([savedFor('foo')]))
      await settle()
      expect(offSwitchResult(), "nothing of foo's switch on b").toBeNull()
      expect(rowValue('Highest mode'), "b's ceiling").toBe('Auto')
      expect(fake.stored('foo').spec.approval).toEqual({ modeCeiling: 'manual' })
      expect(fake.stored('b').spec.approval).toEqual({ modeCeiling: 'auto' })
      expect(unanswered(fake)).toEqual([])
      tab.unmount()
    })
  })

  describe('a reload (R24)', () => {
    it.each([
      ['control-api applied the PUT', true, 'Manual'],
      ['control-api had not applied the PUT', false, 'Auto'],
    ])(
      'T30 after a reload mid-switch the read view shows the stored ceiling (%s)',
      async (_case, applied, ceiling) => {
        const fake = tabFake({ modeCeiling: 'auto' })
        const tab = renderApprovalsTab({ fake, host: 'foo' })
        await approvalSettingsDriver()
        const put = fake.hold({ method: 'PUT', path: FOO })
        await clickSetToManual()
        await act(async () => {
          await put.arrived
        })
        if (applied) {
          put.applyNow()
          await waitFor(() => expect(writes(fake)[0].applied).toBe(true))
        }

        // E24: the admin reloads. The page and its module state go with the
        // run, whose answer never comes; the new page starts on a new clock.
        tab.unmount()
        resetApprovalTestState()
        __setApprovalClockForTests(createVirtualClock(), seededRandom(22))
        const again = renderApprovalsTab({ fake, host: 'foo' })
        await approvalSettingsDriver()

        expect(rowValue('Highest mode'), 'the stored ceiling').toBe(ceiling)
        expect(setToManualButton(), 'no run in the new page').toHaveTextContent(SET_MANUAL)
        expect(setToManualButton()).not.toHaveAttribute('aria-disabled')
        expect(offSwitchResult()).toBeNull()
        expect(again.toasts()).toEqual([])
        expect(
          writes(fake).map(entry => entry.delivered),
          'the answer reached no page'
        ).toEqual([false])
        again.unmount()
      }
    )
  })
})
