import { config } from "../config";

function createMcpHostRuntimeAuthFromValues(values: {
  baseUrl: string;
  accessToken: string;
}) {
  return values;
}

export function createMcpHostRuntimeAuth() {
  return createMcpHostRuntimeAuthFromValues({
    baseUrl: config.mcpHostGatewayUrl,
    accessToken: "persisted elsewhere",
  });
}
