export const EXTERNAL_REST_API_INTERNAL_URL =
  process.env.EXTERNAL_REST_API_INTERNAL_URL ||
  // In-namespace Service name: works in dedicated `profiles` and shared
  // `profiles-<slug>`. Do not default to `.profiles.svc.cluster.local` —
  // Next bakes this rewrite at image build, so that FQDN 500s on shared
  // tenants (ENOTFOUND). Runtime env still wins when Next evaluates it.
  'http://external-rest-api:8091'
