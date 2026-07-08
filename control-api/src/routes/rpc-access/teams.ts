import { Router } from "express";
import { requireRpcTokenTeamMatch, requireValidRpcAccessToken } from "../../middleware/rpcAccessAuth.js";
import { getTeamAgents, getTeamContexts } from "../../services/directory/index.js";

export function createRpcAccessTeamsRouter(): Router {
  const router = Router();

  router.get("/rpc/access/teams/:teamId/contexts", requireValidRpcAccessToken(), requireRpcTokenTeamMatch(), async (req, res, next) => {
    try {
      res.status(200).json(await getTeamContexts(req.params.teamId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/rpc/access/teams/:teamId/agents", requireValidRpcAccessToken(), requireRpcTokenTeamMatch(), async (req, res, next) => {
    try {
      res.status(200).json(await getTeamAgents(req.params.teamId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
