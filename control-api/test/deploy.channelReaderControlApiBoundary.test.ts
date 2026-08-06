import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'

const BASE = '../../deploy/base'
const forbiddenChannelReaderControlApiTokenNames = [
  'CHANNEL_READER_CONTROL_API_SERVICE' + '_TOKEN',
  'TOKEN_CHANNEL' + '_READER',
  'CLERUM_CONTROL_API_SERVICE' + '_TOKEN',
]
// Bot-token and notification-poll env vars the reader must NEVER receive
// (the consulta token is allowed; bot tokens and poll credentials are not).
const forbiddenWorkflowApprovalReaderBotNames = [
  'WORKFLOW_APPROVAL_READER_TELEGRAM_BOT_TOKEN',
  'WORKFLOW_APPROVAL_READER_SLACK_BOT_TOKEN',
  'WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_INTERVAL_MS',
  'WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_LIMIT',
  'WORKFLOW_APPROVAL_READER_TELEGRAM_API_ROOT',
  'WORKFLOW_APPROVAL_READER_SLACK_API_ROOT',
]

function read(relativeFromRepoRoot: string): string {
  return readFileSync(new URL(relativeFromRepoRoot, import.meta.url), 'utf-8')
}

function readYamlBundle(relativeFromRepoRoot: string): string {
  const url = new URL(relativeFromRepoRoot, import.meta.url)
  if (!statSync(url).isDirectory()) return read(relativeFromRepoRoot)

  const prefix = relativeFromRepoRoot.endsWith('/')
    ? relativeFromRepoRoot
    : `${relativeFromRepoRoot}/`
  return readdirSync(url)
    .filter(name => /\.ya?ml$/.test(name))
    .sort()
    .map(name => read(`${prefix}${name}`))
    .join('\n---\n')
}

function assignmentLine(script: string, variableName: string): string {
  const line = script.split('\n').find(value => value.startsWith(`${variableName}=`))
  if (!line) throw new Error(`Missing assignment for ${variableName}`)
  return line
}

describe('channel-reader -> control-api boundary manifests', () => {
  it('does not seed or register a channel-reader control-api service token', () => {
    const script = read('../../deploy/scripts/apply-inter-service-tokens.sh')
    const serviceTokensMap = assignmentLine(script, 'SERVICE_TOKENS_MAP')
    const internalTokensList = assignmentLine(script, 'INTERNAL_TOKENS_LIST')
    for (const name of forbiddenChannelReaderControlApiTokenNames) {
      expect(script).not.toContain(name)
    }
    expect(serviceTokensMap).not.toContain('channel-reader=')
    expect(internalTokensList).not.toContain('CHANNEL_READER')
    expect(script).toContain('delete secret channel-reader-internal-tokens')
  })

  it('does not project control-api credentials into channel-reader manifests', () => {
    const channelsBase = readYamlBundle(`${BASE}/channels`)

    expect(channelsBase).not.toContain('CLERUM_CONTROL_API_URL')
    expect(channelsBase).not.toContain('CLERUM_CONTROL_API_SERVICE_NAME')
    for (const name of forbiddenChannelReaderControlApiTokenNames) {
      expect(channelsBase).not.toContain(name)
    }
    expect(channelsBase).not.toContain('channel-reader-internal-tokens')
  })

  it('seeds a scoped workflow-approval-request-reader control-api CONSULTA token (read-only, no transmission)', () => {
    // Opción B-completa (owner decision #9): the reader gets a static bearer
    // token for a READ-ONLY consulta endpoint
    // (GET /internal/workflow-approval-reader/approvals/:id/can-approve).
    // This is the same internalServiceAuth pattern as rpc-proxy / webhook-proxy.
    // The reader does NOT transmit decisions to control-api (that goes via
    // mcp-host). The old controlApiClient.ts transmission path was removed in
    // PR #535 and is NOT restored.
    const script = read('../../deploy/scripts/apply-inter-service-tokens.sh')
    const readerDeployment = read(
      '../../deploy/base/channels/workflow-approval-request-reader/deployment.yaml'
    )
    const controlPlaneBase = readYamlBundle(`${BASE}/control-plane`)
    const configSource = read('../../control-api/src/config.ts')
    const serviceTokensMap = assignmentLine(script, 'SERVICE_TOKENS_MAP')
    const internalTokensList = assignmentLine(script, 'INTERNAL_TOKENS_LIST')

    // The script seeds the reader token in the service-token map.
    expect(serviceTokensMap).toContain('workflow-approval-reader=')
    expect(internalTokensList).not.toContain('WORKFLOW_READER')
    expect(script).toContain('TOKEN_WA_READER')
    // control-api config default includes the reader for dev/test without the
    // inter-service-tokens script.
    expect(configSource).toContain('workflow-approval-reader=dev-wa-reader-token')
    // The reader deployment mounts the consulta token from its Secret (optional).
    expect(readerDeployment).toContain('WORKFLOW_APPROVAL_READER_CONTROL_API_TOKEN')
    expect(readerDeployment).toContain('WORKFLOW_APPROVAL_READER_CONTROL_API_BASE_URL')
    // The control-api ingress NP allows the reader (channels → control-plane:8090).
    expect(controlPlaneBase).toContain('app.kubernetes.io/name: workflow-approval-request-reader')
    // The reader still does NOT get bot tokens or notification-poll credentials.
    for (const name of forbiddenWorkflowApprovalReaderBotNames) {
      expect(readerDeployment).not.toContain(name)
    }
  })

  it('reader→control-api egress NP targets control-api by its REAL pod label (app: control-api)', () => {
    // Regression: the egress allow shipped selecting control-api by
    // `app.kubernetes.io/name: control-api`, but control-api pods are labelled
    // `app: control-api` (see deploy/base/control-plane/control-api.yaml). The
    // mismatch left the allow unmatched → Calico denied reader→control-api:8090
    // → the consulta failed closed (consulta_error) in every enforced cluster.
    const egressNp = read(
      `${BASE}/channels/networkpolicies/workflow-approval-request-reader-to-control-api.yaml`
    )
    const controlApiDeploy = read(`${BASE}/control-plane/control-api.yaml`)
    expect(controlApiDeploy).toMatch(/app:\s*control-api/)
    // The egress allow MUST select control-api by the label its pods actually carry.
    expect(egressNp).toMatch(/podSelector:[\s\S]*?app:\s*control-api/)
    expect(egressNp).not.toContain('app.kubernetes.io/name: control-api')
  })

  it('keeps approval resolve rate limit above channel-reader polling demand with multi-agent headroom', () => {
    const controlPlaneBase = readYamlBundle(`${BASE}/control-plane`)
    const channelsBase = readYamlBundle(`${BASE}/channels`)
    const pollIntervalSeconds = Number(
      channelsBase.match(/CLERUM_POLL_INTERVAL_SECONDS:\s*["']?(\d+)["']?/)?.[1]
    )
    const approvalRequestsPerMinute = Number(
      controlPlaneBase.match(/APPROVAL_RL_REQUEST_PER_MIN:\s*["']?(\d+)["']?/)?.[1]
    )

    expect(pollIntervalSeconds).toBe(2)
    expect(approvalRequestsPerMinute).toBe(120)
    expect(approvalRequestsPerMinute).toBeGreaterThanOrEqual((60 / pollIntervalSeconds) * 4)
  })

  it('keeps channel-reader out of the control-api default service-token map', () => {
    const configSource = read('../../control-api/src/config.ts')
    const defaultMap = configSource.match(
      /process\.env\.CONTROL_API_INTERNAL_SERVICE_TOKENS \|\|\s*'([^']+)'/
    )?.[1]

    expect(defaultMap).toBeDefined()
    expect(defaultMap).not.toContain('channel-reader=')
    // Opción B-completa: the reader IS in the map (consulta endpoint, spec step 6).
    expect(defaultMap).toContain('workflow-approval-reader=')
    expect(defaultMap).toContain('webhook-proxy=')
    expect(defaultMap).toContain('auth-proxy=')
  })
})
