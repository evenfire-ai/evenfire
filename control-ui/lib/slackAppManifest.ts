const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'chat:write',
  'files:write',
  'users:read',
]

const BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
]

/**
 * A double-quoted YAML scalar, always. Quoting only what looks unsafe leaves the
 * YAML type traps behind: `123`, `no`, `true`, and `null` are all valid app
 * names and all parse as non-strings when written plain. Double quotes also give
 * the only style that carries escapes, which a name with a newline in it needs.
 */
function yamlScalar(value: string): string {
  const escaped = value
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${escaped}"`
}

/**
 * Slack rejects a manifest whose `request_url` is relative, and the
 * `slackWebhookUrlFor*` helpers fall back to a bare path when the deployment has
 * no public webhook address (the minikube case). Callers must warn instead of
 * handing over a manifest Slack cannot accept.
 */
export function canGenerateSlackAppManifest(requestUrl: string | null | undefined): boolean {
  return /^https?:\/\//i.test(requestUrl ?? '')
}

/**
 * Slack app manifest for this channel. Both request URLs are the same value:
 * the reader serves events and interactivity on one route. Setting only the
 * events URL leaves approval buttons silently dead, because Slack blocks the
 * click client-side and nothing reaches the cluster.
 *
 * `requestUrl` must be absolute. Slack rejects a relative `request_url`, so
 * callers render a warning instead of a manifest when they only have a path.
 */
export function slackAppManifest(appName: string, requestUrl: string): string {
  const name = yamlScalar(appName)
  return `display_information:
  name: ${name}
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${name}
    always_online: false
oauth_config:
  scopes:
    bot:
${BOT_SCOPES.map(scope => `      - ${scope}`).join('\n')}
settings:
  event_subscriptions:
    request_url: ${requestUrl}
    bot_events:
${BOT_EVENTS.map(event => `      - ${event}`).join('\n')}
  interactivity:
    is_enabled: true
    request_url: ${requestUrl}
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`
}
