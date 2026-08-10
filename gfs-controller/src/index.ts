import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { Client, Pool } from "pg";
import { verifyGfsToken } from "./auth/verify";
import { KeyConfigError, loadVerificationKey } from "./auth/keys";
import { GfsServingHandler } from "./api/serve";
import { AccessibleResourceStore } from "./authz/accessibleStore";
import { DecisionCache } from "./authz/cache";
import { InvalidationListener, ListenClient } from "./authz/invalidation";
import { DbAuditSink, PermissionClient } from "./authz/permissionClient";
import { createPermissionStoreProbe } from "./authz/storeProbe";
import { resolveAuthzContext } from "./authz/subjectResolver";
import { loadConfig } from "./config";
import { PgResourceStore } from "./db/resourceStore";
import { GfsWriteService, PgTransactor } from "./db/writeStore";
import { PgBlobStagingStore, reconcileExpiredBlobs } from "./db/blobStaging";
import { GfsMetrics } from "./metrics";
import { GfsServer, ReadinessDeps } from "./server";
import { BlobStore } from "./storage/blobStore";
import { GfsUploadSessionService, uploadCapabilities, type UploadPartRow, type UploadSessionRow } from "./upload/uploadSession";
import { GfsError } from "./api/errors";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function orderedUploadStream(storageMountPath: string, parts: readonly UploadPartRow[], signal?: AbortSignal): Readable {
  return Readable.from((async function* () {
    for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      signal?.throwIfAborted();
      const root = resolve(storageMountPath);
      const expectedPath = resolve(root, ".uploads", part.uploadId, "parts", `${part.partNumber}.part`);
      if (part.stagingPath !== expectedPath || !part.stagingPath.startsWith(`${root}/.uploads/${part.uploadId}/parts/`)) {
        throw new GfsError("path_invalid", "staged upload part path is invalid");
      }
      const handle = await open(part.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const digest = createHash("sha256");
      let bytes = 0;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, 0, buffer.length, null);
          if (result.bytesRead === 0) break;
          const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
          bytes += result.bytesRead;
          digest.update(chunk);
          yield chunk;
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (bytes !== part.lengthBytes || digest.digest("hex") !== part.sha256) {
        throw new GfsError("checksum_mismatch", `staged upload part ${part.partNumber} failed verification`);
      }
    }
  })());
}

async function assertUploadV2Ready(
  pool: Pool,
  storageMountPath: string,
  storageRole: "writer" | "reader"
): Promise<void> {
  const tables = await pool.query(
    `SELECT to_regclass('public.gfs_upload_sessions')::text AS sessions,
            to_regclass('public.gfs_upload_parts')::text AS parts`
  );
  const row = tables.rows[0] as { sessions?: string | null; parts?: string | null } | undefined;
  if (!row?.sessions || !row.parts) throw new Error("[gfsc] GFS_UPLOAD_V2_ENABLED requires migration 0091 upload tables");
  if (storageRole === "writer") {
    const info = await stat(storageMountPath);
    if (!info.isDirectory()) throw new Error("[gfsc] GFS_UPLOAD_V2_ENABLED requires a writable GFS storage directory");
    const uploadRoot = resolve(storageMountPath, ".uploads");
    await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
    for (const ancestor of [resolve(storageMountPath), uploadRoot]) {
      const ancestorInfo = await lstat(ancestor);
      if (!ancestorInfo.isDirectory()) throw new Error("[gfsc] GFS upload storage ancestors must be real directories");
    }
    const probePath = resolve(uploadRoot, `.ready-${randomUUID()}`);
    const probe = await open(
      probePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await probe.sync();
    } finally {
      await probe.close().catch(() => undefined);
      await rm(probePath, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Adapt a pg Client to the narrow ListenClient surface. The only real
 * impedance is `connect()`: @types/pg resolves it to the client, while the
 * LISTEN contract wants `Promise<void>` — so it is awaited and discarded.
 */
function asListenClient(client: Client): ListenClient {
  return {
    connect: async () => {
      await client.connect();
    },
    query: (sql, values) => client.query(sql, values),
    on: (event: "notification" | "error" | "end", listener: (arg: never) => void) =>
      (client.on as (e: string, l: (arg: never) => void) => Client)(event, listener),
  };
}

/**
 * Wire the Postgres LISTEN/NOTIFY invalidation fan-out with a bounded
 * reconnect. The cache enters BYPASS the instant the LISTEN connection is
 * unhealthy (InvalidationListener.degrade) and is re-enabled only after a
 * healthy re-LISTEN — so a reader that cannot hear revocations serves nothing.
 * A dropped connection reconnects after a delay rather than disabling caching
 * forever.
 */
function startInvalidation(pgConnectionString: string, cache: DecisionCache): { stop: () => Promise<void> } {
  const RECONNECT_MS = 2000;
  let current: Client | null = null;
  let stopped = false;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const client = new Client({ connectionString: pgConnectionString });
    current = client;
    const reconnect = (): void => {
      if (stopped) return;
      client.end().catch((err) => console.error(`[gfsc] listen client close error: ${errMsg(err)}`));
      const timer = setTimeout(() => void connect(), RECONNECT_MS);
      timer.unref();
    };
    const listener = new InvalidationListener({ client: asListenClient(client), cache, onDegraded: reconnect });
    try {
      await listener.start();
      console.log("[gfsc] permission-invalidation LISTEN active (decision cache enabled)");
    } catch (err) {
      // Cache is left bypassed (fail-closed); retry so caching can recover.
      console.error(`[gfsc] invalidation LISTEN failed (cache stays bypassed), retrying: ${errMsg(err)}`);
      reconnect();
    }
  };

  void connect();
  return {
    stop: async () => {
      stopped = true;
      if (current) await current.end().catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = new Pool({ connectionString: config.pgConnectionString });
  if (config.uploadV2.enabled) {
    await assertUploadV2Ready(pool, config.storageMountPath, config.storageRole);
  }
  const readiness: ReadinessDeps = {
    isStorageMounted: async () => {
      const info = await stat(config.storageMountPath);
      return info.isDirectory();
    },
    // Fresh-connection credential probe (issue #775): the pool alone cannot
    // detect a rotated password — its idle clients authenticated before the
    // rotation and the readiness cadence keeps one alive forever. The probe
    // keeps the fast pool ping AND dials a brand-new client (amortized) so a
    // stale DSN or missing migration-0048 grants flips the pod NotReady.
    pingPermissionStore: createPermissionStoreProbe({
      pool,
      connectionString: config.pgConnectionString,
      intervalMs: config.credentialProbeIntervalMs,
      storageRole: config.storageRole,
    }),
  };

  // ── Read serving plane (the brokered file API) ──────────────────────────────
  // gfsc cannot verify a token without the platform public key, so it must not
  // serve authorized reads without one. In production an absent key is fatal
  // (fail-loud crash); dev mode may run probes-only with a loud warning.
    const metrics = new GfsMetrics();
    let serving: GfsServingHandler | undefined;
    let invalidation: { stop: () => Promise<void> } | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let runCleanup: (() => Promise<void>) | undefined;

  if (config.publicKey.trim() !== "") {
    const verificationKey = loadVerificationKey(config.publicKey);

    // Short-TTL decision cache, started BYPASSED (fail-closed) until the
    // LISTEN/NOTIFY fan-out is confirmed healthy below.
    const cache = new DecisionCache({ ttlMs: config.decisionCacheTtlMs });
    cache.setBypassed(true);
    invalidation = startInvalidation(config.pgConnectionString, cache);

    const audit = new DbAuditSink(pool);
    const permissions = new PermissionClient(pool, audit, cache);
    const accessible = new AccessibleResourceStore(pool);
    const store = new PgResourceStore(pool);
    const blobs = new BlobStore(config.storageMountPath, config.storageRole);
    const blobManifests = config.storageRole === "writer" ? new PgBlobStagingStore(pool) : undefined;
    let uploadServiceForCleanup: GfsUploadSessionService | undefined;
    const writeService =
      config.storageRole === "writer"
        ? new GfsWriteService(new PgTransactor(pool), blobs, blobManifests!)
        : undefined;

    if (config.storageRole === "writer") {
      let cleanupRunning = false;
      const cleanup = async (): Promise<void> => {
        if (cleanupRunning) return;
        cleanupRunning = true;
        try {
          if (uploadServiceForCleanup) {
            try {
              await uploadServiceForCleanup.reconcile();
            } catch (err) {
              console.error(`[gfsc] upload reconciliation failed: ${errMsg(err)}`);
            }
          }
          try {
            await reconcileExpiredBlobs(blobManifests!, blobs, metrics, {
              olderThanMs: config.blobCleanupSafetyWindowMs,
              limit: config.blobCleanupBatchSize,
            });
          } catch (err) {
            metrics.recordBlobCleanupFailure();
            console.error(`[gfsc] blob reconciliation failed: ${errMsg(err)}`);
          }
        } finally {
          cleanupRunning = false;
        }
      };
      runCleanup = cleanup;
      cleanupTimer = setInterval(() => void cleanup(), config.blobCleanupIntervalMs);
      cleanupTimer.unref();
      void cleanup();
    }

    serving = new GfsServingHandler({
      verifyToken: (token) =>
        verifyGfsToken(token, { key: verificationKey, audience: config.tokenAudience }),
      resolveContext: (claims, requestId) => resolveAuthzContext(pool, claims, requestId),
      authorize: (ctx, resourceId, op) => permissions.authorize(ctx, resourceId, op),
      listAccessible: (ctx, opts) => accessible.list(ctx, opts),
      store,
      blobs,
      ...(writeService ? { writeService } : {}),
      ...(writeService ? { audit } : {}),
      ...(writeService ? {
        copy: {
          authorizeMany: (ctx, requests, budget) => permissions.authorizeMany(ctx, requests, budget),
          permissionEpoch: () => permissions.permissionEpoch(),
          resources: store,
          audit,
          maxObjects: config.syncCopyMaxObjects,
          maxBytes: config.syncCopyMaxBytes,
          timeoutMs: config.syncCopyTimeoutMs,
        },
        rename: {
          maxObjects: config.syncRenameMaxObjects,
          timeoutMs: config.syncRenameTimeoutMs,
        },
      } : {}),
      metrics,
      // Upload mutation and capability advertisement are writer-only. Reader
      // replicas deliberately do not expose a v2 capability even if an
      // operator accidentally carries the same tuning env into both pods.
      uploadCapabilities: () => ({
        upload: uploadCapabilities(
          config.storageRole === "writer" && config.uploadV2.enabled && Boolean(writeService),
          config.uploadV2,
        ),
      }),
      ...(writeService ? {
        uploadService: (uploadServiceForCleanup = new GfsUploadSessionService({
          db: pool,
          tx: new PgTransactor(pool),
          blobs,
          storageMountPath: config.storageMountPath,
          config: config.uploadV2,
          authorize: async (principal, operation, targetRid) => {
            if (!targetRid) throw new GfsError("path_invalid", "upload target is required");
            const targetContext = await resolveAuthzContext(pool, {
              sub: principal.ownerSubject,
              drive: principal.drive,
            });
            const decision = await permissions.authorize(targetContext, targetRid, "write");
            if (!decision.allowed) throw new GfsError("forbidden", `not authorized to ${operation} upload`);
          },
        finalize: async (session: UploadSessionRow, parts: UploadPartRow[], signal?: AbortSignal, deadlineAtMs?: number) => {
            const capturedPermissionEpoch = permissions.permissionEpoch();
            const source = {
              stream: orderedUploadStream(config.storageMountPath, parts, signal),
              expectedBytes: session.expectedBytes,
              ...(session.wholeSha256 ? { expectedSha256: session.wholeSha256 } : {}),
            };
            const mutation = { subject: session.primarySubject, requestId: session.uploadId, audit };
            const onPublished = async (client: import("./db/writeStore").TxClient, published: import("./api/read").GfsResource, publicationSignal?: AbortSignal): Promise<void> => {
              publicationSignal?.throwIfAborted();
              if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
                throw new GfsError("precondition_failed", "upload finalization timed out");
              }
              const currentPermissionEpoch = permissions.permissionEpoch();
              if (
                capturedPermissionEpoch.bypassed
                || currentPermissionEpoch.bypassed
                || currentPermissionEpoch.generation !== capturedPermissionEpoch.generation
              ) {
                throw new GfsError("precondition_failed", "authorization changed during upload finalization");
              }
              const targetRid = session.operation === "create" ? session.parentRid : session.resourceRid;
              if (!targetRid) throw new GfsError("path_invalid", "upload target is required");
              const targetContext = await resolveAuthzContext(pool, {
                sub: session.ownerSubject,
                drive: session.drive,
              });
              const decision = await permissions.authorize(targetContext, targetRid, "write");
              publicationSignal?.throwIfAborted();
              if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
                throw new GfsError("precondition_failed", "upload finalization timed out");
              }
              if (!decision.allowed) throw new GfsError("forbidden", "upload authorization was revoked before publication");
              const completed = await client.query(
                `UPDATE gfs_upload_sessions
                    SET state = 'completed', result_resource_id = $2, result_version = $3,
                        result_sha256 = $4, completed_at = now(), updated_at = now()
                  WHERE upload_id = $1 AND state = 'finalizing' AND session_epoch = $5
                  RETURNING upload_id`,
                [session.uploadId, published.resourceId, published.version, published.contentSha256, session.sessionEpoch]
              );
              publicationSignal?.throwIfAborted();
              if (completed.rows.length !== 1) throw new GfsError("upload_aborted", "upload session changed before publication");
            };
            const resource = session.operation === "create"
              ? await writeService.create({
                drive: session.drive,
                parentId: session.parentRid!,
                name: session.resourceName!,
                kind: "file",
                resourceId: session.uploadId,
                content: source,
                mutation,
                onPublished,
                signal,
                deadlineAtMs,
              })
              : await writeService.replace({
                drive: session.drive,
                resourceId: session.resourceRid!,
                ifMatch: session.ifMatch ?? undefined,
                content: source,
                mutation,
                onPublished,
                signal,
                deadlineAtMs,
              });
            if (!resource.contentSha256) throw new GfsError("internal", "published upload has no checksum");
            return { resourceId: resource.resourceId, version: resource.version, sha256: resource.contentSha256 };
          },
        })),
      } : {}),
    });
    void runCleanup?.();
  } else if (!config.devMode) {
    throw new KeyConfigError("GFS_JWT_PUBLIC_KEY is required to serve authorized reads");
  } else {
    console.warn("[gfsc] DEV MODE: no GFS_JWT_PUBLIC_KEY set — read serving DISABLED (probes only)");
  }

  const server = new GfsServer(config, readiness, serving, metrics);
  const port = await server.start();
  console.log(
    `[gfsc] listening on :${port} (role=${config.storageRole}, drive=${config.driveName}, ` +
      `serving=${serving ? "on" : "off"}, devMode=${config.devMode})`
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gfsc] ${signal} received, shutting down`);
    await server.stop();
    if (invalidation) await invalidation.stop();
    if (cleanupTimer) clearInterval(cleanupTimer);
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[gfsc] fatal:", err);
  process.exit(1);
});
