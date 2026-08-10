import { loadConfig } from "./types";
import { StdioBridge } from "./bridge";

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[stdio-bridge] Starting: ${config.command} ${config.args.join(" ")}`);

  const bridge = new StdioBridge(config);
  await bridge.start();

  const shutdown = async (signal: string) => {
    console.log(`[stdio-bridge] ${signal} received`);
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[stdio-bridge] Fatal:", err);
  process.exit(1);
});
