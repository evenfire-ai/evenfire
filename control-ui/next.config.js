/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
      { source: '/shared-files', destination: '/shared-filesystems' },
      { source: '/shared-files/:path*', destination: '/shared-filesystems/:path*' },
      { source: '/global-files', destination: '/gfs' },
      { source: '/global-files/:path*', destination: '/gfs/:path*' },
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
      { source: '/shared-filesystems', destination: '/shared-files', permanent: true },
      {
        source: '/shared-filesystems/:path*',
        destination: '/shared-files/:path*',
        permanent: true,
      },
      { source: '/gfs', destination: '/global-files', permanent: true },
      { source: '/gfs/:path*', destination: '/global-files/:path*', permanent: true },
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
      { source: '/cost', destination: '/cost-and-usage/usage', permanent: true },
      { source: '/cost/:path*', destination: '/cost-and-usage/:path*', permanent: true },
      { source: '/marketplace', destination: '/marketplace/connectors', permanent: true },
      { source: '/cost-and-usage', destination: '/cost-and-usage/usage', permanent: true },
      { source: '/outputs', destination: '/outputs/recipe-artifacts', permanent: true },
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
