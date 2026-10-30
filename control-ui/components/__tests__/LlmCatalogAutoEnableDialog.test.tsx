import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import * as api from '../../lib/api'
import type { LlmProviderCatalogPolicy } from '../../lib/api.types'
import {
  CATALOG_SYNC_IN_PROGRESS_BODY,
  buildCatalogPolicy,
} from '../../test/fixtures/llmProviderCatalogPolicy'
import { LlmCatalogAutoEnableDialog } from '../LlmCatalogAutoEnableDialog'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getLlmProviderCatalogPolicies: vi.fn(),
    setLlmProviderCatalogAutoEnable: vi.fn(),
  }
})

const OVERRIDE_AT = '2026-10-29T08:30:00.000Z'

const openaiDefault = buildCatalogPolicy('openai')
const azureDefault = buildCatalogPolicy('azure')
const openrouterCustom = buildCatalogPolicy('openrouter', {
  auto_enable: true,
  updated_at: OVERRIDE_AT,
  updated_by: 'ops-admin',
})

// The client error is produced by the real formatter from the exact body the
// control-api route sends, not hand-built.
function apiError(body: unknown, status: number, statusText: string) {
  const text = JSON.stringify(body)
  return api.formatApiError(new Response(text, { status, statusText }), text)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function checkbox(label: string) {
  return screen.getByRole('checkbox', { name: `Auto-enable new ${label} models` })
}

function rowOf(label: string) {
  return checkbox(label).closest('tr') as HTMLTableRowElement
}

beforeEach(() => {
  vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([
    openaiDefault,
    azureDefault,
    openrouterCustom,
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LlmCatalogAutoEnableDialog', () => {
  it('explains that only future catalog inserts are affected', async () => {
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Auto-enable new models' })
    expect(dialog).toHaveTextContent('eligible new models')
    expect(dialog).toHaveTextContent('applies from the next live catalog sync')
    expect(dialog).toHaveTextContent('keep their current state')
    expect(dialog).toHaveTextContent('never disables a model')
    expect(dialog).toHaveTextContent('a large catalog can take several syncs')
    expect(dialog).not.toHaveTextContent('this deployment')
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())
  })

  it('renders the effective state with default and custom hints', async () => {
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    expect(checkbox('OpenAI')).toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent('Default')
    expect(rowOf('OpenAI')).not.toHaveTextContent('Custom')

    expect(checkbox('Azure OpenAI')).not.toBeChecked()
    expect(rowOf('Azure OpenAI')).toHaveTextContent('Default')

    expect(checkbox('OpenRouter')).toBeChecked()
    const custom = rowOf('OpenRouter')
    expect(custom).toHaveTextContent('Custom')
    expect(custom).toHaveTextContent('Default: Off')
    expect(custom).toHaveTextContent(`ops-admin · ${new Date(OVERRIDE_AT).toLocaleString()}`)
  })

  it('PUTs the flipped value and shows the state the server confirmed', async () => {
    const saved = buildCatalogPolicy('azure', {
      auto_enable: true,
      updated_at: '2026-10-30T09:00:00.000Z',
      updated_by: 'admin',
    })
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockResolvedValue(saved)
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('Azure OpenAI')).toBeInTheDocument())

    fireEvent.click(checkbox('Azure OpenAI'))

    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('azure', true)
    await waitFor(() => expect(checkbox('Azure OpenAI')).toBeChecked())
    expect(rowOf('Azure OpenAI')).toHaveTextContent('Custom')
    expect(rowOf('Azure OpenAI')).toHaveTextContent('Default: Off')
    expect(
      await screen.findByText(
        'Azure OpenAI: eligible new models that a live catalog sync finds will start enabled.'
      )
    ).toBeInTheDocument()
  })

  it('keeps the checkbox at the confirmed value while the save is pending', async () => {
    let resolveSave!: (value: LlmProviderCatalogPolicy) => void
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockReturnValue(
      new Promise<LlmProviderCatalogPolicy>(resolve => {
        resolveSave = resolve
      })
    )
    const onDismiss = vi.fn()
    render(<LlmCatalogAutoEnableDialog open onDismiss={onDismiss} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    fireEvent.click(checkbox('OpenAI'))

    expect(checkbox('OpenAI')).toBeChecked()
    expect(checkbox('OpenAI')).toBeDisabled()
    expect(rowOf('OpenAI')).toHaveTextContent('Saving…')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDismiss).not.toHaveBeenCalled()

    await act(async () => {
      resolveSave(
        buildCatalogPolicy('openai', {
          auto_enable: false,
          updated_at: '2026-10-30T09:00:00.000Z',
          updated_by: 'admin',
        })
      )
    })
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
  })

  it('shows a retry message on 503 catalog_sync_in_progress and keeps the old state', async () => {
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockRejectedValue(
      apiError(CATALOG_SYNC_IN_PROGRESS_BODY, 503, 'Service Unavailable')
    )
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    fireEvent.click(checkbox('OpenAI'))

    expect(
      await screen.findByText(
        'A catalog sync is running, so the OpenAI setting was not saved. Try again in a moment.'
      )
    ).toBeInTheDocument()
    expect(checkbox('OpenAI')).toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
    expect(rowOf('OpenAI')).not.toHaveTextContent('Custom')
  })

  it('reports a generic failure and never shows the unconfirmed value', async () => {
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockRejectedValue(
      apiError({ error: 'internal_error' }, 500, 'Internal Server Error')
    )
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenRouter')).toBeInTheDocument())

    fireEvent.click(checkbox('OpenRouter'))

    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('openrouter', false)
    expect(await screen.findByText(/The OpenRouter setting was not saved: 500/)).toBeInTheDocument()
    expect(screen.queryByText(/catalog sync is running/)).toBeNull()
    expect(checkbox('OpenRouter')).toBeChecked()
    expect(rowOf('OpenRouter')).toHaveTextContent('ops-admin')
  })

  it('shows a load failure with a retry that re-reads the policy', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies)
      .mockRejectedValueOnce(apiError({ error: 'internal_error' }, 500, 'Internal Server Error'))
      .mockResolvedValueOnce([openaiDefault])
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)

    expect(
      await screen.findByText(/The auto-enable settings could not be loaded: 500/)
    ).toBeInTheDocument()
    // Shown once: in the table state row, not repeated in the dialog banner.
    expect(screen.getAllByText(/could not be loaded/)).toHaveLength(1)
    expect(screen.queryByRole('checkbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())
    expect(api.getLlmProviderCatalogPolicies).toHaveBeenCalledTimes(2)
  })

  it("drops the previous open's rows on reopen and shows only the fresh server state", async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValueOnce([openaiDefault])
    const { rerender } = render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeChecked())

    rerender(
      <ToastProvider>
        <LlmCatalogAutoEnableDialog open={false} onDismiss={vi.fn()} />
      </ToastProvider>
    )
    const slowRead = deferred<LlmProviderCatalogPolicy[]>()
    vi.mocked(api.getLlmProviderCatalogPolicies).mockReturnValueOnce(slowRead.promise)
    rerender(
      <ToastProvider>
        <LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />
      </ToastProvider>
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText('Loading auto-enable settings…')).toBeInTheDocument()

    const serverOff = buildCatalogPolicy('openai', {
      auto_enable: false,
      updated_at: '2026-10-30T09:00:00.000Z',
      updated_by: 'other-admin',
    })
    await act(async () => slowRead.resolve([serverOff]))
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent('other-admin')
  })

  it('discards a read from a previous open that lands after the current one', async () => {
    const firstRead = deferred<LlmProviderCatalogPolicy[]>()
    const secondRead = deferred<LlmProviderCatalogPolicy[]>()
    vi.mocked(api.getLlmProviderCatalogPolicies)
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
    const { rerender } = render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    rerender(
      <ToastProvider>
        <LlmCatalogAutoEnableDialog open={false} onDismiss={vi.fn()} />
      </ToastProvider>
    )
    rerender(
      <ToastProvider>
        <LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />
      </ToastProvider>
    )

    const serverOff = buildCatalogPolicy('openai', {
      auto_enable: false,
      updated_at: '2026-10-30T09:00:00.000Z',
      updated_by: 'admin',
    })
    await act(async () => secondRead.resolve([serverOff]))
    expect(checkbox('OpenAI')).not.toBeChecked()

    await act(async () => firstRead.resolve([openaiDefault]))
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
  })

  it('does not fetch while closed', () => {
    render(<LlmCatalogAutoEnableDialog open={false} onDismiss={vi.fn()} />)
    expect(api.getLlmProviderCatalogPolicies).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
