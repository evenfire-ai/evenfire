import { describe, expect, it, vi } from 'vitest'
import { HostOverviewService } from '../src/services/hostOverviewService.js'
import { ResourceService } from '../src/services/resourceService.js'

// R1-H1 (High) — cross-agent communication-channel leak in the admin overview.
//
// PR #304 turned host.spec.host from an RFC1123 identifier into an editable
// display name. A communication-channel's spec.hostRef is still the host's
// RFC1123 metadata.name (the channel wizard binds it to metadata.name). If the
// overview matched channels against spec.host as well, an agent whose DISPLAY
// name collides with ANOTHER agent's metadata.name would surface that other
// agent's channels — and their recipients — under the wrong agent.
//
// Fixtures are derived from the REAL producers (T1): the real ResourceService
// is driven through a customApi spy shaped exactly like @kubernetes/client-node
// (getNamespacedCustomObject returns the object; listNamespacedCustomObject
// returns { items }), and the real HostOverviewService consumes it. No layer is
// hand-simulated.

const NS = 'mcp-host'

type Host = {
  metadata: { name: string; namespace: string }
  spec: { host?: string; contextRef?: string }
}

type Channel = {
  metadata: { name: string; namespace: string }
  spec: {
    hostRef: string
    telegram?: Array<{ userIds?: string[] }>
    email?: Array<{ emails?: string[] }>
    slack?: Array<{ userNames?: string[] }>
  }
}

function buildOverviewService(hosts: Host[], channels: Channel[]): HostOverviewService {
  const customApi = {
    getNamespacedCustomObject: vi.fn(async ({ plural, name }: { plural: string; name: string }) => {
      if (plural === 'hosts') {
        const host = hosts.find(h => h.metadata.name === name)
        if (host) return host
      }
      const err = new Error(`${plural}/${name} not found`) as Error & { statusCode: number }
      err.statusCode = 404
      throw err
    }),
    listNamespacedCustomObject: vi.fn(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') return { items: channels }
      return { items: [] }
    }),
  }

  const resources = new ResourceService(customApi as never, NS, {})
  return new HostOverviewService(resources, NS)
}

describe('HostOverviewService — cross-agent communication-channel isolation (R1-H1)', () => {
  // Agent A: metadata.name = "support" (owns the channel).
  // Agent B: metadata.name = "sales", spec.host = "support" (display collides
  //          with A's metadata.name).
  // Channel: spec.hostRef = "support" (bound to A's RFC1123 identifier).
  const hosts: Host[] = [
    { metadata: { name: 'support', namespace: NS }, spec: {} },
    { metadata: { name: 'sales', namespace: NS }, spec: { host: 'support' } },
  ]
  const channels: Channel[] = [
    {
      metadata: { name: 'support-telegram', namespace: NS },
      spec: {
        hostRef: 'support',
        telegram: [{ userIds: ['tg-secret-A'] }],
        email: [{ emails: ['a@example.com'] }],
        slack: [{ userNames: ['slack-A'] }],
      },
    },
  ]

  it('does NOT surface agent A’s channel under agent B whose display name collides', async () => {
    const service = buildOverviewService(hosts, channels)

    const overview = await service.getHostOverview('sales', NS)
    const observed = overview.communicationChannels as Array<{ spec?: { hostRef?: string } }>

    // Observable output (T4): the list the admin sees must not contain A's channel.
    expect(observed.map(ch => ch.spec?.hostRef)).not.toContain('support')
    expect(observed).toHaveLength(0)
    // And none of A's recipients leak into B's aggregated access summary.
    expect(overview.accessSummary.telegramUserIds).not.toContain('tg-secret-A')
    expect(overview.accessSummary.emails).not.toContain('a@example.com')
    expect(overview.accessSummary.slackUserNames).not.toContain('slack-A')
  })

  it('still surfaces the channel under agent A (its real RFC1123 owner)', async () => {
    const service = buildOverviewService(hosts, channels)

    const overview = await service.getHostOverview('support', NS)
    const observed = overview.communicationChannels as Array<{ spec?: { hostRef?: string } }>

    expect(observed.map(ch => ch.spec?.hostRef)).toEqual(['support'])
    expect(overview.accessSummary.telegramUserIds).toEqual(['tg-secret-A'])
  })
})
