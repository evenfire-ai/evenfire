import { createHash } from 'node:crypto'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import type { McpServerAuth, McpServerStatus, McpServerTransport } from './types'

export interface AuthorityMetadata {
  uid: string
  resourceVersion: string
  generation?: number
  deletionTimestamp?: string
}

export interface AuthorityHost {
  name: string
  namespace: string
  metadata: AuthorityMetadata
  contextRef: string
}

export interface AuthorityContext {
  name: string
  namespace: string
  metadata: AuthorityMetadata
  mcpServers: readonly string[]
}

export interface AuthorityMcpServer {
  name: string
  namespace: string
  metadata: AuthorityMetadata
  contextRef?: string
  description?: string
  transport: McpServerTransport
  auth?: McpServerAuth
  managed?: boolean
  enabled: boolean
  status: McpServerStatus
}

export interface AuthoritySecretMetadata {
  name: string
  namespace: string
  metadata: AuthorityMetadata
}

export interface AuthoritySecret extends AuthoritySecretMetadata {
  data: Readonly<Record<string, string>>
}

export interface McpAuthorizationStore {
  readHost(name: string): Promise<AuthorityHost | null>
  readContext(name: string): Promise<AuthorityContext | null>
  readMcpServer(name: string): Promise<AuthorityMcpServer | null>
  readSecretMetadata(name: string): Promise<AuthoritySecretMetadata | null>
  readSecret(name: string): Promise<AuthoritySecret | null>
  listMcpServers?(): Promise<AuthorityMcpServer[]>
}

export interface AuthorizedMcpServerInfo {
  name: string
  contextRef: string
  description?: string
  transport: McpServerTransport
  enabled: boolean
  status: Pick<McpServerStatus, 'deployed' | 'ready'> &
    Partial<Pick<McpServerStatus, 'authoritative'>>
  authRequired: boolean
}

export interface AuthorizedCredential {
  token: string | null
  credentialRevision: string
}

export interface SystemMcpServerInfo {
  name: string
  contextRef: string
  transport: McpServerTransport
  enabled: boolean
  status: Pick<McpServerStatus, 'deployed' | 'ready'> &
    Partial<Pick<McpServerStatus, 'authoritative'>>
  destinationRevision: string
}

export interface SystemMcpServersResponse {
  schemaVersion: 1
  servers: SystemMcpServerInfo[]
  timestamp: string
}

export interface LiveForwardTarget {
  serverName: string
  contextRef: string
  targetUrl: string
  destinationRevision: string
}

/** Project only the transport keys that are part of the mcp-host wire contract. */
export function toPublicMcpTransport(transport: McpServerTransport): McpServerTransport {
  return {
    type: transport.type,
    ...(typeof transport.url === 'string' ? { url: transport.url } : {}),
    ...(Number.isSafeInteger(transport.port) &&
    (transport.port ?? 0) > 0 &&
    (transport.port ?? 0) <= 65_535
      ? { port: transport.port }
      : {}),
  }
}

export type McpAuthorizationFailureCode =
  | 'unauthorized'
  | 'not_found'
  | 'authorization_unavailable'
  | 'credential_unavailable'

export class McpAuthorizationError extends Error {
  constructor(readonly code: McpAuthorizationFailureCode) {
    super(code)
    this.name = 'McpAuthorizationError'
  }
}

type AuthorizedHostContext = {
  principal: VerifiedMcpHostPrincipal
  host: AuthorityHost
  context: AuthorityContext
}

type AuthorizedMcpServerGrant = AuthorizedHostContext & {
  server: AuthorityMcpServer
  secretMetadata: AuthoritySecretMetadata | null
  credentialRevision: string
}

const FALLBACK_SECRET_KEYS = ['token', 'api-key', 'apiKey', 'password'] as const
const MCP_SERVICE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const MCP_SERVICE_NAMESPACE = 'mcp-server'
const DEFAULT_MCP_SERVICE_PORT = 3000

function isLive(metadata: AuthorityMetadata): boolean {
  return Boolean(metadata.uid && metadata.resourceVersion && !metadata.deletionTimestamp)
}

function selectSecretKey(secret: AuthoritySecret | null, configured?: string): string | null {
  if (!secret) return null
  const keys = configured ? [configured] : FALLBACK_SECRET_KEYS
  return (
    keys.find(key => Object.hasOwn(secret.data, key) && typeof secret.data[key] === 'string') ??
    null
  )
}

function decodeBase64Credential(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) return null
  const token = decoded.toString('utf8')
  return Buffer.from(token, 'utf8').equals(decoded) && token.length > 0 ? token : null
}

function revisionFor(server: AuthorityMcpServer, secret: AuthoritySecretMetadata | null): string {
  const material = JSON.stringify({
    serverUid: server.metadata.uid,
    serverResourceVersion: server.metadata.resourceVersion,
    serverDeleting: server.metadata.deletionTimestamp ?? null,
    authType: server.auth?.type ?? 'none',
    authSecretRef: server.auth?.secretRef ?? null,
    authSecretKey: server.auth?.secretKey ?? null,
    secretUid: secret?.metadata.uid ?? null,
    secretResourceVersion: secret?.metadata.resourceVersion ?? null,
    secretDeleting: secret?.metadata.deletionTimestamp ?? null,
  })
  return createHash('sha256').update(material).digest('base64url')
}

function forwardRevision(server: AuthorityMcpServer, targetUrl: string): string {
  const material = JSON.stringify({
    serverUid: server.metadata.uid,
    serverResourceVersion: server.metadata.resourceVersion,
    serverGeneration: server.metadata.generation ?? null,
    serverDeleting: server.metadata.deletionTimestamp ?? null,
    targetUrl,
    enabled: server.enabled,
    deployed: server.status.deployed,
    ready: server.status.ready,
    authoritative: server.status.authoritative ?? null,
  })
  return createHash('sha256').update(material).digest('base64url')
}

function expectedMcpServiceHostname(serverName: string): string | null {
  if (serverName.length > 63 || !MCP_SERVICE_NAME_RE.test(serverName)) return null
  return `${serverName}.${MCP_SERVICE_NAMESPACE}.svc.cluster.local`
}

function liveForwardUrl(server: AuthorityMcpServer): string | null {
  if (server.transport.type === 'stdio' && server.managed !== false) {
    const port = server.transport.port ?? DEFAULT_MCP_SERVICE_PORT
    const hostname = expectedMcpServiceHostname(server.name)
    if (!hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null
    return `http://${hostname}:${port}/mcp`
  }
  if (server.transport.type !== 'sse' && server.transport.type !== 'streamableHttp') return null
  if (
    typeof server.transport.url !== 'string' ||
    server.transport.url.trim() !== server.transport.url
  ) {
    return null
  }
  const expectedHostname = expectedMcpServiceHostname(server.name)
  const expectedPort = server.transport.port ?? DEFAULT_MCP_SERVICE_PORT
  if (
    !expectedHostname ||
    !Number.isSafeInteger(expectedPort) ||
    expectedPort < 1 ||
    expectedPort > 65_535
  ) {
    return null
  }
  try {
    const target = new URL(server.transport.url)
    const actualPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
    if (
      (target.protocol !== 'http:' && target.protocol !== 'https:') ||
      target.username ||
      target.password ||
      target.hash ||
      target.search ||
      target.hostname.toLowerCase() !== expectedHostname ||
      actualPort !== expectedPort ||
      !target.pathname.startsWith('/')
    ) {
      return null
    }
    return target.toString()
  } catch {
    return null
  }
}

function safeDirectoryTransport(transport: McpServerTransport): McpServerTransport {
  let url: string | undefined
  if (typeof transport.url === 'string' && transport.url.trim() === transport.url) {
    try {
      const parsed = new URL(transport.url)
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        !parsed.search &&
        parsed.pathname.startsWith('/')
      ) {
        url = parsed.toString()
      }
    } catch {
      // Invalid transport metadata is omitted from the low-sensitivity directory.
    }
  }
  return {
    type: transport.type,
    ...(url ? { url } : {}),
  }
}

function sameForwardTarget(left: LiveForwardTarget, right: LiveForwardTarget): boolean {
  return (
    left.serverName === right.serverName &&
    left.contextRef === right.contextRef &&
    left.targetUrl === right.targetUrl &&
    left.destinationRevision === right.destinationRevision
  )
}

function sameHostContext(left: AuthorizedHostContext, right: AuthorizedHostContext): boolean {
  return (
    left.principal.subject === right.principal.subject &&
    left.principal.hostName === right.principal.hostName &&
    left.principal.hostUid === right.principal.hostUid &&
    left.principal.jti === right.principal.jti &&
    left.principal.issuedAt === right.principal.issuedAt &&
    left.principal.expiresAt === right.principal.expiresAt &&
    left.host.name === right.host.name &&
    left.host.namespace === right.host.namespace &&
    left.host.metadata.uid === right.host.metadata.uid &&
    left.host.metadata.resourceVersion === right.host.metadata.resourceVersion &&
    left.host.contextRef === right.host.contextRef &&
    left.context.name === right.context.name &&
    left.context.namespace === right.context.namespace &&
    left.context.metadata.uid === right.context.metadata.uid &&
    left.context.metadata.resourceVersion === right.context.metadata.resourceVersion &&
    left.context.mcpServers.join('\u0000') === right.context.mcpServers.join('\u0000')
  )
}

function sameGrant(left: AuthorizedMcpServerGrant, right: AuthorizedMcpServerGrant): boolean {
  return (
    sameHostContext(left, right) &&
    left.server.metadata.uid === right.server.metadata.uid &&
    left.server.metadata.resourceVersion === right.server.metadata.resourceVersion &&
    left.credentialRevision === right.credentialRevision
  )
}

export class McpAuthorizationService {
  constructor(
    private readonly store: McpAuthorizationStore,
    private readonly nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  private assertPrincipalLive(principal: VerifiedMcpHostPrincipal): void {
    if (principal.expiresAt <= this.nowEpochSeconds()) {
      throw new McpAuthorizationError('unauthorized')
    }
  }

  private async resolveHostContext(
    principal: VerifiedMcpHostPrincipal
  ): Promise<AuthorizedHostContext> {
    this.assertPrincipalLive(principal)
    let host: AuthorityHost | null
    let context: AuthorityContext | null
    try {
      host = await this.store.readHost(principal.hostName)
      if (
        !host ||
        host.name !== principal.hostName ||
        host.namespace !== principal.namespace ||
        !isLive(host.metadata) ||
        host.metadata.uid !== principal.hostUid ||
        !host.contextRef
      ) {
        // A missing/recreated/deleting Host invalidates the authenticated
        // principal itself. Surface 401 so mcp-host revokes the whole retained
        // authority set instead of treating this as one missing MCP target.
        throw new McpAuthorizationError('unauthorized')
      }
      context = await this.store.readContext(host.contextRef)
    } catch (error) {
      if (error instanceof McpAuthorizationError) throw error
      throw new McpAuthorizationError('authorization_unavailable')
    }
    if (
      !context ||
      context.name !== host.contextRef ||
      !context.namespace ||
      !isLive(context.metadata)
    ) {
      throw new McpAuthorizationError('not_found')
    }
    return { principal, host, context }
  }

  private async resolveServerGrant(
    binding: AuthorizedHostContext,
    serverName: string,
    includeCredentialMetadata = false
  ): Promise<AuthorizedMcpServerGrant> {
    if (!binding.context.mcpServers.includes(serverName)) {
      throw new McpAuthorizationError('not_found')
    }

    let server: AuthorityMcpServer | null
    try {
      server = await this.store.readMcpServer(serverName)
    } catch {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    if (
      !server ||
      server.name !== serverName ||
      server.namespace !== binding.context.namespace ||
      !server.enabled ||
      !isLive(server.metadata)
    ) {
      throw new McpAuthorizationError('not_found')
    }

    const authRequired = Boolean(server.auth && server.auth.type !== 'none')
    let secretMetadata: AuthoritySecretMetadata | null = null
    if (includeCredentialMetadata && authRequired && server.auth?.secretRef) {
      try {
        secretMetadata = await this.store.readSecretMetadata(server.auth.secretRef)
      } catch {
        throw new McpAuthorizationError('authorization_unavailable')
      }
    }
    if (
      secretMetadata &&
      (secretMetadata.name !== server.auth?.secretRef ||
        secretMetadata.namespace !== server.namespace ||
        !isLive(secretMetadata.metadata))
    ) {
      secretMetadata = null
    }
    return {
      ...binding,
      server,
      secretMetadata,
      credentialRevision: includeCredentialMetadata
        ? revisionFor(server, secretMetadata)
        : revisionFor(server, null),
    }
  }

  private async resolveLiveForwardTarget(
    binding: AuthorizedHostContext,
    serverName: string
  ): Promise<LiveForwardTarget> {
    if (!binding.context.mcpServers.includes(serverName)) {
      throw new McpAuthorizationError('not_found')
    }

    let server: AuthorityMcpServer | null
    try {
      server = await this.store.readMcpServer(serverName)
    } catch {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    const targetUrl = server ? liveForwardUrl(server) : null
    if (
      !server ||
      server.name !== serverName ||
      server.namespace !== binding.context.namespace ||
      server.contextRef !== binding.context.name ||
      !server.enabled ||
      !isLive(server.metadata) ||
      !server.status.deployed ||
      !server.status.ready ||
      server.status.authoritative !== true ||
      !targetUrl
    ) {
      throw new McpAuthorizationError('not_found')
    }
    return {
      serverName: server.name,
      contextRef: binding.context.name,
      targetUrl,
      destinationRevision: forwardRevision(server, targetUrl),
    }
  }

  async listSystemServers(): Promise<SystemMcpServerInfo[]> {
    if (!this.store.listMcpServers) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    let servers: AuthorityMcpServer[]
    try {
      servers = await this.store.listMcpServers()
    } catch {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    return servers.filter(server => Boolean(server.contextRef)).map(server => {
      const targetUrl = liveForwardUrl(server) ?? ''
      return {
        name: server.name,
        contextRef: server.contextRef ?? '',
        transport: safeDirectoryTransport(server.transport),
        enabled: server.enabled,
        status: {
          deployed: server.status.deployed,
          ready: server.status.ready,
          ...(typeof server.status.authoritative === 'boolean'
            ? { authoritative: server.status.authoritative }
            : {}),
        },
        destinationRevision: forwardRevision(server, targetUrl),
      }
    })
  }

  async getLiveForwardTarget(
    principal: VerifiedMcpHostPrincipal,
    serverName: string
  ): Promise<LiveForwardTarget> {
    const binding = await this.resolveHostContext(principal)
    const target = await this.resolveLiveForwardTarget(binding, serverName)
    const revalidatedBinding = await this.resolveHostContext(principal)
    let revalidatedTarget: LiveForwardTarget
    try {
      revalidatedTarget = await this.resolveLiveForwardTarget(revalidatedBinding, serverName)
    } catch (error) {
      if (error instanceof McpAuthorizationError && error.code === 'not_found') {
        throw new McpAuthorizationError('authorization_unavailable')
      }
      throw error
    }
    if (
      !sameHostContext(binding, revalidatedBinding) ||
      !sameForwardTarget(target, revalidatedTarget)
    ) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    this.assertPrincipalLive(principal)
    return target
  }

  async listServers(principal: VerifiedMcpHostPrincipal): Promise<AuthorizedMcpServerInfo[]> {
    const binding = await this.resolveHostContext(principal)
    const names = [...new Set(binding.context.mcpServers)]
    const servers: AuthorizedMcpServerInfo[] = []
    for (const name of names) {
      let grant: AuthorizedMcpServerGrant
      try {
        grant = await this.resolveServerGrant(binding, name)
      } catch (error) {
        if (error instanceof McpAuthorizationError && error.code === 'not_found') continue
        throw error
      }
      const authRequired = Boolean(grant.server.auth && grant.server.auth.type !== 'none')
      servers.push({
        name: grant.server.name,
        contextRef: grant.context.name,
        ...(grant.server.description ? { description: grant.server.description } : {}),
        transport: toPublicMcpTransport(grant.server.transport),
        enabled: grant.server.enabled,
        status: {
          deployed: grant.server.status.deployed,
          ready: grant.server.status.ready,
          ...(typeof grant.server.status.authoritative === 'boolean'
            ? { authoritative: grant.server.status.authoritative }
            : {}),
        },
        authRequired,
      })
    }
    const revalidated = await this.resolveHostContext(principal)
    if (!sameHostContext(binding, revalidated)) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    return servers
  }

  async getCredential(
    principal: VerifiedMcpHostPrincipal,
    serverName: string
  ): Promise<AuthorizedCredential> {
    const binding = await this.resolveHostContext(principal)
    const grant = await this.resolveServerGrant(binding, serverName, true)
    const authRequired = Boolean(grant.server.auth && grant.server.auth.type !== 'none')
    if (!authRequired) {
      const revalidated = await this.resolveServerGrant(
        await this.resolveHostContext(principal),
        serverName,
        true
      )
      if (!sameGrant(grant, revalidated)) {
        throw new McpAuthorizationError('authorization_unavailable')
      }
      this.assertPrincipalLive(principal)
      return { token: null, credentialRevision: grant.credentialRevision }
    }

    if (!grant.server.auth?.secretRef || !grant.secretMetadata) {
      throw new McpAuthorizationError('credential_unavailable')
    }
    let secret: AuthoritySecret | null
    try {
      secret = await this.store.readSecret(grant.server.auth.secretRef)
    } catch {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    if (
      !secret ||
      secret.name !== grant.secretMetadata.name ||
      secret.namespace !== grant.secretMetadata.namespace ||
      !isLive(secret.metadata) ||
      secret.metadata.uid !== grant.secretMetadata.metadata.uid ||
      secret.metadata.resourceVersion !== grant.secretMetadata.metadata.resourceVersion ||
      secret.metadata.deletionTimestamp !== grant.secretMetadata.metadata.deletionTimestamp
    ) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    const selectedSecretKey = selectSecretKey(secret, grant.server.auth.secretKey)
    if (!selectedSecretKey) throw new McpAuthorizationError('credential_unavailable')
    const token = decodeBase64Credential(secret.data[selectedSecretKey])
    if (!token) throw new McpAuthorizationError('credential_unavailable')

    const revalidated = await this.resolveServerGrant(
      await this.resolveHostContext(principal),
      serverName,
      true
    )
    if (!sameGrant(grant, revalidated)) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    this.assertPrincipalLive(principal)
    return { token, credentialRevision: grant.credentialRevision }
  }
}
