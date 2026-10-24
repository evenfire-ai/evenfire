/** Move requires write and delete authority on the exact old parent. */
export function hasGfsMoveSourcePermissions(held: readonly string[] | null | undefined): boolean {
  return Boolean(held?.includes('write') && held.includes('delete'))
}
