import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  kubectl,
  profilesSql,
  sqlLiteral,
} from '../third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { RECIPE_NS } from '../workflowUi'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SDK_RECIPE_FIXTURE = path.join(
  REPO_ROOT,
  'tests/e2e/fixtures/plugin-workload-sdk-recipe.yaml'
)
const CONTROL_API = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
const WORKLOAD_ID = 'sdk-caller'
const EVENT_TYPE = 'e2e.test.notification'
const MODEL_PROVIDER =
  process.env.E2E_WORKFLOW_MODEL_PROVIDER || process.env.CLURUM_MODEL_PROVIDER || 'zai'
const MODEL_NAME = process.env.E2E_WORKFLOW_MODEL_NAME || process.env.CLURUM_MODEL_NAME || 'glm-5.1'
const CREDENTIAL_SLOT = process.env.E2E_WORKFLOW_CREDENTIAL_SLOT || `${MODEL_PROVIDER}-api-key`

function requireAdminPassword(): string {
  const password =
    process.env.E2E_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASS ||
    process.env.TEST_ADMIN_PASSWORD ||
    'changeme123!'
  if (!password) {
    throw new Error('E2E_ADMIN_PASSWORD or ADMIN_PASSWORD is required for SDK workload grants')
  }
  return password
}

async function adminLogin(): Promise<string> {
  const username = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
  const response = await fetch(`${CONTROL_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: requireAdminPassword() }),
  })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const parsed = JSON.parse(body) as { token?: string; o?: { token?: string } }
  const token = parsed.token || parsed.o?.token
  expect(token, 'admin login must return a token').toBeTruthy()
  return token as string
}

export function makeScopedSdkRecipeName(marker: string): string {
  const normalized = marker.replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return `e2e-sdk-desktop-${normalized}`.slice(0, 63).replace(/[^a-z0-9-]+$/, '')
}

export function renderSdkWorkloadRecipeYaml(recipeName: string, userRef: string): string {
  const template = fs.readFileSync(SDK_RECIPE_FIXTURE, 'utf-8')
  return template
    .replaceAll('PLACEHOLDER_PROVIDER', MODEL_PROVIDER)
    .replaceAll('PLACEHOLDER_MODEL', MODEL_NAME)
    .replaceAll('PLACEHOLDER_RECIPE_NAME', recipeName)
    .replaceAll('PLACEHOLDER_USER_REF', userRef)
}

export function applySdkWorkloadRecipe(recipeName: string, userRef: string): void {
  const yaml = renderSdkWorkloadRecipeYaml(recipeName, userRef)
  kubectl(['apply', '-f', '-'], yaml, 60_000)
  waitForSdkRecipeValidated(recipeName)
}

export function waitForSdkRecipeValidated(recipeName: string, timeoutMs = 180_000): void {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = kubectl([
      'get',
      'workflowrecipe',
      recipeName,
      '-n',
      RECIPE_NS,
      '-o',
      'jsonpath={.status.pluginWorkloadSdk.state}',
    ]).trim()
    if (state === 'validated') return
    sleepMs(3_000)
  }
  throw new Error(`WorkflowRecipe ${recipeName} never reached pluginWorkloadSdk.state=validated`)
}

export async function createSdkWorkloadGrants(recipeName: string, userRef: string): Promise<void> {
  const token = await adminLogin()
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const promptBridgeRes = await fetch(`${CONTROL_API}/api/v1/admin/plugin-workload-sdk/grants`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      recipeNamespace: RECIPE_NS,
      recipeName,
      capabilityFamily: 'promptBridge',
      provider: MODEL_PROVIDER,
      allowedModels: [MODEL_NAME],
      promptTargets: [
        {
          targetRef: `primary-${MODEL_PROVIDER}`,
          provider: MODEL_PROVIDER,
          model: MODEL_NAME,
          credentialSlot: CREDENTIAL_SLOT,
        },
      ],
      defaultTargetRef: `primary-${MODEL_PROVIDER}`,
      allowedCallers: [WORKLOAD_ID],
      quotaLimits: { maxRequestsPerRun: 3 },
    }),
  })
  expect(promptBridgeRes.status, await promptBridgeRes.text()).toBe(200)

  const clientNotificationsRes = await fetch(
    `${CONTROL_API}/api/v1/admin/plugin-workload-sdk/grants`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        recipeNamespace: RECIPE_NS,
        recipeName,
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: [EVENT_TYPE],
        allowedUserRefs: [userRef],
        allowedCallers: [WORKLOAD_ID],
        quotaLimits: { maxNotificationsPerRun: 10 },
      }),
    }
  )
  expect(clientNotificationsRes.status, await clientNotificationsRes.text()).toBe(200)
}

function sleepMs(ms: number): void {
  execFileSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))])
}

function readyPodName(namespace: string, labelSelector: string, timeoutMs = 180_000): string {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const name = kubectl([
      '-n',
      namespace,
      'get',
      'pod',
      '-l',
      labelSelector,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]).trim()
    if (name) {
      const phase = kubectl([
        '-n',
        namespace,
        'get',
        'pod',
        name,
        '-o',
        'jsonpath={.status.phase}',
      ]).trim()
      const ready = kubectl([
        '-n',
        namespace,
        'get',
        'pod',
        name,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ]).trim()
      if (phase === 'Running' && ready === 'True') return name
    }
    sleepMs(3_000)
  }
  throw new Error(`pod not ready for selector ${labelSelector} in ${namespace}`)
}

export function waitForRecipeMcpHostReady(recipeName: string, timeoutMs = 180_000): string {
  return readyPodName(
    RECIPE_NS,
    `clerum.io/recipe=${recipeName},clerum.io/component=workflow-mcp-host`,
    timeoutMs
  )
}

export function restartSdkCallerWorkload(recipeName: string): string {
  waitForRecipeMcpHostReady(recipeName)
  const labelSelector = `clerum.io/recipe=${recipeName},clerum.io/workload=${WORKLOAD_ID}`
  const pod = readyPodName(RECIPE_NS, labelSelector)
  kubectl(['-n', RECIPE_NS, 'delete', 'pod', pod, '--wait=false'])
  return readyPodName(RECIPE_NS, labelSelector)
}

export async function waitForSdkCallerNotification(
  recipeName: string,
  timeoutMs = 240_000
): Promise<string> {
  const labelSelector = `clerum.io/recipe=${recipeName},clerum.io/workload=${WORKLOAD_ID}`
  const started = Date.now()
  let pod = ''

  while (Date.now() - started < timeoutMs) {
    pod = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'pod',
      '-l',
      labelSelector,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]).trim()
    if (pod) {
      const logs = kubectl(['-n', RECIPE_NS, 'logs', pod, '--tail=80'], undefined, 30_000)
      const match = logs.match(/E2E_SDK_CLIENT_NOTIFICATION_OK=([0-9a-f-]{36})/i)
      if (match?.[1]) return match[1]
      if (logs.includes('E2E_SDK_DONE')) break
    }
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }

  if (!pod) {
    throw new Error(`sdk-caller pod missing for recipe ${recipeName}`)
  }
  const logs = kubectl(['-n', RECIPE_NS, 'logs', pod, '--tail=120'], undefined, 30_000)
  const match = logs.match(/E2E_SDK_CLIENT_NOTIFICATION_OK=([0-9a-f-]{36})/i)
  if (!match?.[1]) {
    throw new Error(`sdk-caller never reported clientNotifications success:\n${logs.slice(-2_000)}`)
  }
  return match[1]
}

/**
 * Waits for the SDK caller to complete a promptBridge (LLM) round-trip and
 * returns the invocationId it logged. This is the business signal that the
 * workload exercised the LLM through the SDK and received a response, which
 * must happen before the notification journey is meaningful.
 */
export async function waitForSdkPromptBridgeInvocation(
  recipeName: string,
  timeoutMs = 240_000
): Promise<string> {
  const labelSelector = `clerum.io/recipe=${recipeName},clerum.io/workload=${WORKLOAD_ID}`
  const started = Date.now()
  let pod = ''

  while (Date.now() - started < timeoutMs) {
    pod = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'pod',
      '-l',
      labelSelector,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]).trim()
    if (pod) {
      const logs = kubectl(['-n', RECIPE_NS, 'logs', pod, '--tail=120'], undefined, 30_000)
      const match = logs.match(/E2E_SDK_PROMPT_BRIDGE_OK=([0-9a-zA-Z-]+)/)
      if (match?.[1]) return match[1]
      const failure = logs.match(/E2E_SDK_PROMPT_BRIDGE_FAIL=(\S+)/)
      if (failure?.[1]) {
        throw new Error(`sdk-caller promptBridge failed: ${failure[1]}`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }
  throw new Error(`sdk-caller never reported promptBridge success for recipe ${recipeName}`)
}

export function cleanupSdkWorkloadRecipe(recipeName: string): void {
  kubectl([
    'delete',
    'workflowrecipe',
    recipeName,
    '-n',
    RECIPE_NS,
    '--ignore-not-found',
    '--wait=false',
  ])
}

/**
 * Removes any non-terminal SDK notification deliveries for the user before the
 * test enqueues its own. SDK notification_deliveries rows are not tied to the
 * recipe lifecycle, so deliveries left 'queued'/'retrying' by a prior failed
 * run would be claimed by the channel-reader once fallback is enabled and sent
 * to the fresh fake Telegram inbox — polluting the per-notification assertions
 * with duplicate bodies. Scoped to the user and to non-terminal rows so it
 * never touches deliveries already settled as 'sent'/'failed'.
 */
export function purgeStaleSdkNotifications(userId: string): void {
  profilesSql(`
    DELETE FROM notification_deliveries
     WHERE event_type = 'plugin_workload_sdk.notification'
       AND audience->>'userId' = ${sqlLiteral(userId)}
       AND status IN ('queued', 'retrying');
  `)
}

/**
 * Resets the user's notification preferences to defaults so the channel
 * fallback precondition is deterministic. The SDK claim gates on
 * COALESCE(unp.channel_fallback_enabled, true) = true and matches
 * wama.medium = COALESCE(unp.preferred_medium, latest verified). A stale
 * preferences row (e.g. channel_fallback_enabled=false from a prior desktop
 * action) would correctly suppress the fallback under test, so we clear it:
 * fallback defaults back to enabled and preferred_medium falls back to the
 * single verified Telegram account. This sets up the documented prerequisite
 * (channel_fallback_enabled=true); it does not alter the behavior under test.
 */
export function resetUserNotificationPreferences(userId: string): void {
  profilesSql(`
    DELETE FROM user_notification_preferences
     WHERE user_id = ${sqlLiteral(userId)};
  `)
}

export function fetchNotificationDeliveryRow(notificationId: string): {
  eventType: string
  status: string
  userId: string
  deliveredMedium: string | null
} | null {
  const row = profilesSql(`
    SELECT event_type, status, COALESCE(audience->>'userId', ''), delivered_medium
      FROM notification_deliveries
     WHERE payload->>'notificationId' = ${sqlLiteral(notificationId)}
       AND event_type = 'plugin_workload_sdk.notification'
     LIMIT 1;
  `)
  if (!row) return null
  const [eventType, status, userId, deliveredMedium] = row.split('|')
  return {
    eventType: eventType || '',
    status: status || '',
    userId: userId || '',
    deliveredMedium: deliveredMedium && deliveredMedium !== '' ? deliveredMedium : null,
  }
}

export async function waitForDesktopNotificationAck(
  notificationId: string,
  userId: string,
  timeoutMs = 60_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const row = fetchNotificationDeliveryRow(notificationId)
    if (row?.status === 'sent' && row.deliveredMedium === 'desktop' && row.userId === userId) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  const row = fetchNotificationDeliveryRow(notificationId)
  throw new Error(
    `notification ${notificationId} was not desktop-acked (last row=${JSON.stringify(row)})`
  )
}

/**
 * Reads the wall-clock grace window the desktop-first emitter applied to a
 * queued SDK notification. Returns the number of seconds remaining before the
 * channel-reader is eligible to claim the delivery for messaging fallback
 * (negative when the window has already elapsed).
 */
export function notificationGraceSecondsRemaining(notificationId: string): number {
  const raw = profilesSql(`
    SELECT COALESCE(EXTRACT(EPOCH FROM (next_attempt_at - NOW())), 0)::int
      FROM notification_deliveries
     WHERE payload->>'notificationId' = ${sqlLiteral(notificationId)}
       AND event_type = 'plugin_workload_sdk.notification'
     LIMIT 1;
  `)
  return Number.parseInt(raw, 10) || 0
}

/**
 * Fast-forwards the desktop-first grace window for a queued SDK notification so
 * the channel-reader becomes eligible to fall back to a messaging channel. This
 * only advances simulated time (the `next_attempt_at` gate); it does NOT mark
 * the delivery as sent, choose a medium, or otherwise perform the behavior under
 * test. The real channel-reader still has to claim the row and deliver it.
 */
export function expireNotificationGraceWindow(notificationId: string): void {
  profilesSql(`
    UPDATE notification_deliveries
       SET next_attempt_at = NOW() - INTERVAL '1 minute'
     WHERE payload->>'notificationId' = ${sqlLiteral(notificationId)}
       AND event_type = 'plugin_workload_sdk.notification'
       AND status IN ('queued', 'retrying');
  `)
}

/**
 * Waits until the channel-reader marks the SDK notification terminal after the
 * messaging fallback. The DB row only proves it became terminal (status='sent')
 * for the right user and was NOT a desktop ACK (delivered_medium stays out of
 * 'desktop' because the desktop app was never opened in this scenario). The
 * authoritative proof that the message actually left through Telegram is the
 * fake provider's sentMessages, asserted by the caller; this helper just gates
 * on the terminal transition so that assertion runs against a settled row.
 */
export async function waitForChannelReaderTerminalDelivery(
  notificationId: string,
  userId: string,
  timeoutMs = 120_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const row = fetchNotificationDeliveryRow(notificationId)
    if (row?.status === 'sent' && row.userId === userId && row.deliveredMedium !== 'desktop') {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  const row = fetchNotificationDeliveryRow(notificationId)
  throw new Error(
    `notification ${notificationId} never reached a non-desktop terminal delivery (last row=${JSON.stringify(row)})`
  )
}
