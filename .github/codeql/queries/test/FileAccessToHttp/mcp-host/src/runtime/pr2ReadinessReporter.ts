import fs from "node:fs";
const persistedCredential = fs.readFileSync(
  "/var/run/evenfire/runtime-auth.json",
  "utf-8",
);

export function startPr2ReadinessReporter(
  auth: { baseUrl: string; accessToken: string },
  fetchImpl: typeof fetch = fetch,
): void {
  // SAFE: persisted data is only a credential in Authorization. The destination
  // is trusted configuration plus the one fixed readiness endpoint.
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

  // UNSAFE: persisted data controls the full URL.
  fetchImpl(persistedCredential, { method: "POST" });

  // UNSAFE: persisted data controls the hostname/base URL.
  fetchImpl(
    `${persistedCredential.replace(/\/+$/, "")}/api/v1/internal/pr2-readiness/runtime-evidence`,
    { method: "POST" },
  );

  // UNSAFE: persisted data changes the endpoint path.
  fetchImpl(`${auth.baseUrl}/${persistedCredential}`, {
    method: "POST",
  });

  // UNSAFE: a persisted value is sent in the body as well as Authorization.
  fetchImpl(
    `${auth.baseUrl.replace(/\/+$/, "")}/api/v1/internal/pr2-readiness/runtime-evidence`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${persistedCredential}` },
      body: persistedCredential,
    },
  );

  // UNSAFE: an evidence field derived from persisted data changes the destination.
  const persistedEvidence = JSON.parse(persistedCredential) as {
    endpoint: string;
  };
  fetchImpl(`${auth.baseUrl}/${persistedEvidence.endpoint}`, {
    method: "POST",
  });
}
