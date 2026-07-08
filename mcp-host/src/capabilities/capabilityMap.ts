/**
 * Static capability map.
 *
 * Each entry advertises a third-party integration the agent can reach via
 * the shell once the operator has set the required env vars. The capability
 * `name` and `hint` are public to the LLM via `clerum__get_capabilities`;
 * the `requires[]` env-var names are checked at call time against the
 * effective env (ConfigStore + process.env) and surfaced as booleans only.
 *
 * Hints are STATIC strings — never derived from a value. Never include a
 * secret substring. They tell the model *how* to use a credential
 * (`$VAR` shell expansion) without ever revealing the value.
 *
 * Provider keys (OPENAI_API_KEY, ZAI_API_KEY, etc.) are intentionally NOT
 * entries in this map: they're required for the Host itself to function,
 * not an LLM-visible capability.
 */

export interface Capability {
  /** Short identifier exposed to the LLM, e.g. `'github'`. */
  name: string
  /** Env var names that must be non-empty for `configured: true`. */
  requires: string[]
  /** Static usage hint shown to the LLM. No secret substrings; safe to log. */
  hint: string
}

export const CAPABILITY_MAP: Capability[] = [
  {
    name: 'github',
    requires: ['GITHUB_TOKEN'],
    hint:
      'Available as $GITHUB_TOKEN. Use `gh` CLI (reads token from env) or ' +
      '`curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/...`.',
  },
  {
    name: 'brave_search',
    requires: ['BRAVE_SEARCH_API_KEY'],
    hint:
      'Available as $BRAVE_SEARCH_API_KEY. Call with ' +
      '`curl -H "X-Subscription-Token: $BRAVE_SEARCH_API_KEY" "https://api.search.brave.com/res/v1/web/search?q=..."`.',
  },
  {
    name: 'smtp',
    requires: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
    hint:
      'Available as $SMTP_HOST, $SMTP_USER, $SMTP_PASS. Use `msmtp` or any ' +
      'SMTP-aware mailer that reads credentials from environment variables.',
  },
  {
    name: 'slack',
    requires: ['SLACK_BOT_TOKEN'],
    hint:
      'Available as $SLACK_BOT_TOKEN. Call ' +
      '`curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" ' +
      '-d \'{"channel":"#x","text":"y"}\' https://slack.com/api/chat.postMessage`.',
  },
  {
    name: 'sendgrid',
    requires: ['SENDGRID_API_KEY'],
    hint:
      'Available as $SENDGRID_API_KEY. Call ' +
      '`curl -X POST https://api.sendgrid.com/v3/mail/send -H "Authorization: Bearer $SENDGRID_API_KEY" -H "Content-Type: application/json" -d @body.json`.',
  },
]

/**
 * Capability is configured iff every required env var resolves to a
 * non-empty string in the supplied env-getter.
 */
export function isCapabilityConfigured(
  cap: Capability,
  getEnv: (key: string) => string | undefined
): boolean {
  for (const k of cap.requires) {
    const v = getEnv(k)
    if (typeof v !== 'string' || v.length === 0) return false
  }
  return true
}
