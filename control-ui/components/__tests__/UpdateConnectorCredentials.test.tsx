import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  UpdateConnectorCredentials,
} from '@components/UpdateConnectorCredentials'
import type { CredentialSurface } from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import { createMcpSecret, getMcpServer, getMcpServers, updateMcpSecret } from '@lib/api'
import type { EnvSecret, McpServerResource } from '@lib/api'

vi.mock('@lib/api', () => ({
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  updateMcpSecret: vi.fn(),
  createMcpSecret: vi.fn(),
}))

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)
const mockCreateMcpSecret = vi.mocked(createMcpSecret)

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
async function renderPanel(
  envSecret: EnvSecret | undefined,
  surface: CredentialSurface = 'rotate',
  recipeOwned = false
) {
  const utils = render(
    <ToastProvider>
      <UpdateConnectorCredentials
        serverName={SERVER_NAME}
        envSecret={envSecret}
        surface={surface}
        recipeOwned={recipeOwned}
      />
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

/** Fills `keys` (secretKey -> value), submits, and confirms the set-mode
 *  dialog — draining the microtask chain in between so callers land on a
 *  settled `phase`. */
async function submitSet(keys: Record<string, string>) {
  for (const [secretKey, value] of Object.entries(keys)) {
    fireEvent.change(screen.getByLabelText(secretKey), { target: { value } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Set & start' }))
  await flush()
}

const ALL_KEYS = { 'api-key': 'a-value', 'workspace-id': 'w-value' }

/** The shape control-api actually returns for a duplicate create: a bare 500,
 *  NOT a 409 (see spec Non-goals). Mocking 409 here would be a test that can
 *  never fail against the real server. */
function serverError() {
  return Object.assign(new Error('500 Internal Server Error'), { status: 500 })
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
    // The toast must keep the rotate wording that matches the banner. A single
    // mode-blind string ("Failed to save credentials.") reads as a regression on
    // the default path, where the banner right next to it says "Rotation failed".
    expect(screen.getByText('Failed to rotate credentials.')).toBeInTheDocument()
    // The PUT was actually attempted (not blocked client-side), and the failure
    // short-circuits before any DeploymentReady poll.
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockGetMcpServer).not.toHaveBeenCalled()
  })

  // The 404 branch is the ONLY status the rotate path may treat as "the Secret
  // vanished". Widening it (e.g. `>= 400`) would swallow this real 409 —
  // control-api/src/routes/admin/secrets.ts returns it for a WorkflowRecipe-owned
  // Secret — into a silent mode flip that tells the operator to re-enter every
  // key, hiding the message that actually points them at /admin/recipe-secrets.
  // Every other rotate-rejection mock in this file carries NO `.status`, so
  // `undefined >= 400` is false and none of them can catch that widening.
  it('rethrows a status-carrying non-404 PUT rejection (409 recipe-owned) instead of flipping to set mode', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(
        new Error(
          '409 - Secret "linear-credentials" is owned by a WorkflowRecipe; rotate it through /admin/recipe-secrets'
        ),
        { status: 409 }
      )
    )
    await renderPanel(ENV_SECRET, 'rotate')
    await submitRotation({ 'api-key': 'new-key-value' })

    // The operator sees the backend's own message, verbatim.
    expect(screen.getByText(/Rotation failed:.*owned by a WorkflowRecipe/)).toBeInTheDocument()
    expect(screen.getByText(/\/admin\/recipe-secrets/)).toBeInTheDocument()
    // ...and NOT the vanished-Secret recovery, which would demand every key.
    expect(screen.queryByText(/This Secret no longer exists\./)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate again' })).toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })
})

describe('UpdateConnectorCredentials — rotate mode against a vanished Secret', () => {
  it('switches to set mode instead of creating a partial Secret', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret "linear-credentials" not found in mcp-server'), {
        status: 404,
      })
    )
    await renderPanel(ENV_SECRET, 'rotate')

    // Only ONE key filled — valid for a rotation, fatal for a create.
    await submitRotation({ 'api-key': 'only-one' })

    expect(screen.getByText(/This Secret no longer exists\./)).toBeInTheDocument()
    // The partial data must NOT have been posted.
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
    // The form is now in set mode, demanding every key.
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
  })

  // The recovery is a ROUND TRIP, and only its return leg proves the set-mode
  // latch is not one-way. `recreateRequired` is never reset (resetToIdle does
  // not touch it), so it must sit BEHIND the `secretCreated` guard: once the
  // recreate lands, the Secret exists and every set-mode surface is a lie —
  // "needs credentials before it can start", `Required` placeholders, all keys
  // forced on the next submit, and a confirm dialog offering to create a Secret
  // that is already there.
  it('returns to rotate semantics once the recreate succeeds', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret "linear-credentials" not found in mcp-server'), {
        status: 404,
      })
    )
    mockCreateMcpSecret.mockResolvedValue({ name: ENV_SECRET.name, namespace: 'mcp-server' })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'Running',
        lastTransitionTime: '2026-01-01T00:00:30.000Z',
      })
    )
    await renderPanel(ENV_SECRET, 'rotate')

    // Leg 1: rotate against a Secret that vanished — the form latches to set.
    await submitRotation({ 'api-key': 'only-one' })
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()

    // Leg 2: recreate it with every key, and let the connector come up.
    await submitSet(ALL_KEYS)
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS)
    })
    await flush()
    expect(screen.getByText(/Credentials set\./)).toBeInTheDocument()

    // Leg 3: back to an editable form. The Secret EXISTS now, so every surface
    // must have returned to rotate semantics.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.queryByText(/needs credentials before it can start/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Rotate values stored in Secret/i)).toBeInTheDocument()
    // The per-field tell: `Required` is what forces every key on the next submit.
    expect(screen.getByLabelText('api-key')).toHaveAttribute(
      'placeholder',
      'Leave blank to keep current value'
    )
  })

  // The other direction of the same latch. `secretCreated` means "a create
  // already landed", and it is what GATES set mode — so a later 404, which is
  // proof the Secret is gone again, has to clear it. Otherwise the second
  // vanish would leave the rotate button on screen while the error text demands
  // every key, and each retry would 404 forever.
  it('flips back to set mode when the Secret vanishes a SECOND time in the same session', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret "linear-credentials" not found in mcp-server'), {
        status: 404,
      })
    )
    mockCreateMcpSecret.mockResolvedValue({ name: ENV_SECRET.name, namespace: 'mcp-server' })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'Running',
        lastTransitionTime: '2026-01-01T00:00:30.000Z',
      })
    )
    await renderPanel(ENV_SECRET, 'rotate')

    // First vanish, recreate, and return to the rotate form.
    await submitRotation({ 'api-key': 'only-one' })
    await submitSet(ALL_KEYS)
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS)
    })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()

    // Deleted again out-of-band: the rotate PUT 404s a second time.
    await submitRotation({ 'api-key': 'only-one-again' })

    expect(screen.getByText(/This Secret no longer exists\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    // Still no partial create.
    expect(mockCreateMcpSecret).toHaveBeenCalledTimes(1)
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

  it('reports failure with the HCC diagnostic only after the FULL poll budget when RolloutIncomplete persists', async () => {
    // RolloutIncomplete is the HCC saying "I exhausted MY 120s budget", not an
    // irreversible verdict — its post-terminal re-poll can still correct the
    // condition to True (see the recovery test below). So the UI must NOT latch
    // failure on the first sighting; it reports failure only when its OWN
    // POLL_TIMEOUT_MS expires with the diagnostic still uncorrected — and then
    // with the HCC's rollout numbers, never a bare "timed out".
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
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
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

  it('reports failure with the condition message when RolloutIncomplete persists after the PUT', async () => {
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME],
    })
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

  it('names only the verified connector as serving; lists other shared-Secret connectors as rolling out separately (no multi-connector overclaim)', async () => {
    // A Secret shared by several connectors: the PUT reports ALL of them in
    // affectedConnectors, but this screen's poll observes ONLY its own
    // (SERVER_NAME) DeploymentReady. The success banner must therefore claim the
    // new credential is being served for SERVER_NAME alone, and merely name the
    // others as rolling out separately — never assert an unobserved success for
    // them (a false-positive: SERVER_NAME could converge while the other pod
    // CrashLoopBackOffs, yet the old banner said both "restarted and is serving").
    const OTHER = 'other-connector-b'
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key'],
      affectedConnectors: [SERVER_NAME, OTHER],
    })
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

describe('UpdateConnectorCredentials — recipe-owned', () => {
  it('renders an explanation and no form when the Secret belongs to a WorkflowRecipe', async () => {
    await renderPanel(ENV_SECRET, 'recipe-owned')

    expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
    // No form at all: neither the inputs nor either submit button.
    expect(screen.queryByLabelText('api-key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
  })
})

// ─── R1-H1: ownership must not depend on the observed condition ────────────
//
// `surface` is derived from status. A managed:false connector whose status is
// absent, Unknown, or stale carries NO SecretNotFound condition, so it resolves
// to `rotate` — and the PUT's own 404 is then the FIRST evidence the Secret is
// missing. If that 404 were allowed to open the create form, the ownership
// guard would be defeated exactly when it matters: the operator would POST an
// unlabeled Secret outside the WorkflowRecipe flow, collide with the recipe's
// later provisioning, and then wait forever for an HCC rollout that
// managed:false connectors never receive.
//
// `recipeOwned` is therefore threaded from the page as an ownership FACT
// (spec.managed === false), independent of any condition.
describe('UpdateConnectorCredentials — recipe-owned, late 404', () => {
  it('lands on explanation-only when a rotate PUT 404s on a recipe-owned connector', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret "linear-credentials" not found in mcp-server'), {
        status: 404,
      })
    )
    // Status has not been written yet, so the resolver can only say 'rotate'.
    await renderPanel(ENV_SECRET, 'rotate', true)
    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()

    await submitRotation({ 'api-key': 'only-one' })

    // The 404 must point at the recipe, not at a create form.
    expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('api-key')).not.toBeInTheDocument()
    expect(screen.queryByText(/Enter every key to recreate it/)).not.toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  // Defense in depth: even if a caller (or a future resolver change) handed
  // this component `surface: 'set'` for a recipe-owned connector, POST must
  // stay unreachable. `mode` may never resolve to 'set' by ANY path.
  it('never renders the create form for a recipe-owned connector handed surface="set"', async () => {
    await renderPanel(ENV_SECRET, 'set', true)

    expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.queryByText(/needs credentials before it can start/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('api-key')).not.toBeInTheDocument()
  })

  // The managed:TRUE control for the same journey — the recovery this screen
  // exists to provide must keep working, so the guard above cannot be a blanket
  // "never recover from a 404".
  it('still opens the create form on a late 404 for a managed connector', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret "linear-credentials" not found in mcp-server'), {
        status: 404,
      })
    )
    await renderPanel(ENV_SECRET, 'rotate', false)
    await submitRotation({ 'api-key': 'only-one' })

    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    expect(screen.queryByText(/managed by its WorkflowRecipe/i)).not.toBeInTheDocument()
  })
})

describe('UpdateConnectorCredentials — set mode', () => {
  it('renders set-mode copy instead of rotation copy', async () => {
    await renderPanel(ENV_SECRET, 'set')

    expect(screen.getByText(/needs credentials before it can start/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  })

  it('blocks submit until every declared key has a value and names the missing ones', async () => {
    await renderPanel(ENV_SECRET, 'set')

    // Only one of the two declared keys filled.
    fireEvent.change(screen.getByLabelText('api-key'), { target: { value: 'secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    await flush()

    expect(
      screen.getByText(/Enter every credential value\. Missing: workspace-id/)
    ).toBeInTheDocument()
    // No confirm dialog, so nothing was sent.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('UpdateConnectorCredentials — set mode submit', () => {
  it('calls createMcpSecret and not updateMcpSecret', async () => {
    mockCreateMcpSecret.mockResolvedValue({ name: ENV_SECRET.name, namespace: 'mcp-server' })
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(mockCreateMcpSecret).toHaveBeenCalledWith(ENV_SECRET.name, {
      'api-key': 'a-value',
      'workspace-id': 'w-value',
    })
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
  })

  // The AlreadyExists race. control-api collapses it to 500, so the retry must
  // NOT be gated on a status code.
  it('falls back to updateMcpSecret when the create fails, and reports success', async () => {
    mockCreateMcpSecret.mockRejectedValue(serverError())
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key', 'workspace-id'],
      affectedConnectors: [SERVER_NAME],
    })
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(mockUpdateMcpSecret).toHaveBeenCalledWith(ENV_SECRET.name, ALL_KEYS)
    // A successful retry must actually land the submit in the set-mode
    // in-flight state, not merely avoid the ROTATE failure copy (which can
    // never render in set mode regardless of outcome — see index.tsx:479-481 —
    // so asserting its absence alone would pass vacuously).
    expect(screen.getByText(/Setting credentials — waiting for/i)).toBeInTheDocument()
    expect(screen.queryByText(/Could not set credentials/i)).not.toBeInTheDocument()
  })

  // ─── R1-H3: the retry must stay STATUS-AGNOSTIC ──────────────────────────
  //
  // control-api collapses the Kubernetes AlreadyExists into a bare 500 and can
  // never emit 409 today (spec Non-goals), so a `postError.status === 409`
  // branch would be dead code and the retry fires on ANY POST failure. The
  // 500-only success test above cannot detect a regression that GATES the retry
  // on 500 — the reviewer confirmed that mutation left all 28 component tests
  // green. These two close that hole from both sides.

  // FORWARD-COMPATIBILITY ONLY. control-api does NOT return 409 for a duplicate
  // create today; this asserts the client would still recover if the server
  // were ever fixed to send the correct status. Do not read this fixture as
  // current server behavior — `serverError()` above is the real shape.
  it('forward-compatibility: still falls back to the merge-patch if the create ever answers 409', async () => {
    mockCreateMcpSecret.mockRejectedValue(
      Object.assign(new Error('409 - secrets "linear-credentials" already exists'), { status: 409 })
    )
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key', 'workspace-id'],
      affectedConnectors: [SERVER_NAME],
    })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'Running',
        lastTransitionTime: '2026-01-01T00:00:30.000Z',
      })
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockUpdateMcpSecret).toHaveBeenCalledWith(ENV_SECRET.name, ALL_KEYS)
    // The operator must reach the real set-mode progress state, not a failure.
    expect(screen.getByText(/Setting credentials — waiting for/i)).toBeInTheDocument()
    expect(screen.queryByText(/Could not set credentials/i)).not.toBeInTheDocument()

    // ...and all the way to the set-mode success banner.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS)
    })
    await flush()
    expect(screen.getByText(/Credentials set\./)).toBeInTheDocument()
  })

  // The other half of the same invariant: a NON-500 create failure must still
  // produce exactly one merge-patch attempt. Gating the retry on 500 makes this
  // zero.
  it('attempts the merge-patch exactly once after a NON-500 create failure', async () => {
    mockCreateMcpSecret.mockRejectedValue(
      Object.assign(new Error('400 Bad Request'), { status: 400 })
    )
    mockUpdateMcpSecret.mockResolvedValue({
      name: ENV_SECRET.name,
      namespace: 'mcp-server',
      keys: ['api-key', 'workspace-id'],
      affectedConnectors: [SERVER_NAME],
    })
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(mockCreateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Setting credentials — waiting for/i)).toBeInTheDocument()
  })

  // ─── R1-M1: which failure the operator is shown when BOTH legs fail ──────
  //
  // A 404 from the follow-up PUT is noise — the whole point of the retry is
  // that the Secret might already exist, so "it does not exist" adds nothing to
  // the create error the operator actually attempted.
  it('reports the original create error when the retry fails with 404', async () => {
    mockCreateMcpSecret.mockRejectedValue(
      Object.assign(new Error('data["api-key"] must be a string'), { status: 400 })
    )
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 - Secret not found'), { status: 404 })
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(screen.getByText(/data\["api-key"\] must be a string/)).toBeInTheDocument()
    expect(screen.queryByText(/404 - Secret not found/)).not.toBeInTheDocument()
    // The PUT was genuinely attempted — otherwise this test would pass for the
    // wrong reason (a retry that never ran also "reports the create error").
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
  })

  // Any OTHER PUT failure describes the CURRENT state more precisely than the
  // opaque create error does. The production pair: control-api answers a bare
  // 500 for the AlreadyExists, then the merge-patch answers the real 409 that
  // names the WorkflowRecipe and points at /admin/recipe-secrets. Showing the
  // 500 hides the only actionable instruction the operator gets.
  it('surfaces the retry error when the merge-patch fails with an actionable 409', async () => {
    mockCreateMcpSecret.mockRejectedValue(serverError())
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(
        new Error(
          '409 - Secret "linear-credentials" is owned by a WorkflowRecipe; rotate it through /admin/recipe-secrets'
        ),
        { status: 409 }
      )
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(
      screen.getByText(/Could not set credentials:.*owned by a WorkflowRecipe/)
    ).toBeInTheDocument()
    expect(screen.getByText(/\/admin\/recipe-secrets/)).toBeInTheDocument()
    // The opaque create error must not be what the operator is left with.
    expect(screen.queryByText(/500 Internal Server Error/)).not.toBeInTheDocument()
  })

  it('surfaces the retry error when the merge-patch fails with 403', async () => {
    mockCreateMcpSecret.mockRejectedValue(serverError())
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('403 - secrets is forbidden in namespace "mcp-server"'), {
        status: 403,
      })
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(screen.getByText(/Could not set credentials:.*is forbidden/)).toBeInTheDocument()
  })

  it('reaches the success banner once DeploymentReady turns True', async () => {
    mockCreateMcpSecret.mockResolvedValue({ name: ENV_SECRET.name, namespace: 'mcp-server' })
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'True',
        message: 'Running',
        lastTransitionTime: '2026-01-01T00:00:30.000Z',
      })
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS)
    })
    await flush()

    expect(screen.getByText(/Credentials set\./)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`${SERVER_NAME} started`))).toBeInTheDocument()
  })

  it('shows a set-mode failure banner and toast when both the create and the retry fail', async () => {
    mockCreateMcpSecret.mockRejectedValue(serverError())
    mockUpdateMcpSecret.mockRejectedValue(serverError())
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    expect(screen.getByText(/Could not set credentials:/)).toBeInTheDocument()
    // The toast is the only failure surface that could plausibly carry rotate
    // wording here — the banner branch above can never render it in set mode, so
    // asserting THAT absence would pass vacuously.
    expect(screen.getByText('Failed to set credentials.')).toBeInTheDocument()
    expect(screen.queryByText('Failed to rotate credentials.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('offers to try setting the credentials again — never "the rotation" — when the poll times out', async () => {
    // The timeout banner used to be the one retrospective surface with no mode
    // branch, so a create that never converged told the operator to "try the
    // rotation again" about a rotation that never happened.
    mockCreateMcpSecret.mockResolvedValue({ name: ENV_SECRET.name, namespace: 'mcp-server' })
    // Always stale: the condition predates the POST on every poll.
    mockGetMcpServer.mockResolvedValue(
      serverWithCondition({
        status: 'False',
        message: 'rolling out',
        lastTransitionTime: '2020-01-01T00:00:00.000Z',
      })
    )
    await renderPanel(ENV_SECRET, 'set')
    await submitSet(ALL_KEYS)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS)
    })

    const banner = screen.getByText(/did not finish within/i)
    expect(banner).toHaveTextContent('You can also try setting the credentials again.')
    expect(banner.textContent).not.toMatch(/rotation/i)
  })
})
