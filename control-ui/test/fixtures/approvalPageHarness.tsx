/**
 * Page harness for the Host approval settings.
 *
 * It renders the real agent page (app/hosts/[name]/page.tsx) over a fake
 * control-api, through the real `lib/api` client with `fetch` stubbed. Only the
 * Next router, the shell and the two tabs that have their own suites are mocked
 * (as in HostDetailsPage.rateLimit.test.tsx).
 *
 * `navigate` remounts the page: the shipped build remounts it on every tab or
 * agent change (verified on next 16.4.6). `rerenderKept` keeps the instance and
 * exists only for tests that need the other behaviour. `navigate` and `remount`
 * replace only the page: the ToastProvider stays mounted, as the root layout's
 * does in the app (app/layout.tsx), so a toast raised for a page that is gone
 * stays on screen. `unmount` removes both.
 *
 * `renderHostPage` stubs the global `fetch` with the fake's, and
 * `resetApprovalTestState` does not restore it. Every test file calls
 * `vi.unstubAllGlobals()` in `afterEach`.
 */
import React from 'react'
import { expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import {
  FIRST_SAVE_DIALOG_TITLE,
  FIRST_SAVE_POLICY_LABEL,
  LOOSENING_CONFIRM_LABEL,
  LOOSENING_DIALOG_TITLE,
} from '../../components/HostApprovalSection/constants'
import { ToastProvider } from '../../components/Toast'
import type { ToastTone } from '../../components/Toast/types'
import * as api from '../../lib/api'
import { __resetHostApprovalDisplayForTests } from '../../lib/hostApprovalDisplay'
import { __resetHostApprovalSaveForTests } from '../../lib/hostApprovalSave'
import { __resetReadRequestCacheForTests } from '../../lib/readRequestCache'
import type { FakeControlApi, FakeControlApiOptions } from './fakeControlApi'
import { llmModelWireRow } from './llmModelRows'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  tab: undefined as string | undefined,
  name: 'foo',
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: navigation.name, tab: navigation.tab }),
  usePathname: () => `/agents/${navigation.name}`,
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={href}
      onClick={event => {
        event.preventDefault()
        navigation.tab = String(href).split('/').at(-1)
        navigation.replace(href)
      }}
    >
      {children}
    </a>
  ),
}))
vi.mock('../../components/AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => <aside aria-label="Sidebar" /> }))
vi.mock('../../components/HostIdentityTab', () => ({
  HostIdentityTab: ({ hostName }: { hostName: string }) => (
    <section aria-label="Identity editor">{hostName}</section>
  ),
}))
vi.mock('../../components/HostAccessTab', () => ({
  HostAccessTab: ({ hostName }: { hostName: string }) => (
    <section aria-label="Access editor">{hostName}</section>
  ),
}))

type PageParams = { name: string; tab?: string }

export type ApprovalToolState = 'default' | 'required' | 'skip'

export interface HostPageHandle {
  navigate(tabLabel: string): Promise<void>
  remount(params: PageParams): void
  /** Re-renders the same page instance. An omitted `tab` keeps the tab the page shows. */
  rerenderKept(params: PageParams): void
  unmount(): void
  /** The texts of the toasts on screen, only those of `tone` when it is given. */
  toasts(tone?: ToastTone): string[]
  banner(): string | null
}

export interface ApprovalSettingsDriver {
  edit(): Promise<void>
  cancel(): Promise<void>
  editTool(name: string, state: ApprovalToolState): Promise<void>
  save(): Promise<void>
  confirmDialog(): Promise<void>
  clickSetToManual(): Promise<void>
  readView(): Record<string, string>
  message(): string | null
}

const STATE_LABELS: Record<ApprovalToolState, string> = {
  default: 'Default',
  required: 'Required',
  skip: 'Skip',
}

/**
 * The page's one mount read that the fake does not model, `/admin/llm-models`,
 * answered with control-api's recorded route answer (./llmModelRows). Any other
 * read the fake does not model answers 404 and shows in `fake.log`.
 */
export function pageMountDefaults(): NonNullable<FakeControlApiOptions['defaults']> {
  return {
    '/api/v1/admin/llm-models': {
      status: 200,
      body: { rows: [llmModelWireRow(true), llmModelWireRow(false)] },
    },
  }
}

export function resetApprovalTestState(): void {
  __resetReadRequestCacheForTests()
  __resetHostApprovalSaveForTests()
  __resetHostApprovalDisplayForTests()
}

/** Every error banner on the page, in document order. `banner()` and `message()` read the first. */
export function errorBanners(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.cu-banner--error'))
}

function firstErrorBannerText(): string | null {
  const [first] = errorBanners()
  return first ? (first.textContent ?? '') : null
}

/** The page under a ToastProvider; a new `pageKey` remounts the page and keeps the provider. */
function tree(pageKey: number) {
  return (
    <ToastProvider>
      <HostDetailsPage key={pageKey} />
    </ToastProvider>
  )
}

export function renderHostPage(options: {
  fake: FakeControlApi
  name: string
  tab?: string
}): HostPageHandle {
  vi.stubGlobal('fetch', options.fake.fetch)
  api.setControlUIReadPrincipal('unit-test-admin', 'admin')
  navigation.name = options.name
  navigation.tab = options.tab
  let pageKey = 0
  const result = render(tree(pageKey))

  const setParams = (params: PageParams) => {
    navigation.name = params.name
    navigation.tab = params.tab
  }
  const remountPage = () => {
    pageKey += 1
    result.rerender(tree(pageKey))
  }

  const handle: HostPageHandle = {
    async navigate(tabLabel) {
      fireEvent.click(screen.getByRole('tab', { name: tabLabel }))
      // The mocked Link recorded the new segment; mount a fresh page for it.
      remountPage()
      await screen.findByRole('tab', { name: tabLabel })
    },
    remount(params) {
      setParams(params)
      remountPage()
    },
    rerenderKept(params) {
      setParams({ ...params, tab: params.tab ?? navigation.tab })
      result.rerender(tree(pageKey))
    },
    unmount() {
      result.unmount()
    },
    toasts(tone) {
      const selector = tone ? `.cu-toast--${tone} .cu-toast__text` : '.cu-toast__text'
      return Array.from(document.querySelectorAll(selector)).map(node => node.textContent ?? '')
    },
    banner: firstErrorBannerText,
  }
  return handle
}

/** The per-tool approval section, or null when the page does not render it. */
export function perToolSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.cu-host-approval-section')
}

function section(): HTMLElement {
  const node = perToolSection()
  if (!node) throw new Error('The per-tool approval section is not rendered')
  return node
}

function button(name: string): HTMLElement {
  return within(section()).getByRole('button', { name })
}

const unavailable = (what: string) => async () => {
  throw new Error(`${what} does not exist in the Approvals tab yet`)
}

/**
 * The policy the driver gives a first save: "Nobody (Desktop only)" loosens
 * nothing, so the readiness scenarios' saves reach the write with no
 * loosening dialog to confirm.
 */
const DRIVER_FIRST_SAVE_POLICY = 'cli_only'

/**
 * Goes to where the approval settings live, the Approvals tab, without
 * waiting for the section: a failed load renders none.
 */
export async function showApprovalSettings(page: HostPageHandle): Promise<void> {
  const tab = screen.queryByRole('tab', { name: 'Approvals' })
  if (!tab || tab.getAttribute('aria-selected') !== 'true') await page.navigate('Approvals')
}

/**
 * Opens the per-tool section once it has loaded, in its read view.
 *
 * - `edit` presses Edit; in the edit view it does nothing.
 * - `save` presses Save and, on a first save, answers the policy dialog with
 *   "Nobody (Desktop only)". A loosening dialog stays open for `confirmDialog`.
 * - `readView` reads every row the section shows, either view, by its state
 *   (`data-tool-state`), not its text.
 */
export async function openApprovalSettings(page: HostPageHandle): Promise<ApprovalSettingsDriver> {
  await showApprovalSettings(page)
  await waitFor(() => section())
  await waitFor(() => expect(screen.queryByRole('status', { name: /Loading approval/ })).toBeNull())

  return {
    async edit() {
      const edit = within(section()).queryByRole('button', { name: 'Edit' })
      if (!edit) return
      await act(async () => {
        fireEvent.click(edit)
      })
    },
    async cancel() {
      fireEvent.click(button('Cancel'))
    },
    async editTool(name, state) {
      const select = within(section()).getByLabelText(name)
      fireEvent.change(select, { target: { value: state } })
    },
    async save() {
      await act(async () => {
        fireEvent.click(button('Save'))
      })
      // The dialogs render outside the section.
      const firstSave = screen.queryByRole('dialog', { name: FIRST_SAVE_DIALOG_TITLE })
      if (!firstSave) return
      fireEvent.change(within(firstSave).getByLabelText(FIRST_SAVE_POLICY_LABEL), {
        target: { value: DRIVER_FIRST_SAVE_POLICY },
      })
      await act(async () => {
        fireEvent.click(within(firstSave).getByRole('button', { name: 'Save' }))
      })
    },
    async confirmDialog() {
      const dialog = screen.getByRole('alertdialog', { name: LOOSENING_DIALOG_TITLE })
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: LOOSENING_CONFIRM_LABEL }))
      })
    },
    clickSetToManual: unavailable('"Set to Manual now"'),
    readView() {
      const view: Record<string, string> = {}
      for (const row of section().querySelectorAll<HTMLElement>('[data-tool-row]')) {
        const state = row.dataset.toolState as ApprovalToolState
        view[row.dataset.toolRow ?? ''] = STATE_LABELS[state] ?? state
      }
      return view
    },
    message: firstErrorBannerText,
  }
}
