export interface ServerRoute {
  name: string;
  url: string;
  contextRef: string;
  managed: boolean;
  ready: boolean;
  port: number;
}

export interface HccServerInfo {
  name: string;
  contextRef: string;
  transport: { type: string; url?: string };
  enabled: boolean;
  status: { deployed: boolean; ready: boolean; authoritative?: boolean };
  destinationRevision?: string;
}

export interface HccServersResponse {
  servers: HccServerInfo[];
  contextRef: string;
  timestamp: string;
}

export interface ProxyConfig {
  port: number;
  hccApiUrl: string;
  hccPollInterval: number;
  hccCacheTTL: number;
  hccCacheExpiry: number;
  requestTimeout: number;
  maxResponseSize: number;
  devMode: boolean;
  devServers: ServerRoute[];
  logLevel: string;
  forwardingEnabled: boolean;
  systemTokenFile: string;
  requestBodyLimit: number;
  allowLoopbackTargets: boolean;
}

export function loadConfig(): ProxyConfig {
  const devMode = process.env.CLERUM_DEV_MODE === "true";

  let devServers: ServerRoute[] = [];
  if (devMode && process.env.MCP_PROXY_SERVERS) {
    devServers = JSON.parse(process.env.MCP_PROXY_SERVERS);
  }

  return {
    port: parseInt(process.env.MCP_PROXY_PORT || "8083", 10),
    hccApiUrl: process.env.HCC_API_URL || "http://host-context-controller.control-plane:8081",
    hccPollInterval: parseInt(process.env.HCC_POLL_INTERVAL || "30000", 10),
    hccCacheTTL: parseInt(process.env.HCC_CACHE_TTL || "180000", 10),
    hccCacheExpiry: parseInt(process.env.HCC_CACHE_EXPIRY || "600000", 10),
    requestTimeout: parseInt(process.env.MCP_PROXY_REQUEST_TIMEOUT || "30000", 10),
    maxResponseSize: parseInt(process.env.MCP_PROXY_MAX_RESPONSE_SIZE || "10485760", 10),
    devMode,
    devServers,
    logLevel: process.env.LOG_LEVEL || "info",
    forwardingEnabled: process.env.MCP_PROXY_FORWARDING_ENABLED === "true",
    systemTokenFile:
      process.env.MCP_PROXY_SYSTEM_TOKEN_FILE ||
      "/var/run/secrets/clerum/mcp-proxy/token",
    requestBodyLimit: Math.min(
      Math.max(parseInt(process.env.MCP_PROXY_REQUEST_BODY_LIMIT || "1048576", 10), 1),
      8 * 1048576
    ),
    allowLoopbackTargets: devMode,
  };
}
