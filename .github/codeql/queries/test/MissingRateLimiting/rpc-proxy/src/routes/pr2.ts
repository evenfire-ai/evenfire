import express from "express";
import fs from "node:fs";
import { requireRpcAuth, requireScope } from "../middleware/auth";
import { tokenDeclaresV2 } from "../userDelegationV2";


const router = express.Router();

function isV2ViewRequest(req: any): boolean {
  return Boolean(req.userDelegationV2 && req.authorizedActionV2);
}

function v2ViewAuthority(req: any, res: any, next: () => void): void {
  if (!tokenDeclaresV2(req.token)) {
    next();
    return;
  }
  requireRpcAuth(req, res, () => requireScope("sandbox:ui:view")(req, res, next));
}

function requireV2Delegation(req: any, res: any, next: () => void): void {
  if (!isV2ViewRequest(req)) {
    res.status(401).json({ error: "v2_delegation_required" });
    return;
  }
  next();
}

router.all(
  "/safe-v2-only-view",
  v2ViewAuthority,
  requireV2Delegation,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-v2-only", "protected");
    res.sendStatus(204);
  },
);

router.all("/unsafe-v2-legacy-pass-through", v2ViewAuthority, (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-v2-pass-through", "protected");
  res.sendStatus(204);
});

export default router;
