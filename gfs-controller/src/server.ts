import http, { IncomingMessage, ServerResponse } from "node:http";
import type { GfsConfig } from "./config";
import { GfsMetrics } from "./metrics";

/**
 * Readiness dependencies — injected so the fail-closed checks can be exercised
 * deterministically in tests without a real volume or a real Postgres.
 */
export interface ReadinessDeps {
  /** Resolves true only if the drive volume is mounted at the configured path. */
  isStorageMounted: () => Promise<boolean>;
  /** Resolves if the permission store answers; rejects (fail-closed) otherwise. */
  pingPermissionStore: () => Promise<void>;
}

/**
 * The read serving plane (api/serve.ts). Injected (optional) so the probe-only
 * server stays testable without verify/db/store deps. `tryHandle` returns true
 * iff it matched and handled a read route.
 */
export interface ServingPlane {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * gfsc HTTP server. P1 exposes the liveness/readiness probes; the read API
 * (P1-S07), JWT verification (P1-S06), and authz (P1-S08) build on this.
 */
export class GfsServer {
  private httpServer: http.Server | null = null;
  private alive = true;
  /** SLI registry (P5-S02). Shared so the serving path records into this same
   * instance that /metrics renders. */
  private readonly metrics: GfsMetrics;

  /** Expose the SLI registry so request handlers record reads/writes/cache here. */
  getMetrics(): GfsMetrics {
    return this.metrics;
  }

  constructor(
    private readonly config: GfsConfig,
    private readonly readiness: ReadinessDeps,
    private readonly serving?: ServingPlane,
    metrics?: GfsMetrics
  ) {
    // Accept a shared registry so the serving plane records into the SAME
    // instance /metrics renders; default to a fresh one for probe-only servers.
    this.metrics = metrics ?? new GfsMetrics();
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.httpServer.listen(this.config.port, () => {
        resolve(this.port());
      });
    });
  }

  port(): number {
    const addr = this.httpServer?.address();
    if (addr && typeof addr !== "string") return addr.port;
    return this.config.port;
  }

  stop(): Promise<void> {
    this.alive = false;
    return new Promise((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || "/";
    if (url === "/healthz") {
      this.handleHealthz(res);
      return;
    }
    if (url === "/readyz") {
      await this.handleReadyz(res);
      return;
    }
    if (url === "/metrics") {
      // SLI exposition (P5-S02). Prometheus text; zero-valued until the serving
      // path records into getMetrics().
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(this.metrics.render());
      return;
    }
    // Delegate to the read serving plane (the brokered file API). It returns
    // true once it has matched and handled (or rejected) a read route; anything
    // it does not recognize falls through to a 404.
    if (this.serving && (await this.serving.tryHandle(req, res))) {
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: "not_found", message: "not found" } });
  }

  /** Liveness: 200 while the process is up, 503 once shutdown has begun. */
  private handleHealthz(res: ServerResponse): void {
    sendJson(res, this.alive ? 200 : 503, {
      status: this.alive ? "ok" : "shutting_down",
    });
  }

  /**
   * Readiness — FAIL CLOSED. gfsc is ready ONLY when the drive volume is
   * mounted AND the permission store (the source of truth for authorization)
   * is reachable. Any check failing yields 503 with a concrete reason; gfsc
   * never reports ready when it could not verify the store, so it can never
   * serve requests it cannot authorize.
   */
  private async handleReadyz(res: ServerResponse): Promise<void> {
    let mounted: boolean;
    try {
      mounted = await this.readiness.isStorageMounted();
    } catch (err) {
      sendJson(res, 503, {
        status: "not_ready",
        code: "not_mounted",
        reason: `storage check failed: ${errMsg(err)}`,
      });
      return;
    }
    if (!mounted) {
      sendJson(res, 503, {
        status: "not_ready",
        code: "not_mounted",
        reason: `storage volume not mounted at ${this.config.storageMountPath}`,
      });
      return;
    }

    try {
      await this.readiness.pingPermissionStore();
    } catch (err) {
      sendJson(res, 503, {
        status: "not_ready",
        code: "not_ready",
        reason: `permission store unreachable: ${errMsg(err)}`,
      });
      return;
    }

    sendJson(res, 200, {
      status: "ready",
      role: this.config.storageRole,
      drive: this.config.driveName,
    });
  }
}
