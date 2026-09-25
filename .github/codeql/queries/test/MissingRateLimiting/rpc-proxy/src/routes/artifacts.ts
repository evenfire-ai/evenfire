import express from "express";
import fs from "node:fs";
import { rateLimit } from "express-rate-limit";
import { requireRpcAuth, requireScope } from "../middleware/auth";
import { resolveArtifactReadHostConnectionForUser } from "../services/mcpProxyService";

const router = express.Router();
const HOST_ARTIFACT_READ_LIMIT_PER_MIN = 30;

const resolveArtifactReadHost = async (req: any, _res: any, next: () => void): Promise<void> => {
  req.artifactReadHost = await resolveArtifactReadHostConnectionForUser(req.auth.sub, req.params.hostRef);
  if (!req.artifactReadHost) return;
  next();
};

const artifactReadEdgeRateLimit = rateLimit({
  windowMs: 60_000,
  limit: HOST_ARTIFACT_READ_LIMIT_PER_MIN,
  standardHeaders: "draft-7",
  keyGenerator: (req: any) => `${req.auth?.sub}:${req.artifactReadHost?.name}`,
  handler: (_req: any, res: any) => res.status(429).json({ error: "Too Many Requests" }),
});

router.get(
  "/rpc/hosts/:hostRef/artifacts",
  requireRpcAuth,
  requireScope("host:task:read"),
  resolveArtifactReadHost,
  artifactReadEdgeRateLimit,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-artifact-safe", "protected");
    res.sendStatus(204);
  },
);

router.get(
  "/rpc/hosts/:hostRef/artifacts/:filename/download",
  requireRpcAuth,
  requireScope("host:task:read"),
  resolveArtifactReadHost,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-artifact-no-limit", "protected");
    res.sendStatus(204);
  },
);

const wrongPolicy = rateLimit({
  windowMs: 60_000,
  limit: 31,
  standardHeaders: "draft-7",
  keyGenerator: (req: any) => `${req.auth?.sub}:${req.artifactReadHost?.name}`,
  handler: (_req: any, res: any) => res.status(429).json({ error: "Too Many Requests" }),
});
router.get(
  "/rpc/hosts/:hostRef/artifacts",
  requireRpcAuth,
  requireScope("host:task:read"),
  resolveArtifactReadHost,
  wrongPolicy,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-artifact-wrong-policy", "protected");
    res.sendStatus(204);
  },
);

const staleAlias = artifactReadEdgeRateLimit;
router.get(
  "/rpc/hosts/:hostRef/artifacts",
  requireRpcAuth,
  requireScope("host:task:read"),
  resolveArtifactReadHost,
  staleAlias,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-artifact-stale-alias", "protected");
    res.sendStatus(204);
  },
);

router.get(
  "/rpc/hosts/:hostRef/artifacts",
  requireRpcAuth,
  requireScope("host:task:read"),
  resolveArtifactReadHost,
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-artifact-late", "protected");
    res.sendStatus(204);
  },
  artifactReadEdgeRateLimit,
);

export default router;
