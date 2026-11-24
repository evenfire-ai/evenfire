import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import {
  openApprovalSettings,
  pageMountDefaults,
  perToolSection,
  renderHostPage,
  resetApprovalTestState,
} from '../approvalPageHarness'
import { materializeHostResource } from '../contextResource'
import { createFakeControlApi } from '../fakeControlApi'

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

/** Reads the page made that neither the fake nor `defaults` answers. */
function unanswered(fake: ReturnType<typeof seedFake>): string[] {
  return fake.log.filter(entry => entry.response?.status === 404).map(entry => entry.path)
}

describe('approval page harness', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => vi.unstubAllGlobals())

  it("harness renders today's per-tool section from the fake's stored tools", async () => {
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
    const fake = seedFake()
    const page = renderHostPage({ fake, name: 'foo', tab: 'advanced' })
    const driver = await openApprovalSettings(page)
    await driver.editTool('http_request', 'skip')
    await driver.save()
    await waitFor(() => expect(fake.log.filter(entry => entry.applied)).toHaveLength(1))
    expect(fake.stored('foo').spec.approval).toMatchObject({ tools: { http_request: false } })
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
})
