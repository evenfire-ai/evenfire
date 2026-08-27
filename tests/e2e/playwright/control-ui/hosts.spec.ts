/**
 * Control UI — Hosts tab tests
 *
 * Validates the Hosts table and Host Wizard UI.
 * Uses the authedPage fixture to bypass the login form.
 */
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { type HostCr, controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD, CUI_HOSTS } from '../helpers/selectors'

const KUBE_CONTEXT =
  process.env.KUBECONTEXT ?? process.env.E2E_K8S_CONTEXT ?? process.env.K8S_CONTEXT
const CHANNEL_READER_NAMESPACE = process.env.E2E_CHANNEL_READER_NAMESPACE ?? 'channels'
const FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES = [
  'workflow:list',
  'workflow:read',
  'workflow:trigger',
  'workflow:approval:resolve',
  'workflow:approval:decide',
]
const CONCURRENT_EDIT_WARNING =
  "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."

type ChannelReaderIngressStatus = {
  serviceName: string
  deploymentName: string
  desiredReplicas: number
  readyReplicas: number
}

function kubectlOutput(args: string[]): string {
  if (!KUBE_CONTEXT) {
    throw new Error(
      'KUBECONTEXT, E2E_K8S_CONTEXT, or K8S_CONTEXT is required for channel-reader ingress assertions'
    )
  }
  return execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function waitForChannelReaderIngressReady(
  hostName: string,
  timeoutMs = 120_000
): Promise<ChannelReaderIngressStatus> {
  const deploymentName = `channel-reader-${hostName}`
  const serviceName = deploymentName
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      kubectlOutput(['get', 'service', serviceName, '-n', CHANNEL_READER_NAMESPACE, '-o', 'name'])
      const desiredRaw = kubectlOutput([
        'get',
        'deployment',
        deploymentName,
        '-n',
        CHANNEL_READER_NAMESPACE,
        '-o',
        'jsonpath={.spec.replicas}',
      ])
      const readyRaw = kubectlOutput([
        'get',
        'deployment',
        deploymentName,
        '-n',
        CHANNEL_READER_NAMESPACE,
        '-o',
        'jsonpath={.status.readyReplicas}',
      ])
      const desiredReplicas = Number(desiredRaw || '0')
      const readyReplicas = Number(readyRaw || '0')
      if (desiredReplicas >= 1 && readyReplicas >= 1) {
        return { serviceName, deploymentName, desiredReplicas, readyReplicas }
      }
      lastError = new Error(
        `${deploymentName} replicas not ready yet: desired=${desiredReplicas} ready=${readyReplicas}`
      )
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for channel-reader ingress "${deploymentName}" ` +
      `in namespace "${CHANNEL_READER_NAMESPACE}". Last error: ${String(lastError ?? 'none')}`
  )
}

async function dismissAdminEmailPromptIfPresent(page: Page): Promise<void> {
  // AdminBridgeAlerts shows "Set up your admin email" for admin accounts
  // without a recovery email and overlays the page. Dismissing it is a named
  // test precondition (this suite does not test that prompt); the click is
  // logged so a run transcript shows exactly what happened.
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  try {
    await remindLater.waitFor({ state: 'visible', timeout: 3_000 })
  } catch {
    return // prompt not shown — nothing to dismiss
  }
  console.log('[e2e] dismissing "Set up your admin email" prompt (Remind me later)')
  await remindLater.click()
  await remindLater.waitFor({ state: 'hidden', timeout: 5_000 })
}

test.describe('Control UI — Hosts', () => {
  test.beforeEach(async ({ authedPage }) => {
    // Hosts tab is default — just wait for dashboard to load
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('Hosts tab is active by default', async ({ authedPage }) => {
    // The Hosts tab button should be visually active (darker background via inline style)
    const hostsTab = authedPage.locator(CUI_DASHBOARD.TAB_HOSTS)
    await expect(hostsTab).toBeVisible()
    // Tab button exists and we can see the Create Host button (only shown on Hosts tab)
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeVisible()
  })

  test('shows hosts table with expected columns', async ({ authedPage }) => {
    const table = authedPage.locator(CUI_HOSTS.TABLE)
    await expect(table).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.locator(CUI_HOSTS.TABLE_HEADER_NAME)).toBeVisible()
    await expect(authedPage.locator(CUI_HOSTS.TABLE_HEADER_NAMESPACE)).toBeVisible()
  })

  test('shows chatllm host from cluster', async ({ authedPage }) => {
    await expect(authedPage.locator('table')).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.getByRole('button', { name: /^chatllm$/ })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('Create Host button opens the create-agent page', async ({ authedPage }) => {
    await authedPage.click(CUI_DASHBOARD.CREATE_HOST_BUTTON)
    // The create flow is a canonical page (/hosts/new) titled "Create agent",
    // not a modal — assert the route AND the page heading.
    await expect(authedPage).toHaveURL(/\/hosts\/new/, { timeout: 10_000 })
    await expect(
      authedPage.getByRole('heading', { name: 'Create agent', exact: true })
    ).toBeVisible({ timeout: 10_000 })
  })

  test('create-agent page can be left via Back to agents', async ({ authedPage }) => {
    await authedPage.click(CUI_DASHBOARD.CREATE_HOST_BUTTON)
    await expect(authedPage).toHaveURL(/\/hosts\/new/, { timeout: 10_000 })
    await dismissAdminEmailPromptIfPresent(authedPage)
    await authedPage.getByRole('button', { name: 'Back to agents' }).click()
    // Back on the hosts list, the create action is available again
    await expect(authedPage).toHaveURL(/\/hosts(?!\/new)/, { timeout: 10_000 })
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeVisible()
  })

  test('Refresh button reloads host data', async ({ authedPage }) => {
    const refreshBtn = authedPage.locator(CUI_DASHBOARD.REFRESH_BUTTON)
    await expect(refreshBtn).toBeVisible()
    await refreshBtn.click()
    // After refresh, table should still be present (data reloaded)
    await expect(authedPage.locator(CUI_HOSTS.TABLE)).toBeVisible({ timeout: 15_000 })
  })
})

/**
 * Stateless Agents (Host spec.lifecycle.stateless)
 *
 * Covers the three lifecycle flows added with the Agent type selector:
 *   a) create flow — selecting "Stateless (suspends when idle)" in the wizard
 *      lands spec.lifecycle.stateless=true on the created Host CR
 *   b) edit flow — saving an unrelated field on a stateless host preserves the
 *      flag (the admin facade full-replaces the spec)
 *   c) channel ingress — a CommunicationChannel remains attachable to a
 *      stateless Host while the default policy forces it always-on with a
 *      visible rejection reason
 */

/** Bounded readiness wait: polls the Host CR and FAILS with diagnostics on expiry. */
async function waitForHostCr(
  name: string,
  predicate: (host: HostCr) => boolean,
  label: string,
  timeoutMs = 90_000
): Promise<HostCr> {
  const deadline = Date.now() + timeoutMs
  let lastSeen: HostCr | null = null
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      lastSeen = await controlApi.getHost(name)
      lastError = null
      if (predicate(lastSeen)) return lastSeen
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for host "${name}" (${label}). ` +
      `Last seen: ${JSON.stringify(lastSeen)}. Last error: ${String(lastError ?? 'none')}`
  )
}

function findStatelessRejection(host: HostCr) {
  return (host.status?.conditions ?? []).find(
    condition => condition.type === 'StatelessEnableRejected' && condition.status === 'True'
  )
}

test.describe('Control UI — Stateless Agents', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('create flow: Stateless selection lands spec.lifecycle.stateless=true on the Host CR', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    const agentName = `e2e-stateless-create-${Date.now()}`
    let contextName = ''
    const secretName = `${agentName}-secret`
    try {
      // PRECONDITION (labeled setup): a managed host secret for the picker.
      // The wizard's "Use existing secret" list is label-filtered
      // (clerum.io/host-secret) and a fresh profile has none -- depending on
      // pre-existing environment secrets would be shared-state flakiness.
      await controlApi.createHostSecret(secretName, {
        'openai-api-key': 'e2e-stateless-create-dummy-key',
      })

      await authedPage.click(CUI_DASHBOARD.CREATE_HOST_BUTTON)
      await expect(authedPage).toHaveURL(/\/hosts\/new/, { timeout: 10_000 })
      await expect(
        authedPage.getByRole('heading', { name: 'Create agent', exact: true })
      ).toBeVisible({ timeout: 10_000 })
      await dismissAdminEmailPromptIfPresent(authedPage)

      // Step 0 — agent name + Agent type
      await authedPage.getByPlaceholder('agent-name').fill(agentName)
      const statelessRadio = authedPage.getByRole('radio', {
        name: /Stateless \(suspends when idle\)/,
      })
      await statelessRadio.check()
      await expect(statelessRadio).toBeChecked()
      await authedPage.getByRole('button', { name: 'Next', exact: true }).click()

      // Step 1 — keep the default model, reuse the first existing secret
      await authedPage.getByRole('radio', { name: /Use existing secret/ }).check()
      await authedPage.getByRole('button', { name: /Select secret/ }).click()
      // Deterministic pick: the exact secret this test seeded, never .first()
      const seededSecret = authedPage.getByRole('option', { name: new RegExp(secretName) })
      await expect(seededSecret).toBeVisible({ timeout: 10_000 })
      await seededSecret.click()
      await authedPage.getByRole('button', { name: 'Next', exact: true }).click()

      // Step 2 — access grants are optional
      await authedPage.getByRole('button', { name: 'Next', exact: true }).click()

      // Step 3 — no connector is needed for this flag-only flow.
      await authedPage.getByRole('button', { name: 'Create Agent', exact: true }).click()
      // Completion leaves the create page (canonical routing) — the CR poll
      // below is the business signal; this asserts the UI transition.
      await expect(authedPage).not.toHaveURL(/\/hosts\/new/, { timeout: 30_000 })

      const created = await waitForHostCr(
        agentName,
        host => host.spec?.lifecycle?.stateless === true,
        'spec.lifecycle.stateless=true'
      )
      contextName = String(created.spec?.contextRef || '')
      expect(created.spec?.lifecycle?.stateless).toBe(true)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
      if (contextName) await controlApi.ensureContextDeleted(contextName)
      await controlApi.ensureSecretDeleted(secretName)
    }
  })

  test('edit flow: saving an unrelated field preserves spec.lifecycle on a stateless host', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    const agentName = `e2e-stateless-edit-${Date.now()}`
    try {
      await controlApi.createHost({
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: '',
          secretRef: '',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
          lifecycle: { stateless: true },
        },
      })
      await waitForHostCr(
        agentName,
        host => host.spec?.lifecycle?.stateless === true,
        'created with spec.lifecycle.stateless=true',
        30_000
      )

      await authedPage.goto(`/hosts/${encodeURIComponent(agentName)}`)
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      // The Agent type field loaded the stateless flag from the CR
      await expect(authedPage.getByText('Stateless (suspends when idle)')).toBeVisible({
        timeout: 15_000,
      })

      // Edit an UNRELATED field and save — the flag must survive the full replace
      await authedPage.getByRole('button', { name: 'Edit', exact: true }).first().click()
      await authedPage.getByLabel('Display ID').fill(`${agentName}-updated`)
      await authedPage.getByRole('button', { name: 'Save', exact: true }).click()
      const savedToast = authedPage.getByText('Agent configuration saved.')
      try {
        await expect(savedToast).toBeVisible({ timeout: 15_000 })
      } catch {
        await expect(authedPage.getByText(CONCURRENT_EDIT_WARNING)).toBeVisible()
        await authedPage.reload()
        await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({
          timeout: 15_000,
        })
        await expect(authedPage.getByText('Stateless (suspends when idle)')).toBeVisible({
          timeout: 15_000,
        })
        await authedPage.getByRole('button', { name: 'Edit', exact: true }).first().click()
        await authedPage.getByLabel('Display ID').fill(`${agentName}-updated`)
        await authedPage.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(savedToast).toBeVisible({ timeout: 15_000 })
      }

      const after = await controlApi.getHost(agentName)
      expect(after.spec?.host).toBe(`${agentName}-updated`)
      expect(after.spec?.lifecycle?.stateless).toBe(true)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
    }
  })

  test('channel ingress: default policy keeps stateless host always-on with visible rejection', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    const agentName = `e2e-stateless-channel-${Date.now()}`
    const channelName = `${agentName}-chan`
    try {
      // PRECONDITION (labeled setup): an existing ingress channel, matching
      // the wizard's "Use existing channel" path without depending on a real
      // Telegram provider during the operator UI assertion below.
      await controlApi.createCommunicationChannel({
        metadata: { name: channelName },
        spec: {
          hostRef: agentName,
          access: { users: [], teams: [] },
          telegram: [],
          slack: [],
          telegramSettings: {
            botHandle: '@e2e_stateless_channel_bot',
            replyOnlyWhenMentioned: true,
          },
        },
        credentials: { 'telegram-bot-token': '000000:e2e-stateless-channel-fixture' },
      })
      await controlApi.createHost({
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: '',
          secretRef: '',
          channels: [channelName],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
          lifecycle: { stateless: true },
          workflowControl: { scopes: FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES },
        },
      })

      const rejected = await waitForHostCr(
        agentName,
        host => {
          const condition = findStatelessRejection(host)
          const channels = Array.isArray(host.spec?.channels) ? host.spec?.channels : []
          return (
            host.spec?.lifecycle?.stateless === true &&
            channels.includes(channelName) &&
            Array.isArray(host.spec?.workflowControl?.scopes) &&
            host.spec.workflowControl.scopes.includes('workflow:approval:resolve') &&
            condition?.reason === 'ActiveCommunicationChannels'
          )
        },
        'stateless Host rejected into always-on mode with a CommunicationChannel ingress'
      )
      const rejection = findStatelessRejection(rejected)
      expect(rejection?.reason).toBe('ActiveCommunicationChannels')
      const rejectionMessage = String(rejection?.message ?? '')
      expect(rejectionMessage).toMatch(/CommunicationChannel|communication channel/i)
      const ingress = await waitForChannelReaderIngressReady(agentName)
      expect(ingress.serviceName).toBe(`channel-reader-${agentName}`)
      expect(ingress.readyReplicas).toBeGreaterThanOrEqual(1)

      await authedPage.goto(`/hosts/${encodeURIComponent(agentName)}`)
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByText('Stateless (suspends when idle)')).toBeVisible({
        timeout: 15_000,
      })
      await expect(authedPage.getByText('Stateless mode rejected:')).toBeVisible({
        timeout: 15_000,
      })
      const rejectionBanner = authedPage
        .locator('.cu-banner--warning')
        .filter({ hasText: 'Stateless mode rejected:' })
      await expect(rejectionBanner).toContainText(rejectionMessage)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
      await controlApi.ensureCommunicationChannelDeleted(channelName)
    }
  })
})

/**
 * Concurrent edit protection (AP-6)
 *
 * The host detail page captures metadata.resourceVersion when the edit form's
 * data is LOADED and sends it on save. A save built on a stale read gets
 * exactly one attempt and a 409 {error:'conflict', reason:'resource_changed'};
 * the UI shows the conflict banner, stays in edit mode, and preserves the
 * operator's draft. RV-absent API callers keep legacy last-write-wins.
 */
test.describe('Control UI — Concurrent edit protection (AP-6)', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  // ACCEPTANCE GATE — this test FAILS if:
  //   (a) the facade retries the stale payload into the server: the business
  //       signal (controlApi.getHost) would see the out-of-band change
  //       overwritten by the stale form echo;
  //   (b) the UI silently exits edit mode on 409: the Display ID input
  //       visibility + draft-value assertions fail;
  //   (c) the conflict banner never renders: the visible-UI assertion fails;
  //   (d) recovery-after-reload is broken: reload → edit → save no longer
  //       succeeds, or the final CR drops either actor's change.
  test('a stale edit form cannot silently overwrite concurrent changes', async ({ authedPage }) => {
    test.setTimeout(180_000)
    const agentName = `e2e-ap6-conflict-${Date.now()}`
    const staleDraftDisplayId = `${agentName}-stale-draft`
    const recoveredDisplayId = `${agentName}-recovered`
    try {
      // PRECONDITION (labeled setup): a stateless host — the lifecycle flag
      // is the collision victim. The stale form echo carries stateless=true;
      // if the stale save landed, it would silently resurrect the flag the
      // concurrent actor removed.
      await controlApi.createHost({
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: '',
          secretRef: '',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
          lifecycle: { stateless: true },
        },
      })
      await waitForHostCr(
        agentName,
        host => host.spec?.lifecycle?.stateless === true,
        'created with spec.lifecycle.stateless=true',
        30_000
      )

      // Real entry: open the detail page (this load anchors the edit form's
      // resourceVersion), then enter edit mode.
      await authedPage.goto(`/hosts/${encodeURIComponent(agentName)}`)
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByText('Stateless (suspends when idle)')).toBeVisible({
        timeout: 15_000,
      })
      await authedPage.getByRole('button', { name: 'Edit', exact: true }).first().click()
      const displayIdInput = authedPage.getByLabel('Display ID')
      await expect(displayIdInput).toBeVisible()

      // OUT-OF-BAND CHANGE (labeled precondition of the collision, NOT a
      // shortcut of the flow under test): a legitimate second actor updates
      // the host through the RV-absent legacy API path (last-write-wins),
      // removing the lifecycle flag while the operator's form stays open.
      const secondActorRead = await controlApi.getHost(agentName)
      const specWithoutLifecycle = { ...(secondActorRead.spec ?? {}) }
      delete specWithoutLifecycle.lifecycle
      await controlApi.updateHost(agentName, { spec: specWithoutLifecycle })
      const afterOutOfBand = await controlApi.getHost(agentName)
      expect(afterOutOfBand.spec?.lifecycle?.stateless).not.toBe(true)

      // Back in the UI: change an UNRELATED field on the stale form and save.
      await displayIdInput.fill(staleDraftDisplayId)
      await authedPage.getByRole('button', { name: 'Save', exact: true }).click()

      // ASSERT (a) visible UI — the conflict banner renders and the edit form
      // stays open with the operator's draft intact.
      await expect(authedPage.getByText(CONCURRENT_EDIT_WARNING)).toBeVisible({
        timeout: 15_000,
      })
      await expect(displayIdInput).toBeVisible()
      await expect(displayIdInput).toHaveValue(staleDraftDisplayId)
      // (b) no success toast — the save did not report success.
      await expect(authedPage.getByText('Agent configuration saved.')).not.toBeVisible()
      // (c) BUSINESS SIGNAL — the stale save did NOT land: the out-of-band
      // removal survived and the draft Display ID is absent from the CR.
      const afterBlockedSave = await controlApi.getHost(agentName)
      expect(afterBlockedSave.spec?.lifecycle?.stateless).not.toBe(true)
      expect(afterBlockedSave.spec?.host).toBe(agentName)

      // RECOVERY — the banner's own instruction, as a real user action:
      // reload, see the concurrent change, then edit and save again.
      await authedPage.reload()
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      // The out-of-band change is now visible in the form (flag removed).
      await expect(authedPage.getByText('Stateful (always on)')).toBeVisible({ timeout: 15_000 })
      await authedPage.getByRole('button', { name: 'Edit', exact: true }).first().click()
      await authedPage.getByLabel('Display ID').fill(recoveredDisplayId)
      await authedPage.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(authedPage.getByText('Agent configuration saved.')).toBeVisible({
        timeout: 15_000,
      })

      // BUSINESS SIGNAL — the CR carries BOTH the out-of-band change (flag
      // still removed) and the recovered edit (new Display ID).
      const afterRecovery = await controlApi.getHost(agentName)
      expect(afterRecovery.spec?.host).toBe(recoveredDisplayId)
      expect(afterRecovery.spec?.lifecycle?.stateless).not.toBe(true)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
    }
  })
})
