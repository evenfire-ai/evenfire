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
    const controlApiDestination = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
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
      {
        source: '/control-api/:path*',
        destination: `${controlApiDestination}/:path*`,
      },
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
      { source: '/marketplace', destination: '/marketplace/connectors', permanent: true },
      { source: '/cost-and-usage', destination: '/cost-and-usage/usage', permanent: true },
      {
        source: '/agent-outputs',
        destination: '/agent-outputs/recipe-artifacts',
        permanent: true,
      },
      { source: '/outputs', destination: '/agent-outputs/recipe-artifacts', permanent: true },
      { source: '/outputs/:path*', destination: '/agent-outputs/:path*', permanent: true },
      {
        source: '/contexts/:name/shared-files',
        destination: '/contexts/:name/agent-files',
        permanent: true,
      },
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
