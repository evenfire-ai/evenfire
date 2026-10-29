import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChangeConnectorSecret } from '@components/ChangeConnectorSecret'
import { ToastProvider } from '@components/Toast'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '@components/UpdateConnectorCredentials'
import {
  createMcpSecret,
  deleteMcpSecret,
  getMcpServer,
  listMcpSecrets,
  updateMcpSecret,
  updateMcpServer,
} from '@lib/api'
import type { EnvSecret, McpServerResource } from '@lib/api'

vi.mock('@lib/api', () => ({
  createMcpSecret: vi.fn(),
  deleteMcpSecret: vi.fn(),
  getMcpServer: vi.fn(),
  listMcpSecrets: vi.fn(),
  updateMcpSecret: vi.fn(),
  updateMcpServer: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockListMcpSecrets = vi.mocked(listMcpSecrets)
const mockUpdateMcpServer = vi.mocked(updateMcpServer)

const SERVER_NAME = 'linear-connector'
const OLD_REFERENCE: EnvSecret = {
  name: 'old-secret',
  keys: [{ secretKey: 'api-key', envVar: 'LINEAR_API_KEY' }],
}
const OLD_SECRET = { name: 'old-secret', uid: 'old-uid', keys: ['api-key'] }
const NEW_SECRET = { name: 'shared-credentials', uid: 'shared-uid', keys: ['api-key'] }

function assignedServer(
  overrides: {
    spec?: Record<string, unknown>
    generation?: number
    resourceVersion?: string
    status?: McpServerResource['status']
  } = {}
): McpServerResource {
  return {
    metadata: {
      name: SERVER_NAME,
      uid: 'server-uid',
      resourceVersion: overrides.resourceVersion ?? '10',
      generation: overrides.generation ?? 2,
    },
    spec: {
      image: 'example/linear:v1',
      contextRef: 'private-context',
      managed: true,
      enabled: true,
      envSecret: OLD_REFERENCE,
      ...(overrides.spec ?? {}),
    },
    ...(overrides.status ? { status: overrides.status } : {}),
  }
}

/** A DeploymentReady condition shaped like the reconciler writes it. */
function deploymentReady(
  status: 'True' | 'False',
  at: string,
  generation = 3
): McpServerResource['status'] {
  return {
    conditions: [
      {
        type: 'DeploymentReady',
        status,
        reason: status === 'True' ? 'RolloutComplete' : 'WaitingForReplicas',
        message: status === 'True' ? 'ready' : 'rolling out',
        lastTransitionTime: at,
        observedGeneration: generation,
      },
    ],
  }
}

/** Drains chained microtasks without relying on real timers — safe under
 *  `vi.useFakeTimers()`, unlike `waitFor`/`findBy*`. */
async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function renderPanel(
  options: {
    server?: McpServerResource
    reference?: EnvSecret
    blockedReason?: string
    list?: Promise<{ items: Array<{ name: string; uid: string; keys: string[] }> }>
  } = {}
) {
  const { server = assignedServer(), reference = OLD_REFERENCE, blockedReason, list } = options
  mockListMcpSecrets.mockReturnValue(list ?? Promise.resolve({ items: [OLD_SECRET, NEW_SECRET] }))
  mockGetMcpServer.mockResolvedValue(server)
  const onFinished = vi.fn()
  const onCancel = vi.fn()
  const onBusyChange = vi.fn()
  const onSpecSaved = vi.fn()
  render(
    <ToastProvider>
      <ChangeConnectorSecret
        serverName={SERVER_NAME}
        server={server}
        reference={reference}
        onFinished={onFinished}
        onCancel={onCancel}
        onBusyChange={onBusyChange}
        onSpecSaved={onSpecSaved}
        blockedReason={blockedReason}
      />
    </ToastProvider>
  )
  await flush(2)
  return { onFinished, onCancel, onBusyChange, onSpecSaved }
}

/** Chooses the replacement Secret and drains the state updates that follow. */
async function chooseReplacement(secretName = NEW_SECRET.name) {
  fireEvent.click(screen.getByLabelText(/^Existing Secret/))
  fireEvent.click(screen.getByRole('option', { name: secretName }))
  await flush(2)
}

/** The resource `updateMcpServer` answers with after an accepted assignment:
 *  the new reference (destinations preserved), a bumped generation, and a
 *  fresh Ready condition. */
function savedServer(status?: McpServerResource['status']): McpServerResource {
  return assignedServer({
    generation: 3,
    resourceVersion: '11',
    spec: {
      envSecret: {
        name: NEW_SECRET.name,
        keys: [{ secretKey: 'api-key', envVar: 'LINEAR_API_KEY' }],
      },
    },
    status: status ?? deploymentReady('True', '2026-01-01T00:00:05.000Z'),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  mockUpdateMcpServer.mockResolvedValue(savedServer())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('ChangeConnectorSecret — reference-only selection', () => {
  it('shows the current assignment and never renders a credential value input', async () => {
    await renderPanel()
    expect(screen.getByText(/Currently assigned:/)).toHaveTextContent('old-secret')
    await chooseReplacement()
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeEnabled()
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(screen.queryByText(/Credential value/i)).not.toBeInTheDocument()
  })

  it('disables assignment until the metadata list is ready', async () => {
    await renderPanel({ list: new Promise(() => undefined) })
    expect(screen.getByRole('status')).toHaveTextContent('Loading Secrets…')
    expect(screen.getByLabelText(/^Existing Secret/)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
  })

  it('offers retry when metadata cannot load and reports the failure inline', async () => {
    await renderPanel({ list: Promise.reject(new Error('boom')) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load Secrets')
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
  })

  it('treats an unchanged assignment as a no-op', async () => {
    await renderPanel()
    await chooseReplacement(OLD_SECRET.name)
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
  })

  it('demands an explicit replacement key when the new Secret lacks one, never a value', async () => {
    const partialReference: EnvSecret = {
      name: 'old-secret',
      keys: [
        { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
        { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
      ],
    }
    await renderPanel({ reference: partialReference })
    await chooseReplacement()

    // The dropped destination survives as an explicit choice; the error points
    // at the key selection, not at a credential value.
    expect(screen.getByLabelText(/^Environment variable 2/)).toHaveValue('LINEAR_WORKSPACE')
    expect(screen.getByLabelText(/^Secret key 2/)).toHaveValue('')
    expect(screen.getByRole('alert').textContent).toContain('Choose a stored key')
    expect(screen.getByRole('alert').textContent?.toLowerCase()).not.toContain(
      'enter a credential value'
    )
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
  })

  it('surfaces the blocked reason and keeps assignment disabled', async () => {
    await renderPanel({ blockedReason: 'Wait for the egress save to finish.' })
    await chooseReplacement()
    expect(screen.getByRole('status')).toHaveTextContent('Wait for the egress save to finish.')
    expect(screen.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
  })

  it('reports busy once assignment starts and clears it on cancel', async () => {
    const { onCancel, onBusyChange } = await renderPanel()
    await chooseReplacement()
    expect(onBusyChange).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment change' }))
    await flush(2)
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('ChangeConnectorSecret — assignment save', () => {
  async function submitThroughConfirm() {
    fireEvent.click(screen.getByRole('button', { name: 'Assign and restart' }))
    await flush(2)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('old-secret')
    expect(dialog.textContent).toContain(NEW_SECRET.name)
    expect(dialog.textContent).toContain('Other connectors keep their current assignments')
    // The duplicate-submit guard: the form's own button is disabled while the
    // confirmation is pending, so a second click is inert and no second dialog
    // can stack.
    const assignButtons = screen.getAllByRole('button', { name: 'Assign and restart' })
    expect(assignButtons).toHaveLength(2)
    const formButton = assignButtons.find(button => button.getAttribute('type') === 'submit')
    expect(formButton).toBeDisabled()
    fireEvent.click(formButton!)
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign and restart' }))
    // Drain the full verify → save → confirm-read microtask chain.
    await flush(8)
    return dialog
  }

  it('confirms with both Secret names, writes only envSecret, and never touches shared Secret values', async () => {
    const { onFinished } = await renderPanel()
    await chooseReplacement()
    await submitThroughConfirm()

    expect(mockUpdateMcpServer).toHaveBeenCalledOnce()
    expect(mockUpdateMcpServer).toHaveBeenCalledWith(SERVER_NAME, {
      metadata: { uid: 'server-uid', resourceVersion: '10' },
      spec: {
        ...assignedServer().spec,
        envSecret: {
          name: NEW_SECRET.name,
          // The connector's original destination survives the reassignment.
          keys: [{ secretKey: 'api-key', envVar: 'LINEAR_API_KEY' }],
        },
      },
    })
    expect(createMcpSecret).not.toHaveBeenCalled()
    expect(updateMcpSecret).not.toHaveBeenCalled()
    expect(deleteMcpSecret).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Assignment saved')

    // Correlated readiness: a fresh True after the save resolves the wait.
    mockGetMcpServer.mockResolvedValue(
      savedServer(deploymentReady('True', '2026-01-01T00:00:05.000Z'))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(onFinished).toHaveBeenCalledOnce()
    expect(screen.getByText(/Assigned Secret changed/)).toBeInTheDocument()
  })

  it('rejects a concurrent spec change before writing and locks until refresh', async () => {
    const { onFinished } = await renderPanel()
    // Both the pre-write snapshot read and the pre-write re-read see a
    // connector that no longer matches the displayed snapshot.
    mockGetMcpServer.mockResolvedValue(assignedServer({ spec: { image: 'example/linear:v2' } }))
    await chooseReplacement()
    await submitThroughConfirm()

    expect(screen.getByRole('alert').textContent).toContain('connector changed')
    expect(mockUpdateMcpServer).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Refresh credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign and restart' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    expect(onFinished).toHaveBeenCalledOnce()
  })

  it('reports a rejected save without cleanup of either shared Secret', async () => {
    mockUpdateMcpServer.mockRejectedValue(Object.assign(new Error('409 conflict'), { status: 409 }))
    const { onFinished } = await renderPanel()
    await chooseReplacement()
    await submitThroughConfirm()

    expect(screen.getByRole('alert').textContent).toContain('rejected')
    expect(deleteMcpSecret).not.toHaveBeenCalled()
    expect(updateMcpSecret).not.toHaveBeenCalled()
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('reports an uncertain outcome when the confirmation read cannot verify the save', async () => {
    mockUpdateMcpServer.mockRejectedValue(Object.assign(new Error('503'), { status: 503 }))
    await renderPanel()
    await chooseReplacement()
    await submitThroughConfirm()

    expect(screen.getByRole('alert').textContent).toContain('could not be confirmed')
    expect(deleteMcpSecret).not.toHaveBeenCalled()
  })

  it('reports the bounded readiness timeout and recovers through the refresh action', async () => {
    mockUpdateMcpServer.mockResolvedValue(savedServer())
    // Never fresh or never True: the poll cannot conclude within its budget.
    mockGetMcpServer.mockResolvedValue(
      savedServer(deploymentReady('False', '2025-12-31T23:59:00.000Z'))
    )
    const { onFinished } = await renderPanel()
    await chooseReplacement()
    await submitThroughConfirm()
    expect(screen.getByRole('status').textContent).toContain('Assignment saved')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS)
    })
    const timeoutAlert = screen.getByRole('alert')
    expect(timeoutAlert.textContent).toContain('readiness could not be verified')
    expect(onFinished).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    expect(onFinished).toHaveBeenCalledOnce()
  })
})
