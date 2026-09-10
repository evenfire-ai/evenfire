import express from "express";
import fs from "node:fs";
import { requireActionCheckpointCaller } from "../../middleware/actionCheckpointCaller";

const router = express.Router();

router.post("/safe-checkpoint", requireActionCheckpointCaller, (_req, res) => {
  fs.writeFileSync("/tmp/evenfire-codeql-safe-checkpoint", "protected");
  res.sendStatus(204);
});

router.post(
  "/unsafe-checkpoint-late-guard",
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-checkpoint", "protected");
    res.sendStatus(204);
  },
  requireActionCheckpointCaller,
);
