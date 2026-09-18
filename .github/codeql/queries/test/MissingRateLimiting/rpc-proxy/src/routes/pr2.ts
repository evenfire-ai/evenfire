import express from "express";
import fs from "node:fs";
import { requireRpcAuth, requireScope } from "../middleware/auth";
import { tokenDeclaresV2 } from "../userDelegationV2";
import { requireRpcAuth as unrelatedNamedGuard } from "./unrelatedAuth";

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

router.post(
  "/safe-pr2",
  requireRpcAuth,
  requireScope("mcp:server:invoke"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-safe", "protected");
    res.sendStatus(204);
  },
);

router.post("/unsafe-one-stage", requireRpcAuth, (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-pr2-one-stage", "protected");
  res.sendStatus(204);
});

router.post(
  "/unsafe-unrelated",
  unrelatedNamedGuard,
  requireScope("mcp:server:invoke"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-unrelated", "protected");
    res.sendStatus(204);
  },
);

router.post("/unsafe-direct", (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-pr2-direct", "protected");
  res.sendStatus(204);
});

router.post(
  "/unsafe-unregistered-v2",
  requireRpcAuth,
  requireScope("mcp:server:invoke"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-unregistered-v2", "protected");
    res.sendStatus(204);
  },
);

router.post(
  "/unsafe-wrong-method",
  requireRpcAuth,
  requireScope("mcp:server:invoke"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-wrong-method", "protected");
    res.sendStatus(204);
  },
);

router.post(
  "/unsafe-stale-binder-literal",
  requireRpcAuth,
  requireScope("mcp:server:invoke"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-stale-binder", "protected");
    res.sendStatus(204);
  },
);

router.post(
  "/unsafe-guard-after-handler",
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-pr2-guard-after", "protected");
    res.sendStatus(204);
  },
  requireRpcAuth,
  requireScope("mcp:server:invoke"),
);

export default router;
