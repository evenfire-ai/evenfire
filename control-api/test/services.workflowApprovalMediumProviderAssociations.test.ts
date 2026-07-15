import { describe, expect, it, vi } from 'vitest'
import { addSlackTargetAssociation } from '../src/services/workflowApprovalMediumSlackVerificationService.js'
import { addTeamsTargetAssociation } from '../src/services/workflowApprovalMediumTeamsVerificationService.js'

function mutationGateway(current: Record<string, unknown>) {
  const state = { next: null as unknown }
  return {
    state,
    gateway: {
      mutateResource: vi.fn(
        async (
          _resource: string,
          _name: string,
          mutate: (resource: Record<string, unknown>) => unknown,
          _namespace?: string
        ) => {
          state.next = mutate(current)
        }
      ),
    },
  }
}

describe('workflow approval provider associations', () => {
  it('persists Slack conversation metadata captured during confirmation', async () => {
    const { gateway, state } = mutationGateway({ spec: { slack: [] } })

    await addSlackTargetAssociation(
      gateway as never,
      {
        id: 'target-1',
        medium: 'slack',
        agentName: 'agent-a',
        channelName: 'cc-a',
        channelNamespace: 'channels',
        botLabel: 'Evenfire',
        botUsername: null,
        botDeepLink: null,
        providerWorkspaceId: 'T123',
        replyOnlyWhenMentioned: true,
        status: 'ready',
      },
      {
        userId: 'user-a',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'G123',
        providerChannelType: 'private_channel',
        providerChannelTitle: '#leadership',
      }
    )

    expect(state.next).toMatchObject({
      spec: {
        slack: [
          {
            channelId: 'G123',
            workspaceId: 'T123',
            conversationType: 'private_channel',
            title: '#leadership',
            userIds: ['U123'],
            confirmedByUserId: 'user-a',
          },
        ],
      },
    })
  })

  it('persists Teams conversation metadata captured during confirmation', async () => {
    const { gateway, state } = mutationGateway({ spec: { teams: [] } })

    await addTeamsTargetAssociation(
      gateway as never,
      {
        id: 'target-1',
        medium: 'teams',
        agentName: 'agent-a',
        channelName: 'cc-a',
        channelNamespace: 'channels',
        botLabel: 'Evenfire',
        botUsername: null,
        botDeepLink: null,
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        replyOnlyWhenMentioned: true,
        status: 'ready',
      },
      {
        userId: 'user-a',
        providerUserId: '29:user',
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        providerChannelId: '19:channel@thread.tacv2',
        providerChannelType: 'channel',
        providerChannelTitle: 'General',
        providerTeamId: 'team-1',
        providerTeamsChannelId: '19:channel@thread.tacv2',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        replyInThreads: false,
      }
    )

    expect(state.next).toMatchObject({
      spec: {
        teams: [
          {
            channelId: '19:channel@thread.tacv2',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            serviceUrl: 'https://smba.trafficmanager.net/amer/',
            conversationType: 'channel',
            title: 'General',
            teamId: 'team-1',
            teamsChannelId: '19:channel@thread.tacv2',
            userIds: ['29:user'],
            confirmedByUserId: 'user-a',
            replyInThreads: false,
          },
        ],
      },
    })
  })

  it('preserves an existing Teams thread reply preference when confirmation omits it', async () => {
    const { gateway, state } = mutationGateway({
      spec: {
        teams: [
          {
            channelId: '19:channel@thread.tacv2',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            userIds: ['29:existing-user'],
            replyInThreads: false,
          },
        ],
      },
    })

    await addTeamsTargetAssociation(
      gateway as never,
      {
        id: 'target-1',
        medium: 'teams',
        agentName: 'agent-a',
        channelName: 'cc-a',
        channelNamespace: 'channels',
        botLabel: 'Evenfire',
        botUsername: null,
        botDeepLink: null,
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        replyOnlyWhenMentioned: true,
        status: 'ready',
      },
      {
        userId: 'user-a',
        providerUserId: '29:new-user',
        providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        providerChannelId: '19:channel@thread.tacv2',
        providerChannelType: 'channel',
        providerChannelTitle: 'General',
      }
    )

    expect(state.next).toMatchObject({
      spec: {
        teams: [
          {
            channelId: '19:channel@thread.tacv2',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            userIds: ['29:existing-user', '29:new-user'],
            replyInThreads: false,
          },
        ],
      },
    })
  })
})
