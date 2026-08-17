import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  UpdateConnectorCredentials,
} from '@components/UpdateConnectorCredentials'
import { getMcpServer, getMcpServers, getRegistryCredentialSchema, updateMcpSecret } from '@lib/api'
import type { EnvSecret, McpServerResource } from '@lib/api'
import { buildSecretSummary } from '../../test/fixtures/secretSummary'

vi.mock('@lib/api', () => ({
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  getRegistryCredentialSchema: vi.fn(),
  updateMcpSecret: vi.fn(),
}))

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockGetRegistryCredentialSchema = vi.mocked(getRegistryCredentialSchema)
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

function secretRotationResponse(keys: string[], affectedConnectors = [SERVER_NAME]) {
  return {
    ...buildSecretSummary({ name: ENV_SECRET.name, keys }),
    namespace: 'mcp-server',
    affectedConnectors,
  }
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
    const rotateButton = screen.getByRole('button', { name: 'Rotate credentials' })
    const table = screen.getByRole('table')
    for (const key of ENV_SECRET.keys) {
      expect(within(table).getByText(key.secretKey)).toBeInTheDocument()
      expect(within(table).getByText(key.envVar)).toBeInTheDocument()
      const input = screen.getByLabelText(key.secretKey) as HTMLInputElement
      expect(input).toHaveAttribute('type', 'password')
      expect(input).toHaveAttribute('autocomplete', 'new-password')
      expect(input.value).toBe('')
    }
    expect(
      rotateButton.compareDocumentPosition(screen.getByLabelText(ENV_SECRET.keys[0].secretKey))
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING)
  })

  it('uses the Marketplace credential label when the connector retains its catalog source', async () => {
    mockGetRegistryCredentialSchema.mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [
        {
          name: 'api-key',
          label: 'Linear API key',
          kind: 'api-key',
        },
      ],
    })
    render(
      <ToastProvider>
        <UpdateConnectorCredentials
          serverName={SERVER_NAME}
          envSecret={ENV_SECRET}
          registryCredentialSource={{ name: '@evenfire/linear', version: '1.0.0' }}
        />
      </ToastProvider>
    )

    await flush(3)

    expect(mockGetRegistryCredentialSchema).toHaveBeenCalledWith('@evenfire/linear', '1.0.0')
    expect(screen.getByLabelText('Linear API key')).toBeInTheDocument()
    expect(screen.getByLabelText('workspace-id')).toBeInTheDocument()
  })

  it('never renders a stored credential value — inputs stay empty through a full rotation cycle', async () => {
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key', 'workspace-id']))
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

describe('UpdateConnectorCredentials — PUT rejection', () => {
  it('surfaces the backend error and never reports success when the rotation PUT is rejected', async () => {
    // The primary #223 journey must fail LOUD, not silent: when control-api
    // rejects the rotation PUT — e.g. the c01394e invalid Secret-key 400, or any
    // other 4xx/5xx — the UI has to show the failure and must never flip to a
    // false "Credentials rotated." A rejected PUT also means no rollout to poll.
    mockUpdateMcpSecret.mockRejectedValue(
      new Error('400 Bad Request - data key "..bad" is not a valid Secret key')
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'sk-super-secret' })

    expect(screen.getByText(/Rotation failed/i)).toBeInTheDocument()
    expect(screen.getByText(/not a valid Secret key/i)).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
    // The PUT was actually attempted (not blocked client-side), and the failure
    // short-circuits before any DeploymentReady poll.
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockGetMcpServer).not.toHaveBeenCalled()
  })
})

// ─── Polling / DeploymentReady correlation — the CRD contract (Fase 3 §6) ───
describe('UpdateConnectorCredentials — rollout polling', () => {
  it('reports success once a FRESH DeploymentReady=True is observed after the PUT', async () => {
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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

  it('reports failure with the HCC diagnostic only after the FULL poll budget when RolloutIncomplete persists', async () => {
    // RolloutIncomplete is the HCC saying "I exhausted MY 120s budget", not an
    // irreversible verdict — its post-terminal re-poll can still correct the
    // condition to True (see the recovery test below). So the UI must NOT latch
    // failure on the first sighting; it reports failure only when its OWN
    // POLL_TIMEOUT_MS expires with the diagnostic still uncorrected — and then
    // with the HCC's rollout numbers, never a bare "timed out".
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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

    // First sighting: no failure latched — still inside the UI's own budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.queryByText(/Rotation failed/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Rotating credentials/i)).toBeInTheDocument()

    // Budget expiry with the diagnostic still standing: failure, carrying the
    // HCC's rollout numbers, and NOT the inconclusive-timeout copy.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS)
    })
    expect(screen.getByText(/Rotation failed:.*ready 0\/1/)).toBeInTheDocument()
    expect(screen.queryByText(/did not finish within/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
  })

  it('recovers to success when a transient RolloutIncomplete is later corrected to True (HCC re-poll)', async () => {
    // The HCC readiness budget (24x5s=120s, reconciler.ts pollReadiness) can write
    // a False/RolloutIncomplete BEFORE a legitimately slow pod finishes rolling
    // out; its post-terminal re-poll (commit c49957b) then corrects the condition
    // to True within the UI's own POLL_TIMEOUT_MS (180s). RolloutIncomplete is
    // therefore NOT irreversible — it means "the controller exhausted ITS budget,
    // still observing". The UI must keep polling and report SUCCESS on the later
    // True, not latch 'failed' on the first RolloutIncomplete. This is the
    // false-negative a slow/loaded cluster reproduces (convergence 120s..180s).
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
    mockGetMcpServer
      .mockResolvedValueOnce(
        serverWithCondition({
          status: 'False',
          reason: 'RolloutIncomplete',
          message: 'Rollout did not converge — ready 0/1, unavailable 1',
          lastTransitionTime: '2026-01-01T00:00:02.000Z',
        })
      )
      .mockResolvedValue(
        serverWithCondition({
          status: 'True',
          message: 'ready',
          lastTransitionTime: '2026-01-01T00:00:10.000Z',
        })
      )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    // First poll: a fresh RolloutIncomplete. The HCC may still correct it, so the
    // UI must NOT declare failure and stop polling here — instead it tells the
    // operator the rollout has outlived the controller's budget and is still
    // being verified.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.queryByText(/Rotation failed/i)).not.toBeInTheDocument()
    expect(
      screen.getByText(/taking longer than the controller's readiness budget/i)
    ).toBeInTheDocument()

    // Second poll: the HCC has corrected DeploymentReady to True -> success.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Credentials rotated\./i)).toBeInTheDocument()
  })

  it('keeps waiting when DeploymentReady=True predates the PUT (stale success must not count)', async () => {
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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

  it('reports failure with the condition message when RolloutIncomplete persists after the PUT', async () => {
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'False',
        // Pin the diagnosed reason explicitly: this test asserts failure IS
        // reported, so it must not silently inherit the helper's default reason.
        reason: 'RolloutIncomplete',
        message: 'pod CrashLoopBackOff: 0/1 ready',
        lastTransitionTime: '2026-01-01T00:00:03.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    // A genuinely stuck pod: the diagnostic never gets corrected, so the UI's
    // full budget elapses and the failure surfaces the HCC's message verbatim.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS)
    })

    expect(
      screen.getByText(/Rotation failed: pod CrashLoopBackOff: 0\/1 ready/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()
  })

  it('counts a fresh True inside the clock-skew tolerance window as this rotation (M3)', async () => {
    // Regression guard for CLOCK_SKEW_TOLERANCE_MS. The cutoff is stamped from
    // the browser clock; lastTransitionTime from the cluster clock. When the
    // browser runs slightly AHEAD, a genuinely fresh condition can carry a
    // timestamp a few seconds BEFORE the raw cutoff — the tolerance backs the
    // cutoff off so it still counts. System time is 00:00:00Z, so the tolerant
    // cutoff is 23:59:55Z and a condition at 23:59:58Z is inside the window and
    // fresh. Remove `- CLOCK_SKEW_TOLERANCE_MS` and the cutoff becomes 00:00:00Z,
    // this condition is judged stale, the rotation wedges until timeout, and
    // this assertion goes red — which the pre-existing success test (whose
    // timestamp sits AFTER system time) could not detect.
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'ready',
        // 2s before system time (00:00:00Z): inside the 5s skew window, but
        // stale the instant the tolerance is removed.
        lastTransitionTime: '2025-12-31T23:59:58.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(screen.getByText(/Credentials rotated\./i)).toBeInTheDocument()
  })

  it('reports a bounded timeout — never success — when the condition never transitions', async () => {
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key']))
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

  it('names only the verified connector as serving; lists other shared-Secret connectors as rolling out separately (no multi-connector overclaim)', async () => {
    // A Secret shared by several connectors: the PUT reports ALL of them in
    // affectedConnectors, but this screen's poll observes ONLY its own
    // (SERVER_NAME) DeploymentReady. The success banner must therefore claim the
    // new credential is being served for SERVER_NAME alone, and merely name the
    // others as rolling out separately — never assert an unobserved success for
    // them (a false-positive: SERVER_NAME could converge while the other pod
    // CrashLoopBackOffs, yet the old banner said both "restarted and is serving").
    const OTHER = 'other-connector-b'
    mockUpdateMcpSecret.mockResolvedValue(secretRotationResponse(['api-key'], [SERVER_NAME, OTHER]))
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'ready',
        lastTransitionTime: '2026-01-01T00:00:05.000Z',
      })
    )

    await renderPanel(ENV_SECRET)
    await submitRotation({ 'api-key': 'new-key-value' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    const banner = screen.getByRole('status')
    // The verified connector IS asserted as serving; the other is only named as
    // rolling out separately.
    expect(banner).toHaveTextContent(
      `Credentials rotated. ${SERVER_NAME} restarted and is serving the new credential. ` +
        `Another connector sharing this Secret rolls out separately: ${OTHER}.`
    )
    // Regression guard for the overclaim: the unobserved connector must never be
    // asserted as already serving the new credential.
    expect(banner.textContent).not.toMatch(new RegExp(`${OTHER}[^.]*restarted and is serving`))
  })
})
