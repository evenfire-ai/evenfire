/**
 * E2E -- Operator visibility: stateless × CommunicationChannel hard-rejection banner
 *
 * Validates plan Addendum 6 item 4 (issue #791) on the LIVE control-ui host detail
 * view: a stateless Host that has a CONFIRMED CommunicationChannel association is
 * hard-rejected by HCC (effectiveMode=stateful + StatelessEnableRejected condition),
 * and the operator sees a prominent warning banner carrying the status reason
 * VERBATIM plus the disassociation recovery action. Removing the channel clears it.
 *
 * Why this spec arranges via a direct CRD write (kubectl), not the control-api:
 *   The normal control-api/UI path CANNOT reach this state by design — control-api
 *   rejects associating a CommunicationChannel with a stateless Host, and rejects
 *   flipping a channel-bound Host to stateless, both with 409
 *   `stateless_host_communication_channel_conflict`
 *   (control-api/src/routes/admin/resources.ts). The hard-rejection is HCC's
 *   defensive backstop for direct/racing CRD writes (AP-7,
 *   docs/architecture/stateless-invariants.md). So this spec reproduces exactly that
 *   race: it `kubectl apply`s a CommunicationChannel referencing a dedicated stateless
 *   Host, then asserts the operator-facing banner.
 *
 * Opt-in: this spec is skipped unless E2E_STATELESS_CHANNEL_REJECTION=1, because it
 * requires a dedicated stateless Host, a kubectl context, and the Addendum-6 executor
 * fix deployed (until it lands, a channel keeps effectiveMode=stateless and the
 * effectiveMode=stateful assertion below fails).
 *
 * Prerequisites (when enabled):
 *   1. Port-forwards running (control-ui :3000, control-api :8090).
 *   2. Admin credentials: ADMIN_USER, ADMIN_PASS.
 *   3. E2E_STATELESS_HOST — a dedicated Host with spec.lifecycle.stateless=true that is
 *      NOT chatllm-stateless (avoids colliding with the transient Test 2d window of
 *      scripts/e2e/e2e-stateless-suspend-wake.sh on a shared profile).
 *   4. E2E_KUBECONTEXT (or CONTEXT) — an allowed kubectl context (clerum-test /
 *      clerum-codex-* / gke_eventfire-*_clerum-dev). Passed to every kubectl call.
 */
import { execFileSync } from 'node:child_process'
import { type Page, expect, test } from '@playwright/test'

const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123!'

const ENABLED = process.env.E2E_STATELESS_CHANNEL_REJECTION === '1'
const HOST = process.env.E2E_STATELESS_HOST || ''
const KUBECONTEXT = process.env.E2E_KUBECONTEXT || process.env.CONTEXT || ''
const HOSTS_NS = process.env.E2E_HOSTS_NAMESPACE || 'mcp-host'
const CHANNELS_NS = process.env.E2E_CHANNELS_NAMESPACE || 'channels'
const REJECTED_CONDITION = 'StatelessEnableRejected'

// Unique per run so parallel/leftover runs never collide, and cleanup is targeted.
const CC_NAME = `e2e-vis-stateless-reject-${Date.now()}`

function kubectl(args: string[], input?: string): string {
  if (!KUBECONTEXT) {
    throw new Error(
      'E2E_KUBECONTEXT (or CONTEXT) must be set to an allowed context; kubectl context is never inferred.'
    )
  }
  return execFileSync('kubectl', ['--context', KUBECONTEXT, ...args], {
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
  })
}

function getHostJson(): {
  effectiveMode?: string
  rejected?: boolean
  rejectionMessage?: string
} {
  const raw = kubectl(['get', 'host', HOST, '-n', HOSTS_NS, '-o', 'json'])
  const obj = JSON.parse(raw) as {
    status?: {
      lifecycle?: { effectiveMode?: string }
      conditions?: Array<{ type?: string; status?: string; message?: string }>
    }
  }
  const condition = obj.status?.conditions?.find(c => c.type === REJECTED_CONDITION)
  return {
    effectiveMode: obj.status?.lifecycle?.effectiveMode,
    rejected: condition?.status === 'True',
    rejectionMessage: condition?.message,
  }
}

function applyChannel(): void {
  const manifest = `apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: ${CC_NAME}
  namespace: ${CHANNELS_NS}
spec:
  hostRef: ${HOST}
  email:
    - channelId: "INBOX"
      emails:
        - "e2e-visibility@example.test"
`
  kubectl(['apply', '-n', CHANNELS_NS, '-f', '-'], manifest)
}

function deleteChannel(): void {
  try {
    kubectl(['delete', 'communicationchannel', CC_NAME, '-n', CHANNELS_NS, '--ignore-not-found'])
  } catch (err) {
    // Cleanup is best-effort; surface it but never mask a prior assertion failure.
    console.warn(`[e2e] failed to delete CommunicationChannel ${CC_NAME}: ${String(err)}`)
  }
}

async function login(page: Page) {
  await page.goto(BASE_UI)
  await page.waitForSelector('text=Sign in', { timeout: 15_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 20_000 })
}

test.describe('operator sees the stateless × CommunicationChannel hard-rejection banner', () => {
  test.skip(
    !ENABLED,
    'opt-in: set E2E_STATELESS_CHANNEL_REJECTION=1 (with E2E_STATELESS_HOST, E2E_KUBECONTEXT) and deploy the Addendum-6 executor fix'
  )

  test.beforeAll(() => {
    // Fail loud on missing prerequisites rather than skipping silently.
    if (!HOST) throw new Error('E2E_STATELESS_HOST must name a dedicated stateless Host.')
    if (!KUBECONTEXT) throw new Error('E2E_KUBECONTEXT (or CONTEXT) must be set to an allowed context.')
    const host = getHostJson()
    // Guard: the target must actually be a stateless Host, or the whole scenario is invalid.
    const statelessRaw = kubectl([
      'get',
      'host',
      HOST,
      '-n',
      HOSTS_NS,
      '-o',
      'jsonpath={.spec.lifecycle.stateless}',
    ]).trim()
    if (statelessRaw !== 'true') {
      throw new Error(
        `E2E_STATELESS_HOST "${HOST}" must have spec.lifecycle.stateless=true (got "${statelessRaw}"). Host status: ${JSON.stringify(host)}`
      )
    }
    // Ensure a clean slate from any aborted prior run.
    deleteChannel()
  })

  test.afterAll(() => {
    deleteChannel()
  })

  test('renders the hard-rejection warning verbatim and clears it after disassociation', async ({
    page,
  }) => {
    // Arrange: the AP-7 racing CRD write — associate a channel with the stateless Host.
    applyChannel()

    // HCC hard-rejects on the next reconcile: effectiveMode=stateful + rejected condition.
    // Bounded, fail-loud poll — on timeout the last observed status is reported.
    await expect
      .poll(() => JSON.stringify(getHostJson()), {
        timeout: 120_000,
        intervals: [2_000],
        message:
          'HCC did not hard-reject the stateless Host after the CommunicationChannel was applied ' +
          '(requires the Addendum-6 executor fix deployed).',
      })
      .toMatch(/"effectiveMode":"stateful".*"rejected":true|"rejected":true.*"effectiveMode":"stateful"/)

    const rejectionMessage = getHostJson().rejectionMessage
    expect(rejectionMessage, 'StatelessEnableRejected condition must carry a message').toBeTruthy()
    // Contract (Addendum 6): the message names the channel count AND the recovery action.
    expect(rejectionMessage).toMatch(/disassociate/i)

    // Assert the operator-facing banner shows the status message VERBATIM.
    // The verbatim reason renders on TWO deliberate operator-visibility surfaces —
    // the warning banner AND the lifecycle chip — so scope each assertion to its
    // own surface rather than letting an unscoped getByText(reason) collide across
    // both (strict-mode violation).
    await login(page)
    await page.goto(`${BASE_UI}/hosts/${encodeURIComponent(HOST)}`)
    // Anchor on the banner CONTAINER, not the 'Stateless mode rejected:' text —
    // that phrase lives in a <strong> leaf whose text is only the prefix, so the
    // reason (a sibling text node in the same .cu-banner--warning div) is not part
    // of the leaf. Match the container by class + its heading text, then assert
    // the reason WITHIN it.
    const rejectionBanner = page.locator('.cu-banner--warning', {
      hasText: 'Stateless mode rejected:',
    })
    await expect(rejectionBanner).toBeVisible({ timeout: 20_000 })
    // (1) the warning banner container carries the reason verbatim
    await expect(rejectionBanner).toContainText(rejectionMessage as string, { timeout: 20_000 })
    // (2) the lifecycle chip is a second visibility surface — assert it deliberately
    await expect(
      page.locator('.cu-chip', { hasText: rejectionMessage as string })
    ).toBeVisible({ timeout: 20_000 })

    // Disassociation recovery: remove the channel; HCC clears the rejection.
    // Strict delete (not the best-effort cleanup helper) so a real failure here
    // fails the test loudly instead of being swallowed mid-scenario.
    kubectl(['delete', 'communicationchannel', CC_NAME, '-n', CHANNELS_NS, '--ignore-not-found'])
    await expect
      .poll(() => JSON.stringify(getHostJson()), {
        timeout: 120_000,
        intervals: [2_000],
        message: 'HCC did not clear the hard-rejection after the CommunicationChannel was removed.',
      })
      .toMatch(/"rejected":false/)

    // BOTH surfaces must clear once the Host reports stateless-active again: the
    // warning banner disappears AND the rejection reason no longer renders on any
    // surface (banner or lifecycle chip).
    await page.reload()
    await expect(
      page.locator('.cu-banner--warning', { hasText: 'Stateless mode rejected:' })
    ).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByText(rejectionMessage as string, { exact: false })).toHaveCount(0, {
      timeout: 20_000,
    })
  })
})
