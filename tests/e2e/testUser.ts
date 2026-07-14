/**
 * Canonical E2E test identity.
 *
 * Keep this aligned with:
 * - scripts/e2e/seed-e2e-data.sh
 * - scripts/minikube/seed-test-data.sh
 * - scripts/minikube/full-setup.sh
 *
 * The repo-wide default is test@clerum.io. Cluster-backed E2E suites should
 * import this helper instead of hardcoding local fallback emails.
 */
export const E2E_TEST_EMAIL =
  process.env.E2E_DEV_LOGIN_EMAIL ??
  process.env.TEST_USER_EMAIL ??
  process.env.CLERUM_TEST_USER_EMAIL ??
  'test@clerum.io'

export const E2E_TEST_NAME = process.env.E2E_DEV_LOGIN_NAME ?? 'Test User'

export const E2E_TEST_HOST_REF = process.env.E2E_HOST_REF ?? 'chatllm'

export function getE2ETestCandidateEmails(): string[] {
  return [
    process.env.E2E_DEV_LOGIN_EMAIL,
    process.env.TEST_USER_EMAIL,
    process.env.CLERUM_TEST_USER_EMAIL,
    'test@clerum.io',
  ].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index
  )
}
