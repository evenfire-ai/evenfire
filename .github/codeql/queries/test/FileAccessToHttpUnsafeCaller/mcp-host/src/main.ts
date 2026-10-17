import { startPr2ReadinessReporter } from "./runtime/pr2ReadinessReporter";
import { createMcpHostRuntimeAuth } from "./workflow/runtimeAuthFactory";

declare const request: { body: { url: string } };

let runtimeAuth = null;
runtimeAuth = createMcpHostRuntimeAuth();
if (runtimeAuth) startPr2ReadinessReporter(runtimeAuth);

startPr2ReadinessReporter({
  baseUrl: request.body.url,
  accessToken: "untrusted",
});
