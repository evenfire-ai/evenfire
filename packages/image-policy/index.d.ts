export declare const SHA256_IMAGE_DIGEST_RE: RegExp
export declare function hasLatestTag(image: string): boolean
export declare function hasInvalidDigest(image: string): boolean
export declare function hasValidSha256Digest(image: string): boolean
export declare function hasUnsafeImageReferenceSyntax(image: string): boolean
export declare function matchesAllowedImagePrefix(image: string, rawPrefix: string): boolean

export declare const DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES: readonly string[]

export type PluginImageDenyReason = 'empty' | 'unsafe_syntax' | 'latest_tag' | 'host_not_allowed'
export type PluginImageDecision = { ok: true } | { ok: false; reason: PluginImageDenyReason }
export interface ClassifyPluginImageOptions {
  allowedPrefixes?: string[]
  rejectLatest?: boolean
}
export declare function classifyPluginImage(
  image: unknown,
  options?: ClassifyPluginImageOptions
): PluginImageDecision
