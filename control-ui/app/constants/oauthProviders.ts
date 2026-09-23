// Display metadata for the 8 baked OAuth providers (Slice 1). The provider id is
// the frozen enum control-api serves via isKnownOAuthProvider; these are only
// labels and the provider's own "where to register the redirect URI" docs shown
// beside the redirect URI in the install wizard (D-B4). The generic sentinel is
// Slice 3 and intentionally absent.

export const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  'microsoft-graph': 'Microsoft 365',
  slack: 'Slack',
  salesforce: 'Salesforce',
  notion: 'Notion',
  monday: 'monday.com',
  clickup: 'ClickUp',
  vercel: 'Vercel',
}

// Where the operator registers the OAuth app + redirect URI for each provider.
// A missing entry simply renders no docs link (the redirect URI + copy button
// remain the primary affordance).
export const OAUTH_PROVIDER_DOC_URLS: Record<string, string> = {
  google: 'https://console.cloud.google.com/apis/credentials',
  'microsoft-graph':
    'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app',
  slack: 'https://api.slack.com/apps',
  salesforce: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
  notion: 'https://www.notion.so/my-integrations',
  monday: 'https://developer.monday.com/apps/docs/oauth',
  clickup: 'https://developer.clickup.com/docs/authentication',
  vercel: 'https://vercel.com/docs/rest-api/reference/integrations',
}

export function oauthProviderLabel(provider: string): string {
  return OAUTH_PROVIDER_LABELS[provider] ?? provider
}
