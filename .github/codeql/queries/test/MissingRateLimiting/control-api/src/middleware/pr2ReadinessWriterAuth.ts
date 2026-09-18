import { requireInternalControlJwt } from "./internalControlJwt";
import { requireInternalToken } from "./internalServiceAuth";
import { requireMcpHostJwt } from "./mcpHostJwtAuth";

export function requirePr2RuntimeReadinessWriter(req: any, res: any, next: () => void): void {
  const service = String(req.header("x-service-token") || "").trim();
  if (service === "external-rest-api") {
    requireInternalToken(req, res, () => {
      req.pr2RuntimeReadinessWriter = "external-rest-api";
      next();
    });
    return;
  }
  if (service) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.internalControl === true) {
    requireInternalControlJwt(req, res, () => {
      req.pr2RuntimeReadinessWriter = "workflow-recipes";
      next();
    });
    return;
  }
  requireMcpHostJwt(req, res, () => {
    req.pr2RuntimeReadinessWriter = "mcp-host";
    next();
  });
}

export function nonTerminatingReadinessWriter(_req: any, _res: any, next: () => void): void {
  next();
}
