import { createPublicKey } from 'node:crypto'
import { DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES } from '@clerum/image-policy'

type Config = {
  port: number
  jsonBodyLimit: string
  namespace: string
  hostsNamespace: string
  contextsNamespace: string
  communicationChannelsNamespace: string
  mcpServersNamespace: string
  sandboxNamespace: string
  sandboxUiNamespace: string
  secretsNamespace: string
  pgConnectionString: string
  internalTokens: string[]
  internalServiceTokens: Record<string, string>
  internalControlJwtWrcHmacSecret: string
  internalControlJwtHccHmacSecret: string
  allowedIssuanceNamespaces: string[]
  memberRegistrationMode: 'remote' | 'hosted'
  memberRegistrationExternalHubBaseUrl: string
  memberRegistrationServiceBaseUrl: string
  memberRegistrationServiceHmacSecret: string
  memberRegistrationServiceHmacKid: string
  memberRegistrationTenantId: string
  desktopExternalRestApiBaseUrl: string
  desktopRpcProxyBaseUrl: string
  desktopProfileUiBaseUrl: string
  desktopAppName: string
  controlUiBaseUrl: string
  controlUiAppName: string
  sessionJwtPrivateKey: string
  jwtIssuer: string
  jwtAudience: string
  rpcJwtPrivateKey: string
  rpcJwtPublicKey: string
  rpcJwtIssuer: string
  rpcJwtAudience: string
  rpcTokenTtlSeconds: number
  hostSecretLabelKey: string
  hostSecretLabelValue: string
  policyAuthAudience: string
  googleClientId: string
  adminJwtPrivateKey: string
  adminJwtIssuer: string
  adminJwtAudience: string
  adminJwtTtlSeconds: number
  /**
   * Optional RS256 private key used exclusively to sign registry identity
   * vouchers (POST /api/v1/registry/identity-voucher). When unset, falls back
   * to adminJwtPrivateKey.
   *
   * Rationale: a captured admin session JWT (aud=control-ui, 1h TTL) signed by
   * the SAME key as a voucher (aud=registry-api, 60s TTL) becomes a usable
   * voucher if the registry ever loosens its `aud` check. Provisioning a
   * separate keypair eliminates that confused-deputy class. The registry must
   * be configured with the matching CONTROL_API_PUBLIC_KEY.
   */
  registryVoucherPrivateKey: string
  // The registry-assigned key_id (uuid) used as the voucher `kid` header in
  // MANAGED mode (spec §14.2). Delivered by MCC in the registry-voucher Secret
  // as CONTROL_API_REGISTRY_VOUCHER_KID. Self-hosted reads kid from the DB row.
  registryVoucherKid: string
  // Registry consumer config — added in Path A.
  // CLERUM_REGISTRY_URL: where to find the registry. Required; validated
  // against an allowlist at startup (see validateConfig).
  registryUrl: string
  // OAuth2 client_credentials. Required only when registryAuthEnabled=true.
  registryClientId: string
  registryClientSecret: string
  // Toggle. False = no Bearer header, no startup credential check (minikube).
  registryAuthEnabled: boolean
  // Explicit credential + kid source discriminator (spec §14.3 / S10). NEVER
  // absence-based: managed = env/Secret, self-hosted = the registry_connection
  // DB row. Required when registryAuthEnabled; logged at boot.
  registryConnectionMode: 'managed' | 'self-hosted'
  // Publisher UI surface (Sidebar entry + /publisher route) toggle, surfaced
  // to control-ui on the publish-scope response. Static config value — not
  // part of resolvePublishScope()'s cached registry-derived fields. Default
  // OFF for self-hosted deploys, ON for managed; CONTROL_API_PUBLISHER_UI_ENABLED
  // overrides the default either way.
  publisherUiEnabled: boolean
  adminAuthMaxFailures: number
  adminAuthLockMinutes: number
  adminBootstrapUsername: string
  adminBootstrapEmail: string
  adminBootstrapPasswordHash: string
  adminDefaultAgentNames: string[]
  adminDefaultContextIds: string[]
  mcpHostJwtAccessTtlSec: number
  mcpHostJwtRefreshTtlSec: number
  mcpHostJwtControlTtlSec: number
  mcpHostJwtMaxHostRefs: number
  mcpHostJwtMaxHostRefLength: number
  oauthBrokerJwtTtlSec: number
  userApprovalRequestDefaultTtlSec: number
  userApprovalRequestMaxTtlSec: number
  userApprovalRequestExpiryIntervalMs: number
  usageRollup5MinIntervalMs: number
  usageRollupHourlyIntervalMs: number
  usageRollupDailyIntervalMs: number
  usageRetentionIntervalMs: number
  budgetReservationSweepIntervalMs: number
  budgetReservationTtlSeconds: number
  approvalRetentionDays: number
  userApprovalRequestArchiveCronEnabled: boolean
  userApprovalRequestArchiveBatchSize: number
  // Archive cron: workflow_runs -> workflow_runs_audit. The grace window holds
  // terminal runs in the live table so admin UI stays fast without unioning archived rows.
  workflowRunsArchiveCronEnabled: boolean
  workflowRunsArchiveIntervalMs: number
  workflowRunsArchiveGraceMs: number
  workflowRunsArchiveBatchSize: number
  // Schedule worker replaces K8s CronJobs: polls workflow_schedules under an
  // advisory lock for cross-replica dedup, fires matured schedules via
  // workflowRunService.createRun(actor_type='scheduled').
  workflowScheduleWorkerEnabled: boolean
  workflowScheduleWorkerIntervalMs: number
  workflowScheduleWorkerBatchSize: number
  workflowMaxWorkloadsPerRecipe: number
  workflowUiEgressInternalMaxItems: number
  workflowMaxSteps: number
  workflowStepDependsOnMaxItems: number
  workflowStepAllowedToolsMaxItems: number
  workflowStepMcpServersMaxItems: number
  workflowArtifactDownloadMaxBytes: number
  // Per-minute rate limits (PG-backed token buckets).
  approvalRlRequestPerMin: number
  approvalRlRefreshPerMin: number
  approvalRlExternalPerMin: number
  oauthBrokerRlPerMin: number
  adminPublicTokenRlPerMin: number
  // Stateless-agent wake endpoint: per-host wake rate limit + server-side
  // coalescence window for the wake-annotation projection.
  hostWakeRlPerMin: number
  hostWakeCoalesceWindowMs: number
  approvalMediumChallengeTtlSec: number
  telegramProviderEventChallengeTtlSec: number
  approvalMediumChallengeMaxAttempts: number
  workflowApprovalNotificationDeliveryEnabled: boolean
  workflowApprovalNotificationDeliveryIntervalMs: number
  workflowApprovalNotificationDeliveryBatchSize: number
  workflowApprovalTelegramApiRoot: string
  workflowApprovalSlackApiRoot: string
  notificationStreamHeartbeatMs: number
  notificationStreamMaxLifetimeMs: number
  notificationStreamSnapshotLimit: number
  notificationsDesktopFirstEnabled: boolean
  notificationDesktopGraceSeconds: number
  // Stricter than the normal refresh limiter: a client reaching reissue has
  // already exhausted refresh retries and is declaring auth broken — repeat
  // hits indicate either a real crash-loop recovery (bounded by pod restart
  // cadence) or an attacker replaying.
  approvalRlReissuePerMin: number
  approvalRlCleanupIntervalMs: number
  adminRevokedTokenCleanupIntervalMs: number
  // OAuth callback: symmetric secrets for state HMAC + refresh token
  // encryption. Keep both at least 32 chars / hex-encoded 64 chars so dev
  // defaults are usable without ceremony but prod overrides are forced.
  oauthStateHmacSecret: string
  oauthEncryptionKey: string
  // Public base URL the OAuth callback is reachable at (e.g.
  // https://example.com). Used to build the redirect_uri for the token
  // exchange so it matches the authorize step regardless of the internal proxy
  // chain's Host header. Empty → fall back to the request Host (local dev).
  oauthCallbackBaseUrl: string
  // SharedFileSystem — namespace housing both the CRD and the per-SFS
  // workspace-files-controller Service.
  sharedFilesystemsNamespace: string
  // Audience claim used by browsing JWTs; must match WSF_JWT_AUDIENCE on
  // the per-SFS wfc Deployment. The signing key is reused from rpcJwtPrivateKey.
  wfcJwtAudience: string
  // TTL for browsing JWTs minted by /admin/shared-filesystems/:name/token.
  wfcTokenTtlSeconds: number
  // gfs (Global File System) — audience claim for gfsc access tokens; gfsc
  // verifies aud === gfsTokenAudience. The signing key is reused from
  // rpcJwtPrivateKey (the open core uses one platform keypair; per-tenant keys
  // are the managed edition, P6).
  gfsTokenAudience: string
  // TTL for gfs access tokens minted by POST /api/v1/gfs/token.
  gfsTokenTtlSeconds: number
  // In-cluster base URL of the gfsc read ClusterIP Service (gfs namespace).
  gfscBaseUrl: string
  // In-cluster base URL of the writer-only gfsc Service for mutations.
  gfscWriteBaseUrl: string
  // ClusterIP service URL template for the per-SFS wfc. {hash} is replaced
  // with the 10-char sfsHash that HCC's sharedFileSystemReconciler computes.
  // The template ends without a trailing slash; the proxy concatenates the
  // browser-side path. Default points at the in-cluster Service name from
  // sharedFileSystemFactory.wfcServiceName().
  wfcServiceUrlTemplate: string
  // Plugin image-host allowlist (Phase 2.3). Trusted raw-image prefixes for
  // local-mode McpServer images. Audit mode (default) adds no validation
  // error; enforce mode rejects installs/updates with a disallowed image.
  allowedPluginImagePrefixes: string[]
  enforcePluginImageAllowlist: boolean
}

function assertNotPlaceholder(label: string, value: string): void {
  // Fail loud if the former overlay placeholder ever leaks into a running pod.
  // These tokens must be populated by `deploy/scripts/apply-inter-service-tokens.sh`
  // (kubectl patch --type=merge), not by kustomize. A `replace-with-*` value
  // means CI wiped the Secret back to the canary state — refuse to start.
  if (/^replace-with-/.test(value)) {
    throw new Error(
      `${label} has placeholder value "${value}". Run deploy/scripts/apply-inter-service-tokens.sh before deploying.`
    )
  }
}

function parseInternalTokens(input: string): string[] {
  const tokens = input
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
  tokens.forEach((t, i) => assertNotPlaceholder(`CONTROL_API_INTERNAL_TOKENS[${i}]`, t))
  return tokens
}

function parseInternalServiceTokens(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawPair of input.split(',')) {
    const pair = rawPair.trim()
    if (!pair) continue
    const [service, ...rest] = pair.split('=')
    const key = String(service || '').trim()
    const value = rest.join('=').trim()
    if (!key || !value) continue
    assertNotPlaceholder(`CONTROL_API_INTERNAL_SERVICE_TOKENS[${key}]`, value)
    result[key] = value
  }
  return result
}

function parseCsvList(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(',')
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function requiredOrDevDefault(name: string, devDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env.NODE_ENV !== 'production') return devDefault
  return required(name)
}

function positiveIntegerFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return defaultValue

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function boundedIntegerFromEnv(name: string, defaultValue: number, maxValue: number): number {
  const value = positiveIntegerFromEnv(name, defaultValue)
  if (value > maxValue) {
    throw new Error(`${name} must be an integer between 1 and ${maxValue}`)
  }
  return value
}

const HOSTS_NAMESPACE = process.env.CONTROL_API_HOSTS_NAMESPACE || 'mcp-host'
const MCP_SERVERS_NAMESPACE = process.env.CONTROL_API_MCP_SERVERS_NAMESPACE || 'mcp-server'
const SANDBOX_NAMESPACE = process.env.CONTROL_API_SANDBOX_NAMESPACE || 'sandbox-recipes'
const SANDBOX_UI_NAMESPACE = process.env.CONTROL_API_SANDBOX_UI_NAMESPACE || 'sandbox-ui'
const DEFAULT_MCP_HOST_JWT_MAX_HOST_REFS = 32
const DEFAULT_MCP_HOST_JWT_MAX_HOST_REF_LENGTH = 63 + 1 + 253
const WORKFLOW_MAX_WORKLOADS_PER_RECIPE_CEILING = 25
const WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS_CEILING = 25
const WORKFLOW_MAX_STEPS_CEILING = 100
const WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS_CEILING = 100
const WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS_CEILING = 100
// The step mcpServers env can only lower this value; the CRD hard ceiling remains 20.
const WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS_CEILING = 20

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim()
}

function parseRegistryConnectionMode(): 'managed' | 'self-hosted' {
  const raw = process.env.REGISTRY_CONNECTION_MODE
  if (raw === undefined || raw === '') return 'managed' // default; requiredness enforced in the guard below
  if (raw === 'managed' || raw === 'self-hosted') return raw
  throw new Error(`REGISTRY_CONNECTION_MODE must be 'managed' or 'self-hosted' (got '${raw}')`)
}

function publicKeyFromPrivateKey(privateKey: string): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
}

const DEV_RPC_JWT_PRIVATE_KEY = normalizePem(`-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCsIhgYd6Ew+kYp
4/FopBqsNfnKvOJ9TmLh/OkjcS2QpJTqzm6DsSQrFzYN0x6Sipd72+vuorJXCKKV
Qi6xcteJbso8wmUP8V3kGjtDG3r3BiIvkjgrft4OAI3oPct24fJISeSF0jQYOkHg
szYBI7FCQRpt6l6RlMxDITGYIif90cnXkH7gD22KJ6mFg5A2vcZydb14OiYy3o0k
vKmKRuvEk7o7sCvQb6tpNt+W2HwRDNacYX5aBBbiKIzfCwWGloTSZSURswYMZMwB
nLUp/EBFG75Bmbcuj7kCIJoeSKMMKCUexcuGqxiLYB1GJq8PUaT0so//O0rDur8P
p9gXOY5DAgMBAAECggEAVAGPoOFBWZXLCEamWls8aS8uaTMlleHbgE7duN5TTnQD
+VQluz+IVz9MshKGqR3aMCh0TFI6lx8vuYhDIXbamcfoCx8UE2PIXroukeGncUcd
B/pkT1XrKQo8N0txMOO0SnNFg8nCgtBrti2//W5d4+fB7kKjRIlJ5rkcaxLAUa5z
fpvaz+DhwBvvIi5zakhUBGVinVnQV6cKS5c52ccYikSNG9ysGBParCbVsQCwgLan
JhWCmRYuPj5MoaELcZ7lBO2ow+SO/VSTW03fnC/cIYCxZqAEEnq3fg5/FFsy6xsB
CbwQQaGnUrrw/LyGX3vyW7eXDL4hOYLp+l+tZklqAQKBgQDe8I4RegQ7lGvVnEoo
xTBdZg6kgjSRRBMs67/E+HrnnHC8gMjT2MlJguYQEonFP8teDoj0l7+1Bj/LRyHv
CyZr03EpevMQut27VdEO/qWYaGpOsXC2xkuiJWeKYvp3//lcIofXy9VhStlsisk6
yx1LAY6iiZvptaCzJmYTU677swKBgQDFqMaLyLAAIpMcBrLDlGt8qyB6ZVaJZTHP
vs13Md6RJPVXXyGtWRtpMwOSwHJNyy3xN23rWtlj32UE9KW/47oxjbkXfpExG/fi
UBeA80AtjM57q66+LZ9Rs5EAFcOsNrd11XY4Y/37/MMbWQgjfW44uEeB2drx9mB0
LU9H+1KbMQKBgFKij8Zil9cNuLrA56wdC0RTY/IOYTXHKeRorfhwsf3PuunkQoxj
upiI8IXcmTyH3PXMJW+kH+cVnefXQfi9BUzKXxOlAxucaDvcH1WThgXsDhuFIeZd
sgM0IiDldzmro95G3ltarokVmWnmN5iXWRBIT3pnz2bdb+d3wDZBuoaJAoGABCl9
pMvhCN+xgVGSyhOB/+oKkQk5PUNoPRujb/MY4K2KjQBv0RqjPR/Z32k1/vVcTkwA
gIg1M6ksk2Ija1r8PLbjQt9jZ0lTeux80jZND6h7YJdI4rBLPoktcHcE28d7LXwF
NULFwlycLyM8zKKDg6Y9uzo/JgEuHsQlezqLjsECgYAboHrpwXg/SBatigtBvj0E
1ccXGGLgN2dhDbAlZoSKDITOxGiOw48bOX1lT25c06muru+2mCNrsN2lMs07VGk8
PSRsIuFZis/4vrRtjoxUB4OQ29+mfVgqGsABPugCmi/r22gWrvl1aqEEqstg3m7x
sKRpFxViv5P5TmnxLggnhw==
-----END PRIVATE KEY-----`)

const DEV_SESSION_JWT_PRIVATE_KEY = normalizePem(`-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDCtmNr2NL+v57Z
gXUWoRA0wuyd995tjNetk5vu48wqFcGgqMmH+1pH2/eRfayt9W2iKRwoqvRJ9rsw
xIudlZ0ROaLsy9t5UPcemxelV6ObD0PTN5hhIZmmUsX9vodjQvPZdUzxZ0mXcOJz
K75JltnF4dm0wIxNOO+agj8hiaY7g3c+DP9IaLtXcSLCgAs4M/g5YO93/XEVSIw+
yUs+BlQRzNDm0ikBoPh7SibeBQ2zI4phzmKCiObqihWoj1PdNQYFUnS5JkHue1bE
pDf1bIhof6iqfAMZsNwMtD/BO4G1yfhutZMOBbXEDvcdUFIiYYW+8cJYGJAGIjWe
+i9Q/S5ZAgMBAAECggEABTd9g63SHl7sLrvqEw6C6IT58bQKxrDdtPH13TFHfq+p
SciH6L+mYDM/p2tgcWM4Wh5Dmb/VzncAtipn6rOP2x6qE7HVCiOuEUj6udR2ptCC
gtHUIHMV4qfIU/dzOWi5b4+13Whk53yv5oHLJf3XjRaTXoVDpQyD1+YKMrf1RxYf
QIiI6ChaDmPmZ8mJF56vZLz1S98HBvtMlTtI+IYhhkxScSq77enb44NLZ0FInXtr
UJ0WiJ1JYUZdESauiXFH/fTKyXF7vp5ZAIThG+hGaJ987HV8DXL0S0gmFRkw2Wj2
44IKEC+VH60GTIysQ2HmbKExAYwngZBBCNTgoawWgQKBgQDwLLqmCVPgxZ2dkxi3
5RlLZfhPRANQzj4GyE2oQtRwthGn30QJ3tc26WIjDt7a2vRUGiHOEONeDcJQg726
JeBgUMDCuwA9QkdyDZhupF9Erl9f6C515k7Y2il7JX0sA1MmV5Phgh2XH+rUq6Li
A7EFS5P1mT/J7XU842NdD+xUgQKBgQDPis0QJ/1eHY9j6pQC6d8riLEG3lRHiCVt
94gp8YoNI6iJRl4fVUO1A4JxjNIz04g7ZXLusuFUgznXnxGv2+pju//vvVbQeyD6
HKDvfd1Xt0xTe5Y/X5g2l7b7dvHc9o9YAhxqkMmxuusdF+z++VLWbf3T7XXAiufS
k4thtd8N2QKBgQCnCMSqsvQF8AolS+c2BfxohruCDTAtI7LZrrbrncb3uHhhAxLj
tnqA8yFQdoghN4QTdbUrBm3KvND2hBkQfEUnVyIojDunXxAnTzNDR8gGESu9nNGr
J4iQonGU9sauNIXAtcngXUjNEOKWE+SNQbn8j8qQVYuamS4fMZmqYGehgQKBgHng
kufH9BxO06PjX6QOX0YbcYoNCgUvyHs5f7bR5zYsGI70ydUwpyAnvXSdM9vHfxsS
SloupfCRV2huO17AkHadMoFA+ThY9laqdT/u9ArM03+69dKleqeklIo7oXEXQbp3
EuTpvegnUma1ZDGfjKvrz8GikyHM8LJSfumUejaRAoGBALaksx+nAwBqSehPEsU3
84xsDCj0jiJy5SVlKAnyVKM4bjI8pgCHY2dD9jqCYEfRKIMB6jKZDS7ZE1n1IeIC
aI29j2LQbxz6hwRqZisBaGgOg5GaL74Hjodh2OwWl5fGFdKXFFPSsJAYeK6sOxgB
VUxHFu+yhYVbZ5uhL8whXgrI
-----END PRIVATE KEY-----`)

// Use a different dev key for admin JWT to prevent token confusion
const DEV_ADMIN_JWT_PRIVATE_KEY = normalizePem(`-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCysO8JjPH3o4s7
aq/fuxtlm8K6C7NH5xbHA5inHrUA/4Yv2XFXrQUkkkqO1GE78i+bqSg7OBXKWfXY
GmGKkHScmz190vMCunF6K4pqWKCuQv1z/ZPCWOZGllqBnNkooBBHzbtvRZHP2oHr
eeluMy//svUY3Fwy0ud7atMBhTeB7PQjumHAoBgf/Nj5PmIfaXSqm3/gjLq3ulY5
DSqCsp4k8V7mphYrdzwFYadYmSGgsI1QJOdRrXIZoge5HArPA8f1vjvqtLvY0aoY
LjFFlcB6Kc50jPc/Kaks3QfIiNKw8FSWF7AgvAPmNAELoPFh5ctAljRQdZEus6pB
GQmx6nrJAgMBAAECggEAC+MGgbqDKaOy2kTgdngATG/yQhVPa63xF1PTSrG5nXuC
CgqTVj9jn1FOfaYd4kKb/WVBMIBMfcmid6nYmYK+ySCwFF/NK94qeJOvKWAkLzd0
XAwPMV9f0SwFEQh1rzTHpHkoefBVMPAikp8pYrvrul0lng3hob1jKfP7Haemn8E+
mlOLlGkW3mbyAi65bOPTdaqx+uGj5q8ZY1Bz84e23xIWV0bTTsqWJ7/JBc9wG5/9
JA2tWs4QuYhs+14n+TLpnniYUolMUyxPeoaJV81cU1UTNSUbBTZ5ndXAWoenv9Gv
PaR7awUwTPq/qV2+ZgEoPwa9omQQNmk0ACdTNDfSsQKBgQDmtAuBJTrhoXpcPOQV
Qz7rr1fWFvFS729AuWDNhPWaC6/Q2mkwEVB2jMCn7tZhx0M8HEO2xduDlThi0pbu
35shxeYTwQno+SFeCG8l/AmmKp/nJpO8d7PKEwLB8IBm8WYCqIQ4gPWc958enR4Y
2Nve0HtVlnvSSAqeZ58f8gNiEQKBgQDGSOHQ0jN/LRjchCw6QOifZgYm7nCafZuj
G9BBXTVZBXZZlODfDH9tkZaywywuBw/cw7Rcn9k2GWoxm3WjYgQjMB45BcZIpaZo
kLmr6ZQUzxm3JAdT2U3v0XNTD8A8oFsvlEr6/Uno/uNqQq6EufMls6gPzUaVO56Q
AFwKO/pVOQKBgQCw96tbhZOFQLj7yDmtlcfOQtK+BxtW4xQUMh9vh25enFhhfSjz
FlUCmzWtnCgXGSMaGRRYP64DYZO/OotM8Xmujn/O52USsQhHeXDJUmyUal3+kjkB
eVEQ0URsQHA+hy4ZG+tQ7Jt7rPcCJMPRi4gdgw8YuDaDN3/tws7tUlgGAQKBgBY+
Zta+PfiuXnOegDeowG/hSh9j8E3keWk63Yn3otxxuG0kPnXHOSRZiMZVDse7ExR4
/+rEI+Hlx/v4rKG/hSdNZpaPB0dvDdP9KFcYxPvwn7nj2M6XOh8FKCLRSYeDlbco
s6CkeX4h2fE5uco58gTwupHLPXfQUGFnKOwc/mBBAoGAZOC3cOzdROA6t12hlXBG
nFoBPwztGGlol4VRjNHOUv21999k1s9vujmfdoEbtCT8UWR735Cmahv6Dlqhgmfz
udFCb0WGbuF+RYuIoF3rm2aQMZoCCl5E4QlgJroKBTkfFugxZJ+1SLZJ4KKRcMrB
gg1uS2CBS2kyMhFQcB5FLFw=
-----END PRIVATE KEY-----`)

const DEV_ADMIN_PASSWORD_HASH = '$2b$12$9QdfGGp5KYg8osGa1n0.DuwQiB1RopCWIDJhmsuK4ygjTmIT8pvgy'

const RPC_JWT_PRIVATE_KEY = normalizePem(
  requiredOrDevDefault('CONTROL_API_RPC_JWT_PRIVATE_KEY', DEV_RPC_JWT_PRIVATE_KEY)
)
const RPC_JWT_PUBLIC_KEY = normalizePem(
  process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY || publicKeyFromPrivateKey(RPC_JWT_PRIVATE_KEY)
)

const memberRegistrationMode: 'remote' | 'hosted' = (() => {
  const raw = (process.env.CONTROL_API_MEMBER_REGISTRATION_MODE || 'remote').trim()
  if (raw !== 'remote' && raw !== 'hosted') {
    throw new Error(
      `CONTROL_API_MEMBER_REGISTRATION_MODE must be 'remote' or 'hosted' (got '${raw}')`
    )
  }
  return raw
})()

// "Present" = non-empty after trim: blanking a value in the deploy Secret must
// count as absent (spec §8.1 — apply-inter-service-tokens.sh re-adds the key).
function memberRegistrationEnvPresent(name: string): boolean {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== ''
}

if (memberRegistrationMode === 'hosted') {
  // Fail fast on ambiguity — scoped to the DELIBERATELY-set identity vars only.
  // HMAC_SECRET is excluded: the shipped deploy unconditionally injects it via
  // the control-api-internal-tokens Secret (spec §8.1), so it is ignorable legacy.
  const injectedIdentity = [
    'CONTROL_API_MEMBER_REGISTRATION_HMAC_KID',
    'CONTROL_API_MEMBER_REGISTRATION_TENANT_ID',
  ].filter(memberRegistrationEnvPresent)
  if (injectedIdentity.length > 0) {
    throw new Error(
      `[SECURITY] CONTROL_API_MEMBER_REGISTRATION_MODE=hosted is mutually exclusive with an injected remote member-registration identity. Unset: ${injectedIdentity.join(', ')}`
    )
  }
  if (memberRegistrationEnvPresent('CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET')) {
    console.warn(
      '[ControlAPI] CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET is set but IGNORED in hosted member-registration mode (deploy-injected legacy value; credentials are self-enrolled and stored in Postgres)'
    )
  }
}

// Computed once so registryConnectionMode and publisherUiEnabled's mode-based
// default read the exact same resolved value below (rather than re-parsing
// REGISTRY_CONNECTION_MODE a second time).
const registryConnectionMode: 'managed' | 'self-hosted' = parseRegistryConnectionMode()

export const config: Config = {
  port: Number(process.env.CONTROL_API_PORT || 8090),
  jsonBodyLimit: process.env.CONTROL_API_JSON_BODY_LIMIT || '150mb',
  namespace: process.env.CONTROL_API_NAMESPACE || 'mcp-server',
  hostsNamespace: HOSTS_NAMESPACE,
  contextsNamespace: process.env.CONTROL_API_CONTEXTS_NAMESPACE || 'mcp-server',
  communicationChannelsNamespace:
    process.env.CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE || 'channels',
  mcpServersNamespace: MCP_SERVERS_NAMESPACE,
  sandboxNamespace: SANDBOX_NAMESPACE,
  sandboxUiNamespace: SANDBOX_UI_NAMESPACE,
  secretsNamespace: process.env.CONTROL_API_SECRETS_NAMESPACE || 'mcp-host',
  pgConnectionString:
    process.env.CONTROL_API_PG_CONNECTION_STRING ||
    'postgres://postgres:postgres@control-postgres.control-plane.svc.cluster.local:5432/profiles',
  internalTokens: parseInternalTokens(
    process.env.CONTROL_API_INTERNAL_TOKENS || 'dev-external-rest-api-token,dev-rpc-proxy-token'
  ),
  internalServiceTokens: parseInternalServiceTokens(
    process.env.CONTROL_API_INTERNAL_SERVICE_TOKENS ||
      'external-rest-api=dev-external-rest-api-token,rpc-proxy=dev-rpc-proxy-token,webhook-proxy=dev-webhook-proxy-token,workflow-approval-reader=dev-wa-reader-token'
  ),
  internalControlJwtWrcHmacSecret: requiredOrDevDefault(
    'INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET',
    'dev-wrc-internal-control-jwt-hmac-secret-32-bytes'
  ),
  internalControlJwtHccHmacSecret: requiredOrDevDefault(
    'INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET',
    'dev-hcc-internal-control-jwt-hmac-secret-32-bytes'
  ),
  allowedIssuanceNamespaces: parseCsvList(
    process.env.CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES || `${HOSTS_NAMESPACE},${SANDBOX_NAMESPACE}`
  ),
  memberRegistrationMode,
  memberRegistrationExternalHubBaseUrl:
    process.env.CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL ||
    'https://registration.evenfire.ai/api/v1',
  memberRegistrationServiceBaseUrl:
    memberRegistrationMode === 'hosted'
      ? process.env.CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL || ''
      : requiredOrDevDefault(
          'CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL',
          'http://member-registration-service.profiles.svc.cluster.local:8092/api/v1'
        ),
  memberRegistrationServiceHmacSecret: (() => {
    if (memberRegistrationMode === 'hosted') {
      // Hosted mode never signs with the env secret; see the module-scope warning.
      return ''
    }
    const value = requiredOrDevDefault(
      'CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET',
      'dev-member-registration-hmac-secret'
    )
    assertNotPlaceholder('CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET', value)
    return value
  })(),
  memberRegistrationServiceHmacKid:
    process.env.CONTROL_API_MEMBER_REGISTRATION_HMAC_KID || 'example-dev',
  memberRegistrationTenantId:
    process.env.CONTROL_API_MEMBER_REGISTRATION_TENANT_ID || 'example-dev',
  desktopExternalRestApiBaseUrl:
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091',
  desktopRpcProxyBaseUrl:
    process.env.CONTROL_API_DESKTOP_RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094',
  desktopProfileUiBaseUrl:
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL || 'http://127.0.0.1:3001',
  desktopAppName: process.env.CONTROL_API_DESKTOP_APP_NAME || 'Evenfire',
  controlUiBaseUrl: process.env.CONTROL_API_CONTROL_UI_BASE_URL || 'http://127.0.0.1:3000',
  controlUiAppName: process.env.CONTROL_API_CONTROL_UI_APP_NAME || 'Evenfire',
  sessionJwtPrivateKey: normalizePem(
    requiredOrDevDefault('CONTROL_API_SESSION_JWT_PRIVATE_KEY', DEV_SESSION_JWT_PRIVATE_KEY)
  ),
  jwtIssuer: requiredOrDevDefault('CONTROL_API_JWT_ISSUER', 'control-api'),
  jwtAudience: requiredOrDevDefault('CONTROL_API_JWT_AUDIENCE', 'profile-ui'),
  rpcJwtPrivateKey: RPC_JWT_PRIVATE_KEY,
  rpcJwtPublicKey: RPC_JWT_PUBLIC_KEY,
  rpcJwtIssuer: requiredOrDevDefault('CONTROL_API_RPC_JWT_ISSUER', 'control-api'),
  rpcJwtAudience: requiredOrDevDefault('CONTROL_API_RPC_JWT_AUDIENCE', 'rpc-proxy'),
  rpcTokenTtlSeconds: Number(process.env.CONTROL_API_RPC_TOKEN_TTL_SECONDS || 300),
  hostSecretLabelKey: process.env.CONTROL_API_HOST_SECRET_LABEL_KEY || 'clerum.io/host-secret',
  hostSecretLabelValue: process.env.CONTROL_API_HOST_SECRET_LABEL_VALUE || 'true',
  policyAuthAudience: process.env.CONTROL_API_POLICY_AUTH_AUDIENCE || 'control-api',
  googleClientId: requiredOrDevDefault('CONTROL_API_GOOGLE_CLIENT_ID', 'dev-google-client-id'),
  adminJwtPrivateKey: normalizePem(
    requiredOrDevDefault('CONTROL_API_ADMIN_JWT_PRIVATE_KEY', DEV_ADMIN_JWT_PRIVATE_KEY)
  ),
  adminJwtIssuer: requiredOrDevDefault('CONTROL_API_ADMIN_JWT_ISSUER', 'control-api'),
  adminJwtAudience: requiredOrDevDefault('CONTROL_API_ADMIN_JWT_AUDIENCE', 'control-ui'),
  adminJwtTtlSeconds: Number(process.env.CONTROL_API_ADMIN_JWT_TTL_SECONDS || 60 * 60),
  // Optional — empty string means "fall back to adminJwtPrivateKey" (see
  // registry.ts). Production should set this to a dedicated RS256 key.
  registryVoucherPrivateKey: normalizePem(
    process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY ?? ''
  ),
  registryVoucherKid: process.env.CONTROL_API_REGISTRY_VOUCHER_KID ?? '',
  registryUrl: process.env.CLERUM_REGISTRY_URL ?? '',
  registryClientId: process.env.CLERUM_REGISTRY_CLIENT_ID ?? '',
  registryClientSecret: process.env.CLERUM_REGISTRY_CLIENT_SECRET ?? '',
  registryAuthEnabled: process.env.CLERUM_REGISTRY_AUTH_ENABLED === 'true',
  registryConnectionMode,
  // 'true'/'false' wins explicitly; otherwise default OFF for self-hosted,
  // ON for managed — reuses the registryConnectionMode value above rather
  // than re-parsing REGISTRY_CONNECTION_MODE.
  publisherUiEnabled:
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED === 'true'
      ? true
      : process.env.CONTROL_API_PUBLISHER_UI_ENABLED === 'false'
        ? false
        : registryConnectionMode !== 'self-hosted',
  adminAuthMaxFailures: Number(process.env.CONTROL_API_ADMIN_AUTH_MAX_FAILURES || 5),
  adminAuthLockMinutes: Number(process.env.CONTROL_API_ADMIN_AUTH_LOCK_MINUTES || 15),
  adminBootstrapUsername: requiredOrDevDefault('CONTROL_API_ADMIN_BOOTSTRAP_USERNAME', 'admin'),
  adminBootstrapEmail: process.env.CONTROL_API_ADMIN_BOOTSTRAP_EMAIL || '',
  adminBootstrapPasswordHash: requiredOrDevDefault(
    'CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH',
    DEV_ADMIN_PASSWORD_HASH
  ),
  adminDefaultAgentNames: (process.env.CONTROL_API_ADMIN_DEFAULT_AGENT_NAMES || 'chatllm')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean),
  adminDefaultContextIds: (process.env.CONTROL_API_ADMIN_DEFAULT_CONTEXT_IDS || 'context1')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean),
  mcpHostJwtAccessTtlSec: Number(process.env.WORKFLOW_APPROVAL_ACCESS_TTL_SEC || 600),
  mcpHostJwtRefreshTtlSec: Number(process.env.WORKFLOW_APPROVAL_REFRESH_TTL_SEC || 3600),
  mcpHostJwtControlTtlSec: Number(process.env.MCP_HOST_JWT_CONTROL_TTL_SEC || 600),
  mcpHostJwtMaxHostRefs: positiveIntegerFromEnv(
    'MCP_HOST_JWT_MAX_HOST_REFS',
    DEFAULT_MCP_HOST_JWT_MAX_HOST_REFS
  ),
  mcpHostJwtMaxHostRefLength: positiveIntegerFromEnv(
    'MCP_HOST_JWT_MAX_HOST_REF_LENGTH',
    DEFAULT_MCP_HOST_JWT_MAX_HOST_REF_LENGTH
  ),
  oauthBrokerJwtTtlSec: Number(process.env.CONTROL_API_OAUTH_BROKER_JWT_TTL_SEC || 600),
  userApprovalRequestDefaultTtlSec: Number(process.env.WORKFLOW_APPROVAL_DEFAULT_TTL_SEC || 86400),
  userApprovalRequestMaxTtlSec: Number(process.env.WORKFLOW_APPROVAL_MAX_TTL_SEC || 604800),
  userApprovalRequestExpiryIntervalMs: Number(
    process.env.WORKFLOW_APPROVAL_EXPIRY_INTERVAL_MS || 60000
  ),
  usageRollup5MinIntervalMs: Number(process.env.USAGE_ROLLUP_5MIN_INTERVAL_MS || 60_000),
  usageRollupHourlyIntervalMs: Number(process.env.USAGE_ROLLUP_HOURLY_INTERVAL_MS || 300_000),
  usageRollupDailyIntervalMs: Number(process.env.USAGE_ROLLUP_DAILY_INTERVAL_MS || 3_600_000),
  usageRetentionIntervalMs: Number(process.env.USAGE_RETENTION_INTERVAL_MS || 86_400_000),
  // Budget danger-zone reservation sweep (deletes expired rows). Cleanup only —
  // expired reservations already stop counting via the `expires_at > NOW()`
  // filter, so a coarse interval (default 60s) is fine.
  budgetReservationSweepIntervalMs: Number(
    process.env.BUDGET_RESERVATION_SWEEP_INTERVAL_MS || 60_000
  ),
  // Danger-zone reservation TTL (§9.8a: ~2-3× the rollup lag, ~5 min). Short
  // enough that a hung reservation auto-frees; long enough that real spend has
  // reached the rollups before it expires (no double-count on the next check).
  budgetReservationTtlSeconds: positiveIntegerFromEnv('BUDGET_RESERVATION_TTL_SECONDS', 300),
  // Default 180 days. Archival runs daily at 02:00 UTC; older terminal
  // approvals move to the archive table.
  approvalRetentionDays: positiveIntegerFromEnv('APPROVAL_RETENTION_DAYS', 180),
  userApprovalRequestArchiveCronEnabled:
    (process.env.APPROVAL_ARCHIVE_CRON_ENABLED ?? 'true') !== 'false',
  userApprovalRequestArchiveBatchSize: positiveIntegerFromEnv('APPROVAL_ARCHIVE_BATCH_SIZE', 500),
  // workflow_runs archive cron defaults:
  //   interval 15 min, grace 1h, batch 500 (matches approvals).
  workflowRunsArchiveCronEnabled:
    (process.env.WORKFLOW_RUNS_ARCHIVE_CRON_ENABLED ?? 'true') !== 'false',
  workflowRunsArchiveIntervalMs: Number(
    process.env.WORKFLOW_RUNS_ARCHIVE_INTERVAL_MS || 15 * 60 * 1000
  ),
  workflowRunsArchiveGraceMs: Number(process.env.WORKFLOW_RUNS_ARCHIVE_GRACE_MS || 60 * 60 * 1000),
  workflowRunsArchiveBatchSize: Number(process.env.WORKFLOW_RUNS_ARCHIVE_BATCH_SIZE || 500),
  // Schedule worker defaults:
  //   interval 10s (low latency vs cron granularity of 1min),
  //   batch 50 rows per sweep, enabled by default.
  workflowScheduleWorkerEnabled:
    (process.env.WORKFLOW_SCHEDULE_WORKER_ENABLED ?? 'true') !== 'false',
  workflowScheduleWorkerIntervalMs: Number(
    process.env.WORKFLOW_SCHEDULE_WORKER_INTERVAL_MS || 10_000
  ),
  workflowScheduleWorkerBatchSize: Number(process.env.WORKFLOW_SCHEDULE_WORKER_BATCH_SIZE || 50),
  workflowMaxWorkloadsPerRecipe: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE',
    WORKFLOW_MAX_WORKLOADS_PER_RECIPE_CEILING,
    WORKFLOW_MAX_WORKLOADS_PER_RECIPE_CEILING
  ),
  workflowUiEgressInternalMaxItems: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS',
    WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS_CEILING,
    WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS_CEILING
  ),
  workflowMaxSteps: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_MAX_STEPS',
    WORKFLOW_MAX_STEPS_CEILING,
    WORKFLOW_MAX_STEPS_CEILING
  ),
  workflowStepDependsOnMaxItems: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS',
    WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS_CEILING,
    WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS_CEILING
  ),
  workflowStepAllowedToolsMaxItems: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS',
    50,
    WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS_CEILING
  ),
  workflowStepMcpServersMaxItems: boundedIntegerFromEnv(
    'CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS',
    WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS_CEILING,
    WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS_CEILING
  ),
  workflowArtifactDownloadMaxBytes: positiveIntegerFromEnv(
    'CLERUM_ATTACHMENT_MAX_BYTES',
    50 * 1024 * 1024
  ),
  approvalRlRequestPerMin: Number(process.env.APPROVAL_RL_REQUEST_PER_MIN || 120),
  approvalRlRefreshPerMin: Number(process.env.APPROVAL_RL_REFRESH_PER_MIN || 20),
  approvalRlExternalPerMin: Number(process.env.APPROVAL_RL_EXTERNAL_PER_MIN || 60),
  oauthBrokerRlPerMin: Number(process.env.CONTROL_API_OAUTH_BROKER_RL_PER_MIN || 60),
  adminPublicTokenRlPerMin: Number(process.env.CONTROL_API_ADMIN_PUBLIC_TOKEN_RL_PER_MIN || 20),
  // Default derived from the wake mechanism's worst case, not picked ad hoc.
  // rpc-proxy's wake-and-hold loop re-triggers POST /rpc/hosts/:hostRef/wake
  // every wakeRetriggerMs=15000 for up to wakeMaxHoldMs=90000 (defaults in
  // rpc-proxy/src/config.ts), so one held request costs
  // 1 + floor(90000/15000) = 7 calls per rpc-proxy instance; rpc-proxy runs
  // replicas: 2 (deploy/base/rpc-proxy/rpc-proxy.yaml) with per-instance
  // dedup, so the mechanism alone can emit 14 calls / 90s (~9.4/min) per
  // host. Desktop prewarm adds a burst of up to 3 calls per device.
  // Middleware order in routes/rpc-access/hosts.ts is limiter BEFORE
  // handler, and the hostWakeCoalesceWindowMs coalescer runs INSIDE the
  // handler (it coalesces annotation projections, not calls) — coalesced
  // calls therefore still consume rate-limit budget, so this budget must
  // cover RAW calls (the arithmetic above counts raw calls). 30/min is >=3x
  // the single-hold mechanism volume and covers one held wake plus prewarm
  // bursts from a few concurrent devices (4 x 3 = 12) plus a real message.
  // Derivation is regression-guarded by test/config.hostWakeRateLimit.test.ts.
  hostWakeRlPerMin: Number(process.env.CONTROL_API_HOST_WAKE_RL_PER_MIN || 30),
  hostWakeCoalesceWindowMs: Number(process.env.CONTROL_API_HOST_WAKE_COALESCE_WINDOW_MS || 2000),
  approvalMediumChallengeTtlSec: Number(
    process.env.WORKFLOW_APPROVAL_MEDIUM_CHALLENGE_TTL_SEC || 60 * 60
  ),
  telegramProviderEventChallengeTtlSec: positiveIntegerFromEnv(
    'TELEGRAM_PROVIDER_EVENT_CHALLENGE_TTL_SEC',
    120
  ),
  approvalMediumChallengeMaxAttempts: Number(
    process.env.WORKFLOW_APPROVAL_MEDIUM_CHALLENGE_MAX_ATTEMPTS || 5
  ),
  workflowApprovalNotificationDeliveryEnabled:
    (process.env.WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_ENABLED ?? 'true') !== 'false',
  workflowApprovalNotificationDeliveryIntervalMs: positiveIntegerFromEnv(
    'WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_INTERVAL_MS',
    5_000
  ),
  workflowApprovalNotificationDeliveryBatchSize: boundedIntegerFromEnv(
    'WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_BATCH_SIZE',
    10,
    50
  ),
  workflowApprovalTelegramApiRoot:
    process.env.WORKFLOW_APPROVAL_TELEGRAM_API_ROOT || 'https://api.telegram.org',
  workflowApprovalSlackApiRoot:
    process.env.WORKFLOW_APPROVAL_SLACK_API_ROOT || 'https://slack.com/api',
  notificationStreamHeartbeatMs: Number(process.env.NOTIFICATION_STREAM_HEARTBEAT_MS || 25 * 1000),
  notificationStreamMaxLifetimeMs: Number(
    process.env.NOTIFICATION_STREAM_MAX_LIFETIME_MS || 10 * 60 * 1000
  ),
  notificationStreamSnapshotLimit: Number(process.env.NOTIFICATION_STREAM_SNAPSHOT_LIMIT || 50),
  notificationsDesktopFirstEnabled:
    (process.env.NOTIFICATIONS_DESKTOP_FIRST_ENABLED ?? 'true') !== 'false',
  // Parse safely: a non-empty non-numeric env (e.g. "disabled") yields NaN,
  // which would flow into the notification enqueue make_interval($N::int) and
  // break ALL SDK notification delivery. Fall back to 90 for non-finite/negative.
  notificationDesktopGraceSeconds: (() => {
    const n = Number(process.env.NOTIFICATION_DESKTOP_GRACE_SECONDS || 90)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 90
  })(),
  approvalRlReissuePerMin: Number(process.env.APPROVAL_RL_REISSUE_PER_MIN || 5),
  // Cleanup of stale token-bucket rows (older than 5 min — the only active
  // window). 5 min lines up with the longest bucket window we use.
  approvalRlCleanupIntervalMs: Number(process.env.APPROVAL_RL_CLEANUP_INTERVAL_MS || 5 * 60_000),
  adminRevokedTokenCleanupIntervalMs: Number(
    process.env.CONTROL_API_ADMIN_REVOKED_TOKEN_CLEANUP_INTERVAL_MS || 5 * 60_000
  ),
  oauthStateHmacSecret: requiredOrDevDefault(
    'CONTROL_API_OAUTH_STATE_HMAC_SECRET',
    'dev-oauth-state-hmac-secret-32-bytes-pad'
  ),
  oauthEncryptionKey: requiredOrDevDefault(
    'CONTROL_API_OAUTH_ENCRYPTION_KEY',
    // 32-byte hex-encoded dev key (AES-256-GCM). Prod must override.
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  ),
  // Optional: when set, used verbatim as the origin of the public OAuth callback
  // URL (the redirect_uri). Empty → derive from the request Host (local dev).
  oauthCallbackBaseUrl: process.env.CONTROL_API_OAUTH_CALLBACK_BASE_URL ?? '',
  // SharedFileSystem feature defaults — keep these aligned with the wfc
  // service's WSF_* env names and with HCC's CONTEXT_MAPPER_WFC_* defaults.
  //
  // v1 invariant: SharedFileSystem CRDs always live with the Hosts that mount
  // their PVCs read-only, i.e. in the Hosts namespace. So this MUST default to
  // HOSTS_NAMESPACE (not a hardcoded `mcp-host`): on a per-tenant MCC cluster
  // the Hosts namespace is `mcp-host-<slug>`, and the SharedFilesystems admin
  // route + the granted RBAC both target that tenant namespace. Defaulting to
  // a bare `mcp-host` made the route query the untenanted namespace and 403
  // (its RBAC is granted in `mcp-host-<slug>`, never `mcp-host`). The explicit
  // CONTROL_API_SHARED_FILESYSTEMS_NAMESPACE override still wins when set.
  sharedFilesystemsNamespace:
    process.env.CONTROL_API_SHARED_FILESYSTEMS_NAMESPACE || HOSTS_NAMESPACE,
  wfcJwtAudience: process.env.CONTROL_API_WFC_JWT_AUDIENCE || 'workspace-files-controller',
  wfcTokenTtlSeconds: Number(process.env.CONTROL_API_WFC_TOKEN_TTL_SECONDS || 300),
  gfsTokenAudience: process.env.CONTROL_API_GFS_JWT_AUDIENCE || 'gfs-controller',
  gfsTokenTtlSeconds: Number(process.env.CONTROL_API_GFS_TOKEN_TTL_SECONDS || 3600),
  gfscBaseUrl: process.env.CONTROL_API_GFSC_BASE_URL || 'http://gfsc.gfs.svc.cluster.local:8087',
  gfscWriteBaseUrl:
    process.env.CONTROL_API_GFSC_WRITE_BASE_URL || 'http://gfsc-writer.gfs.svc.cluster.local:8087',
  // {hash} = first 10 chars of sha256(`${ns}/${name}`); see sharedFileSystemHash
  // in host-context-controller/src/k8s/sharedFileSystemFactory.ts.
  wfcServiceUrlTemplate:
    process.env.CONTROL_API_WFC_SERVICE_URL_TEMPLATE ||
    'http://wfc-{hash}.mcp-host.svc.cluster.local:8086',
  // Plugin image-host allowlist (Phase 2.3). Permissive default = current
  // fleet hosts + example.com; enforce defaults to false (audit
  // mode). NOT parseCsvList — that lowercases, which would corrupt prefixes.
  allowedPluginImagePrefixes: (
    process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES ??
    [...DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES].join(',')
  )
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  // Match HCC's getEnvBool truthy set (true/1, case-insensitive) so the paired
  // enforce flags (CONTROL_API_/CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST) agree on
  // operator input and don't diverge at the enforce flip.
  enforcePluginImageAllowlist:
    (process.env.CONTROL_API_ENFORCE_IMAGE_ALLOWLIST ?? '').toLowerCase() === 'true' ||
    process.env.CONTROL_API_ENFORCE_IMAGE_ALLOWLIST === '1',
}

// Namespace config validation: fail fast if any namespace is empty.
// Empty namespace would target the K8s default namespace — a silent security gap.
const NAMESPACE_KEYS: (keyof Config)[] = [
  'hostsNamespace',
  'contextsNamespace',
  'communicationChannelsNamespace',
  'mcpServersNamespace',
  'sandboxNamespace',
  'sandboxUiNamespace',
  'secretsNamespace',
  'sharedFilesystemsNamespace',
]
for (const key of NAMESPACE_KEYS) {
  if (!(config[key] as string).trim()) {
    throw new Error(
      `[CONFIG] Namespace config "${key}" is empty. ` +
        'All namespace values must be non-empty strings.'
    )
  }
}

// Registry consumer auth guard: when auth is on, refuse to boot without OAuth2
// credentials and refuse a registry URL outside the allowlist (defense against
// cross-environment misconfiguration sending writes to the wrong registry).
if (config.registryAuthEnabled) {
  // Mode must be set EXPLICITLY when the registry is enabled — never inferred
  // from which credentials happen to be present (S10: no silent split-brain).
  if (!process.env.REGISTRY_CONNECTION_MODE) {
    throw new Error(
      'REGISTRY_CONNECTION_MODE is required (managed|self-hosted) when CLERUM_REGISTRY_AUTH_ENABLED=true'
    )
  }
  console.log(`[ControlAPI] Registry connection mode: ${config.registryConnectionMode}`)

  // URL allowlist applies in BOTH modes. The shared registry
  // `registry.evenfire.ai` is the default a self-hoster connects to (see
  // docs/how-to/connect-to-registry.md); the in-cluster URL covers a
  // self-hosted registry-api. A deployment that runs its own registry adds its
  // URL via CLERUM_REGISTRY_URL_ALLOWLIST (comma-separated) rather than editing
  // this list. `example.com` is the reserved-domain fixture used across the
  // test suite — inert (no real registry) and kept so tests need no churn.
  const allowed = [
    'https://registry.evenfire.ai',
    'http://registry-api.registry.svc.cluster.local:8085',
    'https://example.com',
    // Trim-only (NOT parseCsvList, which lowercases) — the entries are compared
    // verbatim against config.registryUrl, which is not lowercased.
    ...(process.env.CLERUM_REGISTRY_URL_ALLOWLIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  ]
  if (process.env.CLERUM_DEV_MODE === 'true') {
    allowed.push('http://localhost:8085')
  }
  if (!allowed.includes(config.registryUrl)) {
    throw new Error(
      `CLERUM_REGISTRY_URL=${config.registryUrl} is not in the registry URL allowlist: ${allowed.join(', ')}`
    )
  }

  if (config.registryConnectionMode === 'managed') {
    // Managed machine creds live in env (unchanged).
    if (!config.registryClientId) {
      throw new Error(
        'CLERUM_REGISTRY_CLIENT_ID is required in managed mode with registry auth enabled'
      )
    }
    if (!config.registryClientSecret) {
      throw new Error(
        'CLERUM_REGISTRY_CLIENT_SECRET is required in managed mode with registry auth enabled'
      )
    }
    // Voucher v2 material is MANDATORY in managed mode (M3 cutover done — no
    // break-glass legacy fallback remains).
    if (!config.registryVoucherPrivateKey) {
      throw new Error(
        'CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY is required in managed mode (voucher v2)'
      )
    }
    if (!config.registryVoucherKid) {
      throw new Error('CONTROL_API_REGISTRY_VOUCHER_KID is required in managed mode (voucher v2)')
    }
  }
  // self-hosted: env creds/material NOT required here — they come from the
  // registry_connection row. The "no row" fail-fast is an async guard in main.ts
  // AFTER initDb (config.ts is sync and cannot query Postgres). See Task 8.
}

// Production safety check: reject known dev keys at startup
if (process.env.NODE_ENV === 'production') {
  // NOTE: the old voucher-key fallback WARN (dedicated key unset → sign with the
  // admin JWT key) is gone. Under voucher v2 a managed prod boot without the
  // dedicated key/kid FAILS FAST in the registryAuthEnabled guard above (unless
  // break-glass), so there is no silent fallback left to warn about.

  const devKeyFingerprint = 'MIIEvAIBADANBgkqhkiG9w0BAQEFAASC' // start of DEV_RPC_JWT_PRIVATE_KEY
  const devSessionFingerprint = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC' // start of DEV_SESSION_JWT_PRIVATE_KEY
  const devAdminFingerprint = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCysO8J' // start of DEV_ADMIN_JWT_PRIVATE_KEY
  if (
    config.rpcJwtPrivateKey.includes(devKeyFingerprint) ||
    config.sessionJwtPrivateKey.includes(devSessionFingerprint) ||
    config.adminJwtPrivateKey.includes(devKeyFingerprint) ||
    config.adminJwtPrivateKey.includes(devAdminFingerprint)
  ) {
    throw new Error(
      '[SECURITY] Production startup rejected: hardcoded dev JWT signing keys detected. ' +
        'Set CONTROL_API_RPC_JWT_PRIVATE_KEY, CONTROL_API_SESSION_JWT_PRIVATE_KEY, and ' +
        'CONTROL_API_ADMIN_JWT_PRIVATE_KEY to real secrets.'
    )
  }

  for (const [serviceName, token] of Object.entries(config.internalServiceTokens)) {
    if (/^dev-/.test(token)) {
      throw new Error(
        `[SECURITY] Production startup rejected: default dev internal service token detected for "${serviceName}". ` +
          'Set CONTROL_API_INTERNAL_SERVICE_TOKENS to deployment-specific secrets.'
      )
    }
  }
}
