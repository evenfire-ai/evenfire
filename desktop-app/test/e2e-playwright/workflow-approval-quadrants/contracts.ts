import { expect } from '@playwright/test'
import { expectDeploymentReady, kubectlJson, kubectlOut } from './cluster'
import { CHANNELS_NS, SHARED_MCP_HOST_NAME, SHARED_MCP_HOST_NS } from './constants'

const E2E_SHARED_TELEGRAM_CHANNEL_NAME = 'e2e-quadrant-shared-telegram'

type CommunicationChannelList = {
  items?: Array<{
    metadata?: { namespace?: string }
    spec?: {
      hostRef?: string
      telegram?: Array<{ channelId?: string; userIds?: string[] }>
    }
  }>
}

function telegramProviderUserId(item: NonNullable<CommunicationChannelList['items']>[number]) {
  return item.spec?.telegram?.[0]?.userIds?.[0]
}

function sharedCommunicationChannel() {
  const parsed = kubectlJson<CommunicationChannelList>(
    ['get', 'communicationchannels.clerum.io', '-A', '-o', 'json'],
    10_000
  )
  const channels = parsed.items ?? []
  const preferredHost = process.env.E2E_SHARED_MCP_HOST_NAME || SHARED_MCP_HOST_NAME
  return (
    channels.find(item => item.spec?.hostRef === preferredHost && telegramProviderUserId(item)) ??
    channels.find(item => item.spec?.hostRef === preferredHost) ??
    channels.find(item => {
      const hostRef = item.spec?.hostRef ?? ''
      const providerUserId = telegramProviderUserId(item)
      return hostRef.length > 0 && /^\d+$/.test(providerUserId ?? '')
    })
  )
}

export function applySharedTelegramCommunicationChannel(
  providerUserId: string,
  hostName = SHARED_MCP_HOST_NAME
): void {
  expect(providerUserId, 'E2E Telegram provider id must be numeric').toMatch(/^\d+$/)
  const yaml = `
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: ${E2E_SHARED_TELEGRAM_CHANNEL_NAME}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/workflow-approval-quadrants: "true"
spec:
  hostRef: ${hostName}
  telegram:
    - channelId: e2e-quadrants
      userIds:
        - "${providerUserId}"
`
  kubectlOut(['apply', '-f', '-'], yaml, 30_000)
}

export function cleanupSharedTelegramCommunicationChannel(): void {
  kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'communicationchannel',
      E2E_SHARED_TELEGRAM_CHANNEL_NAME,
      '--ignore-not-found=true',
    ],
    undefined,
    30_000
  )
}

export function sharedMcpHostNameFromCommunicationChannel(): string {
  const channel = sharedCommunicationChannel()
  expect(channel, 'shared host CommunicationChannel must exist for Q3').toBeTruthy()

  const hostRef = channel?.spec?.hostRef
  expect(hostRef, 'Q3 CommunicationChannel must include a hostRef').toBeTruthy()
  expect(hostRef, 'Q3 hostRef should be a single mcp-host service name').not.toContain('/')
  return hostRef as string
}

export function sharedTelegramApproverFromCommunicationChannel(): string {
  const channel = sharedCommunicationChannel()
  expect(channel, 'shared host CommunicationChannel must exist for Q3').toBeTruthy()
  expect(channel?.metadata?.namespace).toBe(CHANNELS_NS)

  const providerUserId = telegramProviderUserId(channel)
  expect(providerUserId, 'Q3 CommunicationChannel must include a Telegram user id').toMatch(/^\d+$/)
  return providerUserId as string
}

export function expectChannelReaderReadyForSharedHost(
  providerUserId: string,
  hostName = sharedMcpHostNameFromCommunicationChannel()
): void {
  // Per-Host channel-reader Deployments are `channel-reader-<host>` (one
  // per Host CRD). The legacy static `clerum-channel-reader` Deployment
  // was retired in #273.
  expectDeploymentReady(CHANNELS_NS, `channel-reader-${hostName}`)
  expect(sharedMcpHostNameFromCommunicationChannel()).toBe(hostName)
  expect(sharedTelegramApproverFromCommunicationChannel()).toBe(providerUserId)

  const expectedPolicy = `channel-reader-${hostName}-egress`
  const policyName = kubectlOut(
    ['-n', CHANNELS_NS, 'get', 'networkpolicy', expectedPolicy, '-o', 'jsonpath={.metadata.name}'],
    undefined,
    10_000
  ).trim()
  expect(policyName).toBe(expectedPolicy)
}

export function expectChannelReaderHasNoProviderHttpIngress(
  hostName = sharedMcpHostNameFromCommunicationChannel()
): void {
  const services = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'svc',
      '-l',
      'app=channel-reader',
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ],
    undefined,
    10_000
  ).trim()
  expect(services, 'channel-reader exposes no HTTP/provider ingress service').toBe('')

  // Per-Host Deployment shape (#273 retired the static `clerum-channel-reader`).
  const containerPorts = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'deploy',
      `channel-reader-${hostName}`,
      '-o',
      'jsonpath={.spec.template.spec.containers[0].ports[*].containerPort}',
    ],
    undefined,
    10_000
  ).trim()
  expect(containerPorts, 'channel-reader deployment has no HTTP provider port').toBe('')
}

export function expectChannelReaderCanReachSharedMcpHostRuntime(
  hostName = sharedMcpHostNameFromCommunicationChannel()
): void {
  const pod = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'pod',
      '-l',
      `app=channel-reader,clerum.io/host=${hostName}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    undefined,
    10_000
  ).trim()
  expect(pod, 'channel-reader pod must exist').toBeTruthy()

  const script = `
const url = 'http://${hostName}.${SHARED_MCP_HOST_NS}.svc.cluster.local:8080/v1/runtime/health';
fetch(url).then(async response => {
  const body = await response.json().catch(() => ({}));
  process.stdout.write(JSON.stringify({ status: response.status, body }));
}).catch(error => {
  process.stderr.write(String(error && error.message || error));
  process.exit(1);
});
`
  const raw = kubectlOut(
    ['-n', CHANNELS_NS, 'exec', pod, '--', 'node', '-e', script],
    undefined,
    10_000
  )
  expect(JSON.parse(raw)).toEqual({ status: 200, body: { status: 'ok' } })
}

export function expectWorkflowApprovalReaderAvoidsControlPlaneGateway(): void {
  const configJson = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'configmap',
      'clerum-workflow-approval-request-reader-config',
      '-o',
      'json',
    ],
    undefined,
    10_000
  )
  const config = JSON.parse(configJson) as {
    data?: Record<string, string | undefined>
  }
  expect(config.data?.CONTROL_API_BASE_URL).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_MCP_HOST_BASE_URL).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_MCP_HOST_REF).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_TELEGRAM_API_ROOT).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_SLACK_API_ROOT).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_INTERVAL_MS).toBeUndefined()
  expect(config.data?.WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_LIMIT).toBeUndefined()
  expect(Object.values(config.data ?? {}).join('\n')).not.toContain('chatllm')

  const envNames = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'deploy',
      'clerum-workflow-approval-request-reader',
      '-o',
      'jsonpath={.spec.template.spec.containers[0].env[*].name}',
    ],
    undefined,
    10_000
  )
  expect(envNames).not.toContain('CONTROL_API_BASE_URL')
  expect(envNames).not.toContain('WORKFLOW_APPROVAL_READER_SERVICE_TOKEN')
  expect(envNames).not.toContain('CONTROL_API_INTERNAL_SERVICE_TOKENS')
  expect(envNames).not.toContain('WORKFLOW_APPROVAL_READER_TELEGRAM_BOT_TOKEN')
  expect(envNames).not.toContain('WORKFLOW_APPROVAL_READER_SLACK_BOT_TOKEN')
}

export function expectWorkflowApprovalReaderNetworkPolicyTargetsMcpHostOnly(): void {
  const gatewayPolicy = kubectlOut(
    [
      '-n',
      'control-plane',
      'get',
      'networkpolicy',
      'nginx-workflow-approval-gateway',
      '-o',
      'yaml',
    ],
    undefined,
    10_000
  )
  expect(gatewayPolicy).not.toContain('app.kubernetes.io/name: workflow-approval-request-reader')

  const readerEgress = kubectlOut(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'networkpolicy',
      'workflow-approval-request-reader-to-mcp-host',
      '-o',
      'yaml',
    ],
    undefined,
    10_000
  )
  expect(readerEgress).toContain('kubernetes.io/metadata.name: sandbox-recipes')
  expect(readerEgress).toContain('clerum.io/component: workflow-mcp-host')
  expect(readerEgress).toContain('clerum.io/managed-by: wrc')
  expect(readerEgress).not.toContain('kubernetes.io/metadata.name: mcp-host')
  expect(readerEgress).not.toContain('clerum.io/managed-by: host-context-controller')
  expect(readerEgress).toContain('port: 8080')

  const firstPartyMcpHostIngress = kubectlOut(
    ['-n', 'mcp-host', 'get', 'networkpolicy', 'mcp-host', '-o', 'yaml'],
    undefined,
    10_000
  )
  expect(firstPartyMcpHostIngress).not.toContain(
    'app.kubernetes.io/name: workflow-approval-request-reader'
  )

  const workflowMcpHostIngress = kubectlOut(
    [
      '-n',
      'sandbox-recipes',
      'get',
      'networkpolicy',
      'allow-workflow-approval-reader-to-workflow-mcp-host',
      '-o',
      'yaml',
    ],
    undefined,
    10_000
  )
  expect(workflowMcpHostIngress).toContain('kubernetes.io/metadata.name: channels')
  expect(workflowMcpHostIngress).toContain(
    'app.kubernetes.io/name: workflow-approval-request-reader'
  )
  expect(workflowMcpHostIngress).toContain('port: 8080')
}
