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

/** Plain YAML scalars cannot carry ': ', '#', quotes, or leading punctuation. */
const YAML_PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

function yamlScalar(value: string): string {
  const trimmed = value.trim()
  if (YAML_PLAIN_SAFE.test(trimmed)) return trimmed
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Slack rejects a manifest whose `request_url` is relative, and
 * `slackWebhookUrlForChannel` falls back to a bare path when the deployment has
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
