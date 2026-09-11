import { config } from "../config";

declare const request: { body: { url: string } };

function createMcpHostRuntimeAuthFromValues(values: {
  baseUrl: string;
  accessToken: string;
}) {
  return values;
}

export function createMcpHostRuntimeAuth() {
  if (false) {
    return createMcpHostRuntimeAuthFromValues({
      baseUrl: config.mcpHostGatewayUrl,
      accessToken: "persisted elsewhere",
    });
  }
  return createMcpHostRuntimeAuthFromValues({
    baseUrl: request.body.url,
    accessToken: "persisted elsewhere",
  });
}
