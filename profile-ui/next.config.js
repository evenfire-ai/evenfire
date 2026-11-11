const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@clerum/frontend-components'],
  turbopack: {
    root: path.join(__dirname, '..'),
  },
  experimental: {
    globalNotFound: true,
    // Next 16.4 defaults this to 'security': when it detects a coding agent,
    // `next build`/`next dev` check npm advisories and can block the build
    // until the agent upgrades Next. Dependency upgrades here go through
    // reviewed PRs, so builds must not depend on that live advisory lookup.
    agentUpgrade: false,
  },
  async rewrites() {
    const destination =
      process.env.EXTERNAL_REST_API_INTERNAL_URL ||
      'http://external-rest-api.profiles.svc.cluster.local:8091'
    // WARNING (see evenfire #287, and RC2 in PR #280): this rewrite routes through
    // Next's internal proxy, which silently truncates request bodies at 10MiB and
    // hard-caps at a 30s proxyTimeout — the exact construct RC2 removed from
    // control-ui. It is latent here only because profile-ui has NO large-body /
    // base64 / file-upload route. Do NOT add a GFS-style upload route behind this
    // rewrite without first replacing it with an app-router handler (as control-ui
    // did), or uploads will truncate at 10MiB / time out at 30s.
    return [
      {
        source: '/external-rest-api/:path*',
        destination: `${destination}/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
