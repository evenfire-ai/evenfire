import { startPr2ReadinessReporter } from "./runtime/pr2ReadinessReporter";
import { createMcpHostRuntimeAuth } from "./workflow/runtimeAuthFactory";

let runtimeAuth = null;
runtimeAuth = createMcpHostRuntimeAuth();
if (runtimeAuth) startPr2ReadinessReporter(runtimeAuth);
