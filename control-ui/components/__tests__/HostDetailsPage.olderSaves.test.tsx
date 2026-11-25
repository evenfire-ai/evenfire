/**
 * The page's older saves (Overview, Model & credentials, guardrails) against
 * approval writes that land while they run (spec R16, change C16). Each one
 * takes the form's version first, reads the Host with a signal so the read is
 * its own, and counts its busy state so an overlapping load cannot clear it.
 * The page runs over the fake control-api through the real `lib/api` client,
 * as the readiness scenarios do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
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

describe('the page’s older saves (spec R16)', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => vi.unstubAllGlobals())

  it('an Overview save does not join a Host read already in flight, and still PUTs', async () => {
    const fake = createFakeControlApi({
      hosts: { foo: seedHost('foo') },
      crd: 'current',
      versionRule: true,
      defaults: pageMountDefaults(),
    })
    const page = renderHostPage({ fake, name: 'foo' })
    const edit = await screen.findByRole('button', { name: 'Edit agent name' })
    await waitFor(() => expect(edit).toBeEnabled())
    const otherHold = fake.hold({ method: 'GET', path: FOO })
    const other = getHost('foo')
    await act(async () => {
      await otherHold.arrived
    })
    fireEvent.click(edit)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    await waitFor(() => expect(reads(fake, FOO).filter(entry => entry.arrived)).toHaveLength(2))

    expect(
      reads(fake, FOO).filter(entry => entry.arrived),
      'GET /hosts/foo arrivals'
    ).toHaveLength(2)
    await act(async () => {
      otherHold.deliverNow()
      await other
    })
    // The save went through once the other read was answered.
    await waitFor(() => expect(writes(fake).some(entry => entry.applied)).toBe(true))
    await settle()
    page.unmount()
  })

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
    expect(reads(fake, FOO_DETAIL).length, 'the page read foo').toBeGreaterThan(0)
    page.unmount()
  })
})
