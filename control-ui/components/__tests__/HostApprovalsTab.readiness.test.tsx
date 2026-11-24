/**
 * The approval settings scenarios that run before the change (spec §8, A6
 * readiness), named after the spec §7 A3 rows they test. Each test asserts the
 * spec's target outcome through the driver, which hides where the per-tool
 * section lives. Against the page before PR A, T2x passes as a baseline and
 * the others fail for the defect their row names.
 *
 * The fake runs with `versionRule: false`, as control-api did before PR A. A
 * read the UI cannot start while a save keeps Save disabled is started by the
 * test through `lib/api` (T9, T23). Every per-tool edit moves a tool whose
 * default is Skip to Required, which never loosens (§6.6), so no confirmation
 * dialog stands between Save and the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getHost, getHostDetailBundle } from '../../lib/api'
import {
  type ApprovalSettingsDriver,
  errorBanners,
  openApprovalSettings,
  pageMountDefaults,
  perToolSection,
  renderHostPage,
  resetApprovalTestState,
  showApprovalSettings,
} from '../../test/fixtures/approvalPageHarness'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import {
  type FakeControlApi,
  type FakeLogEntry,
  type HostObject,
  createFakeControlApi,
} from '../../test/fixtures/fakeControlApi'
import { buildGuardrailDetailScenario } from '../../test/fixtures/guardrailProducer'

const FOO = '/api/v1/admin/hosts/foo'
const FOO_DETAIL = `${FOO}/detail`
const B_DETAIL = '/api/v1/admin/hosts/b/detail'
const C_DETAIL = '/api/v1/admin/hosts/c/detail'

// Spec §6.4 steps 3 and 4, verbatim.
const CHANGED_SINCE_OPENED =
  'These settings changed since you opened them. Reload to see the latest.'
const CREATED_ELSEWHERE =
  "This agent's approval settings were just created elsewhere. Reload to see them."

type WireAnswer = { status: number; body: unknown }

// The proxy's own 504 (app/control-api/[...path]/route.ts), recorded by its route.wireBodies test.
const PROXY_504 = JSON.parse(
  readFileSync(resolve(__dirname, '../../test/fixtures/wire/proxy-504.wire.json'), 'utf8')
) as WireAnswer

// control-api's production 500 for a /detail read that fails unexpectedly,
// recorded by control-api/test/routes.hostPut.fakeContract.test.ts.
const DETAIL_500 = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/host-detail-500.wire.json'),
    'utf8'
  )
) as WireAnswer

function seedHost(name: string, spec: Record<string, unknown> = {}): HostObject {
  return materializeHostResource(
    {
      metadata: { name },
      spec: {
        host: name,
        contextRef: 'ctx-a',
        secretRef: `${name}-llm`,
        channels: [],
        model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      },
    },
    { spec }
  )
}

function createFake(hosts: Record<string, HostObject>): FakeControlApi {
  return createFakeControlApi({
    hosts,
    crd: 'current',
    versionRule: false,
    defaults: pageMountDefaults(),
  })
}

function approvalOf(spec: Record<string, unknown>): Record<string, unknown> {
  return spec.approval as Record<string, unknown>
}

function writes(fake: FakeControlApi, path = FOO): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'write' && entry.path === path)
}

function reads(fake: FakeControlApi, path: string): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'read' && entry.path === path)
}

/** The rows set to something other than their default, as the driver reads them. */
function overrides(view: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(view).filter(([, state]) => state !== 'Default'))
}

/** Lets the work the last answers started run to its end, inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(done => setTimeout(done, 50))
  })
}

/**
 * Answers the first `count` GETs of `path` from now with control-api's recorded
 * 500, each as it arrives. A navigation remounts the page, and the target tab
 * reads the Host on its own beside the page, so a first load is more than one
 * read.
 */
function failReads(fake: FakeControlApi, path: string, count: number): void {
  for (let nth = 1; nth <= count; nth += 1) {
    const hold = fake.hold({ method: 'GET', path, nth })
    void hold.arrived.then(() => hold.respondWith(DETAIL_500.status, DETAIL_500.body))
  }
}

/** foo, opened in the per-tool editor with system_info moved to Required. */
async function openFooWithDraft(
  approval: Record<string, unknown> = { tools: { json_transform: true } }
) {
  const fake = createFake({ foo: seedHost('foo', { approval }) })
  const page = renderHostPage({ fake, name: 'foo' })
  const driver = await openApprovalSettings(page)
  await driver.edit()
  await driver.editTool('system_info', 'required')
  return { fake, page, driver }
}

const SAVED_TOOLS = { json_transform: true, system_info: true }
const SAVED_VIEW = { json_transform: 'Required', system_info: 'Required' }
// T8's other agents: neither shares a tool with foo's saved view.
const B_VIEW = { clerum__generate_pdf: 'Required' }
const C_VIEW = { clerum__generate_docx: 'Required' }

/** foo's saved overrides that are on screen: none when no per-tool section is rendered. */
function fooSavedShown(driver: ApprovalSettingsDriver): Record<string, string> {
  if (!perToolSection()) return {}
  const shown = overrides(driver.readView())
  return Object.fromEntries(
    Object.entries(SAVED_VIEW).filter(([name, state]) => shown[name] === state)
  )
}

describe('approval settings readiness (spec §7 A3)', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => vi.unstubAllGlobals())

  it('T1 the per-tool PUT carries its read version, so a spec change made during the PUT survives', async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const put = fake.hold({ method: 'PUT', path: FOO })
    await driver.save()
    await act(async () => {
      await put.arrived
    })
    fake.writeExternal('foo', spec => {
      spec.contextRef = 'c2'
    })
    await act(async () => {
      put.deliverNow()
    })
    await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
    await settle()

    expect.soft(writes(fake)[0].versionSent, 'the first PUT carries a version').toBeDefined()
    expect.soft(fake.stored('foo').spec.contextRef, 'the other writer’s contextRef').toBe('c2')
    expect(approvalOf(fake.stored('foo').spec)).toEqual({ tools: SAVED_TOOLS })
    page.unmount()
  })

  it('T2 an external change to tools after Edit stops the save with no PUT', async () => {
    const fake = createFake({
      foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    fake.writeExternal('foo', spec => {
      approvalOf(spec).tools = { json_transform: true, shell_exec: false }
    })
    await driver.editTool('system_info', 'required')
    await driver.save()
    // The save's own read of the Host shows it ran.
    await waitFor(() => expect(reads(fake, FOO)).not.toHaveLength(0))
    await settle()

    expect.soft(writes(fake), 'PUTs after the external change').toHaveLength(0)
    expect.soft(driver.message() ?? '', 'the stop message').toContain(CHANGED_SINCE_OPENED)
    expect
      .soft(approvalOf(fake.stored('foo').spec), 'the other writer’s tools')
      .toEqual({ tools: { json_transform: true, shell_exec: false } })
    expect(overrides(driver.readView()), 'the draft is kept').toEqual(SAVED_VIEW)
    page.unmount()
  })

  it('T2x an external defaultPolicy change after Edit is kept by the save (baseline)', async () => {
    const fake = createFake({
      foo: seedHost('foo', {
        approval: { defaultPolicy: 'channel_users', tools: { json_transform: true } },
      }),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    fake.writeExternal('foo', spec => {
      approvalOf(spec).defaultPolicy = 'cli_only'
    })
    await driver.editTool('system_info', 'required')
    await driver.save()
    await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
    await settle()

    expect(approvalOf(fake.stored('foo').spec)).toEqual({
      defaultPolicy: 'cli_only',
      tools: SAVED_TOOLS,
    })
    page.unmount()
  })

  it('T7 leaving the tab during the per-tool PUT reports the outcome in the root toast naming the agent', async () => {
    // "No component write after unmount" cannot be observed on React 18; "Host-changed notice fires" is T8r's (Task 21a).
    const { fake, page, driver } = await openFooWithDraft()
    const put = fake.hold({ method: 'PUT', path: FOO })
    await driver.save()
    await act(async () => {
      await put.arrived
    })
    await page.navigate('Overview')
    await act(async () => {
      put.deliverNow()
    })
    // The client got the answer after the tab was left, so the continuation ran.
    await waitFor(() => expect(writes(fake)[0].delivered).toBe(true))
    await settle()

    expect(writes(fake)).toHaveLength(1)
    expect(writes(fake)[0].applied).toBe(true)
    expect(approvalOf(fake.stored('foo').spec)).toEqual({ tools: SAVED_TOOLS })
    expect(page.toasts('success'), 'success toasts').toContainEqual(expect.stringContaining('foo'))
    page.unmount()
  })

  it("T8 a late refresh of an agent the kept instance has left never shows that agent's tools (harness-only)", async () => {
    // Three agents. After its first load the target keeps the section mounted
    // and shows the last values it applied until a newer load applies, so the
    // load that lands last decides the screen. foo's refresh must therefore land
    // while the screen shows another agent (b) and a load is still out (c):
    // only then does what is on screen tell whether foo's refresh was painted.
    const fake = createFake({
      foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
      b: seedHost('b', { approval: { tools: { clerum__generate_pdf: true } } }),
      c: seedHost('c', { approval: { tools: { clerum__generate_docx: true } } }),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    await driver.editTool('system_info', 'required')
    const fooRefresh = fake.hold({ method: 'GET', path: FOO_DETAIL })
    await driver.save()
    await act(async () => {
      await fooRefresh.arrived
    })

    page.rerenderKept({ name: 'b' })
    await waitFor(() => expect(reads(fake, B_DETAIL).some(entry => entry.delivered)).toBe(true))
    await settle()
    expect(perToolSection(), "b's per-tool section").not.toBeNull()
    expect(overrides(driver.readView()), "b's tools").toEqual(B_VIEW)

    const cLoad = fake.hold({ method: 'GET', path: C_DETAIL })
    page.rerenderKept({ name: 'c' })
    await act(async () => {
      await cLoad.arrived
    })
    await act(async () => {
      fooRefresh.deliverNow()
    })
    await settle()
    // The deciding moment. It is asserted after c's load is released, so that
    // no hold stays open when it fails.
    const fooShownAfterItsRefresh = fooSavedShown(driver)
    await act(async () => {
      cLoad.deliverNow()
    })
    await settle()

    expect(fooShownAfterItsRefresh, "foo's saved tools after foo's late refresh").toEqual({})
    expect(overrides(driver.readView()), "c's tools").toEqual(C_VIEW)
    expect(fooSavedShown(driver), "foo's saved tools after c's load").toEqual({})
    page.unmount()
  })

  it('T9 the refresh after a save does not join a read of the Host started before the write', async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const olderHold = fake.hold({ method: 'GET', path: FOO_DETAIL })
    const older = getHostDetailBundle('foo')
    await act(async () => {
      await olderHold.arrived
    })
    await driver.save()
    await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))
    await settle()
    await act(async () => {
      olderHold.deliverNow()
      await older
    })
    await settle()

    expect.soft(overrides(driver.readView()), 'the tools on screen').toEqual(SAVED_VIEW)
    // The test's read was taken before the write.
    expect((await older).host.spec?.approval).toEqual({ tools: { json_transform: true } })
    page.unmount()
  })

  it('T10 a first save stops when another writer created the approval block, with no PUT', async () => {
    const fake = createFake({ foo: seedHost('foo') })
    const page = renderHostPage({ fake, name: 'foo' })
    const driver = await openApprovalSettings(page)
    await driver.edit()
    fake.writeExternal('foo', spec => {
      spec.approval = { defaultPolicy: 'cli_only', channels: {} }
    })
    const created = approvalOf(fake.stored('foo').spec)
    await driver.editTool('system_info', 'required')
    await driver.save()
    // The save's own read of the Host shows it ran.
    await waitFor(() => expect(reads(fake, FOO)).not.toHaveLength(0))
    await settle()

    expect.soft(writes(fake), 'PUTs after the external write').toHaveLength(0)
    expect.soft(driver.message() ?? '', 'the stop message').toContain(CREATED_ELSEWHERE)
    expect(approvalOf(fake.stored('foo').spec), 'the block the other writer created').toEqual(
      created
    )
    page.unmount()
  })

  it('T10r a save stops when the approval block it opened with was removed, and does not recreate it', async () => {
    // An empty block: present, but every effective value is the default.
    const { fake, page, driver } = await openFooWithDraft({})
    fake.writeExternal('foo', spec => {
      delete spec.approval
    })
    await driver.save()
    // The save's own read of the Host shows it ran.
    await waitFor(() => expect(reads(fake, FOO)).not.toHaveLength(0))
    await settle()

    expect.soft(writes(fake), 'PUTs after the removal').toHaveLength(0)
    expect.soft(fake.stored('foo').spec, 'the removed block').not.toHaveProperty('approval')
    expect(driver.message() ?? '', 'the stop message').toContain(CREATED_ELSEWHERE)
    page.unmount()
  })

  it('T15 a PUT that was applied but got no answer is reported as saved', async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const put = fake.hold({ method: 'PUT', path: FOO })
    await driver.save()
    await act(async () => {
      await put.arrived
    })
    await act(async () => {
      put.dropResponse()
    })
    await waitFor(() => expect(writes(fake)[0].applied).toBe(true))
    await settle()

    expect(approvalOf(fake.stored('foo').spec), 'the write landed').toEqual({ tools: SAVED_TOOLS })
    expect.soft(page.banner(), 'the error shown').toBeNull()
    expect(page.toasts('success'), 'success toasts').toHaveLength(1)
    page.unmount()
  })

  it("T15x a PUT that was applied but answered by the proxy's 504 is reported as saved", async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const put = fake.hold({ method: 'PUT', path: FOO })
    await driver.save()
    await act(async () => {
      await put.arrived
    })
    put.applyNow()
    await waitFor(() => expect(writes(fake)[0].applied).toBe(true))
    await act(async () => {
      put.respondWith(PROXY_504.status, PROXY_504.body)
    })
    await waitFor(() => expect(writes(fake)[0].delivered).toBe(true))
    await settle()

    expect(approvalOf(fake.stored('foo').spec), 'the write landed').toEqual({ tools: SAVED_TOOLS })
    expect.soft(page.banner(), 'the error shown').toBeNull()
    expect(page.toasts('success'), 'success toasts').toHaveLength(1)
    page.unmount()
  })

  it('T16 a failed first load shows a banner with Retry and no per-tool section', async () => {
    const fake = createFake({
      foo: seedHost('foo', { approval: { tools: { json_transform: true } } }),
    })
    failReads(fake, FOO_DETAIL, 4)
    const page = renderHostPage({ fake, name: 'foo' })
    await showApprovalSettings(page)
    // The banner shows that the load settled and its failure reached the page.
    await waitFor(() => expect(errorBanners()).not.toHaveLength(0))
    await settle()

    expect(reads(fake, FOO_DETAIL).map(entry => entry.response?.status)).not.toContain(200)
    expect.soft(perToolSection() === null, 'no per-tool section is rendered').toBe(true)
    const retry = errorBanners().flatMap(banner =>
      within(banner).queryAllByRole('button', { name: 'Retry' })
    )
    expect(retry, 'Retry buttons in the error banner').toHaveLength(1)
    page.unmount()
  })

  it('T17 a failed refresh after a saved PUT keeps the saved tools on screen, shows an error and leaves Save usable', async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const refresh = fake.hold({ method: 'GET', path: FOO_DETAIL })
    await driver.save()
    await act(async () => {
      await refresh.arrived
    })
    // The page renders while the refresh is out, as it does over a network;
    // then the refresh fails.
    await settle()
    await act(async () => {
      refresh.respondWith(DETAIL_500.status, DETAIL_500.body)
    })
    await settle()

    expect(writes(fake)[0].applied, 'the PUT was accepted').toBe(true)
    expect.soft(overrides(driver.readView()), 'the tools on screen').toEqual(SAVED_VIEW)
    expect(errorBanners(), 'error banners after the failed refresh').not.toHaveLength(0)
    // Save is usable again: a further edit is written.
    await driver.edit()
    await driver.editTool('clerum__generate_pdf', 'required')
    await driver.save()
    await waitFor(() => expect(writes(fake).filter(entry => entry.applied)).toHaveLength(2))
    await settle()
    page.unmount()
  })

  it("T23 the per-tool save's read of the Host does not join another read of it in flight", async () => {
    const { fake, page, driver } = await openFooWithDraft()
    const otherHold = fake.hold({ method: 'GET', path: FOO })
    const other = getHost('foo')
    await act(async () => {
      await otherHold.arrived
    })
    await driver.save()
    await settle()

    expect
      .soft(
        reads(fake, FOO).filter(entry => entry.arrived),
        'GET /hosts/foo arrivals'
      )
      .toHaveLength(2)
    await act(async () => {
      otherHold.deliverNow()
      await other
    })
    // The save went through once the other read was answered.
    await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
    await settle()
    page.unmount()
  })

  it('T24 a guardrails save read before an approval change does not revert it after the page reloads', async () => {
    const [scenarioHost] = buildGuardrailDetailScenario('sample-hook', 'foo').hosts.items
    const fake = createFake({
      foo: seedHost('foo', {
        approval: { modeCeiling: 'allow_all', tools: { json_transform: true } },
        guardrails: scenarioHost.spec?.guardrails,
      }),
      b: seedHost('b'),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    await page.navigate('Advanced')
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for sample-hook' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Pre-call' }))
    const guardrailsRead = fake.hold({ method: 'GET', path: FOO })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await act(async () => {
      await guardrailsRead.arrived
    })
    fake.writeExternal('foo', spec => {
      approvalOf(spec).modeCeiling = 'manual'
    })
    const approvalAfterChange = approvalOf(fake.stored('foo').spec)
    const fooLoads = reads(fake, FOO_DETAIL).length
    page.rerenderKept({ name: 'b' })
    await waitFor(() => expect(reads(fake, B_DETAIL).some(entry => entry.delivered)).toBe(true))
    await settle()
    page.rerenderKept({ name: 'foo' })
    // foo loads again and the page takes the version after the approval change.
    await waitFor(() =>
      expect(
        reads(fake, FOO_DETAIL)
          .slice(fooLoads)
          .some(entry => entry.delivered)
      ).toBe(true)
    )
    await settle()
    await act(async () => {
      guardrailsRead.deliverNow()
    })
    // The guardrails PUT was sent and answered.
    await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))
    await settle()

    expect
      .soft(approvalOf(fake.stored('foo').spec), 'the approval change')
      .toEqual(approvalAfterChange)
    const sent = writes(fake)[0].body as { spec: Record<string, unknown> }
    expect(sent.spec.guardrails, 'the PUT is the hook removal').toEqual({ hooks: {} })
    page.unmount()
  })
})
