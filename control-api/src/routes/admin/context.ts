import { Router } from "express";
import { listTeamsByContext, listUsersByContext } from "../../services/directory/index.js";

export function createAdminContextRouter(): Router {
  const router = Router();

  router.get("/admin/contexts/:contextId/users", async (req, res, next) => {
    try {
      res.status(200).json({ items: await listUsersByContext(req.params.contextId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/contexts/:contextId/teams", async (req, res, next) => {
    try {
      res.status(200).json({ items: await listTeamsByContext(req.params.contextId) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
