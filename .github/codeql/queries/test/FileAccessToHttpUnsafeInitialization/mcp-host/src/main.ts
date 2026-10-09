import { startPr2ReadinessReporter } from "./runtime/pr2ReadinessReporter";
import { createMcpHostRuntimeAuth } from "./workflow/runtimeAuthFactory";

declare const request: {
  body: { runtimeAuth: { baseUrl: string; accessToken: string } };
};

let runtimeAuth = request.body.runtimeAuth;
startPr2ReadinessReporter(runtimeAuth);
runtimeAuth = createMcpHostRuntimeAuth();
