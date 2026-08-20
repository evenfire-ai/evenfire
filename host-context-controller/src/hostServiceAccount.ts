/**
 * Per-Host ServiceAccount naming. HCC discovery TokenReview maps
 * `system:serviceaccount:<hostNamespace>:<this>` back to the Host name.
 * Keep in lockstep with HostReconciler.ensureHostServiceAccount.
 */
export function hostServiceAccountName(hostName: string): string {
  return `host-${hostName}-sa`
}
