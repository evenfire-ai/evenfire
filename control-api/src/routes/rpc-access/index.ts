import { Router } from "express";
import { K8sGateway } from "../../k8s.js";
import { createRpcAccessTeamsRouter } from "./teams.js";
import { createRpcAccessUsersRouter } from "./users.js";

export function createRpcAccessRouter(gateway: K8sGateway): Router {
  const router = Router();
  router.use(createRpcAccessUsersRouter(gateway));
  router.use(createRpcAccessTeamsRouter());

  return router;
}
