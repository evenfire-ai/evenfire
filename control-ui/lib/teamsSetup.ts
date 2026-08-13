/**
 * Placeholder origin shown in guidance copy, and used to build a placeholder
 * command, when the deployment has no public webhook address to substitute.
 * Substituting it by hand for a real origin is the documented workflow for a
 * self-hosted (minikube) deployment, so a command built from this placeholder
 * is deliberately still rendered rather than withheld.
 */
export const LOCAL_TEAMS_ENDPOINT_ORIGIN = 'https://<public-webhook-origin>'

const TEAMS_BOT_NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/

/**
 * Teams CLI `--name` constraint: lowercase letters, numbers, and hyphens,
 * starting with a letter. Shared by the create and edit pages so both gate
 * Copy on the same rule instead of one silently drifting from the other.
 */
export function isValidTeamsBotName(value: string): boolean {
  return TEAMS_BOT_NAME_RE.test(value.trim())
}

/**
 * The Teams CLI needs an absolute endpoint. A deployment with no
 * NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL and a hostname that does not
 * start with `app.` produces a bare path, which would register a bot pointing
 * at a host that does not exist. Mirrors canGenerateSlackAppManifest.
 */
export function canGenerateTeamsCommand(endpoint: string | null | undefined): boolean {
  return /^https?:\/\//i.test(endpoint ?? '')
}

/**
 * `teams app create` command that writes the generated CLIENT_ID, TENANT_ID,
 * and CLIENT_SECRET into `.env`. `endpoint` must be absolute; callers gate on
 * canGenerateTeamsCommand and render a warning instead of calling this with a
 * relative path.
 */
export function buildTeamsAppCreateCommand(params: { botName: string; endpoint: string }): string {
  const botName = params.botName.trim() || '<bot-name>'
  return [
    'teams app create \\',
    `  --name "${botName}" \\`,
    `  --endpoint "${params.endpoint}" \\`,
    '  --env .env',
  ].join('\n')
}
