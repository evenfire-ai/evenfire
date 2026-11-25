/**
 * Fixtures for the per-tool section's own tests (`HostApprovalSection.*.test.tsx`).
 *
 * The section renders alone over the fake control-api: only `fetch` is
 * replaced, so the real save protocol, `getHost`, `apiSend` and in-flight GET
 * map run (spec A6), and "no PUT" is read from the fake's log. Its props are
 * what a tab passes after a load: the fake's stored Host, whether it has no
 * approval block, and its ceiling.
 *
 * The dialogs portal to `document.body`, outside the section, so they are
 * looked up on the screen; the section's own controls are looked up inside it.
 */
import React from 'react'
import { vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { HostApprovalSection } from '../../components/HostApprovalSection'
import type { HostApprovalSectionProps, RowState } from '../../components/HostApprovalSection/types'
import type { HostResource } from '../../lib/api'
import { approvalBlockOf, effectiveApproval } from '../../lib/approvalEffective'
import { __resetHostApprovalSaveForTests } from '../../lib/hostApprovalSave'
import { __resetReadRequestCacheForTests } from '../../lib/readRequestCache'
import { materializeHostResource } from './contextResource'
import {
  type FakeControlApi,
  type FakeLogEntry,
  type HostObject,
  createFakeControlApi,
} from './fakeControlApi'

export const FOO_PATH = '/api/v1/admin/hosts/foo'

const STATE_LABELS: Record<RowState, string> = {
  default: 'Default',
  required: 'Required',
  skip: 'Skip',
}

export function seedHost(name: string, spec: Record<string, unknown> = {}): HostObject {
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

/**
 * The fake control-api as control-api runs since spec §6.8 (version rule on),
 * holding agent `foo` with `approval` as its block (none when undefined), and
 * any `others`, in place of `fetch`.
 */
export function createSectionFake(
  approval: Record<string, unknown> | undefined,
  options: {
    crd?: 'current' | 'v0.12.1'
    spec?: Record<string, unknown>
    others?: Record<string, HostObject>
  } = {}
): FakeControlApi {
  const spec = { ...options.spec, ...(approval === undefined ? {} : { approval }) }
  const fake = createFakeControlApi({
    hosts: { ...options.others, foo: seedHost('foo', spec) },
    crd: options.crd ?? 'current',
    versionRule: true,
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

/** The props a tab passes for agent `host` as the fake stores it now. */
export function propsFromStore(
  fake: FakeControlApi,
  host = 'foo'
): Pick<HostApprovalSectionProps, 'host' | 'stored' | 'inherited' | 'ceiling'> {
  const stored = fake.stored(host) as HostResource
  const block = approvalBlockOf(stored)
  return {
    host,
    stored,
    inherited: block === undefined,
    ceiling: effectiveApproval(block).modeCeiling,
  }
}

/** Renders the section for agent `foo` as the fake stores it; `rerenderSection` changes props in place. */
export function renderSection(
  fake: FakeControlApi,
  overrides: Partial<HostApprovalSectionProps> = {}
) {
  const onSettled = vi.fn<HostApprovalSectionProps['onSettled']>()
  const props: HostApprovalSectionProps = { ...propsFromStore(fake), onSettled, ...overrides }
  const view = render(<HostApprovalSection {...props} />)
  return {
    ...view,
    onSettled,
    rerenderSection(next: Partial<HostApprovalSectionProps>) {
      Object.assign(props, next)
      view.rerender(<HostApprovalSection {...props} />)
    },
  }
}

/** Puts the save protocol and the read cache back between tests. */
export function resetSectionTestState(): void {
  __resetHostApprovalSaveForTests()
  __resetReadRequestCacheForTests()
}

export function section(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.cu-host-approval-section')
  if (!node) throw new Error('The per-tool approval section is not rendered')
  return node
}

export function sectionButton(name: string): HTMLButtonElement {
  return within(section()).getByRole('button', { name }) as HTMLButtonElement
}

export function rowSelect(name: string): HTMLSelectElement {
  return within(section()).getByLabelText(name) as HTMLSelectElement
}

export function clickEdit(): void {
  fireEvent.click(sectionButton('Edit'))
}

export function setRow(name: string, state: RowState): void {
  fireEvent.change(rowSelect(name), { target: { value: state } })
}

export async function clickSave(): Promise<void> {
  await act(async () => {
    fireEvent.click(sectionButton('Save'))
  })
}

/** Every row the section shows, read or edit view, as `name → Default | Required | Skip`. */
export function shownRows(): Record<string, string> {
  const rows: Record<string, string> = {}
  for (const row of section().querySelectorAll<HTMLElement>('[data-tool-row]')) {
    const state = row.dataset.toolState as RowState
    rows[row.dataset.toolRow ?? ''] = STATE_LABELS[state] ?? state
  }
  return rows
}

/** The rows set to something other than their default. */
export function shownOverrides(): Record<string, string> {
  return Object.fromEntries(Object.entries(shownRows()).filter(([, state]) => state !== 'Default'))
}

/** The section's outcome message, or null. */
export function sectionMessage(): HTMLElement | null {
  return section().querySelector<HTMLElement>('.cu-banner--error')
}

export function dialogByName(role: 'dialog' | 'alertdialog', name: string): HTMLElement {
  return screen.getByRole(role, { name })
}

export function writes(fake: FakeControlApi, path = FOO_PATH): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'write' && entry.path === path)
}

export function reads(fake: FakeControlApi, path = FOO_PATH): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'read' && entry.path === path)
}

/** Lets the work the last answers started run to its end, inside act. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(done => setTimeout(done, 50))
  })
}
