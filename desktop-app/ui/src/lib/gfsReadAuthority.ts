const GFS_PERMISSION_BITS = new Set(['read', 'write', 'delete', 'manage_acl', 'share'])

/** The AppService affordance projection is the only client result that can authorize a raw link. */
export function hasExactGfsReadAuthority(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const held = result.held
  const grantableBits = result.grantableBits
  if (
    !Array.isArray(held) ||
    !Array.isArray(grantableBits) ||
    typeof result.canDelegate !== 'boolean' ||
    typeof result.canCreateShare !== 'boolean'
  )
    return false
  const validUniqueBits = (bits: unknown[]) =>
    bits.every(bit => typeof bit === 'string' && GFS_PERMISSION_BITS.has(bit)) &&
    new Set(bits).size === bits.length
  return validUniqueBits(held) && validUniqueBits(grantableBits) && held.includes('read')
}
