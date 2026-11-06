/**
 * The branch-profile name shape `make` enforces for the #825 lanes
 * (`Makefile`, `^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$`). Specs that create
 * and delete cluster objects check it themselves, so a direct
 * `npx playwright test` run cannot target the shared `minikube` profile or
 * any other cluster.
 */
const BRANCH_PROFILE_RE = /^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/

export function assertBranchProfileContext(context: string): void {
  if (!BRANCH_PROFILE_RE.test(context)) {
    throw new Error(
      `Context '${context}' is not a branch-scoped Minikube profile (expected ${BRANCH_PROFILE_RE.source}).`
    )
  }
}
