import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ExistingConnectorSecretFields } from '@components/ExistingConnectorSecretFields'
import { listMcpSecrets } from '@lib/api'
import type { McpServerResource } from '@lib/api'
import type { ExistingCredentialSelection } from '@lib/connectorCredentials.types'

vi.mock('@lib/api', () => ({
  listMcpSecrets: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockListMcpSecrets = vi.mocked(listMcpSecrets)

const SERVER: McpServerResource = {
  metadata: { name: 'connector' },
  spec: { image: 'example/image:v1' },
}

/** The connector's current reference used by the reassignment flow. */
const INITIAL_REFERENCE = {
  name: 'old-secret',
  keys: [
    { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
    { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
  ],
}

const SECRET_A = { name: 'alpha-credentials', uid: 'uid-a', keys: ['api-key'] }
const SECRET_B = { name: 'beta-credentials', uid: 'uid-b', keys: ['beta-token'] }

function renderFields(props: Partial<Parameters<typeof ExistingConnectorSecretFields>[0]> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <ExistingConnectorSecretFields server={SERVER} onChange={onChange} {...props} />
  )
  return { onChange, ...utils }
}

/** The latest onChange payload, so tests can assert the reported selection. */
function lastSelection(onChange: ReturnType<typeof vi.fn>): ExistingCredentialSelection {
  return onChange.mock.calls.at(-1)?.[0] as ExistingCredentialSelection
}

/** The picker is a SelectionDropdown button: open it, then click the option. */
async function chooseSecret(name: string) {
  const trigger = await screen.findByLabelText(/^Existing Secret/)
  await waitFor(() => expect(trigger).toBeEnabled())
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name }))
}

beforeEach(() => {
  mockListMcpSecrets.mockResolvedValue({ items: [SECRET_B, SECRET_A] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ExistingConnectorSecretFields — metadata loading', () => {
  it('reports not-ready while loading, then enables the selector', async () => {
    let resolveList: ((value: { items: (typeof SECRET_A)[] }) => void) | undefined
    mockListMcpSecrets.mockReturnValue(
      new Promise(resolve => {
        resolveList = resolve
      })
    )
    const { onChange } = renderFields()

    expect(screen.getByRole('status')).toHaveTextContent('Loading Secrets…')
    expect(screen.getByLabelText(/^Existing Secret/)).toBeDisabled()
    expect(lastSelection(onChange).ready).toBe(false)

    resolveList?.({ items: [SECRET_A] })
    await waitFor(() => expect(screen.getByLabelText(/^Existing Secret/)).toBeEnabled())
    expect(lastSelection(onChange).ready).toBe(true)
  })

  it('offers retry after a listing failure and recovers without losing the alert', async () => {
    mockListMcpSecrets.mockRejectedValueOnce(new Error('boom'))
    renderFields()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load Secrets')
    // No metadata is available, so nothing can be selected yet.
    expect(screen.getByLabelText(/^Existing Secret/)).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading Secrets' }))
    await waitFor(() => expect(screen.getByLabelText(/^Existing Secret/)).toBeEnabled())
    expect(mockListMcpSecrets).toHaveBeenCalledTimes(2)
  })

  it('explains an empty Secret list instead of rendering a bare selector', async () => {
    mockListMcpSecrets.mockResolvedValue({ items: [] })
    renderFields()

    expect(await screen.findByText(/No connector Secrets are available/)).toBeInTheDocument()
    // The list is loaded (not stuck in a loading/error state); it is simply empty.
    expect(screen.getByLabelText(/^Existing Secret/)).toBeEnabled()
  })

  it('reloads metadata on demand through the explicit refresh control', async () => {
    renderFields()
    await waitFor(() => expect(screen.getByLabelText(/^Existing Secret/)).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh secrets' }))
    await waitFor(() => expect(mockListMcpSecrets).toHaveBeenCalledTimes(2))
  })
})

describe('ExistingConnectorSecretFields — reference-only key mapping', () => {
  it('auto-maps stored keys to environment variables and never renders a value input', async () => {
    const { onChange } = renderFields()
    await chooseSecret(SECRET_A.name)

    expect(screen.getByLabelText(/^Environment variable 1/)).toHaveValue('API_KEY')
    // Write-only contract: no credential value is ever requested or rendered.
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(screen.queryByText(/Credential value/i)).not.toBeInTheDocument()
    const selection = lastSelection(onChange)
    expect(selection.secret).toEqual(SECRET_A)
    expect(selection.rows).toEqual([
      expect.objectContaining({ secretKey: 'api-key', envVar: 'API_KEY', value: '' }),
    ])
  })

  it('preserves each destination and demands an explicit key when the new Secret lacks it', async () => {
    const { onChange } = renderFields({ initialReference: INITIAL_REFERENCE })
    await chooseSecret(SECRET_B.name)

    // Destination names are the connector's contract: both survive the switch,
    // and the missing source key is an explicit choice, never a value prompt.
    expect(screen.getByLabelText(/^Environment variable 1/)).toHaveValue('LINEAR_API_KEY')
    expect(screen.getByLabelText(/^Environment variable 2/)).toHaveValue('LINEAR_WORKSPACE')
    expect(screen.getByLabelText(/^Secret key 1/)).toHaveValue('')
    expect(screen.getByLabelText(/^Secret key 2/)).toHaveValue('')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a stored key')
    expect(screen.getByRole('alert').textContent?.toLowerCase()).not.toContain(
      'enter a credential value'
    )
    const selection = lastSelection(onChange)
    expect(selection.rows.map(row => row.envVar)).toEqual(['LINEAR_API_KEY', 'LINEAR_WORKSPACE'])
    expect(
      selection.rows.every(row => row.secretKey === '' || SECRET_B.keys.includes(row.secretKey))
    ).toBe(true)
  })

  it('clears the key error once an explicit stored key is chosen and keeps the destination', async () => {
    const singleKeyReference = { name: 'old-secret', keys: [INITIAL_REFERENCE.keys[0]] }
    renderFields({ initialReference: singleKeyReference })
    await chooseSecret(SECRET_B.name)
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a stored key')

    fireEvent.change(screen.getByLabelText(/^Secret key 1/), {
      target: { value: 'beta-token' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Environment variable 1/)).toHaveValue('LINEAR_API_KEY')
  })

  it('flags a key that vanished from the selected Secret as a key problem after a refresh', async () => {
    const { onChange } = renderFields()
    await chooseSecret(SECRET_A.name)
    expect(lastSelection(onChange).rows[0]?.secretKey).toBe('api-key')

    // Out-of-band: the stored key disappeared, then the operator refreshes.
    mockListMcpSecrets.mockResolvedValue({
      items: [{ ...SECRET_A, keys: ['replacement-key'] }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh secrets' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('not stored in the selected Secret')
    )
    // The stale choice is reported where it was made — the key select — and the
    // message never asks the operator to re-enter a credential value.
    expect(screen.getByLabelText(/^Secret key 1/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert').textContent?.toLowerCase()).not.toContain(
      'enter a credential value'
    )
  })

  it('keeps the empty-Secret guidance discoverable when the selected Secret stores no keys', async () => {
    mockListMcpSecrets.mockResolvedValue({
      items: [{ name: 'hollow-credentials', uid: 'uid-hollow', keys: [] }],
    })
    renderFields()
    await chooseSecret('hollow-credentials')

    expect(
      screen
        .getAllByRole('alert')
        .map(alert => alert.textContent)
        .join(' ')
    ).toContain('This Secret has no stored keys')
    expect(screen.queryByRole('button', { name: 'Add key mapping' })).not.toBeInTheDocument()
  })
})
