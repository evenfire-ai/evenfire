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
import { catalogPolicyCase, catalogPolicyError } from '../../test/fixtures/llmProviderCatalogPolicy'
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

const openaiDefault = catalogPolicyCase('openai.default')
const azureDefault = catalogPolicyCase('azure.default')
const groqCustomOn = catalogPolicyCase('groq.override_on')
const openaiCustomOff = catalogPolicyCase('openai.override_off')

// The client error is produced by the real formatter from the exact body the
// control-api route sends, not hand-built.
function apiError(body: unknown, status: number, statusText: string) {
  const text = JSON.stringify(body)
  return api.formatApiError(new Response(text, { status, statusText }), text)
}

function syncInProgressError() {
  const { status, body } = catalogPolicyError('catalog_sync_in_progress')
  return apiError(body, status, 'Service Unavailable')
}

function changedBy(policy: LlmProviderCatalogPolicy) {
  return `${policy.updated_by} · ${new Date(policy.updated_at as string).toLocaleString()}`
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
    groqCustomOn,
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

    expect(checkbox('Groq')).toBeChecked()
    const custom = rowOf('Groq')
    expect(custom).toHaveTextContent('Custom')
    expect(custom).toHaveTextContent('Default: Off')
    expect(custom).toHaveTextContent(changedBy(groqCustomOn))
  })

  it('PUTs the flipped value and shows the state the server confirmed', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([
      catalogPolicyCase('groq.default'),
    ])
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockResolvedValue(groqCustomOn)
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('Groq')).toBeInTheDocument())
    expect(checkbox('Groq')).not.toBeChecked()

    fireEvent.click(checkbox('Groq'))

    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('groq', true)
    await waitFor(() => expect(checkbox('Groq')).toBeChecked())
    expect(rowOf('Groq')).toHaveTextContent('Custom')
    expect(rowOf('Groq')).toHaveTextContent('Default: Off')
    expect(
      await screen.findByText(
        'Groq: eligible new models that a live catalog sync finds will start enabled.'
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
      resolveSave(openaiCustomOff)
    })
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
  })

  it('shows a retry message on 503 catalog_sync_in_progress and keeps the old state', async () => {
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockRejectedValue(syncInProgressError())
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
    await waitFor(() => expect(checkbox('Groq')).toBeInTheDocument())

    fireEvent.click(checkbox('Groq'))

    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('groq', false)
    expect(await screen.findByText(/The Groq setting was not saved: 500/)).toBeInTheDocument()
    expect(screen.queryByText(/catalog sync is running/)).toBeNull()
    expect(checkbox('Groq')).toBeChecked()
    expect(rowOf('Groq')).toHaveTextContent(changedBy(groqCustomOn))
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
    expect(screen.queryByRole('button', { name: /^Reset .* to default$/ })).toBeNull()
    expect(screen.getByText('Loading auto-enable settings…')).toBeInTheDocument()

    await act(async () => slowRead.resolve([openaiCustomOff]))
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent(changedBy(openaiCustomOff))
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

    await act(async () => secondRead.resolve([openaiCustomOff]))
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

function resetButton(label: string) {
  return screen.getByRole('button', { name: `Reset ${label} to default` })
}

function queryResetButton(label: string) {
  return screen.queryByRole('button', { name: `Reset ${label} to default` })
}

describe('LlmCatalogAutoEnableDialog reset to default', () => {
  it('offers a reset only on overridden rows, including an override equal to the default', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([
      catalogPolicyCase('openai.override_same'),
      groqCustomOn,
      azureDefault,
    ])
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    expect(rowOf('OpenAI')).toHaveTextContent('Custom')
    expect(resetButton('OpenAI')).toBeEnabled()
    expect(resetButton('Groq')).toBeEnabled()
    expect(queryResetButton('Azure OpenAI')).toBeNull()
  })

  it('shows a reset row as default even though it records who reset it', async () => {
    const reset = catalogPolicyCase('openai.reset')
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([reset])
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    expect(checkbox('OpenAI')).toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent('Default')
    expect(rowOf('OpenAI')).not.toHaveTextContent('Custom')
    expect(rowOf('OpenAI')).not.toHaveTextContent(reset.updated_by as string)
    expect(queryResetButton('OpenAI')).toBeNull()
  })

  it('sends a null override and shows the default state the server confirmed', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([groqCustomOn])
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockResolvedValue(
      catalogPolicyCase('groq.reset')
    )
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('Groq')).toBeChecked())

    fireEvent.click(resetButton('Groq'))

    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledTimes(1)
    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('groq', null)
    await waitFor(() => expect(checkbox('Groq')).not.toBeChecked())
    expect(checkbox('Groq')).toBeEnabled()
    expect(rowOf('Groq')).toHaveTextContent('Default')
    expect(rowOf('Groq')).not.toHaveTextContent('Custom')
    expect(rowOf('Groq')).not.toHaveTextContent(groqCustomOn.updated_by as string)
    expect(queryResetButton('Groq')).toBeNull()
    expect(
      await screen.findByText(
        'Groq now follows the default: new models that the catalog sync finds will start disabled.'
      )
    ).toBeInTheDocument()
  })

  it('moves focus to the row checkbox once a reset removes the button', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([groqCustomOn])
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockResolvedValue(
      catalogPolicyCase('groq.reset')
    )
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('Groq')).toBeChecked())

    resetButton('Groq').focus()
    fireEvent.click(resetButton('Groq'))

    await waitFor(() => expect(queryResetButton('Groq')).toBeNull())
    expect(document.activeElement).toBe(checkbox('Groq'))
  })

  it('keeps focus on the reset button when the reset is refused', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([openaiCustomOff])
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockRejectedValue(syncInProgressError())
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    resetButton('OpenAI').focus()
    fireEvent.click(resetButton('OpenAI'))

    expect(await screen.findByText(/A catalog sync is running/)).toBeInTheDocument()
    expect(resetButton('OpenAI')).toBeEnabled()
    expect(document.activeElement).toBe(resetButton('OpenAI'))
  })

  it('shows the retry message on 503 and leaves the override on screen', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([openaiCustomOff])
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockRejectedValue(syncInProgressError())
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    fireEvent.click(resetButton('OpenAI'))

    expect(
      await screen.findByText(
        'A catalog sync is running, so the OpenAI setting was not saved. Try again in a moment.'
      )
    ).toBeInTheDocument()
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
    expect(rowOf('OpenAI')).toHaveTextContent('Custom')
    expect(rowOf('OpenAI')).toHaveTextContent(changedBy(openaiCustomOff))
    expect(resetButton('OpenAI')).toBeEnabled()
  })

  it('locks the row and the dialog while a reset is pending', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([openaiCustomOff])
    const save = deferred<LlmProviderCatalogPolicy>()
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockReturnValue(save.promise)
    const onDismiss = vi.fn()
    render(<LlmCatalogAutoEnableDialog open onDismiss={onDismiss} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())

    fireEvent.click(resetButton('OpenAI'))

    expect(resetButton('OpenAI')).toBeDisabled()
    expect(checkbox('OpenAI')).toBeDisabled()
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent('Saving…')
    fireEvent.click(resetButton('OpenAI'))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledTimes(1)

    await act(async () => save.resolve(catalogPolicyCase('openai.reset')))
    expect(checkbox('OpenAI')).toBeChecked()
    expect(checkbox('OpenAI')).toBeEnabled()
    expect(queryResetButton('OpenAI')).toBeNull()
  })

  it('disables the reset while a toggle on the same row is pending', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValue([groqCustomOn])
    const save = deferred<LlmProviderCatalogPolicy>()
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockReturnValue(save.promise)
    render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('Groq')).toBeInTheDocument())

    fireEvent.click(checkbox('Groq'))

    expect(resetButton('Groq')).toBeDisabled()
    fireEvent.click(resetButton('Groq'))
    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledTimes(1)
    expect(api.setLlmProviderCatalogAutoEnable).toHaveBeenCalledWith('groq', false)

    await act(async () => save.resolve(catalogPolicyCase('groq.override_same')))
    expect(checkbox('Groq')).not.toBeChecked()
    expect(resetButton('Groq')).toBeEnabled()
  })

  it('drops a reset answer that lands while a reopen is still reading', async () => {
    vi.mocked(api.getLlmProviderCatalogPolicies).mockResolvedValueOnce([openaiCustomOff])
    const save = deferred<LlmProviderCatalogPolicy>()
    vi.mocked(api.setLlmProviderCatalogAutoEnable).mockReturnValue(save.promise)
    const { rerender } = render(<LlmCatalogAutoEnableDialog open onDismiss={vi.fn()} />)
    await waitFor(() => expect(checkbox('OpenAI')).toBeInTheDocument())
    fireEvent.click(resetButton('OpenAI'))

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

    await act(async () => save.resolve(catalogPolicyCase('openai.reset')))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText('Loading auto-enable settings…')).toBeInTheDocument()

    await act(async () => slowRead.resolve([openaiCustomOff]))
    expect(checkbox('OpenAI')).not.toBeChecked()
    expect(rowOf('OpenAI')).toHaveTextContent('Custom')
    expect(resetButton('OpenAI')).toBeEnabled()
  })
})
