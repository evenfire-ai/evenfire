import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTeamAgents, getUserAgents, listTeams } from '../src/services/directory/index.js'
import { secretKeyNames } from '../src/services/secretKeyNames.js'
import { listSlackApprovalTargets } from '../src/services/workflowApprovalMediumSlackVerificationService.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/services/directory/index.js', () => ({
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  listTeams: vi.fn(),
}))

vi.mock('../src/services/secretKeyNames.js', () => ({
  secretKeyNames: vi.fn(),
}))

const mockedGetUserAgents = vi.mocked(getUserAgents)
const mockedGetTeamAgents = vi.mocked(getTeamAgents)
const mockedListTeams = vi.mocked(listTeams)
const mockedSecretKeyNames = vi.mocked(secretKeyNames)

/**
 * Keys the fake cluster holds per `namespace/secretName`. The mocked
 * `secretKeyNames` answers from this map, so a test declares Secret contents
 * the same way it declares channels.
 */
const secretKeys = new Map<string, string[]>()

function seedSecretKeys(namespace: string, name: string, keys: string[]): void {
  secretKeys.set(`${namespace}/${name}`, keys)
}

/** Both keys the write path requires before a channel may claim the Slack provider. */
const WORKING_SLACK_KEYS = ['slack-signing-secret', 'slack-bot-token']

async function seedSlackChannel(
  gateway: MockGateway,
  options: {
    name: string
    namespace?: string
    hostRef?: string
    users?: string[]
    secretName?: string
  }
): Promise<void> {
  const namespace = options.namespace ?? 'channels'
  await gateway.createResource(
    'communicationchannels',
    {
      metadata: { name: options.name },
      spec: {
        hostRef: options.hostRef ?? 'agent-a',
        access: { users: options.users ?? ['user-1'], teams: [] },
        credentialsSecretRef: { name: options.secretName ?? `${options.name}-credentials` },
        slackSettings: { botHandle: 'Evenfire-jos' },
      },
    },
    namespace
  )
}

/** Every `namespace/secretName` the implementation actually read. */
function readSecretRefs(): string[] {
  return mockedSecretKeyNames.mock.calls.map(([, name, namespace]) => `${namespace}/${name}`)
}

describe('listSlackApprovalTargets Secret filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    secretKeys.clear()
    mockedGetUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: ['agent-a'] })
    mockedGetTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: [] })
    mockedListTeams.mockResolvedValue({ currentTeamId: '', items: [] })
    mockedSecretKeyNames.mockImplementation(async (_gateway, name, namespace) => {
      const keys = secretKeys.get(`${namespace}/${name}`)
      if (!keys) {
        const error = new Error(`secrets "${name}" unreadable`) as Error & { statusCode: number }
        error.statusCode = 403
        throw error
      }
      return [...keys].sort((a, b) => a.localeCompare(b))
    })
  })

  it('lists a channel whose Secret holds both Slack keys', async () => {
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack' })
    seedSecretKeys('channels', 'agent-a-slack-credentials', [
      'slack-bot-token',
      'slack-signing-secret',
    ])

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items).toHaveLength(1)
    expect(targets.items[0]).toMatchObject({
      agentName: 'agent-a',
      channelName: 'agent-a-slack',
      channelNamespace: 'channels',
      medium: 'slack',
    })
  })

  it('hides a channel whose Secret holds no Slack keys even though it names a Slack app', async () => {
    // The reported duplicate "Evenfire-jos": a Telegram channel that had a Slack
    // App Name typed into it. It projects as a ready Slack target, but its
    // Secret only ever held Telegram credentials, so picking it 409s.
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack' })
    await seedSlackChannel(gateway, { name: 'agent-a-impostor' })
    seedSecretKeys('channels', 'agent-a-slack-credentials', WORKING_SLACK_KEYS)
    seedSecretKeys('channels', 'agent-a-impostor-credentials', ['telegram-bot-token'])

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items.map(target => target.channelName)).toEqual(['agent-a-slack'])
  })

  it('hides a channel whose Secret holds the signing secret but no bot token', async () => {
    // The picker filter and the write-path validator must agree on what "Slack
    // works" means: PROVIDER_REQUIRED_KEYS.slack requires both keys. The signing
    // secret only verifies INBOUND requests, so a half-configured channel is
    // listed, accepts the events, and then fails when the approval message is
    // posted through the Web API.
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack' })
    await seedSlackChannel(gateway, { name: 'agent-a-half-configured' })
    seedSecretKeys('channels', 'agent-a-slack-credentials', WORKING_SLACK_KEYS)
    seedSecretKeys('channels', 'agent-a-half-configured-credentials', ['slack-signing-secret'])

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items.map(target => target.channelName)).toEqual(['agent-a-slack'])
  })

  it('never reads the Secret of a channel the caller cannot access', async () => {
    // The ordering property. This endpoint lists communicationchannels across
    // ALL namespaces and is gated only by a valid external session, so reading
    // keys before the access check would let any authenticated profile user
    // drive control-api into reading every credentials Secret in the cluster.
    // Asserting only on `items` would not catch that: the foreign channel is
    // absent from the result either way.
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack' })
    await seedSlackChannel(gateway, {
      name: 'agent-b-slack',
      namespace: 'other-tenant',
      hostRef: 'agent-b',
      users: ['user-2'],
    })
    seedSecretKeys('channels', 'agent-a-slack-credentials', WORKING_SLACK_KEYS)
    seedSecretKeys('other-tenant', 'agent-b-slack-credentials', WORKING_SLACK_KEYS)

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items.map(target => target.channelName)).toEqual(['agent-a-slack'])
    expect(mockedSecretKeyNames).not.toHaveBeenCalledWith(
      expect.anything(),
      'agent-b-slack-credentials',
      expect.anything()
    )
    expect(readSecretRefs()).toEqual(['channels/agent-a-slack-credentials'])
  })

  it('reads a shared Secret once when two accessible channels reference it', async () => {
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack-one', secretName: 'shared-credentials' })
    await seedSlackChannel(gateway, { name: 'agent-a-slack-two', secretName: 'shared-credentials' })
    seedSecretKeys('channels', 'shared-credentials', WORKING_SLACK_KEYS)

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items).toHaveLength(2)
    expect(readSecretRefs()).toEqual(['channels/shared-credentials'])
  })

  it('drops only the offending target when a Secret cannot be read', async () => {
    // Fails OPEN, deliberately, and unlike the write-path validator: this is a
    // read-only listing, and one broken channel must not blank the whole picker.
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-slack' })
    await seedSlackChannel(gateway, { name: 'agent-a-unreadable' })
    seedSecretKeys('channels', 'agent-a-slack-credentials', WORKING_SLACK_KEYS)
    // agent-a-unreadable-credentials is intentionally unseeded: the mock throws
    // a 403 for it, the same shape secretKeyNames rethrows on an RBAC denial.

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items.map(target => target.channelName)).toEqual(['agent-a-slack'])
  })

  it('warns with the Secret ref and the cause when a target is dropped for an unreadable Secret', async () => {
    // Failing open is right here, but silence is not: RBAC drift is a real
    // condition on these clusters, and without this line a target disappears
    // from the picker with nothing anywhere to say why.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gateway = new MockGateway('channels')
    await seedSlackChannel(gateway, { name: 'agent-a-unreadable' })

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe(
      '[WorkflowApprovalMedium] Slack target hidden: cannot read Secret ' +
        '"channels/agent-a-unreadable-credentials": secrets "agent-a-unreadable-credentials" unreadable'
    )
    warn.mockRestore()
  })
})
