import { Readable } from "node:stream";
import { normalizeResourceId, PathError } from "../storage/paths";
import { GfsError } from "./errors";

/** Internal resource record as stored in the permission store. */
export interface GfsResource {
  resourceId: string;
  drive: string;
  parentResourceId: string | null;
  name: string;
  kind: "file" | "directory";
  pathCache: string | null;
  version: number;
  bytes: number;
  deletedAt: string | null;
}

/** Public view returned to clients — includes the canonical gfs:// URI. */
export interface GfsResourceView {
  resourceId: string;
  rid: string;
  gfsUri: string;
  drive: string;
  parentResourceId: string | null;
  name: string;
  kind: "file" | "directory";
  path: string | null;
  version: number;
  bytes: number;
}

/**
 * Metadata access over the permission store. The DB-backed, authorization-aware
 * implementation lands in P1-S08; this interface keeps the read API testable in
 * isolation. listChildren returns rows ordered by (name, resourceId) strictly
 * AFTER the (afterName, afterId) cursor, EXCLUDING tombstoned rows.
 */
export interface ResourceStore {
  getResource(drive: string, resourceId: string): Promise<GfsResource | null>;
  listChildren(
    drive: string,
    parentResourceId: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<GfsResource[]>;
}

export interface BlobReader {
  read(resourceId: string): Promise<Readable>;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** Clamp a caller-supplied limit into [1, MAX_LIMIT]; default when absent/invalid. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

interface CursorPayload {
  n: string;
  i: string;
}

export function encodeCursor(resource: GfsResource): string {
  const payload: CursorPayload = { n: resource.name, i: resource.resourceId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.n !== "string" || typeof parsed.i !== "string") {
      throw new Error("malformed cursor payload");
    }
    return parsed;
  } catch {
    throw new GfsError("path_invalid", "invalid cursor");
  }
}

function ridOf(resourceId: string): string {
  return normalizeResourceId(resourceId);
}

export function toView(resource: GfsResource): GfsResourceView {
  const rid = ridOf(resource.resourceId);
  return {
    resourceId: resource.resourceId,
    rid,
    gfsUri: `gfs://${resource.drive}/${rid}`,
    drive: resource.drive,
    parentResourceId: resource.parentResourceId,
    name: resource.name,
    kind: resource.kind,
    path: resource.pathCache,
    version: resource.version,
    bytes: resource.bytes,
  };
}

function requireLive(resource: GfsResource | null, resourceId: string): GfsResource {
  if (!resource) throw new GfsError("not_found", `resource not found: ${resourceId}`);
  if (resource.deletedAt) throw GfsError.gone(`resource is deleted: ${resourceId}`, "resource_deleted");
  return resource;
}

/**
 * List the children of a directory, cursor-paginated. The store is asked for
 * limit+1 rows so we can tell whether another page exists WITHOUT a count(*)
 * over a potentially huge folder — bounded memory regardless of folder size.
 */
export async function listChildren(
  store: ResourceStore,
  drive: string,
  parentResourceId: string,
  opts: { limit?: unknown; cursor?: string }
): Promise<{ items: GfsResourceView[]; nextCursor: string | null }> {
  let normalizedParent: string;
  try {
    normalizedParent = ridOf(parentResourceId);
  } catch (err) {
    if (err instanceof PathError) throw new GfsError("path_invalid", err.message);
    throw err;
  }
  const parent = requireLive(await store.getResource(drive, normalizedParent), parentResourceId);
  if (parent.kind !== "directory") {
    throw new GfsError("not_a_directory", `resource is not a directory: ${parentResourceId}`);
  }

  const limit = clampLimit(opts.limit);
  const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  const rows = await store.listChildren(drive, normalizedParent, {
    limit: limit + 1,
    afterName: after?.n,
    afterId: after?.i,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;
  return { items: page.map(toView), nextCursor };
}

export async function statResource(
  store: ResourceStore,
  drive: string,
  resourceId: string
): Promise<GfsResourceView> {
  let normalized: string;
  try {
    normalized = ridOf(resourceId);
  } catch (err) {
    if (err instanceof PathError) throw new GfsError("path_invalid", err.message);
    throw err;
  }
  return toView(requireLive(await store.getResource(drive, normalized), resourceId));
}

/**
 * Stream a file's bytes. Returns the resource view (for headers like size) plus
 * a Readable — never buffers the whole file (no memory-DoS on the writer). A
 * directory yields is_a_directory; metadata-present-but-bytes-missing is a
 * server inconsistency surfaced as internal (never a silent empty body).
 */
export async function downloadResource(
  store: ResourceStore,
  blobs: BlobReader,
  drive: string,
  resourceId: string
): Promise<{ resource: GfsResourceView; stream: Readable }> {
  let normalized: string;
  try {
    normalized = ridOf(resourceId);
  } catch (err) {
    if (err instanceof PathError) throw new GfsError("path_invalid", err.message);
    throw err;
  }
  const resource = requireLive(await store.getResource(drive, normalized), resourceId);
  if (resource.kind === "directory") {
    throw new GfsError("is_a_directory", `resource is a directory: ${resourceId}`);
  }
  try {
    const stream = await blobs.read(normalized);
    return { resource: toView(resource), stream };
  } catch (err) {
    if ((err as { code?: string }).code === "not_found") {
      throw new GfsError(
        "internal",
        `metadata exists but blob is missing for ${resourceId} (storage inconsistency)`
      );
    }
    throw err;
  }
}
