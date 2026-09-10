import express from "express";
import fs from "node:fs";
import { requireRpcAuth, requireScope } from "../middleware/auth";
import { requireRpcAuth as unrelatedNamedGuard } from "./unrelatedAuth";

const router = express.Router();

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
