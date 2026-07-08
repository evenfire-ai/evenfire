import http from "node:http";
import { ServerRoute, HccServersResponse, ProxyConfig } from "./types";

export class HccClient {
  private config: ProxyConfig;
  private cache: ServerRoute[] = [];
  private lastSuccessfulPoll: number = 0;

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  async fetchServers(): Promise<ServerRoute[]> {
    try {
      const response = await this.httpGet<HccServersResponse>(
        `${this.config.hccApiUrl}/api/v1/mcpservers`
      );

      this.cache = response.servers.map((s) => ({
        name: s.name,
        url: s.transport.url || `http://${s.name}.mcp-server.svc.cluster.local:3000/mcp`,
        contextRef: s.contextRef,
        managed: s.enabled,
        ready: s.status.ready,
        port: this.extractPort(s.transport.url || `http://${s.name}.mcp-server.svc.cluster.local:3000/mcp`),
      }));

      this.lastSuccessfulPoll = Date.now();
      return this.cache;
    } catch (err) {
      console.error(`[HccClient] Poll failed: ${err instanceof Error ? err.message : err}`);
      return this.cache;
    }
  }

  getCachedServers(): ServerRoute[] {
    return this.cache;
  }

  isCacheStale(): boolean {
    if (this.lastSuccessfulPoll === 0) return true;
    return Date.now() - this.lastSuccessfulPoll > this.config.hccCacheTTL;
  }

  isCacheExpired(): boolean {
    if (this.lastSuccessfulPoll === 0) return true;
    return Date.now() - this.lastSuccessfulPoll > this.config.hccCacheExpiry;
  }

  getLastPollTime(): number {
    return this.lastSuccessfulPoll;
  }

  private extractPort(url: string): number {
    try {
      const parsed = new URL(url);
      return parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);
    } catch {
      return 3000;
    }
  }

  private httpGet<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          method: "GET",
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body) as T);
              } catch {
                reject(new Error(`Invalid JSON from HCC: ${body.substring(0, 100)}`));
              }
            } else {
              reject(new Error(`HCC returned ${res.statusCode}: ${body.substring(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("HCC request timeout"));
      });
      req.end();
    });
  }
}
