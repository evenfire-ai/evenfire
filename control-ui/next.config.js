const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    globalNotFound: true,
  },
  // Keep Turbopack rooted at the monorepo so it can resolve the linked
  // @clerum packages without guessing from whichever lockfile it finds first.
  turbopack: {
    root: path.join(__dirname, '..'),
  },
  async rewrites() {
    // NOTE: `/control-api/:path*` is intentionally NOT rewritten here. It is served by
    // the app-router handler app/control-api/[...path]/route.ts, which streams the body
    // (no 10MiB proxyClientMaxBodySize truncation) and honours the runtime-configurable
    // CONTROL_API_PROXY_TIMEOUT_MS. Routing it through a rewrite sends it via Next's
    // internal proxy, which silently truncates request bodies at 10MiB and hard-caps at
    // a 30s proxyTimeout — the "Request timed out" / "request aborted" failure on large
    // GFS uploads. The handler reads CONTROL_API_INTERNAL_URL for its upstream.
    return [
      { source: '/agents', destination: '/hosts' },
      { source: '/agents/:path*', destination: '/hosts/:path*' },
      { source: '/connectors', destination: '/mcp-servers' },
      { source: '/connectors/:path*', destination: '/mcp-servers/:path*' },
      { source: '/plugins/sdk', destination: '/plugin-workload-sdk' },
      { source: '/plugins', destination: '/workflow-recipes' },
      { source: '/plugins/:path*', destination: '/workflow-recipes/:path*' },
      { source: '/agent-files', destination: '/shared-filesystems' },
      { source: '/agent-files/:path*', destination: '/shared-filesystems/:path*' },
      { source: '/agent-outputs/:path*', destination: '/outputs/:path*' },
      { source: '/global-file-system', destination: '/gfs' },
      { source: '/global-file-system/:path*', destination: '/gfs/:path*' },
      { source: '/external-channels', destination: '/communication-channels' },
      {
        source: '/external-channels/:path*',
        destination: '/communication-channels/:path*',
      },
      { source: '/users-and-teams/admins/new', destination: '/control-admins/new' },
      { source: '/users-and-teams', destination: '/profile-admin/users' },
      { source: '/users-and-teams/:path*', destination: '/profile-admin/:path*' },
      { source: '/marketplace/connectors', destination: '/registry' },
      { source: '/marketplace/plugins', destination: '/registry' },
      { source: '/marketplace/:path*', destination: '/registry/:path*' },
      { source: '/cost-and-usage/:path*', destination: '/cost/:path*' },
      { source: '/settings/ui', destination: '/settings' },
    ]
  },
  async redirects() {
    // Cost & Usage consolidation: old top-level routes now live under /cost/*.
    // Keep bookmarks and deep links working (including their sub-routes).
    return [
      { source: '/hosts', destination: '/agents', permanent: true },
      { source: '/hosts/:path*', destination: '/agents/:path*', permanent: true },
      { source: '/mcp-servers', destination: '/connectors', permanent: true },
      { source: '/mcp-servers/:path*', destination: '/connectors/:path*', permanent: true },
      { source: '/workflow-recipes', destination: '/plugins', permanent: true },
      { source: '/workflow-recipes/:path*', destination: '/plugins/:path*', permanent: true },
      { source: '/plugin-workload-sdk', destination: '/plugins/sdk', permanent: true },
      { source: '/shared-filesystems', destination: '/agent-files', permanent: true },
      {
        source: '/shared-filesystems/:path*',
        destination: '/agent-files/:path*',
        permanent: true,
      },
      { source: '/shared-files', destination: '/agent-files', permanent: true },
      { source: '/shared-files/:path*', destination: '/agent-files/:path*', permanent: true },
      { source: '/gfs', destination: '/global-file-system', permanent: true },
      {
        source: '/gfs/:path*',
        destination: '/global-file-system/:path*',
        permanent: true,
      },
      { source: '/global-files', destination: '/global-file-system', permanent: true },
      {
        source: '/global-files/:path*',
        destination: '/global-file-system/:path*',
        permanent: true,
      },
      { source: '/communication-channels', destination: '/external-channels', permanent: true },
      {
        source: '/communication-channels/:path*',
        destination: '/external-channels/:path*',
        permanent: true,
      },
      { source: '/profile-admin', destination: '/users-and-teams', permanent: true },
      { source: '/profile-admin/:path*', destination: '/users-and-teams/:path*', permanent: true },
      {
        source: '/control-admins/new',
        destination: '/users-and-teams/admins/new',
        permanent: true,
      },
      { source: '/registry', destination: '/marketplace/connectors', permanent: true },
      { source: '/registry/:path*', destination: '/marketplace/:path*', permanent: true },
      // The Publisher console folded into the org-named Marketplace tab (§4).
      // Keep old bookmarks working. Specific routes precede the catch-all.
      { source: '/publisher/api-keys', destination: '/marketplace/keys', permanent: true },
      {
        source: '/publisher/credentials',
        destination: '/marketplace/org/credentials',
        permanent: true,
      },
      {
        source: '/publisher/shared-with-me',
        destination: '/marketplace/org/entries',
        permanent: true,
      },
      { source: '/publisher/entries', destination: '/marketplace/org/entries', permanent: true },
      { source: '/publisher', destination: '/marketplace/org/entries', permanent: true },
      { source: '/publisher/:path*', destination: '/marketplace/org/entries', permanent: true },
      { source: '/cost', destination: '/cost-and-usage/usage', permanent: true },
      { source: '/cost/:path*', destination: '/cost-and-usage/:path*', permanent: true },
      // Host detail tab consolidation (R1-H1 in feat/agent-ux-polish PR
      // review): the old top-level tabs are now sub-tabs under the new
      // `access` and `advanced` parents. Send each old slug to its new
      // parent so bookmarks, shared links, and the approval-tools E2E
      // (which navigates to /hosts/<name>/approvals) still reach the
      // section they used to.
      {
        source: '/agents/:name/member-access',
        destination: '/agents/:name/access',
        permanent: true,
      },
      { source: '/agents/:name/team-access', destination: '/agents/:name/access', permanent: true },
      { source: '/agents/:name/approvals', destination: '/agents/:name/advanced', permanent: true },
      { source: '/agents/:name/env-vars', destination: '/agents/:name/advanced', permanent: true },
      // The agent-scoped Contexts tab was renamed to Connectors. Keep old
      // bookmarks and shared links working before the /agents -> /hosts
      // rewrite reaches the physical tab route.
      {
        source: '/agents/:name/contexts',
        destination: '/agents/:name/connectors',
        permanent: true,
      },
      // Connector edit "Context" tab renamed to "Access".
      {
        source: '/connectors/:name/edit/context',
        destination: '/connectors/:name/edit/access',
        permanent: true,
      },
      // Users & Teams access tabs consolidated onto "Agents" (D10): the old
      // "Contexts" and "Access" tab URLs all land on the Agents tab.
      {
        source: '/users-and-teams/users/:id/contexts',
        destination: '/users-and-teams/users/:id/agents',
        permanent: true,
      },
      {
        source: '/users-and-teams/teams/:id/contexts',
        destination: '/users-and-teams/teams/:id/agents',
        permanent: true,
      },
      {
        source: '/users-and-teams/users/:id/access',
        destination: '/users-and-teams/users/:id/agents',
        permanent: true,
      },
      {
        source: '/users-and-teams/teams/:id/access',
        destination: '/users-and-teams/teams/:id/agents',
        permanent: true,
      },
      { source: '/marketplace', destination: '/marketplace/connectors', permanent: true },
      { source: '/cost-and-usage', destination: '/cost-and-usage/usage', permanent: true },
      {
        source: '/agent-outputs',
        destination: '/agent-outputs/recipe-artifacts',
        permanent: true,
      },
      { source: '/outputs', destination: '/agent-outputs/recipe-artifacts', permanent: true },
      { source: '/outputs/:path*', destination: '/agent-outputs/:path*', permanent: true },
      { source: '/secrets', destination: '/secrets/llm', permanent: true },
      { source: '/settings', destination: '/settings/ui', permanent: true },
      { source: '/traces/hosts', destination: '/traces', permanent: true },
      { source: '/traces/sessions', destination: '/traces', permanent: true },
      { source: '/traces/workflows', destination: '/traces', permanent: true },
      { source: '/usage', destination: '/cost-and-usage/usage', permanent: true },
      { source: '/usage/:path*', destination: '/cost-and-usage/usage/:path*', permanent: true },
      { source: '/llm-prices', destination: '/cost-and-usage/llm-prices', permanent: true },
      {
        source: '/llm-prices/:path*',
        destination: '/cost-and-usage/llm-prices/:path*',
        permanent: true,
      },
      { source: '/token-budgets', destination: '/cost-and-usage/token-budgets', permanent: true },
      {
        source: '/token-budgets/:path*',
        destination: '/cost-and-usage/token-budgets/:path*',
        permanent: true,
      },
    ]
  },
}

module.exports = nextConfig
