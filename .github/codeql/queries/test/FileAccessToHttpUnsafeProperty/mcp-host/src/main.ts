import { startPr2ReadinessReporter } from "./runtime/pr2ReadinessReporter";
import { createMcpHostRuntimeAuth } from "./workflow/runtimeAuthFactory";

declare const request: { body: { url: string } };

let runtimeAuth = null;
runtimeAuth = createMcpHostRuntimeAuth();
if (runtimeAuth) {
  runtimeAuth.baseUrl = request.body.url;
  startPr2ReadinessReporter(runtimeAuth);
}
