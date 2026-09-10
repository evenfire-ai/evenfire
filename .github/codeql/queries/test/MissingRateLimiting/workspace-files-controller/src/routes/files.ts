import express from "express";
import fs from "node:fs";

function authMiddleware(verifier: any) {
  return async (req: any, _res: any, next: () => void): Promise<void> => {
    await verifier.verifyBearer(req.header("authorization"));
    next();
  };
}

export function createFilesRouter(opts: any) {
  const router = express.Router();
  const requireRead = (_req: any, _res: any, next: () => void): void => next();

  async function checkpoint(authority: unknown): Promise<void> {
    await opts.checkpointAuthority(authority);
  }

  router.get("/unsafe-auth-late", requireRead, async (_req, res) => {
    await checkpoint(res.locals.authority);
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-auth-late", "protected");
    res.sendStatus(204);
  });

  router.use(authMiddleware(opts.verifier));

  router.get("/safe-files", requireRead, async (_req, res) => {
    await checkpoint(res.locals.authority);
    fs.writeFileSync("/tmp/evenfire-codeql-safe-files", "protected");
    res.sendStatus(204);
  });

  router.get("/unsafe-checkpoint-late", requireRead, async (_req, res) => {
    fs.writeFileSync("/tmp/evenfire-codeql-unsafe-checkpoint-late", "protected");
    await checkpoint(res.locals.authority);
    res.sendStatus(204);
  });

  return router;
}
