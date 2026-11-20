import { createHash, createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'

const ENV = {
  registrationId: 'CONTROL_API_OIDC_REGISTRATION_ID',
  displayLabel: 'CONTROL_API_OIDC_DISPLAY_LABEL',
  issuer: 'CONTROL_API_OIDC_ISSUER',
  clientId: 'CONTROL_API_OIDC_CLIENT_ID',
  clientSecret: 'CONTROL_API_OIDC_CLIENT_SECRET',
  clientAuthMethod: 'CONTROL_API_OIDC_CLIENT_AUTH_METHOD',
  redirectUri: 'CONTROL_API_OIDC_REDIRECT_URI',
  responseMode: 'CONTROL_API_OIDC_RESPONSE_MODE',
  trustGeneration: 'CONTROL_API_OIDC_TRUST_GENERATION',
} as const

const OIDC_ENV_NAMES = new Set<string>(Object.values(ENV))

/**
 * Optional member sign-in settings, outside the all-or-none registration set.
 * They are parsed only when the registration is configured. The switch and the
 * release guard are not part of the configuration generation: toggling them
 * does not invalidate attempts already in flight.
 */
const OPTIONAL_ENV = {
  memberSignIn: 'CONTROL_API_OIDC_MEMBER_SIGN_IN',
  unreleased: 'CONTROL_API_OIDC_UNRELEASED',
  tenantId: 'CONTROL_API_OIDC_TENANT_ID',
  requiredRole: 'CONTROL_API_OIDC_REQUIRED_ROLE',
  allowGuests: 'CONTROL_API_OIDC_ALLOW_GUESTS',
  newMemberTeamId: 'CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID',
  accountCreation: 'CONTROL_API_OIDC_ACCOUNT_CREATION',
  allowedEmailDomains: 'CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS',
} as const

const OIDC_OPTIONAL_ENV_NAMES = new Set<string>(Object.values(OPTIONAL_ENV))

const ENTRA_ISSUER_HOSTS: ReadonlySet<string> = new Set([
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
])

/** Authorities that accept accounts from outside one tenant, plus the Microsoft consumer tenant. */
const ENTRA_MULTI_TENANT_AUTHORITIES: ReadonlySet<string> = new Set([
  'common',
  'organizations',
  'consumers',
  '9188040d-6c67-4c5b-b112-36a304b66dad',
])

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export type OidcAccountCreation = 'entra' | 'allowed_domains' | 'disabled'

export type OidcMemberSignInPolicy = Readonly<{
  /** Set only for Entra issuers. */
  entraTenantId: string | null
  requiredRole: string | null
  allowGuests: boolean
  /** UUID string. */
  newMemberTeamId: string | null
  accountCreation: OidcAccountCreation
  /** Lowercased, without a leading '@'. */
  allowedEmailDomains: readonly string[]
}>

/** True only for the Microsoft Entra ID sovereign-cloud login hosts; CIAM and B2C hosts are not Entra. */
export function isEntraIssuerHost(host: string): boolean {
  return ENTRA_ISSUER_HOSTS.has(host.toLowerCase())
}

const OidcPublicConfigurationSchema = z
  .object({
    [ENV.registrationId]: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
    [ENV.displayLabel]: z.string().min(1).max(80),
    [ENV.issuer]: z.string().min(1).max(2048),
    [ENV.clientId]: z.string().min(1).max(512),
    [ENV.clientAuthMethod]: z.enum(['client_secret_basic', 'client_secret_post']),
    [ENV.redirectUri]: z.string().min(1).max(2048),
    [ENV.responseMode]: z.literal('query'),
    [ENV.trustGeneration]: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  })
  .strict()

export type OidcClientAuthenticationMethod = 'client_secret_basic' | 'client_secret_post'

/**
 * Secret-free OIDC deployment configuration. The credential is resolved only
 * by the protocol owner from `clientSecretRef`; it is never retained here.
 */
export type OidcProviderConfiguration = Readonly<{
  registrationId: string
  displayLabel: string
  issuer: string
  clientId: string
  clientSecretRef: typeof ENV.clientSecret
  clientAuthenticationMethod: OidcClientAuthenticationMethod
  redirectUri: string
  responseType: 'code'
  responseMode: 'query'
  scopes: readonly ['openid', 'profile', 'email']
  trustGeneration: string
  configurationGeneration: string
  /** Eligibility settings that are part of the configuration generation, whether or not the switch is on. */
  memberEligibility: OidcMemberSignInPolicy
  /** The policy when member sign-in is switched on; null when the switch is off. */
  memberSignIn: OidcMemberSignInPolicy | null
  memberAuthenticationActivated: boolean
}>

function invalid(field: string, detail: string): never {
  throw new Error(`${field} ${detail}`)
}

function validatePublicHttpsUrl(raw: string, field: string, requirePath: boolean): URL {
  if (raw !== raw.trim() || /[\u0000-\u0020\u007f]/.test(raw)) {
    return invalid(field, 'must not contain whitespace or control characters')
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return invalid(field, 'must be an absolute URL')
  }

  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    isIP(host) !== 0 ||
    !host.includes('.') ||
    host === 'metadata.goog' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.svc') ||
    host.endsWith('.svc.cluster.local') ||
    host.endsWith('.cluster.local') ||
    !host.split('.').every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return invalid(
      field,
      'must use a public HTTPS DNS name without credentials, query, or fragment'
    )
  }

  if (requirePath && (url.pathname === '' || url.pathname === '/')) {
    return invalid(field, 'must identify the registered callback path')
  }
  return url
}

function safeDisplayLabel(value: string): boolean {
  return value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
}

function computeConfigurationGeneration(
  fields: {
    registrationId: string
    displayLabel: string
    issuer: string
    clientId: string
    clientAuthenticationMethod: OidcClientAuthenticationMethod
    redirectUri: string
    responseMode: 'query'
    trustGeneration: string
    memberEligibility: OidcMemberSignInPolicy
  },
  clientSecret: string,
  generationKey: Buffer
): string {
  const eligibility = fields.memberEligibility
  // A registration with no eligibility settings keeps its pre-policy generation.
  const eligibilityPart =
    eligibility.entraTenantId === null &&
    eligibility.requiredRole === null &&
    !eligibility.allowGuests &&
    eligibility.accountCreation === 'disabled' &&
    eligibility.allowedEmailDomains.length === 0
      ? []
      : [
          [
            eligibility.entraTenantId,
            eligibility.requiredRole,
            eligibility.allowGuests,
            eligibility.accountCreation,
            eligibility.allowedEmailDomains,
          ],
        ]
  const generationPayload = JSON.stringify([
    'oidc-registration-v1',
    fields.registrationId,
    fields.displayLabel,
    fields.issuer,
    fields.clientId,
    fields.clientAuthenticationMethod,
    fields.redirectUri,
    fields.responseMode,
    fields.trustGeneration,
    createHmac('sha256', generationKey).update(clientSecret).digest('base64url'),
    ...eligibilityPart,
  ])
  return `v1:${createHash('sha256').update(generationPayload).digest('hex')}`
}

function parseMemberEligibility(
  environment: NodeJS.ProcessEnv,
  issuerUrl: URL
): OidcMemberSignInPolicy {
  const bad = new Set<string>()
  const tenantRaw = environment[OPTIONAL_ENV.tenantId]
  const roleRaw = environment[OPTIONAL_ENV.requiredRole]
  const guestsRaw = environment[OPTIONAL_ENV.allowGuests]
  const teamRaw = environment[OPTIONAL_ENV.newMemberTeamId]
  const creationRaw = environment[OPTIONAL_ENV.accountCreation]
  const domainsRaw = environment[OPTIONAL_ENV.allowedEmailDomains]
  const entraIssuer = isEntraIssuerHost(issuerUrl.hostname)

  let tenantId: string | null = null
  if (tenantRaw !== undefined) {
    if (
      GUID_PATTERN.test(tenantRaw) &&
      !ENTRA_MULTI_TENANT_AUTHORITIES.has(tenantRaw.toLowerCase())
    ) {
      tenantId = tenantRaw.toLowerCase()
    } else {
      bad.add(OPTIONAL_ENV.tenantId)
    }
  }
  if (entraIssuer) {
    if (tenantRaw === undefined) bad.add(OPTIONAL_ENV.tenantId)
    const [authority, version, ...rest] = issuerUrl.pathname.split('/').filter(Boolean)
    if (
      rest.length > 0 ||
      version !== 'v2.0' ||
      authority === undefined ||
      ENTRA_MULTI_TENANT_AUTHORITIES.has(authority.toLowerCase()) ||
      (tenantId !== null && authority !== tenantId) ||
      issuerUrl.pathname.endsWith('/')
    ) {
      bad.add(ENV.issuer)
    }
  }

  let requiredRole: string | null = null
  if (roleRaw !== undefined) {
    if (roleRaw.length >= 1 && roleRaw.length <= 256 && !/[\u0000-\u0020\u007f]/.test(roleRaw)) {
      requiredRole = roleRaw
    } else {
      bad.add(OPTIONAL_ENV.requiredRole)
    }
  }

  let allowGuests = false
  if (guestsRaw !== undefined) {
    if (guestsRaw === 'true') {
      allowGuests = true
      if (tenantRaw === undefined || roleRaw === undefined) bad.add(OPTIONAL_ENV.allowGuests)
    } else {
      bad.add(OPTIONAL_ENV.allowGuests)
    }
  }

  let newMemberTeamId: string | null = null
  if (teamRaw !== undefined) {
    if (GUID_PATTERN.test(teamRaw)) newMemberTeamId = teamRaw.toLowerCase()
    else bad.add(OPTIONAL_ENV.newMemberTeamId)
  }

  let allowedEmailDomains: string[] = []
  if (domainsRaw !== undefined) {
    allowedEmailDomains = domainsRaw.split(',').map(entry => entry.trim().toLowerCase())
    const valid = allowedEmailDomains.every(
      domain =>
        domain.length <= 253 &&
        domain.includes('.') &&
        domain.split('.').every(label => DOMAIN_LABEL_PATTERN.test(label))
    )
    if (!valid) {
      allowedEmailDomains = []
      bad.add(OPTIONAL_ENV.allowedEmailDomains)
    }
  }

  if (creationRaw !== undefined && creationRaw !== 'enabled') bad.add(OPTIONAL_ENV.accountCreation)
  if (creationRaw !== undefined && entraIssuer) bad.add(OPTIONAL_ENV.accountCreation)
  if (creationRaw === 'enabled' && allowedEmailDomains.length === 0) {
    bad.add(OPTIONAL_ENV.accountCreation)
  }

  if (bad.size > 0) {
    throw new Error(`Invalid OIDC provider configuration field(s): ${[...bad].sort().join(', ')}`)
  }

  const accountCreation: OidcAccountCreation = entraIssuer
    ? 'entra'
    : creationRaw === 'enabled'
      ? 'allowed_domains'
      : 'disabled'
  return Object.freeze({
    entraTenantId: entraIssuer ? tenantId : null,
    requiredRole,
    allowGuests,
    newMemberTeamId,
    accountCreation,
    allowedEmailDomains: Object.freeze(allowedEmailDomains),
  })
}

/**
 * Loads the one optional operator-managed OIDC registration. No OIDC-prefixed
 * setting silently opts into a default; a partial or unknown configuration is
 * rejected. The credential is used only to derive a keyed generation digest.
 */
export function loadOidcProviderConfiguration(
  environment: NodeJS.ProcessEnv,
  generationKey: string
): OidcProviderConfiguration | undefined {
  const unknownNames = Object.keys(environment).filter(
    key =>
      key.startsWith('CONTROL_API_OIDC_') &&
      !OIDC_ENV_NAMES.has(key) &&
      !OIDC_OPTIONAL_ENV_NAMES.has(key)
  )
  if (unknownNames.length > 0) {
    throw new Error(`Unsupported OIDC configuration field: ${unknownNames.sort().join(', ')}`)
  }

  const configuredNames = [...OIDC_ENV_NAMES].filter(name => environment[name] !== undefined)
  if (configuredNames.length === 0) return undefined

  const missingNames = [...OIDC_ENV_NAMES].filter(name => !environment[name]?.trim())
  if (missingNames.length > 0) {
    throw new Error(
      `Incomplete OIDC provider configuration; required fields missing: ${missingNames.sort().join(', ')}`
    )
  }

  const clientSecret = environment[ENV.clientSecret]!
  if (!clientSecret.trim()) return invalid(ENV.clientSecret, 'must not be empty')

  const parsed = OidcPublicConfigurationSchema.safeParse({
    [ENV.registrationId]: environment[ENV.registrationId],
    [ENV.displayLabel]: environment[ENV.displayLabel],
    [ENV.issuer]: environment[ENV.issuer],
    [ENV.clientId]: environment[ENV.clientId],
    [ENV.clientAuthMethod]: environment[ENV.clientAuthMethod],
    [ENV.redirectUri]: environment[ENV.redirectUri],
    [ENV.responseMode]: environment[ENV.responseMode],
    [ENV.trustGeneration]: environment[ENV.trustGeneration],
  })
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? 'configuration'))),
    ]
    throw new Error(`Invalid OIDC provider configuration field(s): ${fields.sort().join(', ')}`)
  }

  const input = parsed.data
  if (!safeDisplayLabel(input[ENV.displayLabel])) {
    return invalid(ENV.displayLabel, 'must be printable and have no leading or trailing whitespace')
  }
  const issuerUrl = validatePublicHttpsUrl(input[ENV.issuer], ENV.issuer, false)
  validatePublicHttpsUrl(input[ENV.redirectUri], ENV.redirectUri, true)
  if (
    input[ENV.clientId] !== input[ENV.clientId].trim() ||
    /[\u0000-\u0020\u007f]/.test(input[ENV.clientId])
  ) {
    return invalid(
      ENV.clientId,
      'must be non-empty and contain no whitespace or control characters'
    )
  }

  const switchRaw = environment[OPTIONAL_ENV.memberSignIn]
  const guardRaw = environment[OPTIONAL_ENV.unreleased]
  if (switchRaw !== undefined && switchRaw !== 'enabled') {
    throw new Error(`Invalid OIDC provider configuration field(s): ${OPTIONAL_ENV.memberSignIn}`)
  }
  if (
    (guardRaw !== undefined && guardRaw !== 'acknowledged') ||
    (switchRaw === 'enabled' && guardRaw === undefined)
  ) {
    throw new Error(`Invalid OIDC provider configuration field(s): ${OPTIONAL_ENV.unreleased}`)
  }
  const memberEligibility = parseMemberEligibility(environment, issuerUrl)

  const generationKeyBytes = deriveOAuthEncryptionKey(generationKey)

  const configurationGeneration = computeConfigurationGeneration(
    {
      registrationId: input[ENV.registrationId],
      displayLabel: input[ENV.displayLabel],
      issuer: input[ENV.issuer],
      clientId: input[ENV.clientId],
      clientAuthenticationMethod: input[ENV.clientAuthMethod],
      redirectUri: input[ENV.redirectUri],
      responseMode: input[ENV.responseMode],
      trustGeneration: input[ENV.trustGeneration],
      memberEligibility,
    },
    clientSecret,
    generationKeyBytes
  )

  return Object.freeze({
    registrationId: input[ENV.registrationId],
    displayLabel: input[ENV.displayLabel],
    issuer: input[ENV.issuer],
    clientId: input[ENV.clientId],
    clientSecretRef: ENV.clientSecret,
    clientAuthenticationMethod: input[ENV.clientAuthMethod],
    redirectUri: input[ENV.redirectUri],
    responseType: 'code',
    responseMode: input[ENV.responseMode],
    scopes: Object.freeze(['openid', 'profile', 'email']) as readonly [
      'openid',
      'profile',
      'email',
    ],
    trustGeneration: input[ENV.trustGeneration],
    configurationGeneration,
    memberEligibility,
    memberSignIn: switchRaw === 'enabled' ? memberEligibility : null,
    memberAuthenticationActivated: switchRaw === 'enabled',
  })
}

export function readOidcClientSecret(
  provider: OidcProviderConfiguration,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const secret = environment[provider.clientSecretRef]
  if (!secret?.trim()) throw new Error('OIDC client credential is unavailable')
  return secret
}

export function currentOidcConfigurationGeneration(
  provider: OidcProviderConfiguration,
  clientSecret: string,
  generationKey: string
): string {
  return computeConfigurationGeneration(
    provider,
    clientSecret,
    deriveOAuthEncryptionKey(generationKey)
  )
}
