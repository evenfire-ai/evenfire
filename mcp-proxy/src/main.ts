import { loadConfig } from "./types";
import { Router } from "./router";
import { HccClient } from "./hccClient";
import { HttpForwarder } from "./httpForwarder";
import { Metrics } from "./metrics";
import { Health } from "./health";
import { ProxyServer } from "./server";
import { proxyLogger } from "./logger";

async function main(): Promise<void> {
  const config = loadConfig();
  proxyLogger.info("proxy_starting", {
    devMode: config.devMode,
    port: config.port,
    forwardingEnabled: config.forwardingEnabled,
  });

  const router = new Router();
  const hccClient = new HccClient(config);
  const forwarder = new HttpForwarder({
    requestTimeout: config.requestTimeout,
    maxResponseSize: config.maxResponseSize,
    maxBufferSize: 65536, // 64KB — TM-2: cap pre-commit buffer independently
    allowLoopbackTargets: config.allowLoopbackTargets,
  });
  const metrics = new Metrics();
  const health = new Health(router, hccClient);
  const server = new ProxyServer(router, forwarder, metrics, health, config, hccClient);

  // Load initial routing table
  if (config.devMode) {
    proxyLogger.info("dev_routes_loaded", { count: config.devServers.length });
    router.update(config.devServers);
  } else {
    const servers = await hccClient.fetchServers();
    const { added } = router.update(servers);
    proxyLogger.info("initial_inventory_loaded", { count: added.length });
  }

  // Start HCC polling (production only)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  if (!config.devMode) {
    pollInterval = setInterval(async () => {
      try {
        const servers = await hccClient.fetchServers();
        const { added, removed } = router.update(servers);
        if (added.length > 0) proxyLogger.info("servers_added", { count: added.length });
        if (removed.length > 0) proxyLogger.info("servers_removed", { count: removed.length });

        for (const s of servers) {
          metrics.setServerHealth(s.name, s.ready);
        }
      } catch (err) {
        proxyLogger.warn("inventory_poll_error", {
          reason: err instanceof Error ? err.name : "unknown",
        });
      }
    }, config.hccPollInterval);
  }

  await server.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    proxyLogger.info("shutdown_requested", { signal });
    if (pollInterval) clearInterval(pollInterval);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  proxyLogger.error("fatal_error", { reason: err instanceof Error ? err.name : "unknown" });
  process.exit(1);
});
