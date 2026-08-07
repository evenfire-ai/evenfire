import { loadConfig } from "./types";
import { Router } from "./router";
import { HccClient } from "./hccClient";
import { HttpForwarder } from "./httpForwarder";
import { Metrics } from "./metrics";
import { Health } from "./health";
import { ProxyServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[MCP Proxy] Starting (devMode=${config.devMode}, port=${config.port})`);

  const router = new Router();
  const hccClient = new HccClient(config);
  const forwarder = new HttpForwarder({
    requestTimeout: config.requestTimeout,
    maxResponseSize: config.maxResponseSize,
    maxBufferSize: 65536, // 64KB — TM-2: cap pre-commit buffer independently
  });
  const metrics = new Metrics();
  const health = new Health(router, hccClient);
  const server = new ProxyServer(router, forwarder, metrics, health, config);

  // Load initial routing table
  if (config.devMode) {
    console.log(`[MCP Proxy] Dev mode: loading ${config.devServers.length} static servers`);
    router.update(config.devServers);
  } else {
    const servers = await hccClient.fetchServers();
    const { added } = router.update(servers);
    console.log(`[MCP Proxy] Initial routing table: ${added.length} servers`);
  }

  // Start HCC polling (production only)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  if (!config.devMode) {
    pollInterval = setInterval(async () => {
      try {
        const servers = await hccClient.fetchServers();
        const { added, removed } = router.update(servers);
        if (added.length > 0) console.log(`[MCP Proxy] Servers added: ${added.join(", ")}`);
        if (removed.length > 0) console.log(`[MCP Proxy] Servers removed: ${removed.join(", ")}`);

        for (const s of servers) {
          metrics.setServerHealth(s.name, s.ready);
        }
      } catch (err) {
        console.error(`[MCP Proxy] Poll error: ${err instanceof Error ? err.message : err}`);
      }
    }, config.hccPollInterval);
  }

  await server.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[MCP Proxy] ${signal} received, shutting down...`);
    if (pollInterval) clearInterval(pollInterval);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[MCP Proxy] Fatal error:", err);
  process.exit(1);
});
