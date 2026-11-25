/**
 * The page's older saves (Overview, Model & credentials, guardrails) against
 * approval writes that land while they run (spec R16, change C16). Each one
 * takes the form's version first, reads the Host with a signal that is never
 * aborted (so the read is its own and the save is still sent after the page
 * unmounts), and counts its busy state so an overlapping load cannot clear it.
 * The three saves are siblings, so each half is tested on each of them. The
 * "no PUT without a version" half is in HostDetailsPage.conflict.test.tsx for
 * the same three saves: the fake always assigns a version, so a read without
 * one needs that file's mocked api.
 * The page runs over the fake control-api through the real `lib/api` client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getHost } from '../../lib/api'
import {
  pageMountDefaults,
  reads,
  renderHostPage,
  resetApprovalTestState,
  settle,
  writes,
} from '../../test/fixtures/approvalPageHarness'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import { type HostObject, createFakeControlApi } from '../../test/fixtures/fakeControlApi'
import { buildGuardrailDetailScenario } from '../../test/fixtures/guardrailProducer'

const FOO = '/api/v1/admin/hosts/foo'
const FOO_DETAIL = `${FOO}/detail`
const B_DETAIL = '/api/v1/admin/hosts/b/detail'

// control-api's production 500 for a /detail read that fails unexpectedly.
const DETAIL_500 = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/host-detail-500.wire.json'),
    'utf8'
  )
) as { status: number; body: unknown }

const SAVE_KINDS = ['overview', 'model', 'guardrails'] as const
type SaveKind = (typeof SAVE_KINDS)[number]

function seedHost(name: string, spec: Record<string, unknown> = {}): HostObject {
  return materializeHostResource(
    {
      metadata: { name },
      spec: {
        host: name,
        contextRef: 'ctx-a',
        secretRef: `${name}-llm`,
        channels: [],
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      },
    },
    { spec }
  )
}

function createFake() {
  const [scenarioHost] = buildGuardrailDetailScenario('sample-hook', 'foo').hosts.items
  return createFakeControlApi({
    hosts: {
      foo: seedHost('foo', {
        approval: { modeCeiling: 'allow_all', tools: { json_transform: true } },
        guardrails: scenarioHost.spec?.guardrails,
      }),
      b: seedHost('b'),
    },
    crd: 'current',
    versionRule: true,
    defaults: pageMountDefaults(),
  })
}

function approvalOf(spec: Record<string, unknown>): Record<string, unknown> {
  return spec.approval as Record<string, unknown>
}

/**
 * Opens agent foo on the tab of `kind` and does everything up to the press
 * that starts the save. `submit` presses it.
 */
async function openSave(kind: SaveKind) {
  const fake = createFake()
  const page = renderHostPage({ fake, name: 'foo' })
  if (kind === 'overview') {
    const edit = await screen.findByRole('button', { name: 'Edit agent name' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'renamed' } })
  } else if (kind === 'model') {
    await page.navigate('Models & creds')
    const edit = await screen.findByRole('button', { name: 'Edit' })
    await waitFor(() => expect(edit).toBeEnabled())
    fireEvent.click(edit)
    await screen.findByRole('dialog', { name: 'Edit model & credentials' })
  } else {
    await page.navigate('Advanced')
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for sample-hook' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Pre-call' }))
  }
  const submit = async () => {
    if (kind === 'overview') {
      fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    } else if (kind === 'model') {
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Edit model & credentials' })).getByRole(
          'button',
          { name: 'Save' }
        )
      )
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    }
  }
  return { fake, page, submit }
}

describe('the page’s older saves (spec R16)', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => vi.unstubAllGlobals())

  it.each(SAVE_KINDS)(
    'a %s save read before an approval change is sent with its pre-reload version and refused',
    async kind => {
      const { fake, page, submit } = await openSave(kind)
      const saveRead = fake.hold({ method: 'GET', path: FOO })
      await submit()
      await act(async () => {
        await saveRead.arrived
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
        saveRead.deliverNow()
      })
      // The PUT was sent and answered.
      await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))
      await settle()

      expect(writes(fake)[0].versionSent, 'the PUT carries a version').toBeDefined()
      expect(writes(fake)[0].response?.status, 'the PUT is refused').toBe(409)
      expect
        .soft(approvalOf(fake.stored('foo').spec), 'the approval change')
        .toEqual(approvalAfterChange)
      page.unmount()
    }
  )

  it.each(SAVE_KINDS)(
    'a %s save does not join a Host read already in flight, and still PUTs',
    async kind => {
      const { fake, page, submit } = await openSave(kind)
      const otherHold = fake.hold({ method: 'GET', path: FOO })
      const other = getHost('foo')
      await act(async () => {
        await otherHold.arrived
      })
      await submit()
      await waitFor(() => expect(reads(fake, FOO).filter(entry => entry.arrived)).toHaveLength(2))

      expect(
        reads(fake, FOO).filter(entry => entry.arrived),
        'GET /hosts/foo arrivals'
      ).toHaveLength(2)
      await act(async () => {
        otherHold.deliverNow()
        await other
      })
      // The save's PUT was applied. It did not wait for the other read: the hold
      // covers only the first GET, so the save's own read was never held.
      await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
      await settle()
      page.unmount()
    }
  )

  it.each(SAVE_KINDS)(
    'a %s save pressed before the page unmounts is still sent, with the form’s version',
    async kind => {
      const { fake, page, submit } = await openSave(kind)
      const formVersion = fake.stored('foo').metadata.resourceVersion
      const saveRead = fake.hold({ method: 'GET', path: FOO })
      await submit()
      await act(async () => {
        await saveRead.arrived
      })
      page.unmount()
      await act(async () => {
        saveRead.deliverNow()
      })
      await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))

      expect(writes(fake), 'PUTs sent').toHaveLength(1)
      expect(writes(fake)[0].versionSent, 'the version the PUT carries').toBe(formVersion)
    }
  )

  it('keeps the guardrails section on screen while the load after a save runs (initialLoading, first load only)', async () => {
    const { fake, page, submit } = await openSave('guardrails')
    const reload = fake.hold({ method: 'GET', path: FOO_DETAIL })
    await submit()
    // The save's PUT was sent, and the load after it is out.
    await act(async () => {
      await reload.arrived
    })
    expect(writes(fake)[0]?.applied, 'the PUT was applied').toBe(true)

    expect(
      screen.queryByRole('status', { name: 'Loading guardrail hooks' }),
      'the loading placeholder'
    ).toBeNull()
    await act(async () => {
      reload.deliverNow()
    })
    await settle()
    page.unmount()
  })
  // The real path to "no version" (M4): the page's first read of the Host fails
  // with control-api's recorded 500, then the admin tries to save. Neither
  // reachable save gets as far as the version guard, and the guardrails save is
  // not reachable at all (no Host read, so no hook to remove). The guard itself
  // is tested per save with a mocked read in HostDetailsPage.conflict.test.tsx.
  async function openAfterFailedFirstRead(kind: 'overview' | 'model') {
    const fake = createFake()
    // The page's read is the first /detail read on Overview and the second
    // (after the Overview mount) on the Models tab.
    const pageRead = fake.hold({
      method: 'GET',
      path: FOO_DETAIL,
      nth: kind === 'overview' ? 1 : 2,
    })
    void pageRead.arrived.then(() => pageRead.respondWith(DETAIL_500.status, DETAIL_500.body))
    const page = renderHostPage({ fake, name: 'foo' })
    await screen.findByRole('tab', { name: 'Approvals' })
    await settle()
    if (kind === 'model') {
      await page.navigate('Models & creds')
      await settle()
    }
    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      'the page’s read failed'
    ).toContain(500)
    expect(screen.getAllByRole('alert').length, 'the failure is shown').toBeGreaterThan(0)
    return { fake, page }
  }

  it('an Overview save is not reachable after a failed first page read', async () => {
    const { fake, page } = await openAfterFailedFirstRead('overview')

    expect(screen.queryByRole('button', { name: 'Edit agent name' }), 'Edit').toBeNull()
    expect(writes(fake), 'PUTs sent').toHaveLength(0)
    page.unmount()
  })

  it('a model save after a failed first page read sends no PUT', async () => {
    const { fake, page } = await openAfterFailedFirstRead('model')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit model & credentials' })
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save, 'Save is pressed').toBeEnabled()
    fireEvent.click(save)
    await settle()

    expect(writes(fake), 'PUTs sent').toHaveLength(0)
    expect(screen.getByRole('dialog', { name: 'Edit model & credentials' })).toBeInTheDocument()
    page.unmount()
  })

  // No UI path overlaps two saves on one kept page: every control that starts one
  // is disabled while busy, and the model editor ignores dismissal while it saves.
  // The one overlap a test can drive is a save with another agent's load on a
  // page kept across an agent change (the harness's rerenderKept; the shipped
  // build remounts, which Task 25's browser row checks).
  it('busy stays set while a guardrails save and another load overlap', async () => {
    const [scenarioHost] = buildGuardrailDetailScenario('sample-hook', 'foo').hosts.items
    const fake = createFakeControlApi({
      hosts: {
        foo: seedHost('foo', { guardrails: scenarioHost.spec?.guardrails }),
        b: seedHost('b'),
      },
      crd: 'current',
      versionRule: true,
      defaults: pageMountDefaults(),
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
    // Another agent's load starts and ends while the save's read is out.
    page.rerenderKept({ name: 'b' })
    await waitFor(() => expect(reads(fake, B_DETAIL).some(entry => entry.delivered)).toBe(true))
    await settle()

    expect(
      screen.getByRole('button', { name: 'Agent actions' }),
      'while the save runs'
    ).toBeDisabled()
    await act(async () => {
      guardrailsRead.deliverNow()
    })
    await waitFor(() => expect(writes(fake)[0]?.delivered).toBe(true))
    await settle()
    // The positive partner: the count returns to zero once the save has ended.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Agent actions' }), 'after the save').toBeEnabled()
    )
    page.unmount()
  })
})
