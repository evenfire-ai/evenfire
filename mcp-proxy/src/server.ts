import http, { IncomingMessage, ServerResponse } from "node:http";
import { Router } from "./router";
import { HttpForwarder } from "./httpForwarder";
import { Metrics } from "./metrics";
import { Health } from "./health";
import { ProxyConfig } from "./types";

export class ProxyServer {
  private httpServer: http.Server | null = null;
  private router: Router;
  private forwarder: HttpForwarder;
  private metrics: Metrics;
  private health: Health;
  private config: ProxyConfig;

  constructor(
    router: Router,
    forwarder: HttpForwarder,
    metrics: Metrics,
    health: Health,
    config: ProxyConfig
  ) {
    this.router = router;
    this.forwarder = forwarder;
    this.metrics = metrics;
    this.health = health;
    this.config = config;
  }

  getPort(): number {
    const addr = this.httpServer?.address();
    if (addr && typeof addr !== "string") return addr.port;
    return this.config.port;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.httpServer.listen(this.config.port, () => {
        console.log(`[MCP Proxy] Listening on port ${this.getPort()}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.health.setAlive(false);

    return new Promise((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }

      this.httpServer.close(() => {
        console.log("[MCP Proxy] Server stopped");
        resolve();
      });

      // Force close after 10s
      setTimeout(() => {
        resolve();
      }, 10000);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || "/";
    const method = req.method || "GET";

    if (url === "/health") {
      this.health.handleHealth(res);
      return;
    }

    if (url === "/ready") {
      this.health.handleReady(res);
      return;
    }

    if (url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(this.metrics.toPrometheus());
      return;
    }

    // Route: POST /servers/{serverName}/mcp
    const match = url.match(/^\/servers\/([^/]+)\/mcp$/);
    if (match && method === "POST") {
      const serverName = match[1];
      await this.handleForward(req, res, serverName);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleForward(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string
  ): Promise<void> {
    const route = this.router.resolve(serverName);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Server '${serverName}' not found` }));
      return;
    }

    if (!route.ready) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Server '${serverName}' not ready` }));
      return;
    }

    const startTime = Date.now();
    this.metrics.incrementActive(serverName);

    try {
      await this.forwarder.forward(req, res, route.url);
      this.metrics.recordRequest({
        server: serverName,
        method: req.method || "POST",
        status: res.statusCode || 200,
        durationMs: Date.now() - startTime,
      });
    } finally {
      this.metrics.decrementActive(serverName);
    }
  }
}
