import { expect } from '@playwright/test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { kubectlOut } from '../workflow-approval-quadrants/cluster'
import { K8S_CONTEXT } from '../workflowUi'
import { configMapNeedsPatch, secretNeedsPatch } from './figureDK8sData'
import { ensureLocalServicePortForward, freePort, stopChild } from './figureDPortForward'
import { figureDProviderResourcesYaml } from './figureDProviderResources'

const NS = 'channels'
const CONTROL_PLANE_NS = 'control-plane'
const APP = 'figure-d-fake-provider'
const CONTROL_API_CONFIG = 'control-api-config'
const CONTROL_API_DEPLOYMENT = 'control-api'
const CONTROL_API_SERVICE = 'control-api'
const READER_DEPLOYMENT = 'clerum-workflow-approval-request-reader'
const READER_SECRET = 'workflow-approval-request-reader-credentials'
const CHANNEL_NAME = 'figure-d-provider-channel'
const CHANNEL_CREDENTIALS_SECRET = 'figure-d-provider-channel-credentials'
let readerPortForward: ChildProcessWithoutNullStreams | null = null

export const FIGURE_D_TELEGRAM_SECRET = 'figure-d-telegram-webhook-secret'
export const FIGURE_D_SLACK_SIGNING_SECRET = 'figure-d-slack-signing-secret'
export const FIGURE_D_SLACK_WORKSPACE = 'TFIGURED'
export const FIGURE_D_COMMUNICATION_CHANNEL_REF = `${NS}/${CHANNEL_NAME}`

export function expectedFigureDReaderEventId(
  medium: 'telegram' | 'slack',
  providerChannelId: string,
  providerEventId: string
): string {
  if (medium === 'slack') {
    return `slack:${FIGURE_D_SLACK_WORKSPACE}:${providerChannelId}:${providerEventId}`
  }
  return `telegram:${providerChannelId}:${providerEventId}`
}

function applyFakeProviderResources(): void {
  const yaml = figureDProviderResourcesYaml(APP, NS)
  kubectlOut(['apply', '-f', '-'], yaml, 30_000)
  kubectlOut(
    ['-n', NS, 'rollout', 'status', `deployment/${APP}`, '--timeout=120s'],
    undefined,
    130_000
  )
}

function applyFigureDCommunicationChannel(): void {
  const yaml = `
apiVersion: v1
kind: Secret
metadata:
  name: ${CHANNEL_CREDENTIALS_SECRET}
  namespace: ${NS}
  labels:
    clerum.io/e2e: "true"
type: Opaque
stringData:
  telegram-bot-token: figure-d-telegram-token
  slack-bot-token: figure-d-slack-token
---
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: ${CHANNEL_NAME}
  namespace: ${NS}
  labels:
    clerum.io/e2e: "true"
spec:
  hostRef: figure-d
  credentialsSecretRef:
    name: ${CHANNEL_CREDENTIALS_SECRET}
  telegram:
    - channelId: figure-d-telegram
      chatType: private
      userIds:
        - figure-d-telegram-user
  slack:
    - channelId: figure-d-slack
      workspaceId: ${FIGURE_D_SLACK_WORKSPACE}
      userIds:
        - figure-d-slack-user
`
  kubectlOut(['apply', '-f', '-'], yaml, 30_000)
}

function patchReaderWebhookSecrets(): boolean {
  const desiredSecret = {
    'telegram-webhook-secret': FIGURE_D_TELEGRAM_SECRET,
    'slack-signing-secret': FIGURE_D_SLACK_SIGNING_SECRET,
  }
  const secretChanged = secretNeedsPatch(NS, READER_SECRET, desiredSecret)
  if (!secretChanged) return false

  kubectlOut(
    [
      '-n',
      NS,
      'patch',
      'secret',
      READER_SECRET,
      '--type=merge',
      '-p',
      JSON.stringify({ stringData: desiredSecret }),
    ],
    undefined,
    10_000
  )
  kubectlOut(['-n', NS, 'rollout', 'restart', 'deployment', READER_DEPLOYMENT], undefined, 10_000)
  kubectlOut(
    ['-n', NS, 'rollout', 'status', 'deployment', READER_DEPLOYMENT, '--timeout=120s'],
    undefined,
    130_000
  )
  waitForSingleReadyReaderPod()
  return true
}

function patchControlApiForFigureDProvider(): boolean {
  const apiRoot = `http://${APP}.${NS}.svc.cluster.local:8099`
  const desiredConfig = {
    WORKFLOW_APPROVAL_TELEGRAM_API_ROOT: apiRoot,
    WORKFLOW_APPROVAL_SLACK_API_ROOT: apiRoot,
    WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_INTERVAL_MS: '1000',
  }
  const configChanged = configMapNeedsPatch(CONTROL_PLANE_NS, CONTROL_API_CONFIG, desiredConfig)
  if (configChanged) {
    kubectlOut(
      [
        '-n',
        CONTROL_PLANE_NS,
        'patch',
        'configmap',
        CONTROL_API_CONFIG,
        '--type=merge',
        '-p',
        JSON.stringify({ data: desiredConfig }),
      ],
      undefined,
      10_000
    )
  }
  if (!configChanged) return false

  kubectlOut(
    ['-n', CONTROL_PLANE_NS, 'rollout', 'restart', 'deployment', CONTROL_API_DEPLOYMENT],
    undefined,
    10_000
  )
  kubectlOut(
    [
      '-n',
      CONTROL_PLANE_NS,
      'rollout',
      'status',
      'deployment',
      CONTROL_API_DEPLOYMENT,
      '--timeout=120s',
    ],
    undefined,
    130_000
  )
  return true
}

function waitForSingleReadyReaderPod(): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rows = kubectlOut(
      [
        '-n',
        NS,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=workflow-approval-request-reader',
        '-o',
        'jsonpath={range .items[*]}{.metadata.name} {.status.phase} {.metadata.deletionTimestamp}{"\\n"}{end}',
      ],
      undefined,
      10_000
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => line.trim().split(/\s+/))
    const activePods = rows.filter(
      ([, phase, deletionTimestamp]) => phase === 'Running' && !deletionTimestamp
    )
    if (rows.length === 1 && activePods.length === 1) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  throw new Error('workflow approval reader rollout left multiple active pods')
}

async function waitForProvider(url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${url}/health`)
          return response.status
        } catch {
          return 0
        }
      },
      { timeout: 30_000, intervals: [250, 500, 1000] }
    )
    .toBe(200)
}

async function ensureReaderPortForward(
  forceRefresh = false
): Promise<ChildProcessWithoutNullStreams | null> {
  return ensureLocalServicePortForward({
    baseUrlEnvName: 'WORKFLOW_APPROVAL_READER_BASE_URL',
    context: K8S_CONTEXT,
    namespace: NS,
    service: 'workflow-approval-request-reader',
    defaultLocalPort: '8098',
    remotePort: '8098',
    forceRefresh,
  })
}

export async function ensureFigureDReaderPortForward(forceRefresh = false): Promise<void> {
  const nextForward = await ensureReaderPortForward(forceRefresh)
  if (!nextForward) return
  await stopChild(readerPortForward)
  readerPortForward = nextForward
}

async function ensureControlApiPortForward(
  forceRefresh = false
): Promise<ChildProcessWithoutNullStreams | null> {
  return ensureLocalServicePortForward({
    baseUrlEnvName: 'CONTROL_API_BASE_URL',
    context: K8S_CONTEXT,
    namespace: CONTROL_PLANE_NS,
    service: CONTROL_API_SERVICE,
    defaultLocalPort: '8090',
    remotePort: '8090',
    forceRefresh,
  })
}

export async function installFigureDProviderHarness(): Promise<{
  providerUrl: string
  stop: () => Promise<void>
}> {
  applyFakeProviderResources()
  applyFigureDCommunicationChannel()
  const controlApiRestarted = patchControlApiForFigureDProvider()
  const readerRestarted = patchReaderWebhookSecrets()
  const controlApiForward = await ensureControlApiPortForward(controlApiRestarted)
  await ensureFigureDReaderPortForward(readerRestarted)

  const port = await freePort()
  const child = spawn(
    'kubectl',
    ['--context', K8S_CONTEXT, '-n', NS, 'port-forward', `svc/${APP}`, `${port}:8099`],
    { stdio: 'pipe' }
  )
  const providerUrl = `http://127.0.0.1:${port}`
  await waitForProvider(providerUrl)

  return {
    providerUrl,
    stop: async () => {
      await stopChild(child)
      await stopChild(readerPortForward)
      readerPortForward = null
      await stopChild(controlApiForward)
    },
  }
}
