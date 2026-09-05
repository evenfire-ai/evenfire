import { createHash } from 'node:crypto'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import type { McpServerAuth, McpServerOAuth, McpServerStatus, McpServerTransport } from './types'

export interface AuthorityMetadata {
  uid: string
  resourceVersion: string
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
  description?: string
  transport: McpServerTransport
  auth?: McpServerAuth
  // OAuth broker config (grantScope) from the CRD. Non-secret; used only to
  // derive the inventory `authKind`. HCC never forwards it to mcp-host raw.
  oauth?: McpServerOAuth
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
}

export interface AuthorizedMcpServerInfo {
  name: string
  description?: string
  transport: McpServerTransport
  enabled: boolean
  status: Pick<McpServerStatus, 'deployed' | 'ready'> &
    Partial<Pick<McpServerStatus, 'authoritative'>>
  authRequired: boolean
  credentialRevision?: string
  /**
   * Non-secret credential-mode policy the mcp-host seam dispatches on
   * (mini-spec 10 §3.2). Derived from the CRD auth selector; carries NO
   * authority (no contextRef/secretRef/token). `none` is represented as an
   * omitted field. Absent → mcp-host degrades to `static` (fail-closed).
   */
  authKind?: AuthorizedMcpAuthKind
}

export type AuthorizedMcpAuthKind = 'static' | 'oauth-user' | 'oauth-context'

/**
 * Derive the non-secret `authKind` policy for the inventory (mini-spec 10 §3.1).
 * Pure: same inputs → same output; an oauth server never collapses to `static`.
 * Returns undefined for the implicit `none` (no auth required) so the caller
 * omits the field.
 */
export function deriveAuthKind(
  auth: McpServerAuth | undefined,
  // Only grantScope is read here; accepting the narrow shape documents the
  // contract and lets callers pass a full McpServerOAuth (structurally wider).
  oauth: Pick<McpServerOAuth, 'grantScope'> | undefined,
  authRequired: boolean
): AuthorizedMcpAuthKind | undefined {
  if (auth?.type === 'oauth') {
    return oauth?.grantScope === 'context' ? 'oauth-context' : 'oauth-user'
  }
  return authRequired ? 'static' : undefined
}

export interface AuthorizedCredential {
  token: string | null
  credentialRevision: string
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
    serverName: string
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
    if (authRequired && server.auth?.secretRef) {
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
      credentialRevision: revisionFor(server, secretMetadata),
    }
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
      const authKind = deriveAuthKind(grant.server.auth, grant.server.oauth, authRequired)
      servers.push({
        name: grant.server.name,
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
        ...(authRequired ? { credentialRevision: grant.credentialRevision } : {}),
        ...(authKind ? { authKind } : {}),
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
    const grant = await this.resolveServerGrant(binding, serverName)
    const authRequired = Boolean(grant.server.auth && grant.server.auth.type !== 'none')
    if (!authRequired) {
      const revalidated = await this.resolveServerGrant(
        await this.resolveHostContext(principal),
        serverName
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
      serverName
    )
    if (!sameGrant(grant, revalidated)) {
      throw new McpAuthorizationError('authorization_unavailable')
    }
    this.assertPrincipalLive(principal)
    return { token, credentialRevision: grant.credentialRevision }
  }
}
