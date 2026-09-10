import express from "express";
import fs from "node:fs";
import { runtimeEdgeGuard } from "./server/edgeRuntimeAuth";

const app = express();

app.post(
  "/safe-mcp-edge",
  runtimeEdgeGuard({ operation: "chat.message.invoke" }),
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-safe-mcp", "protected");
    res.sendStatus(204);
  },
);

app.post(
  "/unsafe-mcp-late-guard",
  (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-mcp-late", "protected");
    res.sendStatus(204);
  },
  runtimeEdgeGuard({ operation: "chat.message.invoke" }),
);
