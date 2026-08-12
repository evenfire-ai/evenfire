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

  it('lists a channel whose Secret holds a Slack signing secret', async () => {
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
    seedSecretKeys('channels', 'agent-a-slack-credentials', ['slack-signing-secret'])
    seedSecretKeys('channels', 'agent-a-impostor-credentials', ['telegram-bot-token'])

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
    seedSecretKeys('channels', 'agent-a-slack-credentials', ['slack-signing-secret'])
    seedSecretKeys('other-tenant', 'agent-b-slack-credentials', ['slack-signing-secret'])

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
    seedSecretKeys('channels', 'shared-credentials', ['slack-signing-secret'])

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
    seedSecretKeys('channels', 'agent-a-slack-credentials', ['slack-signing-secret'])
    // agent-a-unreadable-credentials is intentionally unseeded: the mock throws
    // a 403 for it, the same shape secretKeyNames rethrows on an RBAC denial.

    const targets = await listSlackApprovalTargets({ gateway: gateway as never, userId: 'user-1' })

    expect(targets.items.map(target => target.channelName)).toEqual(['agent-a-slack'])
  })
})
