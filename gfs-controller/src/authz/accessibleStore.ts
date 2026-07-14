import { GfsError } from "../api/errors";
import type { AuthzContext, Queryable } from "./permissionClient";

export interface AccessibleResource {
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
  permissions: string[];
  sources: string[];
  coversDescendants: boolean;
}

export interface AccessibleResourcePage {
  items: AccessibleResource[];
  nextCursor: string | null;
}

interface AccessibleCursor {
  n: string;
  i: string;
}

function splitSubjectKey(subject: string): { type: string; id: string } | null {
  const sep = subject.indexOf(":");
  if (sep < 1) return null;
  const type = subject.slice(0, sep);
  const id = subject.slice(sep + 1);
  if (!type || !id) return null;
  return { type, id };
}

function ridOf(resourceId: string): string {
  return resourceId.replaceAll("-", "");
}

function encodeCursor(row: { name: string; resourceId: string }): string {
  const payload: AccessibleCursor = { n: row.name, i: row.resourceId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): AccessibleCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as AccessibleCursor;
    if (typeof parsed.n !== "string" || typeof parsed.i !== "string") {
      throw new Error("malformed cursor payload");
    }
    return parsed;
  } catch {
    throw new GfsError("path_invalid", "invalid cursor");
  }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 1000);
}

function rowToAccessibleResource(row: {
  resource_id: string;
  drive: string;
  parent_resource_id: string | null;
  name: string;
  kind: "file" | "directory";
  path_cache: string | null;
  version: number;
  bytes: number;
  permissions: string[];
  sources: string[];
  covers_descendants: boolean;
}): AccessibleResource {
  const rid = ridOf(String(row.resource_id));
  return {
    resourceId: String(row.resource_id),
    rid,
    gfsUri: `gfs://${row.drive}/${rid}`,
    drive: row.drive,
    parentResourceId: row.parent_resource_id,
    name: row.name,
    kind: row.kind,
    path: row.path_cache,
    version: row.version,
    bytes: row.bytes,
    permissions: row.permissions ?? [],
    sources: row.sources ?? [],
    coversDescendants: Boolean(row.covers_descendants),
  };
}

export class AccessibleResourceStore {
  constructor(private readonly db: Queryable) {}

  async list(
    ctx: AuthzContext,
    options: { limit?: unknown; cursor?: string } = {}
  ): Promise<AccessibleResourcePage> {
    const limit = clampLimit(options.limit);
    const after = options.cursor ? decodeCursor(options.cursor) : undefined;

    if (ctx.isOperator) {
      return this.listOperator(ctx, limit, after);
    }

    const subjects = ctx.subjects.map(splitSubjectKey).filter((s): s is { type: string; id: string } => !!s);
    if (subjects.length === 0) return { items: [], nextCursor: null };

    const result = await this.db.query(
      `WITH requested_subjects(subject_type, subject_id) AS (
         SELECT * FROM unnest($2::text[], $3::text[])
       ),
       accessible AS (
         SELECT g.resource_id, g.permissions, g.inherit AS covers_descendants, 'grant'::text AS source
           FROM gfs_grants g
           JOIN requested_subjects s
             ON s.subject_type = g.subject_type AND s.subject_id = g.subject_id
          WHERE g.drive = $1 AND 'read' = ANY(g.permissions)
         UNION ALL
         SELECT sh.resource_id, sh.permissions, sh.include_descendants AS covers_descendants, 'share'::text AS source
           FROM gfs_shares sh
           JOIN requested_subjects s
             ON s.subject_type = sh.subject_type AND s.subject_id = sh.subject_id
          WHERE sh.drive = $1 AND 'read' = ANY(sh.permissions)
       )
       SELECT r.resource_id,
              r.drive,
              r.parent_resource_id,
              r.name,
              r.kind,
              r.path_cache,
              r.version,
              r.bytes,
              array_remove(array_agg(DISTINCT a.source), NULL) AS sources,
              array_remove(array_agg(DISTINCT p.permission), NULL) AS permissions,
              bool_or(a.covers_descendants) AS covers_descendants
         FROM accessible a
         JOIN gfs_resources r
           ON r.drive = $1 AND r.resource_id = a.resource_id AND r.deleted_at IS NULL
         LEFT JOIN LATERAL unnest(a.permissions) AS p(permission) ON true
        WHERE ($4::text IS NULL OR (r.name, r.resource_id) > ($4, $5::uuid))
        GROUP BY r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.path_cache, r.version, r.bytes
        ORDER BY r.name, r.resource_id
        LIMIT $6`,
      [
        ctx.drive,
        subjects.map(s => s.type),
        subjects.map(s => s.id),
        after?.n ?? null,
        after?.i ?? null,
        limit + 1,
      ]
    );

    const rows = result.rows as Array<{
      resource_id: string;
      drive: string;
      parent_resource_id: string | null;
      name: string;
      kind: "file" | "directory";
      path_cache: string | null;
      version: number;
      bytes: number;
      permissions: string[];
      sources: string[];
      covers_descendants: boolean;
    }>;
    const page = rows.length > limit ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(rowToAccessibleResource),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ name: String(last.name), resourceId: String(last.resource_id) })
          : null,
    };
  }

  private async listOperator(
    ctx: AuthzContext,
    limit: number,
    after?: AccessibleCursor
  ): Promise<AccessibleResourcePage> {
    const result = await this.db.query(
      `SELECT r.resource_id,
              r.drive,
              r.parent_resource_id,
              r.name,
              r.kind,
              r.path_cache,
              r.version,
              r.bytes,
              ARRAY['operator']::text[] AS sources,
              ARRAY['read','write','delete','manage_acl','share']::text[] AS permissions,
              true AS covers_descendants
         FROM gfs_resources r
        WHERE r.drive = $1
          AND r.deleted_at IS NULL
          AND ($2::text IS NULL OR (r.name, r.resource_id) > ($2, $3::uuid))
        ORDER BY r.name, r.resource_id
        LIMIT $4`,
      [ctx.drive, after?.n ?? null, after?.i ?? null, limit + 1]
    );

    const rows = result.rows as Array<{
      resource_id: string;
      drive: string;
      parent_resource_id: string | null;
      name: string;
      kind: "file" | "directory";
      path_cache: string | null;
      version: number;
      bytes: number;
      sources: string[];
      permissions: string[];
      covers_descendants: boolean;
    }>;
    const page = rows.length > limit ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(rowToAccessibleResource),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ name: String(last.name), resourceId: String(last.resource_id) })
          : null,
    };
  }
}
