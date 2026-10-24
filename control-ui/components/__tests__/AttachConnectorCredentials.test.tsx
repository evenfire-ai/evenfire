import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AttachConnectorCredentials } from '@components/AttachConnectorCredentials'
import { ToastProvider } from '@components/Toast'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '@constants/connectorCredentials'
import * as api from '@lib/api'
import type { McpServerResource } from '@lib/api'

vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  listMcpSecrets: vi.fn(),
  getRegistryCredentialSchema: vi.fn(),
  createMcpSecret: vi.fn(),
  updateMcpSecret: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpSecret: vi.fn(),
}))
const source: McpServerResource = {
  metadata: { name: 'search', uid: 'server-uid', resourceVersion: '12', generation: 2 },
  spec: { image: 'example/search:v1', egressBindings: [] },
}
const reference = { name: 'secret', keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }] }
let saved: McpServerResource
const onSpecSaved = vi.fn(),
  onFinished = vi.fn(),
  onBusyChange = vi.fn()
async function flush(count = 20) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      await Promise.resolve()
    })
}
function panel(overrides = {}) {
  return render(
    <ToastProvider>
      <AttachConnectorCredentials
        serverName="search"
        server={source}
        onSpecSaved={onSpecSaved}
        onFinished={onFinished}
        onBusyChange={onBusyChange}
        {...overrides}
      />
    </ToastProvider>
  )
}
function fill() {
  fireEvent.change(screen.getByLabelText(/^Secret name/), { target: { value: 'secret' } })
  fireEvent.change(screen.getByLabelText(/^Secret key 1/), { target: { value: 'api-key' } })
  fireEvent.change(screen.getByLabelText(/^Environment variable 1/), {
    target: { value: 'API_KEY' },
  })
  fireEvent.change(screen.getByLabelText(/^Credential value 1/), {
    target: { value: 'private-value' },
  })
}
async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
  await flush()
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Attach and restart' }))
  await flush()
}
async function existing() {
  fireEvent.click(screen.getByRole('radio', { name: 'Use an existing Secret' }))
  await flush()
  fireEvent.change(screen.getByLabelText(/^Existing Secret/), { target: { value: 'secret' } })
}
async function tick(ms = POLL_INTERVAL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-23T12:00:00Z')
  vi.resetAllMocks()
  saved = {
    ...source,
    metadata: { ...source.metadata, generation: 3 },
    spec: { ...source.spec, envSecret: reference },
  }
  vi.mocked(api.getMcpServer).mockResolvedValue(source)
  vi.mocked(api.getMcpServers).mockResolvedValue({ items: [] })
  vi.mocked(api.listMcpSecrets).mockResolvedValue({
    items: [{ name: 'secret', uid: 'secret-uid', keys: ['api-key'] }],
  })
  vi.mocked(api.createMcpSecret).mockResolvedValue({
    name: 'secret',
    namespace: 'mcp-server',
    uid: 'created',
    resourceVersion: '1',
  })
  vi.mocked(api.updateMcpServer).mockImplementation(async () => saved)
  vi.mocked(api.updateMcpSecret).mockResolvedValue({
    name: 'secret',
    namespace: 'mcp-server',
    keys: ['api-key'],
    affectedConnectors: ['other'],
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('attach form', () => {
  it('validates before requests and associates/focuses the rejected control', async () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
    const input = screen.getByLabelText(/^Secret name/)
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(document.getElementById(input.getAttribute('aria-describedby'))).toHaveTextContent(
      'Enter a Secret name'
    )
    expect(api.getMcpServer).not.toHaveBeenCalled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
  })
  it('names missing values and makes no writes', () => {
    panel()
    fill()
    fireEvent.change(screen.getByLabelText(/^Credential value 1/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
    expect(screen.getByRole('alert')).toHaveTextContent('api-key')
    expect(api.createMcpSecret).not.toHaveBeenCalled()
  })
  it('blocks attach while the page has unsaved egress edits', () => {
    panel({ blockedReason: 'Save or discard egress edits.' })
    fill()
    expect(screen.getByRole('button', { name: 'Attach and restart' })).toBeDisabled()
  })
  it('creates, saves a reference, clears values, and waits for correlated readiness', async () => {
    panel()
    fill()
    await confirm()
    expect(onSpecSaved).toHaveBeenCalledWith(saved)
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByLabelText(/^Credential value 1/)).toHaveValue('')
    expect(screen.getByText(/Waiting for search to become ready/)).toBeInTheDocument()
    expect(onFinished).not.toHaveBeenCalled()
    vi.mocked(api.getMcpServer).mockResolvedValue({
      ...saved,
      status: {
        conditions: [
          {
            type: 'DeploymentReady',
            status: 'True',
            reason: 'ReplicasAvailable',
            message: '',
            lastTransitionTime: new Date().toISOString(),
            observedGeneration: 2,
          },
        ],
      },
    })
    await tick()
    expect(onFinished).not.toHaveBeenCalled()
    vi.mocked(api.getMcpServer).mockResolvedValue({
      ...saved,
      status: {
        conditions: [
          {
            type: 'DeploymentReady',
            status: 'True',
            reason: 'ReplicasAvailable',
            message: '',
            lastTransitionTime: new Date().toISOString(),
            observedGeneration: 3,
          },
        ],
      },
    })
    await tick()
    expect(onFinished).toHaveBeenCalledOnce()
    expect(screen.getByText('Credentials attached. search is ready.')).toBeInTheDocument()
    await tick()
    expect(onFinished).toHaveBeenCalledOnce()
  })
  it('loads existing keys, edits mappings, and skips Secret writes for blank values', async () => {
    panel()
    await existing()
    expect(screen.getByLabelText(/^Secret key 1/)).toHaveValue('api-key')
    expect(screen.getByLabelText(/^Environment variable 1/)).toHaveValue('API_KEY')
    await confirm()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpServer).toHaveBeenCalledOnce()
  })
  it('warns about other consumers and records the affected list when values are entered', async () => {
    vi.mocked(api.getMcpServers).mockResolvedValue({
      items: [{ metadata: { name: 'other' }, spec: { envSecret: reference } }],
    })
    panel()
    await existing()
    fireEvent.change(screen.getByLabelText(/^Credential value 1/), {
      target: { value: 'replacement' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
    await flush()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Current references: other')
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Attach and restart' })
    )
    await flush()
    expect(api.updateMcpSecret).toHaveBeenCalledWith('secret', { 'api-key': 'replacement' })
    expect(
      screen.getByText(/Other connectors sharing this Secret roll out separately: other/)
    ).toBeInTheDocument()
  })
  it('keeps a generic shared-Secret warning if the consumer preview fails', async () => {
    vi.mocked(api.getMcpServers).mockRejectedValue(new Error('unavailable'))
    panel()
    await existing()
    fireEvent.change(screen.getByLabelText(/^Credential value 1/), {
      target: { value: 'replacement' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
    await flush()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('may restart any connector')
  })
  it('retries list failure and clears drafts on mode and Secret switches', async () => {
    vi.mocked(api.listMcpSecrets).mockRejectedValueOnce(new Error('unavailable'))
    panel()
    fill()
    fireEvent.click(screen.getByRole('radio', { name: 'Use an existing Secret' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Attach and restart' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading Secrets' }))
    await flush()
    fireEvent.change(screen.getByLabelText(/^Existing Secret/), { target: { value: 'secret' } })
    expect(screen.getByLabelText(/^Credential value 1/)).toHaveValue('')
    fireEvent.change(screen.getByLabelText(/^Credential value 1/), {
      target: { value: 'new-draft' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Create a new Secret' }))
    expect(screen.getByLabelText(/^Credential value 1/)).toHaveValue('')
  })
  it('offers explicit existing mode on collision without overwriting', async () => {
    vi.mocked(api.createMcpSecret).mockRejectedValue(
      Object.assign(new Error('collision'), { status: 409 })
    )
    panel()
    fill()
    await confirm()
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose existing Secret' }))
    await flush()
    fireEvent.change(screen.getByLabelText(/^Existing Secret/), { target: { value: 'secret' } })
    expect(screen.getByLabelText(/^Credential value 1/)).toHaveValue('')
  })
  it('requires refresh after an unknown create outcome, never retries the POST', async () => {
    vi.mocked(api.createMcpSecret).mockRejectedValue(new TypeError('network'))
    panel()
    fill()
    await confirm()
    expect(screen.getByRole('alert')).toHaveTextContent('could not be confirmed')
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Attach and restart' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    expect(onFinished).toHaveBeenCalledOnce()
    expect(api.createMcpSecret).toHaveBeenCalledOnce()
  })
  it('times out a saved attachment and hands off without deleting or creating again', async () => {
    panel()
    fill()
    await confirm()
    vi.mocked(api.getMcpServer).mockResolvedValue(saved)
    await tick(POLL_TIMEOUT_MS)
    expect(screen.getByRole('alert')).toHaveTextContent('Credentials were attached')
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    expect(onFinished).toHaveBeenCalledOnce()
    expect(api.createMcpSecret).toHaveBeenCalledOnce()
  })
  it('allows leaving verification after a saved attachment', async () => {
    panel()
    fill()
    await confirm()
    fireEvent.click(screen.getByRole('button', { name: 'Check credentials later' }))
    expect(onFinished).toHaveBeenCalledOnce()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('does not misreport a saved attachment without generation as successful', async () => {
    delete saved.metadata.generation
    panel()
    fill()
    await confirm()
    expect(screen.getByRole('alert')).toHaveTextContent('rollout identity could not be verified')
    expect(onSpecSaved).toHaveBeenCalledOnce()
    expect(onFinished).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('keeps manual rows when optional schema arrives after editing', async () => {
    let resolve: (value: api.CredentialSchema) => void
    vi.mocked(api.getRegistryCredentialSchema).mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    panel({ registryCredentialSource: { name: 'catalog', version: '1' } })
    fill()
    await act(async () => {
      resolve({
        required: false,
        authType: 'none',
        keys: [{ name: 'OTHER', label: 'Other', kind: 'text' }],
      })
    })
    expect(screen.getByLabelText(/^Secret key 1/)).toHaveValue('api-key')
  })
  it.each(['empty', 'error'])(
    'keeps manual entry usable with optional schema %s',
    async outcome => {
      if (outcome === 'error')
        vi.mocked(api.getRegistryCredentialSchema).mockRejectedValue(new Error('unavailable'))
      else
        vi.mocked(api.getRegistryCredentialSchema).mockResolvedValue({
          required: false,
          authType: 'none',
          keys: [],
        })
      panel({ registryCredentialSource: { name: 'catalog', version: '1' } })
      await flush()
      fill()
      await confirm()
      expect(api.updateMcpServer).toHaveBeenCalledOnce()
    }
  )
  it('uses stable row identities when removing earlier rows', () => {
    panel()
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Add key mapping' }))
    fireEvent.change(screen.getByLabelText(/^Credential value 2/), { target: { value: 'second' } })
    const remaining = screen.getByLabelText(/^Credential value 2/)
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 1' }))
    expect(screen.getByLabelText(/^Credential value 1/)).toBe(remaining)
    expect(remaining).toHaveValue('second')
  })
  it('does not submit twice while confirmation is open', async () => {
    panel()
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
    await flush()
    fireEvent.submit(screen.getByLabelText(/^Secret name/).closest('form'))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Attach and restart' })
    )
    await flush()
    expect(api.createMcpSecret).toHaveBeenCalledOnce()
  })
})
