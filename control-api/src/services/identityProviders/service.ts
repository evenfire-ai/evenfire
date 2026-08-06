import { createHash, randomBytes } from 'node:crypto'
import { config } from '../../config.js'
import { pool, withTransaction } from '../../db.js'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../../oauth/encryption.js'
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import { identityProviderLoginData } from '../directory/login.js'
import { validateInvitationFlowToken } from '../invitationFlowRegistrationService.js'
import { identityProviderError } from './errors.js'
import {
  buildMicrosoftAuthorizeUrl,
  createPkceChallenge,
  createPkceVerifier,
  exchangeMicrosoftAuthorizationCode,
  getMicrosoftCurrentUser,
  listMicrosoftTeamMemberIds,
  listMicrosoftTeams,
  listMicrosoftUsers,
  refreshMicrosoftAccessToken,
} from './microsoft.js'
import { markIdentityProviderSetupAuthorized } from './setup.js'
import type {
  IdentityProviderConnection,
  IdentityProviderLoginFlow,
  MicrosoftDirectoryTeam,
  MicrosoftDirectoryUser,
} from './types.js'
import {
  identityProviderCallbackErrorMessage,
  requireCanonicalGuid,
  requireFlowBinding,
  validateIdentityProviderReturnUrl,
} from './validation.js'

const OAUTH_STATE_TTL_MINUTES = 10
const LOGIN_CODE_TTL_MINUTES = 3

type ConnectionRow = {
  id: string
  provider: 'microsoft'
  display_name: string
  directory_tenant_id: string
  client_id: string
  oauth_callback_url: string
  client_secret_encrypted: string
  refresh_token_encrypted: string | null
  granted_scopes: string[] | null
  status: 'pending' | 'connected' | 'disconnected' | 'error'
  allow_member_login: boolean
  allowed_email_domains: string[] | null
  client_secret_expires_at: Date | null
  connected_at: Date | null
  disconnected_at: Date | null
  last_error: string | null
  created_at: Date
}

type OAuthStateRow = {
  connection_id: string
  flow: IdentityProviderLoginFlow
  invitation_id: string | null
  return_url: string
  code_verifier_encrypted: string
  flow_binding_hash: string | null
}

function encryptionKey(): Buffer {
  return deriveOAuthEncryptionKey(config.oauthEncryptionKey)
}

function hashOpaqueValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function connectionFromRow(row: ConnectionRow): IdentityProviderConnection {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    directoryTenantId: row.directory_tenant_id,
    clientId: row.client_id,
    hasClientSecret: Boolean(row.client_secret_encrypted),
    allowMemberLogin: row.allow_member_login,
    allowedEmailDomains: row.allowed_email_domains || [],
    clientSecretExpiresAt: row.client_secret_expires_at?.toISOString() || null,
    validForLogin:
      row.status === 'connected' &&
      row.allow_member_login &&
      (!row.client_secret_expires_at || row.client_secret_expires_at.getTime() > Date.now()),
    status: row.status,
    grantedScopes: row.granted_scopes || [],
    connectedAt: row.connected_at?.toISOString() || null,
    disconnectedAt: row.disconnected_at?.toISOString() || null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  }
}

export function defaultMicrosoftCallbackUrl(fallbackOrigin = ''): string {
  const base = config.oauthCallbackBaseUrl.replace(/\/+$/, '')
  if (base) return `${base}/api/v1/identity-provider-callback/microsoft`
  const origin = fallbackOrigin.replace(/\/+$/, '')
  if (!origin) throw new Error('A public Microsoft OAuth callback URL is required')
  return `${origin}/control-api/api/v1/identity-provider-callback/microsoft`
}

async function getConnectionRow(
  connectionId: string,
  options: { connectedOnly?: boolean } = {}
): Promise<ConnectionRow | null> {
  const result = await pool.query(
    `SELECT id, provider, display_name, directory_tenant_id, client_id, oauth_callback_url,
            client_secret_encrypted, refresh_token_encrypted, granted_scopes, status,
            allow_member_login, allowed_email_domains, client_secret_expires_at,
            connected_at, disconnected_at, last_error, created_at
       FROM identity_provider_connections
      WHERE id = $1
        AND provider = 'microsoft'
        AND ($2::boolean = FALSE OR status = 'connected')
      LIMIT 1`,
    [connectionId.trim(), Boolean(options.connectedOnly)]
  )
  return (result.rows[0] as ConnectionRow | undefined) || null
}

export async function getIdentityProviderConnection(
  connectionId: string
): Promise<IdentityProviderConnection | null> {
  const row = await getConnectionRow(connectionId)
  return row ? connectionFromRow(row) : null
}

export async function listIdentityProviderConnections(fallbackOrigin = ''): Promise<{
  callbackUrl: string
  items: IdentityProviderConnection[]
}> {
  const result = await pool.query(
    `SELECT id, provider, display_name, directory_tenant_id, client_id, oauth_callback_url,
            client_secret_encrypted, refresh_token_encrypted, granted_scopes, status,
            allow_member_login, allowed_email_domains, client_secret_expires_at,
            connected_at, disconnected_at, last_error, created_at
       FROM identity_provider_connections
      ORDER BY CASE status
                 WHEN 'connected' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'error' THEN 2
                 ELSE 3
               END,
               display_name ASC`
  )
  return {
    callbackUrl: defaultMicrosoftCallbackUrl(fallbackOrigin),
    items: (result.rows as ConnectionRow[]).map(connectionFromRow),
  }
}

export async function listPublicIdentityProviders(): Promise<{
  items: Array<{ id: string; provider: 'microsoft'; displayName: string }>
}> {
  const result = await pool.query(
    `SELECT id, provider, display_name
       FROM identity_provider_connections
      WHERE status = 'connected'
        AND allow_member_login = TRUE
        AND (client_secret_expires_at IS NULL OR client_secret_expires_at > NOW())
      ORDER BY display_name ASC`
  )
  return {
    items: result.rows.map(row => ({
      id: String((row as { id: string }).id),
      provider: 'microsoft' as const,
      displayName: String((row as { display_name: string }).display_name),
    })),
  }
}

export async function createPendingMicrosoftConnection(input: {
  displayName: string
  tenantId: string
  clientId: string
  clientSecret: string
  adminUserId: string
  callbackUrl: string
  allowMemberLogin?: boolean
  clientSecretExpiresAt?: string | null
}): Promise<IdentityProviderConnection> {
  const displayName = input.displayName.trim()
  const tenantId = requireCanonicalGuid(input.tenantId, 'Microsoft tenant ID')
  const clientId = requireCanonicalGuid(input.clientId, 'Microsoft client ID')
  const clientSecret = input.clientSecret.trim()
  if (!displayName || !clientSecret) {
    throw identityProviderError(400, 'Microsoft connection fields are required')
  }
  const encryptedSecret = encryptOAuthSecret(encryptionKey(), clientSecret)
  const result = await pool.query(
    `INSERT INTO identity_provider_connections(
       provider, display_name, directory_tenant_id, client_id, oauth_callback_url,
       client_secret_encrypted, allow_member_login, client_secret_expires_at,
       status, connected_by_admin_id, disconnected_at, last_error
     )
     VALUES('microsoft', $1, $2, $3, $4, $5, $7, $8, 'pending', $6, NULL, NULL)
     ON CONFLICT (provider, directory_tenant_id, client_id)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   client_secret_encrypted = EXCLUDED.client_secret_encrypted,
                   allow_member_login = EXCLUDED.allow_member_login,
                   client_secret_expires_at = EXCLUDED.client_secret_expires_at,
                   oauth_callback_url = EXCLUDED.oauth_callback_url,
                   refresh_token_encrypted = NULL,
                   granted_scopes = ARRAY[]::TEXT[],
                   status = 'pending',
                   connected_by_admin_id = EXCLUDED.connected_by_admin_id,
                   connected_at = NULL,
                   disconnected_at = NULL,
                   last_error = NULL,
                   updated_at = NOW()
     RETURNING id, provider, display_name, directory_tenant_id, client_id, oauth_callback_url,
               client_secret_encrypted, refresh_token_encrypted, granted_scopes, status,
               allow_member_login, allowed_email_domains, client_secret_expires_at,
               connected_at, disconnected_at, last_error, created_at`,
    [
      displayName,
      tenantId,
      clientId,
      input.callbackUrl,
      encryptedSecret,
      input.adminUserId,
      input.allowMemberLogin !== false,
      input.clientSecretExpiresAt || null,
    ]
  )
  return connectionFromRow(result.rows[0] as ConnectionRow)
}

export async function disconnectIdentityProviderConnection(connectionId: string): Promise<boolean> {
  return withTransaction(async db => {
    const activeSetup = await db.query(
      `SELECT import_lock_token, import_lock_expires_at
         FROM identity_provider_setup_sessions
        WHERE connection_id = $1
          AND status IN ('draft', 'authorizing', 'configuring', 'importing')
        LIMIT 1
        FOR UPDATE`,
      [connectionId.trim()]
    )
    const setupLock = activeSetup.rows[0] as
      | { import_lock_token?: string | null; import_lock_expires_at?: Date | null }
      | undefined
    if (
      setupLock?.import_lock_token &&
      setupLock.import_lock_expires_at &&
      setupLock.import_lock_expires_at.getTime() >= Date.now()
    ) {
      throw identityProviderError(409, 'Microsoft import is currently running')
    }
    const result = await db.query(
      `UPDATE identity_provider_connections
          SET status = 'disconnected',
              client_secret_encrypted = '',
              refresh_token_encrypted = NULL,
              granted_scopes = ARRAY[]::TEXT[],
              disconnected_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND status IN ('connected', 'pending', 'error')
        RETURNING id`,
      [connectionId.trim()]
    )
    if ((result.rowCount ?? 0) > 0) {
      await db.query(
        `UPDATE identity_provider_setup_sessions
            SET status = 'cancelled', updated_at = NOW()
          WHERE connection_id = $1
            AND status IN ('draft', 'authorizing', 'configuring', 'importing')`,
        [connectionId.trim()]
      )
    }
    return (result.rowCount ?? 0) > 0
  })
}

export async function updateMicrosoftIdentityProviderConnection(input: {
  connectionId: string
  displayName: string
  tenantId: string
  clientId: string
  clientSecret?: string
  allowMemberLogin: boolean
  clientSecretExpiresAt?: string | null
}): Promise<{ connection: IdentityProviderConnection; requiresAuthorization: boolean } | null> {
  const current = await getConnectionRow(input.connectionId)
  if (!current) return null
  const displayName = input.displayName.trim()
  const tenantId = requireCanonicalGuid(input.tenantId, 'Microsoft tenant ID')
  const clientId = requireCanonicalGuid(input.clientId, 'Microsoft client ID')
  const clientSecret = String(input.clientSecret || '').trim()
  if (!displayName) throw identityProviderError(400, 'Microsoft connection name is required')
  const requiresAuthorization =
    tenantId !== current.directory_tenant_id ||
    clientId !== current.client_id ||
    Boolean(clientSecret)
  const result = await pool.query(
    `UPDATE identity_provider_connections
        SET display_name = $2,
            directory_tenant_id = $3,
            client_id = $4,
            client_secret_encrypted = CASE WHEN $5 = '' THEN client_secret_encrypted ELSE $6 END,
            allow_member_login = $7,
            client_secret_expires_at = $8,
            status = CASE WHEN $9 THEN 'pending' ELSE status END,
            refresh_token_encrypted = CASE WHEN $9 THEN NULL ELSE refresh_token_encrypted END,
            granted_scopes = CASE WHEN $9 THEN ARRAY[]::TEXT[] ELSE granted_scopes END,
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1
    RETURNING id, provider, display_name, directory_tenant_id, client_id, oauth_callback_url,
              client_secret_encrypted, refresh_token_encrypted, granted_scopes, status,
              allow_member_login, allowed_email_domains, client_secret_expires_at,
              connected_at, disconnected_at, last_error, created_at`,
    [
      input.connectionId,
      displayName,
      tenantId,
      clientId,
      clientSecret,
      clientSecret ? encryptOAuthSecret(encryptionKey(), clientSecret) : '',
      input.allowMemberLogin,
      input.clientSecretExpiresAt || null,
      requiresAuthorization,
    ]
  )
  const row = result.rows[0] as ConnectionRow | undefined
  return row ? { connection: connectionFromRow(row), requiresAuthorization } : null
}

export async function startMicrosoftOAuth(input: {
  connectionId: string
  flow: IdentityProviderLoginFlow
  returnUrl: string
  invitationToken?: string
  flowBinding?: string
}): Promise<{ authorizeUrl: string }> {
  const connection = await getConnectionRow(input.connectionId, {
    connectedOnly: input.flow !== 'admin_connect',
  })
  if (!connection) throw Object.assign(new Error('Microsoft connection not found'), { status: 404 })
  if (input.flow === 'admin_connect' && connection.status !== 'pending') {
    throw Object.assign(new Error('Microsoft connection is not pending'), { status: 409 })
  }
  if (
    input.flow !== 'admin_connect' &&
    (!connection.allow_member_login ||
      (connection.client_secret_expires_at &&
        connection.client_secret_expires_at.getTime() <= Date.now()))
  ) {
    throw Object.assign(new Error('Microsoft sign-in is not enabled for this organization'), {
      status: 403,
    })
  }

  let invitationId: string | null = null
  if (input.flow === 'invitation_link') {
    let validation: { email: string; invitationUuid: string }
    try {
      validation = await validateInvitationFlowToken(String(input.invitationToken || '').trim())
    } catch {
      throw Object.assign(new Error('Microsoft invitation is not ready to connect'), {
        status: 409,
      })
    }
    const invitation = await pool.query(
      `SELECT id
         FROM invitations
        WHERE token = $1
          AND identity_provider_connection_id = $2
          AND identity_provider = 'microsoft'
          AND status = 'accepted'
          AND LOWER(email) = LOWER($3)
        LIMIT 1`,
      [validation.invitationUuid, connection.id, validation.email]
    )
    invitationId = String((invitation.rows[0] as { id?: string } | undefined)?.id || '') || null
    if (!invitationId) {
      throw Object.assign(new Error('Microsoft invitation is not ready to connect'), {
        status: 409,
      })
    }
  }

  const returnUrl = validateIdentityProviderReturnUrl(input.flow, input.returnUrl)
  const flowBinding = requireFlowBinding(input.flow, String(input.flowBinding || ''))
  const state = randomBytes(32).toString('base64url')
  const verifier = createPkceVerifier()
  await pool.query(
    `INSERT INTO identity_provider_oauth_states(
       state_hash, connection_id, flow, invitation_id, return_url,
       code_verifier_encrypted, flow_binding_hash, expires_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::text || ' minutes')::interval)`,
    [
      hashOpaqueValue(state),
      connection.id,
      input.flow,
      invitationId,
      returnUrl,
      encryptOAuthSecret(encryptionKey(), verifier),
      flowBinding ? hashOpaqueValue(flowBinding) : null,
      String(OAUTH_STATE_TTL_MINUTES),
    ]
  )
  return {
    authorizeUrl: buildMicrosoftAuthorizeUrl({
      tenantId: connection.directory_tenant_id,
      clientId: connection.client_id,
      redirectUri: connection.oauth_callback_url,
      state,
      codeChallenge: createPkceChallenge(verifier),
      prompt: input.flow === 'admin_connect' ? 'consent' : 'select_account',
    }),
  }
}

async function consumeOAuthState(state: string): Promise<OAuthStateRow | null> {
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE identity_provider_oauth_states
          SET consumed_at = NOW()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
      RETURNING connection_id, flow, invitation_id, return_url, code_verifier_encrypted,
                flow_binding_hash`,
      [hashOpaqueValue(state)]
    )
    return (result.rows[0] as OAuthStateRow | undefined) || null
  })
}

async function issueLoginCode(sessionToken: string, flowBindingHash: string): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await pool.query(
    `INSERT INTO identity_provider_login_codes(
       code_hash, session_token_encrypted, flow_binding_hash, expires_at
     )
     VALUES($1, $2, $3, NOW() + ($4::text || ' minutes')::interval)`,
    [
      hashOpaqueValue(code),
      encryptOAuthSecret(encryptionKey(), sessionToken),
      flowBindingHash,
      String(LOGIN_CODE_TTL_MINUTES),
    ]
  )
  return code
}

function appendCallbackResult(returnUrl: string, values: Record<string, string>): string {
  const url = new URL(returnUrl)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.toString()
}

export async function completeMicrosoftOAuthCallback(input: {
  code: string
  state: string
}): Promise<{ redirectUrl: string }> {
  const oauthState = await consumeOAuthState(input.state)
  if (!oauthState) throw Object.assign(new Error('Invalid or expired OAuth state'), { status: 400 })
  const connection = await getConnectionRow(oauthState.connection_id)
  if (!connection) throw Object.assign(new Error('Microsoft connection not found'), { status: 404 })

  try {
    const tokens = await exchangeMicrosoftAuthorizationCode({
      tenantId: connection.directory_tenant_id,
      clientId: connection.client_id,
      clientSecret: decryptOAuthSecret(encryptionKey(), connection.client_secret_encrypted),
      redirectUri: connection.oauth_callback_url,
      code: input.code,
      codeVerifier: decryptOAuthSecret(encryptionKey(), oauthState.code_verifier_encrypted),
    })
    const microsoftUser = await getMicrosoftCurrentUser(tokens.accessToken)

    if (oauthState.flow === 'admin_connect') {
      if (!tokens.refreshToken) throw new Error('Microsoft did not return an offline refresh token')
      await pool.query(
        `UPDATE identity_provider_connections
            SET status = 'connected',
                refresh_token_encrypted = $2,
                granted_scopes = $3::text[],
                connected_external_subject = $4,
                connected_external_email = $5,
                connected_at = NOW(),
                disconnected_at = NULL,
                last_error = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [
          connection.id,
          encryptOAuthSecret(encryptionKey(), tokens.refreshToken),
          tokens.scope,
          microsoftUser.id,
          (microsoftUser.mail || microsoftUser.userPrincipalName).trim().toLowerCase(),
        ]
      )
      await markIdentityProviderSetupAuthorized(connection.id)
      return {
        redirectUrl: appendCallbackResult(oauthState.return_url, {
          connectionId: connection.id,
          connected: '1',
        }),
      }
    }

    const login = await identityProviderLoginData({
      provider: 'microsoft',
      connectionId: connection.id,
      externalSubject: microsoftUser.id,
      email: microsoftUser.mail || microsoftUser.userPrincipalName,
      userPrincipalName: microsoftUser.userPrincipalName,
      displayName: microsoftUser.displayName,
      invitationId: oauthState.invitation_id,
    })
    if (!login) throw Object.assign(new Error('Microsoft identity is not invited'), { status: 403 })
    const sessionToken = signExternalSessionToken({
      userId: login.user.id,
      email: login.user.email,
      teamId: login.membership.team_id || null,
      role: login.membership.role,
    })
    if (!oauthState.flow_binding_hash) {
      throw identityProviderError(400, 'OAuth login flow binding is missing')
    }
    const loginCode = await issueLoginCode(sessionToken, oauthState.flow_binding_hash)
    return {
      redirectUrl: appendCallbackResult(oauthState.return_url, {
        provider: 'microsoft',
        code: loginCode,
      }),
    }
  } catch (error) {
    if (oauthState.flow === 'admin_connect') {
      await pool.query(
        `UPDATE identity_provider_connections
            SET status = 'error', last_error = $2, updated_at = NOW()
          WHERE id = $1`,
        [connection.id, error instanceof Error ? error.message.slice(0, 1000) : 'OAuth failed']
      )
    }
    const status = Number((error as { status?: unknown } | null)?.status || 0)
    return {
      redirectUrl: appendCallbackResult(oauthState.return_url, {
        error:
          status === 403
            ? 'unauthorized_microsoft_account'
            : oauthState.flow === 'admin_connect'
              ? 'microsoft_authorization_failed'
              : 'microsoft_sign_in_failed',
        errorMessage: identityProviderCallbackErrorMessage(
          status === 403 ? 'unauthorized_microsoft_account' : 'microsoft_sign_in_failed'
        ),
      }),
    }
  }
}

export async function completeMicrosoftOAuthErrorCallback(input: {
  state: string
}): Promise<{ redirectUrl: string }> {
  const oauthState = await consumeOAuthState(input.state)
  if (!oauthState) throw Object.assign(new Error('Invalid or expired OAuth state'), { status: 400 })
  if (oauthState.flow === 'admin_connect') {
    await pool.query(
      `UPDATE identity_provider_connections
          SET status = 'error',
              last_error = 'Microsoft authorization was cancelled or denied',
              updated_at = NOW()
        WHERE id = $1`,
      [oauthState.connection_id]
    )
  }
  return {
    redirectUrl: appendCallbackResult(oauthState.return_url, {
      error:
        oauthState.flow === 'admin_connect'
          ? 'microsoft_authorization_failed'
          : 'microsoft_sign_in_failed',
      errorMessage: identityProviderCallbackErrorMessage('microsoft_sign_in_failed'),
    }),
  }
}

export async function exchangeIdentityProviderLoginCode(
  code: string,
  flowBinding: string
): Promise<string | null> {
  const binding = requireFlowBinding('profile_login', flowBinding)
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE identity_provider_login_codes
          SET consumed_at = NOW()
        WHERE code_hash = $1
          AND flow_binding_hash = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
      RETURNING session_token_encrypted`,
      [hashOpaqueValue(code.trim()), hashOpaqueValue(binding || '')]
    )
    const encrypted = String(
      (result.rows[0] as { session_token_encrypted?: string } | undefined)
        ?.session_token_encrypted || ''
    )
    return encrypted ? decryptOAuthSecret(encryptionKey(), encrypted) : null
  })
}

async function refreshConnectionAccessToken(connection: ConnectionRow): Promise<string> {
  if (!connection.refresh_token_encrypted) throw new Error('Microsoft connection needs consent')
  const tokens = await refreshMicrosoftAccessToken({
    tenantId: connection.directory_tenant_id,
    clientId: connection.client_id,
    clientSecret: decryptOAuthSecret(encryptionKey(), connection.client_secret_encrypted),
    refreshToken: decryptOAuthSecret(encryptionKey(), connection.refresh_token_encrypted),
  })
  if (tokens.refreshToken) {
    await pool.query(
      `UPDATE identity_provider_connections
          SET refresh_token_encrypted = $2, granted_scopes = $3::text[], updated_at = NOW()
        WHERE id = $1`,
      [connection.id, encryptOAuthSecret(encryptionKey(), tokens.refreshToken), tokens.scope]
    )
  }
  return tokens.accessToken
}

export async function loadMicrosoftDirectory(connectionId: string): Promise<{
  users: MicrosoftDirectoryUser[]
  teams: MicrosoftDirectoryTeam[]
}> {
  const connection = await getConnectionRow(connectionId, { connectedOnly: true })
  if (!connection) throw Object.assign(new Error('Microsoft connection not found'), { status: 404 })
  const accessToken = await refreshConnectionAccessToken(connection)
  const [users, microsoftTeams, identities, pending, mappings, existingMembers] = await Promise.all(
    [
      listMicrosoftUsers(accessToken),
      listMicrosoftTeams(accessToken),
      pool.query(
        `SELECT external_subject FROM identity_provider_identities WHERE connection_id = $1`,
        [connection.id]
      ),
      pool.query(
        `SELECT identity_provider_subject
         FROM invitations
        WHERE identity_provider_connection_id = $1 AND status IN ('draft', 'pending', 'accepted')`,
        [connection.id]
      ),
      pool.query(
        `SELECT m.external_team_id, m.team_id, t.name AS team_name
         FROM identity_provider_team_mappings m
         JOIN teams t ON t.id = m.team_id
        WHERE m.connection_id = $1`,
        [connection.id]
      ),
      pool.query(`SELECT id, email, name FROM users`),
    ]
  )
  const membershipsByUser = new Map<string, string[]>()
  for (const team of microsoftTeams) {
    for (const userId of await listMicrosoftTeamMemberIds(accessToken, team.id)) {
      membershipsByUser.set(userId, [...(membershipsByUser.get(userId) || []), team.id])
    }
  }
  const importedSubjects = new Set(
    identities.rows.map(row => String((row as { external_subject: string }).external_subject))
  )
  const pendingSubjects = new Set(
    pending.rows.map(row =>
      String((row as { identity_provider_subject: string }).identity_provider_subject)
    )
  )
  const mappedTeams = new Map(
    mappings.rows.map(row => [
      String((row as { external_team_id: string }).external_team_id),
      {
        id: String((row as { team_id: string }).team_id),
        name: String((row as { team_name: string }).team_name),
      },
    ])
  )
  const existingMembersByEmail = new Map(
    existingMembers.rows.map(row => [
      String((row as { email: string }).email)
        .trim()
        .toLowerCase(),
      {
        id: String((row as { id: string }).id),
        name: String((row as { name?: string | null }).name || ''),
      },
    ])
  )
  return {
    users: users.map(user => {
      const email = (user.mail || user.userPrincipalName).trim().toLowerCase()
      const existingMember = existingMembersByEmail.get(email)
      return {
        id: user.id,
        displayName: user.displayName,
        email,
        userPrincipalName: user.userPrincipalName,
        accountEnabled: user.accountEnabled,
        imported: importedSubjects.has(user.id),
        invitationPending: pendingSubjects.has(user.id) && !importedSubjects.has(user.id),
        microsoftTeamIds: membershipsByUser.get(user.id) || [],
        existingMemberId: existingMember?.id || null,
        existingMemberName: existingMember?.name || null,
      }
    }),
    teams: microsoftTeams.map(team => ({
      id: team.id,
      displayName: team.displayName,
      description: team.description,
      importedTeamId: mappedTeams.get(team.id)?.id || null,
      importedTeamName: mappedTeams.get(team.id)?.name || null,
    })),
  }
}
