/**
 * One failed `/detail` read on the Approvals tab (Ruling 44(c)): the page's own
 * load and the tab's load are separate requests, so the header shows the page's
 * failure in place and the page's banner gives way to the tab's. The failure is
 * control-api's recorded 500 answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  errorBanners,
  pageMountDefaults,
  reads,
  renderHostPage,
  resetApprovalTestState,
  settle,
  showApprovalSettings,
  tabLoadBanner,
} from '../../test/fixtures/approvalPageHarness'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import { type HostObject, createFakeControlApi } from '../../test/fixtures/fakeControlApi'

const FOO_DETAIL = '/api/v1/admin/hosts/foo/detail'

// control-api's production 500 for a /detail read that fails unexpectedly.
const DETAIL_500 = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/host-detail-500.wire.json'),
    'utf8'
  )
) as { status: number; body: unknown }

function fooHost(): HostObject {
  return materializeHostResource(
    {
      metadata: { name: 'foo' },
      spec: {
        host: 'foo',
        contextRef: 'ctx-a',
        secretRef: 'foo-llm',
        channels: [],
        model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      },
    },
    { spec: { approval: { tools: { json_transform: true } } } }
  )
}

function createFake() {
  return createFakeControlApi({
    hosts: { foo: fooHost() },
    crd: 'current',
    versionRule: true,
    defaults: pageMountDefaults(),
  })
}

/** Answers the `nth` GET of /detail from now with the recorded 500, as it arrives. */
function failRead(fake: ReturnType<typeof createFake>, nth: number): void {
  const hold = fake.hold({ method: 'GET', path: FOO_DETAIL, nth })
  void hold.arrived.then(() => hold.respondWith(DETAIL_500.status, DETAIL_500.body))
}

describe('a failed /detail read on the Approvals tab (Ruling 44(c))', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => vi.unstubAllGlobals())

  // After one navigation the page remounts and two reads of /detail start:
  // the tab's (2nd from the first page load) and the page's own (3rd).
  const TAB_READ = 2
  const PAGE_READ = 3
  const HEADER_ERROR = "Could not load this agent's details: 500 Internal Server Error"

  function headerSkeleton(): HTMLElement | null {
    return document.querySelector('.cu-detail-flow-panel .cu-agent-detail-title-skeleton')
  }

  async function openApprovals(fake: ReturnType<typeof createFake>) {
    const page = renderHostPage({ fake, name: 'foo' })
    await screen.findByRole('tab', { name: 'Approvals' })
    await settle()
    await showApprovalSettings(page)
    await settle()
    return page
  }

  it('shows one error banner, the tab’s with Retry, and the header’s own error when both reads fail', async () => {
    const fake = createFake()
    failRead(fake, TAB_READ)
    failRead(fake, PAGE_READ)
    const page = await openApprovals(fake)

    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers'
    ).toEqual([200, 500, 500])
    expect(errorBanners(), 'error banners').toHaveLength(1)
    expect(tabLoadBanner(), 'the tab’s banner').not.toBeNull()
    expect(within(tabLoadBanner()!).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(
      screen.getAllByRole('alert').map(alert => alert.textContent),
      'alerts: the tab’s banner and the header’s error'
    ).toContain(HEADER_ERROR)
    expect(screen.getByText('Agent: foo'), 'the title falls back to the route name').toBeVisible()
    expect(headerSkeleton(), 'the title skeleton').toBeNull()
    page.unmount()
  })

  it('retries the page’s own failed read with the tab’s Retry and leaves no error behind (ruling 57)', async () => {
    const fake = createFake()
    failRead(fake, TAB_READ)
    failRead(fake, PAGE_READ)
    const page = await openApprovals(fake)
    fireEvent.click(within(tabLoadBanner()!).getByRole('button', { name: 'Retry' }))
    await settle()

    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers: the tab’s retry and the page’s retry were both sent'
    ).toEqual([200, 500, 500, 200, 200])
    expect(errorBanners(), 'error banners').toHaveLength(0)
    expect(tabLoadBanner(), 'the tab’s banner').toBeNull()
    expect(headerSkeleton(), 'the title skeleton').toBeNull()
    expect(screen.queryByText(HEADER_ERROR), 'the header’s error').toBeNull()
    expect(screen.getByText('Agent: foo'), 'the agent’s title').toBeVisible()
    page.unmount()
  })

  it('keeps the header’s error when the page’s retry fails again while the tab’s succeeds (ruling 57)', async () => {
    const fake = createFake()
    failRead(fake, TAB_READ)
    failRead(fake, PAGE_READ)
    failRead(fake, 5)
    const page = await openApprovals(fake)
    fireEvent.click(within(tabLoadBanner()!).getByRole('button', { name: 'Retry' }))
    await settle()

    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers: the page’s retry was sent and failed'
    ).toEqual([200, 500, 500, 200, 500])
    expect(tabLoadBanner(), 'the tab’s banner').toBeNull()
    expect(screen.getByText(HEADER_ERROR), 'the header’s error').toBeInTheDocument()
    expect(headerSkeleton(), 'the title skeleton').toBeNull()
    page.unmount()
  })

  it('does not retry the page’s read when only the tab’s read failed (M2, ruling 59c)', async () => {
    const fake = createFake()
    failRead(fake, TAB_READ)
    const page = await openApprovals(fake)
    expect(tabLoadBanner(), 'the tab’s banner before Retry').not.toBeNull()
    fireEvent.click(within(tabLoadBanner()!).getByRole('button', { name: 'Retry' }))
    await settle()

    // One read for the tab's retry and none for the page: it had not failed.
    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers'
    ).toEqual([200, 500, 200, 200])
    expect(tabLoadBanner(), 'the tab’s banner after Retry').toBeNull()
    expect(errorBanners(), 'error banners').toHaveLength(0)
    page.unmount()
  })

  it('still shows the error when only the page’s own read fails', async () => {
    const fake = createFake()
    failRead(fake, PAGE_READ)
    const page = await openApprovals(fake)

    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers'
    ).toEqual([200, 200, 500])
    expect(tabLoadBanner(), 'the tab’s banner').toBeNull()
    // The error is announced (role alert) with its exact text, and no page banner shows (I1).
    const alerts = screen.getAllByRole('alert')
    expect(
      alerts.map(alert => alert.textContent),
      'alerts on screen'
    ).toEqual([HEADER_ERROR])
    expect(errorBanners(), 'error banners').toHaveLength(0)
    expect(screen.getByText('Agent: foo')).toBeVisible()
    expect(headerSkeleton(), 'the title skeleton').toBeNull()
    page.unmount()
  })

  it('keeps the page’s banner as the one display on the Overview tab (M6, ruling 59b)', async () => {
    const fake = createFake()
    failRead(fake, 1)
    const page = renderHostPage({ fake, name: 'foo' })
    await screen.findByRole('tab', { name: 'Approvals' })
    await settle()

    expect(
      reads(fake, FOO_DETAIL).map(entry => entry.response?.status),
      '/detail answers'
    ).toEqual([500])
    expect(errorBanners().map(banner => banner.textContent)).toEqual(['500 Internal Server Error'])
    expect(screen.queryByText(HEADER_ERROR), 'the header’s error').toBeNull()
    expect(screen.getByText('Agent: foo'), 'the title falls back to the route name').toBeVisible()
    expect(headerSkeleton(), 'the title skeleton').toBeNull()
    page.unmount()
  })
})
