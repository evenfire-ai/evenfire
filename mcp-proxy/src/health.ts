import { ServerResponse } from "node:http";
import { Router } from "./router";
import { HccClient } from "./hccClient";

export class Health {
  private router: Router;
  private hccClient: HccClient;
  private alive: boolean = true;

  constructor(router: Router, hccClient: HccClient) {
    this.router = router;
    this.hccClient = hccClient;
  }

  handleHealth(res: ServerResponse): void {
    if (this.alive) {
      const body: Record<string, unknown> = { status: "ok" };
      if (this.hccClient.isCacheStale()) {
        body.warning = "HCC cache stale";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "shutting_down" }));
    }
  }

  handleReady(res: ServerResponse): void {
    if (this.hccClient.isCacheExpired()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready", reason: "HCC cache expired" }));
      return;
    }

    // An empty routing table after a successful HCC poll is a valid state
    // (fresh cluster with no McpServer CRDs). Only require ready servers
    // when the routing table is non-empty.
    const totalServers = this.router.size();
    if (totalServers === 0 || this.router.hasReadyServers()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ready",
        servers: totalServers,
      }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready", reason: "no servers ready", total: totalServers }));
    }
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
  }
}
