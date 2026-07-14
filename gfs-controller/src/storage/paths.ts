import { resolve, sep } from "node:path";

/**
 * Path safety for the flat blob layout. Bytes live at
 * `<storage-prefix>/<resourceId>` and the ONLY path component derived from
 * caller input is the resourceId. By constraining it to lowercase hex (a UUID
 * or its 32-hex `rid` form), every traversal vector — `..`, NUL, backslash,
 * absolute markers, path separators — is rejected by construction, before any
 * filesystem call. We additionally re-anchor and assert containment under the
 * prefix as defense in depth. gfsc never trusts inode identity for authz.
 */

const RID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PathError extends Error {
  readonly code = "path_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Normalize a resourceId to its canonical on-disk key (lowercase 32-hex).
 * Accepts a UUID (with hyphens) or the bare 32-hex `rid` form. Throws
 * PathError on anything else — this is the single chokepoint that makes path
 * traversal impossible.
 */
export function normalizeResourceId(resourceId: unknown): string {
  if (typeof resourceId !== "string") {
    throw new PathError("resourceId must be a string");
  }
  const value = resourceId.trim().toLowerCase();
  if (UUID_RE.test(value)) return value.replace(/-/g, "");
  if (RID_RE.test(value)) return value;
  throw new PathError(`invalid resourceId: ${JSON.stringify(resourceId)}`);
}

/**
 * Resolve the absolute on-disk blob path, guaranteed to sit directly under the
 * storage prefix. Because the key is hex-only it can contain no separators,
 * `..`, NUL, backslash, or absolute markers; the containment assertion is a
 * second, independent guard.
 */
export function resolveBlobPath(storagePrefix: string, resourceId: unknown): string {
  const key = normalizeResourceId(resourceId);
  const base = resolve(storagePrefix);
  const full = resolve(base, key);
  if (full !== `${base}${sep}${key}`) {
    throw new PathError("resolved blob path escapes the storage prefix");
  }
  return full;
}
