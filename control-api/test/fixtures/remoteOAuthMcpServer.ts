/**
 * Remote-OAuth McpServer CRs as the remote install saga writes them.
 *
 * Every layer is its real producer: the discovery result comes from
 * `discoverRemoteOAuth` over the recorded Notion well-known bytes, the CIMD client
 * id from `buildCimdDocument`, `spec.oauth` from `buildRemoteOAuthSpec`, and the
 * resource from `buildRemoteMcpServerResource`, the builder the saga itself calls. The catalog identity, when requested, comes
 * from `catalogAnnotations`, the producer every catalog install uses.
 */
import { buildCimdDocument } from '../../src/oauth/cimd.js'
import type { DiscoveryResult } from '../../src/oauth/discovery.js'
import { discoverRemoteOAuth } from '../../src/oauth/discovery.js'
import { catalogAnnotations } from '../../src/routes/admin/registry.js'
import {
  buildRemoteMcpServerResource,
  buildRemoteOAuthSpec,
} from '../../src/routes/admin/remoteMcp.js'
import { PILOTS, makeDiscoveryTransport } from './remoteOAuthDiscovery.js'

let cachedDiscovery: DiscoveryResult | undefined

async function notionDiscovery(): Promise<DiscoveryResult> {
  if (cachedDiscovery) return cachedDiscovery
  const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.notion),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  cachedDiscovery = outcome.result
  return cachedDiscovery
}

export interface RemoteOAuthCrInput {
  serverName: string
  namespace: string
  grantScope: 'user' | 'context'
  /** Catalog identity stamped on create; omit for a manual (by URL) install. */
  catalog?: { id: string; version: string }
}

export type RemoteOAuthCr = {
  metadata: {
    name: string
    labels: Record<string, string>
    annotations?: Record<string, string>
  }
  spec: Record<string, unknown>
}

export async function remoteOAuthMcpServer(input: RemoteOAuthCrInput): Promise<RemoteOAuthCr> {
  const discovery = await notionDiscovery()
  const resource: RemoteOAuthCr = buildRemoteMcpServerResource({
    serverName: input.serverName,
    namespace: input.namespace,
    baseUrl: PILOTS.notion.mcpUrl,
    oauth: buildRemoteOAuthSpec(discovery, {
      clientMode: 'public',
      grantScope: input.grantScope,
      cimdClientId: buildCimdDocument('https://control.example.com').client_id,
    }),
  })
  if (input.catalog) {
    resource.metadata.annotations = catalogAnnotations(input.catalog.id, input.catalog.version)
  }
  return resource
}

/** The base URL every fixture CR points at. */
export const REMOTE_OAUTH_FIXTURE_BASE_URL = PILOTS.notion.mcpUrl
