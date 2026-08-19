import { join, resolve } from "node:path";

/**
 * Path safety for both legacy flat blobs and immutable generations. New bytes
 * live in a reserved internal namespace while their logical key remains
 * `<resourceId>/<generation>`; legacy rows whose metadata has no blob key
 * continue to resolve to `<storage-prefix>/<resourceId>`.
 */

const RID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERATION_RE = UUID_RE;
export const GENERATION_STORAGE_DIRECTORY = ".generations";

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

export function normalizeGeneration(generation: unknown): string {
  if (typeof generation !== "string") {
    throw new PathError("generation must be a string");
  }
  const value = generation.trim().toLowerCase();
  if (!GENERATION_RE.test(value)) {
    throw new PathError(`invalid generation: ${JSON.stringify(generation)}`);
  }
  return value;
}

export function generationBlobKey(resourceId: unknown, generation: unknown): string {
  return `${normalizeResourceId(resourceId)}/${normalizeGeneration(generation)}`;
}

export function normalizeBlobKey(blobKey: unknown): string {
  if (typeof blobKey !== "string") throw new PathError("blobKey must be a string");
  const parts = blobKey.split("/");
  if (parts.length !== 2) throw new PathError("blobKey must contain resource id and generation");
  return generationBlobKey(parts[0], parts[1]);
}

/**
 * Resolve the absolute on-disk blob path, guaranteed to sit directly under the
 * storage prefix. Because the key is hex-only it can contain no separators,
 * `..`, NUL, backslash, or absolute markers; the containment assertion is a
 * second, independent guard.
 */
export function resolveBlobPath(
  storagePrefix: string,
  resourceId: unknown
): string {
  const key = normalizeResourceId(resourceId);
  const base = resolve(storagePrefix);
  const relative = [key];
  const full = resolve(base, ...relative);
  if (full !== join(base, ...relative)) {
    throw new PathError("resolved blob path escapes the storage prefix");
  }
  return full;
}
export function resolveBlobKeyPath(storagePrefix: string, blobKey: unknown): string {
  const key = normalizeBlobKey(blobKey);
  const base = resolve(storagePrefix);
  const relative = [GENERATION_STORAGE_DIRECTORY, ...key.split("/")];
  const full = resolve(base, ...relative);
  if (full !== join(base, ...relative)) {
    throw new PathError("resolved blob key escapes the storage prefix");
  }
  return full;
}
