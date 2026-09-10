import express from "express";
import fs from "node:fs";
import { requireInternalService } from "../../middleware/internalServiceAuth";

function hasExpectedV2OAuthContext(): boolean {
  return true;
}

const router = express.Router();

router.post(
  "/safe-oauth",
  requireInternalService("rpc-proxy"),
  (_req, res) => {
    if (!hasExpectedV2OAuthContext()) return res.sendStatus(403);
    fs.writeFileSync("/tmp/evenfire-codeql-safe-oauth", "protected");
    return res.sendStatus(204);
  },
);

router.post(
  "/unsafe-oauth-late-binding",
  requireInternalService("rpc-proxy"),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-oauth", "protected");
    if (!hasExpectedV2OAuthContext()) return res.sendStatus(403);
    return res.sendStatus(204);
  },
);
