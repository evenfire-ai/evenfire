import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  UpdateConnectorCredentials,
} from '@components/UpdateConnectorCredentials'
import { getMcpServer, getMcpServers, updateMcpSecret } from '@lib/api'
import type { EnvSecret, McpServerResource } from '@lib/api'

vi.mock('@lib/api', () => ({
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  updateMcpSecret: vi.fn(),
}))

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)

const SERVER_NAME = 'my-connector'
// secretKey and envVar are deliberately different strings so table/label
// assertions can't accidentally pass by matching the wrong column.
const ENV_SECRET: EnvSecret = {
  name: 'linear-credentials',
  keys: [
    { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
    { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
  ],
}

function serverWithCondition(condition?: {
  status: 'True' | 'False'
  message: string
  lastTransitionTime: string
  // Explicit reason so tests can distinguish the TRANSITORY False
  // (`WaitingForReplicas`, the normal mid-rollout state) from the TERMINAL
  // False (`RolloutIncomplete`). Defaults preserve the previous behavior.
  reason?: string
}): McpServerResource {
  return {
    metadata: { name: SERVER_NAME },
    status: condition
      ? {
          conditions: [
            {
              type: 'DeploymentReady',
              status: condition.status,
              reason:
                condition.reason ??
                (condition.status === 'True' ? 'RolloutComplete' : 'RolloutIncomplete'),
              message: condition.message,
              lastTransitionTime: condition.lastTransitionTime,
            },
          ],
        }
      : { conditions: [] },
  }
}

/** Drains chained microtasks (promise resolutions across multiple `await`
 *  boundaries) without relying on real timers — safe to call under
 *  `vi.useFakeTimers()`, unlike `waitFor`/`findBy*`, which poll via
 *  `setTimeout` and would hang until timers are advanced. */
async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve()
    })
  }
}

// No default value on purpose: `renderPanel(undefined)` must render the
// no-envSecret state, but a JS default parameter substitutes ENV_SECRET for
// an explicit `undefined` argument, silently defeating that test. Callers
// always pass explicitly.
async function renderPanel(envSecret: EnvSecret | undefined) {
  const utils = render(
    <ToastProvider>
      <UpdateConnectorCredentials serverName={SERVER_NAME} envSecret={envSecret} />
    </ToastProvider>
  )
  // Flush the best-effort "who else uses this Secret" preview fetch
  // (getMcpServers) that fires on mount so it doesn't leak a pending state
  // update into a later assertion.
  await flush(2)
  return utils
}

/** Fills `keys` (secretKey -> value), submits, and confirms the rotation
 *  dialog — draining the microtask chain in between so callers land on a
 *  settled `phase`. */
async function submitRotation(keys: Record<string, string>) {
  for (const [secretKey, value] of Object.entries(keys)) {
    fireEvent.change(screen.getByLabelText(secretKey), { target: { value } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  mockGetMcpServers.mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('UpdateConnectorCredentials — no envSecret', () => {
  it('shows explanatory copy instead of a form when the connector has no managed credentials', async () => {
    await renderPanel(undefined)
    expect(
      screen.getByText(/has no Kubernetes Secret configured for credentials/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('UpdateConnectorCredentials — masked inputs', () => {
  it('renders one empty, masked, no-autocomplete input per secret key and the key→env mapping', async () => {
    await renderPanel(ENV_SECRET)

    expect(screen.getByText(ENV_SECRET.name)).toBeInTheDocument()
    const table = screen.getByRole('table')
    for (const key of ENV_SECRET.keys) {
      expect(within(table).getByText(key.secretKey)).toBeInTheDocument()
      expect(within(table).getByText(key.envVar)).toBeInTheDocument()
      const input = screen.getByLabelText(key.secretKey) as HTMLInputElement
      expect(input).toHaveAttribute('type', 'password')
      expect(input).toHaveAttribute('autocomplete', 'new-password')
      expect(input.value).toBe('')
    }
  })

  it('never renders a stored credential value — inputs stay empty through a full rotation cycle', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'ready',
        lastTransitionTime: '2026-01-01T00:00:05.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'sk-super-secret' })

    // The value the operator typed must never come back out of the form —
    // not as a rendered value, not as a placeholder.
    expect(screen.queryByText('sk-super-secret')).not.toBeInTheDocument()
    const input = screen.getByLabelText('api-key') as HTMLInputElement
    expect(input.value).toBe('')
  })
})

describe('UpdateConnectorCredentials — partial payload', () => {
  it('sends only the filled keys, never the untouched ones', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key', 'workspace-id'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(serverWithCondition(undefined))

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockUpdateMcpSecret).toHaveBeenCalledWith(ENV_SECRET.name, {
      'api-key': 'new-key-value',
    })
  })
})

describe('UpdateConnectorCredentials — client-side validation', () => {
  it('blocks submit and shows a validation error when no key is filled', async () => {
    await renderPanel(ENV_SECRET)

    fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))

    expect(screen.getByText('Enter at least one credential value to rotate.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
  })
})

// ─── Polling / DeploymentReady correlation — the CRD contract (Fase 3 §6) ───
describe('UpdateConnectorCredentials — rollout polling', () => {
  it('reports success once a FRESH DeploymentReady=True is observed after the PUT', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    // First poll: a False condition that predates the PUT (stale) — must NOT
    // be read as an outcome of this rotation.
    mockGetMcpServer.mockResolvedValueOnce(
      serverWithCondition({
        status: 'False',
        message: 'rolling out',
        lastTransitionTime: '2025-12-31T23:59:00.000Z',
      })
    )
    // Second poll: True, timestamped AFTER the PUT.
    mockGetMcpServer.mockResolvedValueOnce(
      serverWithCondition({
        status: 'True',
        message: 'ready',
        lastTransitionTime: '2026-01-01T00:00:05.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    expect(screen.getByText(/Rotating credentials/i)).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // Stale False must not have resolved anything yet.
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Rotation failed/i)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Credentials rotated\./i)).toBeInTheDocument()
  })

  it('keeps waiting through a FRESH transitory False (WaitingForReplicas) and only succeeds on True', async () => {
    // The real production sequence, which the old hardcoded-reason helper could
    // not express: right after the PUT the HCC writes DeploymentReady=False with
    // reason WaitingForReplicas (fresh, post-PUT) for the whole rollout window,
    // then True once the new pod is Ready. The UI must NOT read the transitory
    // False as failure — doing so would abort almost every successful rotation.
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    // First two polls: transitory False, timestamped AFTER the PUT.
    mockGetMcpServer
      .mockResolvedValueOnce(
        serverWithCondition({
          status: 'False',
          reason: 'WaitingForReplicas',
          message: 'Waiting for pods to become ready',
          lastTransitionTime: '2026-01-01T00:00:02.000Z',
        })
      )
      .mockResolvedValueOnce(
        serverWithCondition({
          status: 'False',
          reason: 'WaitingForReplicas',
          message: 'Waiting for pods to become ready',
          lastTransitionTime: '2026-01-01T00:00:02.000Z',
        })
      )
      // Third poll: converged.
      .mockResolvedValue(
        serverWithCondition({
          status: 'True',
          message: 'ready',
          lastTransitionTime: '2026-01-01T00:00:10.000Z',
        })
      )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    // Two polls of transitory False must NOT be reported as failure.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.queryByText(/Rotation failed/i)).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.queryByText(/Rotation failed/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Rotating credentials/i)).toBeInTheDocument()

    // Third poll converges to success.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Credentials rotated\./i)).toBeInTheDocument()
  })

  it('reports failure only on the TERMINAL False (reason RolloutIncomplete)', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'False',
        reason: 'RolloutIncomplete',
        message: 'Rollout did not converge — ready 0/1, unavailable 1',
        lastTransitionTime: '2026-01-01T00:02:05.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Rotation failed:.*ready 0\/1/)).toBeInTheDocument()
  })

  it('keeps waiting when DeploymentReady=True predates the PUT (stale success must not count)', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'ready (old rollout)',
        lastTransitionTime: '2020-01-01T00:00:00.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })

    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Rotating credentials/i)).toBeInTheDocument()
  })

  it('reports failure with the condition message when DeploymentReady=False after the PUT', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'False',
        message: 'pod CrashLoopBackOff: 0/1 ready',
        lastTransitionTime: '2026-01-01T00:00:03.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(
      screen.getByText(/Rotation failed: pod CrashLoopBackOff: 0\/1 ready/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
  })

  it('reports a bounded timeout — never success — when the condition never transitions', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
    // Always stale: predates the PUT on every single poll.
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'False',
        message: 'rolling out',
        lastTransitionTime: '2020-01-01T00:00:00.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS)
    })

    expect(screen.getByText(/did not finish within/i)).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
  })
})
