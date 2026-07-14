/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const controlApiDestination = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
    return [
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
      { source: '/usage', destination: '/cost/usage', permanent: true },
      { source: '/usage/:path*', destination: '/cost/usage/:path*', permanent: true },
      { source: '/llm-prices', destination: '/cost/llm-prices', permanent: true },
      { source: '/llm-prices/:path*', destination: '/cost/llm-prices/:path*', permanent: true },
      { source: '/token-budgets', destination: '/cost/token-budgets', permanent: true },
      {
        source: '/token-budgets/:path*',
        destination: '/cost/token-budgets/:path*',
        permanent: true,
      },
    ]
  },
}

module.exports = nextConfig
