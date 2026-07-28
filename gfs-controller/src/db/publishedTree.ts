export interface PublishedTreeRef {
  resourceId: string;
  parentResourceId: string | null;
  name: string;
  kind: "file" | "directory";
  pathCache: string;
  version: number;
  bytes: bigint;
  blobKey: string | null;
  contentSha256: string | null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function matchesRow(drive: string, expected: PublishedTreeRef, row: Record<string, unknown>): boolean {
  let bytes: bigint;
  try {
    bytes = BigInt(String(row.bytes));
  } catch {
    return false;
  }
  return String(row.resource_id) === expected.resourceId
    && String(row.drive) === drive
    && nullableString(row.parent_resource_id) === expected.parentResourceId
    && String(row.name) === expected.name
    && String(row.kind) === expected.kind
    && String(row.path_cache) === expected.pathCache
    && Number(row.version) === expected.version
    && bytes === expected.bytes
    && nullableString(row.blob_key) === expected.blobKey
    && nullableString(row.content_sha256) === expected.contentSha256
    && row.deleted_at == null;
}

/** An ambiguous COMMIT is published only when every reserved row matches exactly. */
export function matchesPublishedTree(
  drive: string,
  expected: readonly PublishedTreeRef[],
  rows: readonly Record<string, unknown>[]
): boolean {
  if (rows.length !== expected.length) return false;
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = String(row.resource_id);
    if (byId.has(id)) return false;
    byId.set(id, row);
  }
  return expected.every(item => {
    const row = byId.get(item.resourceId);
    return row !== undefined && matchesRow(drive, item, row);
  });
}
