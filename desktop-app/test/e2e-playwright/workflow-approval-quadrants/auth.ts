import { createHmac, randomBytes } from 'node:crypto'
import { signInternalControlJwt } from '../internalControlJwt'
import { K8S_CONTEXT } from '../workflowUi'
import { kubectlOut } from './cluster'
import type { Medium } from './constants'

const READER_SECRET_NAME = 'workflow-approval-request-reader-credentials'
const READER_DEPLOYMENT_NAME = 'clerum-workflow-approval-request-reader'

export function internalControlJwt(iss: 'wrc' | 'hcc'): string {
  return signInternalControlJwt(iss, K8S_CONTEXT)
}

function readerSecretValue(secretKey: string): string | undefined {
  const raw = kubectlOut(
    [
      '-n',
      'channels',
      'get',
      'secret',
      READER_SECRET_NAME,
      '-o',
      `jsonpath={.data['${secretKey}']}`,
    ],
    undefined,
    10_000
  ).trim()
  return raw ? Buffer.from(raw, 'base64').toString('utf-8') : undefined
}

function patchReaderTelegramSecret(secret: string): void {
  kubectlOut(
    [
      '-n',
      'channels',
      'patch',
      'secret',
      READER_SECRET_NAME,
      '--type=merge',
      '-p',
      JSON.stringify({ stringData: { 'telegram-webhook-secret': secret } }),
    ],
    undefined,
    10_000
  )
}

function removeReaderTelegramSecret(): void {
  try {
    kubectlOut(
      [
        '-n',
        'channels',
        'patch',
        'secret',
        READER_SECRET_NAME,
        '--type=json',
        '-p',
        JSON.stringify([{ op: 'remove', path: '/data/telegram-webhook-secret' }]),
      ],
      undefined,
      10_000
    )
  } catch {
    // Missing keys are acceptable when restoring a clean test fixture.
  }
}

function restartReaderDeployment(): void {
  kubectlOut(
    ['-n', 'channels', 'rollout', 'restart', 'deployment', READER_DEPLOYMENT_NAME],
    undefined,
    10_000
  )
  kubectlOut(
    ['-n', 'channels', 'rollout', 'status', 'deployment', READER_DEPLOYMENT_NAME, '--timeout=120s'],
    undefined,
    130_000
  )
}

async function waitForReaderHealth(): Promise<void> {
  const baseUrl = process.env.WORKFLOW_APPROVAL_READER_BASE_URL || 'http://127.0.0.1:8098'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
      })
      if (response.status === 200) return
    } catch {
      // Retry while the deployment rolls and the service port-forward reconnects.
    } finally {
      clearTimeout(timeout)
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `workflow approval reader did not become healthy at ${baseUrl}; refresh the dev port-forward`
  )
}

export async function installReaderTelegramWebhookSecretForE2E(): Promise<() => Promise<void>> {
  const previousSecret = readerSecretValue('telegram-webhook-secret')
  const previousEnv = process.env.WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
  const testSecret =
    previousEnv || previousSecret || `e2e-telegram-${randomBytes(24).toString('base64url')}`

  process.env.WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET = testSecret

  if (previousSecret !== testSecret) {
    patchReaderTelegramSecret(testSecret)
    restartReaderDeployment()
    await waitForReaderHealth()
  }

  return async () => {
    if (previousEnv === undefined) {
      delete process.env.WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
    } else {
      process.env.WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET = previousEnv
    }

    if (previousSecret === testSecret) return
    if (previousSecret === undefined) {
      removeReaderTelegramSecret()
    } else {
      patchReaderTelegramSecret(previousSecret)
    }
    restartReaderDeployment()
  }
}

export function resolveReaderSecret(secretKey: string, envName: string): string {
  const explicit = process.env[envName]
  if (explicit) return explicit

  return Buffer.from(
    kubectlOut(
      [
        '-n',
        'channels',
        'get',
        'secret',
        READER_SECRET_NAME,
        '-o',
        `jsonpath={.data['${secretKey}']}`,
      ],
      undefined,
      10_000
    ),
    'base64'
  ).toString('utf-8')
}

export function readerWebhookRequest(
  approvalRequestId: string,
  medium: Medium,
  providerUserId: string,
  providerEventId: string,
  decision: 'approve' | 'deny',
  providerWorkspaceId?: string
): { bodyText: string; headers: Record<string, string> } {
  const command = `${decision}:${approvalRequestId}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let payload: unknown

  if (medium === 'telegram') {
    payload = {
      callback_query: {
        id: providerEventId,
        data: command,
        from: { id: providerUserId },
        message: { chat: { id: providerUserId } },
      },
    }
    headers['x-telegram-bot-api-secret-token'] = resolveReaderSecret(
      'telegram-webhook-secret',
      'WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET'
    )
  } else if (medium === 'slack') {
    payload = {
      trigger_id: providerEventId,
      user: { id: providerUserId },
      team: { id: providerWorkspaceId ?? 'T-e2e' },
      channel: { id: 'C-e2e' },
      actions: [{ value: command, action_ts: providerEventId }],
    }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const bodyText = JSON.stringify(payload)
    const secret = resolveReaderSecret(
      'slack-signing-secret',
      'WORKFLOW_APPROVAL_READER_SLACK_SIGNING_SECRET'
    )
    headers['x-slack-request-timestamp'] = timestamp
    headers['x-slack-signature'] = `v0=${createHmac('sha256', secret)
      .update(`v0:${timestamp}:${bodyText}`)
      .digest('hex')}`
    return { bodyText, headers }
  } else {
    payload = {
      id: providerEventId,
      custom_id: command,
      user: { id: providerUserId },
      guild_id: providerWorkspaceId ?? null,
      channel_id: 'discord-channel-e2e',
    }
  }

  return { bodyText: JSON.stringify(payload), headers }
}
