export function shouldPurgeSandboxUiDeepLinks(
  previousIdentity: string | null | undefined,
  currentIdentity: string | null
): boolean {
  return (
    previousIdentity !== undefined &&
    previousIdentity !== null &&
    previousIdentity !== currentIdentity
  )
}
