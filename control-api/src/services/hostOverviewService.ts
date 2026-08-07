import { HostOverview } from '../types.js'
import { ResourceService } from './resourceService.js'

export class HostOverviewService {
  constructor(
    private readonly resources: ResourceService,
    private readonly defaultNamespace: string
  ) {}

  async getHostOverview(hostName: string, namespace?: string): Promise<HostOverview> {
    const host = (await this.resources.getResource('hosts', hostName, namespace)) as {
      metadata?: { name?: string }
      spec?: { host?: string; contextRef?: string }
    }

    const allChannels = (await this.resources.listResource('communicationchannels', '*')) as Array<{
      spec?: {
        hostRef?: string
        telegram?: Array<{ userIds?: string[] }>
        email?: Array<{ emails?: string[] }>
        slack?: Array<{ userNames?: string[] }>
      }
    }>

    const hostIdCandidates = new Set<string>(
      [hostName, host.spec?.host].filter((v): v is string => Boolean(v))
    )

    const communicationChannels = allChannels.filter(ch =>
      hostIdCandidates.has(ch.spec?.hostRef || '')
    )

    let context = null as unknown
    const contextRef = host.spec?.contextRef
    if (contextRef) {
      try {
        context = await this.resources.getResource('contexts', contextRef, this.defaultNamespace)
      } catch {
        const contexts = (await this.resources.listResource('contexts', '*')) as Array<{
          spec?: { contextId?: string }
        }>
        context = contexts.find(c => c.spec?.contextId === contextRef) || null
      }
    }

    const allMcpServers = (await this.resources.listResource('mcpservers', '*')) as Array<{
      metadata?: { name?: string }
    }>
    const allowed = new Set<string>(
      ((context as { spec?: { mcpServers?: string[] } } | null)?.spec?.mcpServers || []).filter(
        (v): v is string => Boolean(v)
      )
    )
    const mcpServers = allMcpServers.filter(s => allowed.has(s.metadata?.name || ''))

    const telegramUserIds = new Set<string>()
    const emails = new Set<string>()
    const slackUserNames = new Set<string>()

    for (const ch of communicationChannels) {
      for (const group of ch.spec?.telegram || []) {
        for (const id of group.userIds || []) telegramUserIds.add(id)
      }
      for (const group of ch.spec?.email || []) {
        for (const email of group.emails || []) emails.add(email)
      }
      for (const group of ch.spec?.slack || []) {
        for (const user of group.userNames || []) slackUserNames.add(user)
      }
    }

    return {
      host,
      context,
      communicationChannels,
      mcpServers,
      accessSummary: {
        telegramUserIds: [...telegramUserIds].sort(),
        emails: [...emails].sort(),
        slackUserNames: [...slackUserNames].sort(),
      },
    }
  }
}
