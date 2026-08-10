export interface BridgeConfig {
  command: string;
  args: string[];
  port: number;
  healthPath: string;
  restartMax: number;
  restartDelay: number;
  initTimeout: number;
  shutdownTimeout: number;
  logLevel: string;
}

export function loadConfig(): BridgeConfig {
  const command = process.env.STDIO_COMMAND;
  if (!command) {
    throw new Error("STDIO_COMMAND is required");
  }

  return {
    command,
    args: JSON.parse(process.env.STDIO_ARGS || "[]"),
    port: parseInt(process.env.BRIDGE_PORT || "3000", 10),
    healthPath: process.env.BRIDGE_HEALTH_PATH || "/health",
    restartMax: parseInt(process.env.STDIO_RESTART_MAX || "3", 10),
    restartDelay: parseInt(process.env.STDIO_RESTART_DELAY || "5000", 10),
    initTimeout: parseInt(process.env.STDIO_INIT_TIMEOUT || "30000", 10),
    shutdownTimeout: parseInt(process.env.STDIO_SHUTDOWN_TIMEOUT || "10000", 10),
    logLevel: process.env.LOG_LEVEL || "info",
  };
}
