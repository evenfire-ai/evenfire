import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GfsMetrics } from "../metrics";
import type { AuthzContext } from "../authz/permissionClient";
import type { AuditSink } from "../authz/audit";
import type { AccessibleResourcePage } from "../authz/accessibleStore";
import type { GfsPermission } from "../authz/resolve";
import { checkTokenCeiling } from "../authz/tokenCeiling";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { GfsWriteService } from "../db/writeStore";
import { normalizeResourceId, PathError } from "../storage/paths";
import {
  BlobReader,
  downloadResource,
  listChildren,
  ResourceStore,
  statResource,
  toView,
} from "./read";
import { ok, toResponse } from "./envelope";
import { executeCopyRoute, type CopyRouteDeps } from "./copyRoute";
import { executeRenameRoute } from "./renameRoute";
import { GfsError } from "./errors";
import { normalizeResourceName, ResourceNameError } from "./resourceName";
import { planWrite, WriteError } from "./write";

/**
 * gfsc read serving handler (spec community.md §Operator surfaces / §Auth,
 * plan P1-S07/S08 composed). This is the broker's READ data plane — the single
 * place where a request is turned into a served byte or a denial.
 *
 * Every request runs the full governed chain, in order, FAIL-CLOSED at each hop:
 *
 *   1. Bearer token            → verifyToken (sig/aud/exp, fail-closed → 401)
 *   2. principal → subjects    → resolveContext (DB; store error → 503)
 *   3. token CEILING           → checkTokenCeiling (scopes + pathBindings; the
 *                                 upper bound the token itself carries → 403)
 *   4. permission STORE        → PermissionClient.authorize (source of truth,
 *                                 deny-by-default, audited, fail-closed → 503)
 *   5. read executor           → stat / list / download (existence + bytes)
 *
 * Steps 3 AND 4 must BOTH allow — "neither alone authorizes" (§522). Authz runs
 * BEFORE any metadata is revealed, so an absent resource and an unauthorized one
 * are indistinguishable (both 403) — no existence leak. The `drive` is taken
 * from the token claim, never from the query, so a token can only ever reach the
 * drive it was minted for.
 */

/** The verify/authorize/store collaborators, injected for isolated unit tests. */
export interface ServingDeps {
  verifyToken: (token: string) => GfsVerifiedClaims;
  resolveContext: (
    claims: { sub: string; drive: string },
    requestId?: string
  ) => Promise<AuthzContext>;
  /** Permission-store authorization (the source of truth). */
  authorize: (ctx: AuthzContext, resourceId: string, op: GfsPermission) => Promise<{ allowed: boolean }>;
  /** Lists direct resources visible to the resolved principal. */
  listAccessible?: (ctx: AuthzContext, opts: { limit?: unknown; cursor?: string }) => Promise<AccessibleResourcePage>;
  store: ResourceStore;
  blobs: BlobReader;
  /** The transactional write data plane. Absent on a read-only replica — write
   * routes then respond 404 (the verb is not served), never a silent no-op. */
  writeService?: GfsWriteService;
  audit?: AuditSink;
  copy?: Omit<CopyRouteDeps, "writes">;
  /** Admission limits for the synchronous rename mutation; PATCH is not served without them. */
  rename?: { maxObjects: number; timeoutMs: number };
  metrics?: GfsMetrics;
  /** Injectable clock for deterministic latency tests; defaults to Date.now. */
  now?: () => number;
}

/** Largest mutation body gfsc accepts before failing loud with payload_too_large. */
const MAX_WRITE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Node clamps larger timer delays to 1 ms. Re-arm the copy deadline in bounded
 * chunks so the full positive safe-integer ENV contract remains meaningful.
 * Each callback recomputes its remaining budget against an absolute monotonic
 * deadline: event-loop stalls and machine suspension must not extend the copy.
 */
function armCopyAbortTimer(controller: AbortController, timeoutMs: number): () => void {
  const deadlineNs = process.hrtime.bigint() + BigInt(timeoutMs) * NANOSECONDS_PER_MILLISECOND;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;

  const armNextChunk = (): void => {
    const remainingNs = deadlineNs - process.hrtime.bigint();
    if (remainingNs <= 0n) {
      controller.abort(new GfsError("precondition_failed", "synchronous copy deadline exceeded"));
      return;
    }
    // Round up so an early timer callback cannot expire the request before its
    // monotonic deadline. The next callback recomputes rather than subtracting
    // this nominal delay, which also handles delayed callbacks correctly.
    const remainingMs = Number(
      (remainingNs + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND
    );
    const delayMs = Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (cancelled) return;
      armNextChunk();
    }, delayMs);
    timer.unref();
  };

  armNextChunk();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/** A host principal (`sub` starts with `host:`) is an AGENT — write invariants
 * (mandatory If-Match on replace/delete) apply only to agents. */
function isAgentSub(sub: string): boolean {
  return sub.startsWith("host:");
}

const RESOURCE_RE = /^\/v1\/resources\/([^/]+)(?:\/(children|content))?$/;
const RESOLVE_RE = /^\/v1\/resolve$/;
const ACCESSIBLE_RE = /^\/v1\/accessible$/;
const COPY_RE = /^\/v1\/copy$/;
const GFS_URI_RE = /^gfs:\/\/([^/]+)\/([^/?#]+)$/;

function bearerToken(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new GfsError("unauthorized", "missing or malformed Authorization: Bearer header");
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) throw new GfsError("unauthorized", "empty bearer token");
  return token;
}

/** Normalize a caller-supplied rid, mapping a bad value to 400 (not a 503). */
function requireRid(raw: string): string {
  try {
    return normalizeResourceId(decodeURIComponent(raw));
  } catch (err) {
    if (err instanceof PathError) throw new GfsError("path_invalid", err.message);
    throw err;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export class GfsServingHandler {
  constructor(private readonly deps: ServingDeps) {}

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Try to serve a read OR write route. Returns true iff the path matched a
   * served route (handled — including an error response); false to let the
   * caller fall through to its own 404. GET is read; POST/PUT/DELETE are writes
   * (only when a writeService is configured). A matched path with an unsupported
   * verb is a handled 404 — never a silent no-op.
   */
  async tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", "http://gfsc.local");
    const resourceMatch = RESOURCE_RE.exec(url.pathname);
    const resolveMatch = RESOLVE_RE.exec(url.pathname);
    const accessibleMatch = ACCESSIBLE_RE.exec(url.pathname);
    const copyMatch = COPY_RE.exec(url.pathname);
    if (!resourceMatch && !resolveMatch && !accessibleMatch && !copyMatch) return false;

    const method = req.method ?? "GET";
    const isWrite = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    const copyWrite = method === "POST" && copyMatch && this.deps.writeService && this.deps.copy;
    const renameWrite = method === "PATCH" && resourceMatch?.[2] === undefined
      && this.deps.writeService && this.deps.audit && this.deps.rename;
    const resourceWrite = isWrite && this.deps.writeService && resourceMatch
      && (method === "DELETE" || Boolean(this.deps.audit));
    if ((copyMatch && !copyWrite) || (method === "PATCH" && !renameWrite) || (method !== "GET" && !resourceWrite && !copyWrite)) {
      sendJson(res, 404, { ok: false, error: { code: "not_found", message: "not found" } });
      return true;
    }

    const started = this.clock();
    const copyAbort = copyWrite ? new AbortController() : undefined;
    const cancelCopyTimer = copyAbort
      ? armCopyAbortTimer(copyAbort, this.deps.copy!.timeoutMs)
      : undefined;
    try {
      const claims = this.deps.verifyToken(bearerToken(req));
      const needsMutationRequestId = Boolean(copyMatch) || Boolean(renameWrite)
        || Boolean(resourceMatch && ((method === "POST" && resourceMatch[2] === "children") || (method === "PUT" && resourceMatch[2] === "content")));
      const requestId = needsMutationRequestId ? requireRequestId(req) : undefined;
      const ctx = await this.authContext(claims, req, requestId);
      copyAbort?.signal.throwIfAborted();

      if (method === "GET") {
        await this.handleRead(res, claims, ctx, url, resourceMatch, resolveMatch, accessibleMatch);
        this.deps.metrics?.recordRead(this.clock() - started);
      } else if (copyMatch) {
        await this.serveCopy(req, res, claims, ctx, requestId!, started, copyAbort!.signal);
        this.deps.metrics?.recordWrite(this.clock() - started);
      } else {
        await this.handleWrite(req, res, claims, ctx, method, resourceMatch!, requestId);
        this.deps.metrics?.recordWrite(this.clock() - started);
      }
    } catch (err) {
      const { status, body } = toResponse(err);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end(); // a content stream already started; just terminate
    } finally {
      cancelCopyTimer?.();
    }
    return true;
  }

  private async handleRead(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    url: URL,
    resourceMatch: RegExpExecArray | null,
    resolveMatch: RegExpExecArray | null,
    accessibleMatch: RegExpExecArray | null
  ): Promise<void> {
    if (accessibleMatch) {
      await this.serveAccessible(res, claims, ctx, url);
      return;
    }
    if (resolveMatch) {
      await this.serveResolve(res, claims, ctx, url);
      return;
    }
    const rid = requireRid(resourceMatch![1]);
    const sub = resourceMatch![2]; // undefined | "children" | "content"
    if (sub === "children") {
      await this.serveChildren(res, claims, ctx, rid, url);
    } else if (sub === "content") {
      await this.serveContent(res, claims, ctx, rid);
    } else {
      await this.serveStat(res, claims, ctx, rid);
    }
  }

  /**
   * Dispatch a mutation. The route + verb fix the write op:
   *   POST   /v1/resources/:parentId/children → create
   *   PUT    /v1/resources/:id/content        → replace
   *   DELETE /v1/resources/:id                → delete
   * Every mutation runs planWrite (agent If-Match invariant + which permission
   * the op needs), then the SAME governed authz chain as reads for each required
   * check, then the transactional write service.
   */
  private async handleWrite(
    req: IncomingMessage,
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    method: string,
    resourceMatch: RegExpExecArray,
    requestId?: string
  ): Promise<void> {
    const rid = requireRid(resourceMatch[1]);
    const sub = resourceMatch[2]; // undefined | "children" | "content"
    if (method === "POST" && sub === "children") {
      await this.serveCreate(req, res, claims, ctx, rid, requestId!);
    } else if (method === "PUT" && sub === "content") {
      await this.serveReplace(req, res, claims, ctx, rid, requestId!);
    } else if (method === "PATCH" && sub === undefined) {
      await this.serveRename(req, res, claims, ctx, rid, requestId!);
    } else if (method === "DELETE" && sub === undefined) {
      await this.serveDelete(req, res, claims, ctx, rid);
    } else {
      throw new GfsError("not_found", `no ${method} route for this resource path`);
    }
  }

  /** Resolve the principal to its subject set; a store failure is fail-closed 503. */
  private async authContext(claims: GfsVerifiedClaims, req: IncomingMessage, admittedRequestId?: string): Promise<AuthzContext> {
    const requestId = admittedRequestId ?? headerValue(req, "x-request-id");
    try {
      return await this.deps.resolveContext({ sub: claims.sub, drive: claims.drive }, requestId);
    } catch (err) {
      throw new GfsError(
        "not_mounted",
        `subject resolution failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Enforce BOTH authority layers for `op` on `rid`: the token ceiling (the
   * upper bound the token carries) AND the permission store (the source of
   * truth). Throws `forbidden` if either denies. The resource path is fetched
   * for the ceiling ONLY when the token actually declares pathBindings (P2+);
   * P1 tokens carry none, so this is a pure in-memory check.
   */
  private async authorizeOp(
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    rid: string,
    op: GfsPermission
  ): Promise<void> {
    let resourcePath: string | null = null;
    if (claims.pathBindings.length > 0) {
      const resource = await this.deps.store.getResource(claims.drive, rid);
      resourcePath = resource?.pathCache ?? null;
    }
    const ceiling = checkTokenCeiling({
      scopes: claims.scopes,
      pathBindings: claims.pathBindings,
      op,
      resourcePath,
    });
    if (!ceiling.allowed) {
      throw new GfsError("forbidden", `token does not authorize ${op}`, ceiling.reason);
    }

    const decision = await this.deps.authorize(ctx, rid, op);
    if (!decision.allowed) {
      throw new GfsError("forbidden", `not authorized to ${op} this resource`);
    }
  }

  private async serveAccessible(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    url: URL
  ): Promise<void> {
    const ceiling = checkTokenCeiling({
      scopes: claims.scopes,
      pathBindings: claims.pathBindings,
      op: "read",
      resourcePath: null,
    });
    if (!ceiling.allowed) {
      throw new GfsError("forbidden", "read scope is required for accessible-resource discovery", ceiling.reason);
    }
    if (!this.deps.listAccessible) {
      throw new GfsError("not_mounted", "accessible-resource store is unavailable");
    }
    const page = await this.deps.listAccessible(ctx, {
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    sendJson(res, 200, ok(page));
  }

  private async serveStat(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    rid: string
  ): Promise<void> {
    await this.authorizeOp(claims, ctx, rid, "read");
    const view = await statResource(this.deps.store, claims.drive, rid);
    sendJson(res, 200, ok(view));
  }

  private async serveChildren(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    rid: string,
    url: URL
  ): Promise<void> {
    await this.authorizeOp(claims, ctx, rid, "read");
    const page = await listChildren(this.deps.store, claims.drive, rid, {
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    sendJson(res, 200, ok(page));
  }

  private async serveContent(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    rid: string
  ): Promise<void> {
    await this.authorizeOp(claims, ctx, rid, "read");
    const { resource, stream } = await downloadResource(this.deps.store, this.deps.blobs, claims.drive, rid);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(resource.bytes),
      "X-Gfs-Uri": resource.gfsUri,
      "X-Gfs-Version": String(resource.version),
    });
    stream.pipe(res);
    // Surface a mid-stream read error instead of silently truncating the body.
    // pipe() does not propagate destination close back to the source, so a
    // client abort must destroy the blob stream or its fd stays open.
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      res.on("close", () => {
        stream.destroy();
        resolve();
      });
    });
  }

  private async serveResolve(
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    url: URL
  ): Promise<void> {
    const uri = url.searchParams.get("uri");
    if (!uri) throw new GfsError("path_invalid", "resolve requires a ?uri=gfs://<drive>/<rid>");
    const m = GFS_URI_RE.exec(uri);
    if (!m) throw new GfsError("path_invalid", `not a gfs:// uri: ${uri}`);
    const [, uriDrive, rawRid] = m;
    if (uriDrive !== claims.drive) {
      // The token is scoped to one drive; resolving across drives is denied,
      // not a 404 — never confirm existence on a drive the token cannot reach.
      throw new GfsError("forbidden", `token is scoped to drive ${claims.drive}, not ${uriDrive}`);
    }
    const rid = requireRid(rawRid);
    await this.authorizeOp(claims, ctx, rid, "read");
    const view = await statResource(this.deps.store, claims.drive, rid);
    sendJson(res, 200, ok(view));
  }

  // ── Write routes ────────────────────────────────────────────────────────────

  private async serveCopy(
    req: IncomingMessage,
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    requestId: string,
    admittedAtMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const body = await readJsonBody(req, { signal });
    const data = await executeCopyRoute({
      body, claims, context: ctx, requestId, admittedAtMs, signal, now: () => this.clock(),
      deps: { ...this.deps.copy!, writes: this.deps.writeService! },
    });
    sendJson(res, 201, ok(data));
  }

  private async serveCreate(
    req: IncomingMessage,
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    parentId: string,
    requestId: string
  ): Promise<void> {
    const body = await readJsonBody(req);
    const name = requireName(body, "name");
    const kind = optionalResourceKind(body);
    const content = kind === "directory" ? undefined : readContentBuffer(body);

    // create needs `write` on the destination PARENT; no prior version → no
    // If-Match even for an agent.
    const plan = mapWritePlan(() =>
      planWrite({ op: "create", parentId, isAgent: isAgentSub(claims.sub) })
    );
    await this.authorizeChecks(claims, ctx, plan.checks);

    const created = await this.deps.writeService!.create({
      drive: claims.drive, parentId, name, kind, content,
      mutation: { subject: ctx.primarySubject, requestId, audit: this.deps.audit! },
    });
    sendJson(res, 201, ok(toView(created)));
  }

  private async serveReplace(
    req: IncomingMessage,
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    resourceId: string,
    requestId: string
  ): Promise<void> {
    const body = await readJsonBody(req);
    const content = readContentBuffer(body);
    const ifMatch = optionalNumber(body, "ifMatch");

    const plan = mapWritePlan(() =>
      planWrite({ op: "replace", resourceId, ifMatch, isAgent: isAgentSub(claims.sub) })
    );
    await this.authorizeChecks(claims, ctx, plan.checks);

    const updated = await this.deps.writeService!.replace({
      drive: claims.drive, resourceId, ifMatch, content,
      mutation: { subject: ctx.primarySubject, requestId, audit: this.deps.audit! },
    });
    sendJson(res, 200, ok(toView(updated)));
  }

  private async serveRename(
    req: IncomingMessage, res: ServerResponse, claims: GfsVerifiedClaims,
    ctx: AuthzContext, resourceId: string, requestId: string
  ): Promise<void> {
    const body = await readJsonBody(req);
    const data = await executeRenameRoute({
      body, claims, context: ctx, resourceId, requestId, audit: this.deps.audit!,
      authorizeWrite: () => this.authorizeOp(claims, ctx, resourceId, "write"),
      writes: this.deps.writeService!,
      limits: this.deps.rename!,
    });
    sendJson(res, 200, ok(data));
  }

  private async serveDelete(
    req: IncomingMessage,
    res: ServerResponse,
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    resourceId: string
  ): Promise<void> {
    const body = await readJsonBody(req, { allowEmpty: true });
    const ifMatch = optionalNumber(body, "ifMatch");

    // delete needs the DESTRUCTIVE `delete` bit (agents are default-denied it).
    const plan = mapWritePlan(() =>
      planWrite({ op: "delete", resourceId, ifMatch, isAgent: isAgentSub(claims.sub) })
    );
    await this.authorizeChecks(claims, ctx, plan.checks);

    await this.deps.writeService!.delete({ drive: claims.drive, resourceId, ifMatch });
    sendJson(res, 200, ok({ deleted: true, resourceId }));
  }

  /** Run the governed authz chain (ceiling + store) for every required check. */
  private async authorizeChecks(
    claims: GfsVerifiedClaims,
    ctx: AuthzContext,
    checks: Array<{ resourceId: string; op: GfsPermission }>
  ): Promise<void> {
    for (const check of checks) {
      await this.authorizeOp(claims, ctx, requireRid(check.resourceId), check.op);
    }
  }
}

function requireRequestId(req: IncomingMessage): string {
  const supplied = headerValue(req, "x-request-id");
  if (supplied === undefined) return randomUUID();
  const normalized = requireRid(supplied);
  return [normalized.slice(0, 8), normalized.slice(8, 12), normalized.slice(12, 16), normalized.slice(16, 20), normalized.slice(20)].join("-");
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

/** Map a WriteError (plan-time invariant) to its envelope GfsError. */
function mapWritePlan<T>(plan: () => T): T {
  try {
    return plan();
  } catch (err) {
    if (err instanceof WriteError) {
      const code = err.code === "invalid_request" ? "path_invalid" : "precondition_failed";
      throw new GfsError(code, err.message);
    }
    throw err;
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new GfsError("path_invalid", `'${key}' must be a string`);
  return value;
}

function optionalResourceKind(body: Record<string, unknown>): "file" | "directory" {
  const value = body.kind;
  if (value === undefined || value === null) return "file";
  if (value === "file" || value === "directory") return value;
  throw new GfsError("path_invalid", "'kind' must be 'file' or 'directory'");
}

function readContentBuffer(body: Record<string, unknown>): Buffer {
  const encoded = body.contentBase64;
  if (encoded !== undefined) {
    if (typeof encoded !== "string") throw new GfsError("path_invalid", "'contentBase64' must be a string");
    return decodeBase64Content(encoded);
  }
  return Buffer.from(requireString(body, "content"), "utf8");
}

function decodeBase64Content(encoded: string): Buffer {
  if (encoded.length === 0) return Buffer.alloc(0);
  const standardBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!standardBase64.test(encoded)) {
    throw new GfsError("path_invalid", "'contentBase64' must be valid base64");
  }
  return Buffer.from(encoded, "base64");
}

function requireName(body: Record<string, unknown>, key: string): string {
  try {
    return normalizeResourceName(requireString(body, key));
  } catch (err) {
    if (err instanceof ResourceNameError) throw new GfsError("path_invalid", err.message);
    throw err;
  }
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GfsError("path_invalid", `'${key}' must be an integer`);
  }
  return value;
}

/**
 * Read a JSON request body, bounded by MAX_WRITE_BODY_BYTES (a write that
 * exceeds it fails loud with payload_too_large rather than buffering without
 * limit). A non-JSON or unparseable body is path_invalid.
 */
async function readJsonBody(
  req: IncomingMessage,
  opts: { allowEmpty?: boolean; signal?: AbortSignal } = {}
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = (): void => {
    req.destroy(opts.signal?.reason instanceof Error
      ? opts.signal.reason
      : new GfsError("precondition_failed", "synchronous copy deadline exceeded"));
  };
  opts.signal?.throwIfAborted();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of req) {
      opts.signal?.throwIfAborted();
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_WRITE_BODY_BYTES) {
        throw new GfsError("payload_too_large", `request body exceeds ${MAX_WRITE_BODY_BYTES} bytes`);
      }
      chunks.push(buf);
    }
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
  opts.signal?.throwIfAborted();
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    if (opts.allowEmpty) return {};
    throw new GfsError("path_invalid", "request body is required");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new GfsError("path_invalid", `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}
