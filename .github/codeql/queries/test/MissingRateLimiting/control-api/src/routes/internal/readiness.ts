import express from "express";
import fs from "node:fs";
import {
  nonTerminatingReadinessWriter,
  requirePr2RuntimeReadinessWriter,
} from "../../middleware/pr2ReadinessWriterAuth";

const router = express.Router();

router.post("/safe-readiness", requirePr2RuntimeReadinessWriter, (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-safe-readiness", "protected");
  res.sendStatus(204);
});

router.post("/unsafe-readiness-missing", (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-readiness-missing", "protected");
  res.sendStatus(204);
});

router.post("/unsafe-readiness-nonterminating", nonTerminatingReadinessWriter, (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-readiness-nonterminating", "protected");
  res.sendStatus(204);
});

router.post(
  "/unsafe-readiness-after",
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-readiness-after", "protected");
    res.sendStatus(204);
  },
  requirePr2RuntimeReadinessWriter,
);
