/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const destination =
      process.env.EXTERNAL_REST_API_INTERNAL_URL ||
      "http://external-rest-api.profiles.svc.cluster.local:8091";
    return [
      {
        source: "/external-rest-api/:path*",
        destination: `${destination}/:path*`
      }
    ];
  }
};

module.exports = nextConfig;
