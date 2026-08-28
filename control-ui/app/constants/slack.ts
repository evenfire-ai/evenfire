/**
 * Slack's "Create an app" chooser, where "From an app manifest" is one of the
 * options. Configuration rather than copy: it is an external service address,
 * and the edit page renders the same manifest block, so it belongs somewhere
 * both pages can reach instead of inline in one of them.
 */
export const SLACK_NEW_APP_URL = 'https://api.slack.com/apps?new_app=1'
