import { stat } from "node:fs/promises";
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
          await reconcileExpiredBlobs(blobManifests!, blobs, metrics, {
            olderThanMs: config.blobCleanupSafetyWindowMs,
            limit: config.blobCleanupBatchSize,
          });
        } catch (err) {
          metrics.recordBlobCleanupFailure();
          console.error(`[gfsc] blob reconciliation failed: ${errMsg(err)}`);
        } finally {
          cleanupRunning = false;
        }
      };
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
    });
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
