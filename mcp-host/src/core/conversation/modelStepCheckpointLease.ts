/** A pending approval for the same active task holds its claim until consent expires. */
export function isModelStepCheckpointLeaseAlive(
  header: { status: string; claim_expires_at: number | null },
  approvalExpiresAt: number | null,
  now: number
): boolean {
  return (
    header.status === 'claimed' &&
    ((header.claim_expires_at !== null && header.claim_expires_at > now) ||
      (approvalExpiresAt !== null && approvalExpiresAt > now))
  )
}
