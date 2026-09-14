import express from "express";
import fs from "node:fs";
import { requireInternalService } from "../../middleware/internalServiceAuth";

function validateActionOperationTarget(value: unknown): object {
  return value as object;
}

function hashActionTarget(_value: object): string {
  return "ath2_safe";
}

function hasExpectedV2OAuthContext(encoded: string, expected: object): boolean {
  const decoded = JSON.parse(encoded) as { target: unknown; targetHash: string };
  const target = validateActionOperationTarget(decoded.target);
  return hashActionTarget(target) === decoded.targetHash && Boolean(expected);
}

const router = express.Router();

router.post(
  "/safe-oauth",
  requireInternalService("rpc-proxy"),
  (req, res) => {
    if (!hasExpectedV2OAuthContext(req.header("x-action-context"), {})) {
      return res.sendStatus(403);
    }
    fs.writeFileSync("/tmp/evenfire-codeql-safe-oauth", "protected");
    return res.sendStatus(204);
  },
);

router.post(
  "/unsafe-oauth-ignored-binding",
  requireInternalService("rpc-proxy"),
  (req, res) => {
    hasExpectedV2OAuthContext(req.header("x-action-context"), {});
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-oauth-ignored", "protected");
    return res.sendStatus(204);
  },
);

function hasExpectedV2OAuthContextStub(): boolean {
  return true;
}

router.post(
  "/unsafe-oauth-local-stub",
  requireInternalService("rpc-proxy"),
  (_req, res) => {
    if (!hasExpectedV2OAuthContextStub()) return res.sendStatus(403);
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-oauth-stub", "protected");
    return res.sendStatus(204);
  },
);

router.post(
  "/unsafe-oauth-late-binding",
  requireInternalService("rpc-proxy"),
  (req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-oauth", "protected");
    if (!hasExpectedV2OAuthContext(req.header("x-action-context"), {})) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  },
);
