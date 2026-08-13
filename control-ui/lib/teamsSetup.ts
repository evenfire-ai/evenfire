/**
 * Placeholder origin shown in guidance copy when the deployment has no public
 * webhook address to substitute. Never used to build a real command: a
 * generated command either carries a real absolute endpoint or is not
 * generated at all.
 */
export const LOCAL_TEAMS_ENDPOINT_ORIGIN = 'https://<public-webhook-origin>'

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
