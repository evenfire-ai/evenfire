import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { K8sGateway } from '../../k8s.js'
import {
  listAllTeams,
  listTeamsByAgent,
  listUsers,
  listUsersByAgent,
} from '../../services/directory/index.js'
import { buildAgentDirectoryEntry } from '../../services/directory/accessReconciliation.js'
import { listHostSecrets } from './hostSecrets.js'

export function createAdminHostsOverviewRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/admin/hosts-overview',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (_req, res) => {
      // "*" triggers resourceService cross-namespace merge across
      // listNamespacesForPlural("hosts"), preserving pre-PR behavior.
      const hosts = (await gateway.listResource('hosts', '*')) as Array<{
        metadata?: { name?: string; namespace?: string }
      }>
      const selected = hosts
        .map(h => ({ name: h.metadata?.name, namespace: h.metadata?.namespace }))
        .filter(h => Boolean(h.name))
      const agents = hosts
        .map(host => buildAgentDirectoryEntry(host, config.hostsNamespace))
        .filter(agent => agent !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
      const overviews = await Promise.all(
        selected.map(h => gateway.getHostOverview(h.name as string, h.namespace))
      )
      res.status(200).json({ items: overviews, agents })
    })
  )

  router.get(
    '/admin/hosts/:name/overview',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const overview = await gateway.getHostOverview(req.params.name, config.hostsNamespace)
      const host =
        overview && typeof overview === 'object' && 'host' in overview
          ? (overview as { host?: unknown }).host
          : null
      res.status(200).json({
        ...overview,
        agent: buildAgentDirectoryEntry(host, config.hostsNamespace),
      })
    })
  )

  router.get(
    '/admin/hosts/:name/detail',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const name = req.params.name
      // The detail page needs complete users/teams lists for grant dropdowns.
      // Keep this aggregate explicit so future scale work can replace it with
      // search-backed picker endpoints instead of hiding roster fan-out in UI.
      const [host, contexts, secrets, users, teams, agentUsers, agentTeams] = await Promise.all([
        gateway.getResource('hosts', name, config.hostsNamespace),
        gateway.listResource('contexts', config.contextsNamespace),
        listHostSecrets(gateway),
        listUsers(''),
        listAllTeams(),
        listUsersByAgent(name),
        listTeamsByAgent(name),
      ])
      res.status(200).json({
        host,
        contexts: Array.isArray(contexts) ? contexts : [],
        secrets,
        users,
        teams,
        agentUsers,
        agentTeams,
      })
    })
  )

  return router
}
