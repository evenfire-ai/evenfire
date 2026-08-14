/**
 * Placeholder origin shown in guidance copy, and used to build a placeholder
 * command, when the deployment has no public webhook address to substitute.
 * Substituting it by hand for a real origin is the documented workflow for a
 * self-hosted (minikube) deployment, so a command built from this placeholder
 * is deliberately still rendered rather than withheld.
 */
export const LOCAL_TEAMS_ENDPOINT_ORIGIN = 'https://<public-webhook-origin>'

/**
 * Longest `spec.teamsSettings.appName` control-api accepts
 * (validateCommunicationChannelSpec).
 */
export const TEAMS_APP_NAME_MAX_LENGTH = 80

/**
 * The one rule for a Teams app name, mirroring the server contract exactly:
 * non-empty after trimming, at most TEAMS_APP_NAME_MAX_LENGTH characters.
 *
 * It is a free-form DISPLAY name, so spaces and capitals are legitimate: the
 * CRD declares `appName` as a plain string with no pattern (unlike `tenantId`
 * right below it, which does carry one), control-api checks only emptiness and
 * length (unlike `appId`, which carries a UUID regex), and the Teams CLI
 * documents `--name` as "App/bot name" with `--name "My Bot"` as its own
 * example. A stricter UI rule would reject names Teams and the server both
 * accept, and would block saving a channel whose stored name predates the rule.
 *
 * Returns the message to show, or null when the value is acceptable. Callers
 * share this one function so no page can drift onto its own rule.
 */
export function teamsAppNameError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Teams bot name is required.'
  if (trimmed.length > TEAMS_APP_NAME_MAX_LENGTH) {
    return `Teams bot name must be ${TEAMS_APP_NAME_MAX_LENGTH} characters or fewer.`
  }
  return null
}

/**
 * The Teams CLI needs an absolute endpoint, and Microsoft requires a publicly
 * reachable HTTPS one: a bot registered against `http://` cannot receive
 * activities. A deployment with no NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL
 * and a hostname that does not start with `app.` produces a bare path, which
 * would point a bot at a host that does not exist. Unlike
 * canGenerateSlackAppManifest, this deliberately does not accept `http://`.
 */
export function canGenerateTeamsCommand(endpoint: string | null | undefined): boolean {
  return /^https:\/\//i.test(endpoint ?? '')
}

/**
 * Endpoint to render when canGenerateTeamsCommand said no: the marker origin
 * plus the reader path, for the operator to substitute by hand.
 *
 * The rejected value is usually a bare path (the minikube case), but it can
 * also be an absolute `http://` URL, from an http
 * NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL or from browsing an `app.` host
 * over http. Concatenating that onto the marker would render
 * `https://<public-webhook-origin>http://host/path`, so the origin is dropped
 * and only the path is kept.
 */
export function teamsPlaceholderEndpoint(endpoint: string): string {
  const origin = endpoint.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)
  const path = origin ? endpoint.slice(origin[0].length) : endpoint
  return `${LOCAL_TEAMS_ENDPOINT_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * `teams app create` command that writes the generated CLIENT_ID, TENANT_ID,
 * and CLIENT_SECRET into `.env`. `endpoint` must be absolute; callers gate on
 * canGenerateTeamsCommand and render a warning instead of calling this with a
 * relative path.
 */
/**
 * `--sign-in-audience myOrg` is not optional in practice. channel-reader fetches
 * its bot token from `login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`,
 * which only works for a single-tenant app; a multi-tenant registration needs the
 * botframework.com authority and fails with an AADSTS error. The CLI documents
 * `myOrg` and `multipleOrgs` as the accepted values but does not document which
 * one it defaults to, so it is pinned here rather than assumed.
 */
export function buildTeamsAppCreateCommand(params: { botName: string; endpoint: string }): string {
  const botName = params.botName.trim() || '<bot-name>'
  return [
    'teams app create \\',
    `  --name "${botName}" \\`,
    `  --endpoint "${params.endpoint}" \\`,
    '  --sign-in-audience myOrg \\',
    '  --env .env',
  ].join('\n')
}

/**
 * Enabling file delivery is a manifest property, not a Developer Portal toggle.
 * Older guidance points at App features > Bot > "Upload and download files",
 * which the current portal does not present.
 *
 * The app id is CLIENT_ID: on a teams-managed bot the Teams App ID, the Bot ID
 * and CLIENT_ID are all the same UUID. So once the operator has pasted
 * CLIENT_ID into this form, the command is complete and needs no editing.
 *
 * The fallback is deliberately NOT an angle-bracket placeholder. `<appId>` is a
 * redirect in sh and zsh, so pasting it unedited fails with
 * "no such file or directory: appId" rather than anything that points at the
 * real problem.
 */
export function buildTeamsSupportsFilesCommand(appId?: string): string {
  const id = appId?.trim() || 'YOUR_CLIENT_ID'
  return `teams app manifest update ${id} --set-json 'bots[0].supportsFiles=true' --yes`
}
