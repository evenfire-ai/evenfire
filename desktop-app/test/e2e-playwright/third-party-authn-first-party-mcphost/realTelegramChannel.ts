import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { K8S_CONTEXT } from '../workflowUi'

export const REAL_TELEGRAM_CHANNEL_NAME =
  process.env.E2E_REAL_TELEGRAM_CHANNEL_NAME ||
  'e2e-third-party-authn-first-party-mcphost-real-telegram'
export const REAL_TELEGRAM_CREDENTIALS_SECRET = `cc-${REAL_TELEGRAM_CHANNEL_NAME}-credentials`

const CHANNELS_NS = 'channels'

export type RealTelegramConfig = {
  botName: string
  botToken: string
  providerUserId: string
  providerChannelId: string
  visualUsername: string
}

function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

export function realTelegramConfigOrNull(): RealTelegramConfig | null {
  const botToken =
    process.env.E2E_REAL_TELEGRAM_BOT_TOKEN || process.env.CLERUM_TELEGRAM_BOT_TOKEN || ''
  const providerUserId = process.env.E2E_REAL_TELEGRAM_USER_ID || ''
  const providerChannelId = process.env.E2E_REAL_TELEGRAM_CHAT_ID || ''
  if (!botToken || !providerUserId || !providerChannelId) return null
  return {
    botName: process.env.E2E_REAL_TELEGRAM_BOT_NAME || 'ExampleBot',
    botToken,
    providerUserId,
    providerChannelId,
    visualUsername: process.env.E2E_REAL_TELEGRAM_USERNAME || 'example_user',
  }
}

export function assertRealTelegramConfig(): RealTelegramConfig {
  const cfg = realTelegramConfigOrNull()
  expect(
    cfg,
    [
      'Real Telegram human-recorded gate requires:',
      'E2E_REAL_TELEGRAM=1',
      'HUMAN_E2E_RECORDED=1',
      'E2E_REAL_TELEGRAM_USER_ID=<stable Telegram from.id>',
      'E2E_REAL_TELEGRAM_CHAT_ID=<stable Telegram chat.id>',
      'and E2E_REAL_TELEGRAM_BOT_TOKEN or CLERUM_TELEGRAM_BOT_TOKEN.',
    ].join(' ')
  ).toBeTruthy()
  return cfg as RealTelegramConfig
}

export function applyRealTelegramCommunicationChannel(
  cfg: RealTelegramConfig,
  hostName = 'chatllm'
): void {
  const yaml = `
apiVersion: v1
kind: Secret
metadata:
  name: ${REAL_TELEGRAM_CREDENTIALS_SECRET}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/component: channel-reader
    clerum.io/third-party-authn-first-party-mcphost: "true"
type: Opaque
stringData:
  telegram-bot-token: "${cfg.botToken.replace(/"/g, '\\"')}"
---
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: ${REAL_TELEGRAM_CHANNEL_NAME}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/third-party-authn-first-party-mcphost: "true"
    clerum.io/human-recorded: "true"
spec:
  hostRef: ${hostName}
  credentialsSecretRef:
    name: ${REAL_TELEGRAM_CREDENTIALS_SECRET}
  telegram:
    - channelId: "${cfg.providerChannelId}"
      userIds:
        - "${cfg.providerUserId}"
`
  kubectl(['apply', '-f', '-'], yaml, 30_000)
}

export function removeRealTelegramCommunicationChannel(): void {
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'communicationchannel',
      REAL_TELEGRAM_CHANNEL_NAME,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    20_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'secret',
      REAL_TELEGRAM_CREDENTIALS_SECRET,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    20_000
  )
}

function sleepOneSecond(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}

export function expectRealTelegramPollingReady(hostName = 'chatllm'): void {
  let lastLogs = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    lastLogs = kubectl(
      ['-n', CHANNELS_NS, 'logs', `deployment/channel-reader-${hostName}`, '--tail=220'],
      undefined,
      15_000
    )
    const readyAt = Math.max(
      lastLogs.lastIndexOf('[Main] Initialized 1 channel adapter(s)'),
      lastLogs.lastIndexOf('[Main] Restart complete')
    )
    const conflictAt = Math.max(
      lastLogs.lastIndexOf("Call to 'getUpdates' failed! (409: Conflict"),
      lastLogs.lastIndexOf('409: Conflict')
    )
    if (
      lastLogs.includes('[Main] needsTelegram: true') &&
      lastLogs.includes('[Telegram] Connected as @') &&
      readyAt > conflictAt
    ) {
      return
    }
    sleepOneSecond()
  }
  expect(
    lastLogs,
    'real Telegram polling must be stable without getUpdates 409 conflict'
  ).not.toContain('409: Conflict')
}
