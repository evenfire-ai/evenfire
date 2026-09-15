import express from "express";
import { externalUserRateLimitOptions } from "../../middleware/externalUserRateLimitPolicy";
import { rateLimitMiddleware } from "../../middleware/rateLimitMiddleware";
import { EXTERNAL_RPC_ADMISSION_CLASS } from "../../services/access/actionOperationRegistry";
import { issueUserDelegationV2 } from "../../utils/auth/userDelegationV2Token";

const router = express.Router();

router.post(
  "/external/rpc/delegations",
  rateLimitMiddleware(
    externalUserRateLimitOptions(EXTERNAL_RPC_ADMISSION_CLASS, "pre_auth"),
  ),
  rateLimitMiddleware(
    externalUserRateLimitOptions(EXTERNAL_RPC_ADMISSION_CLASS, "authenticated"),
  ),
  (_req, res) => res.json(issueUserDelegationV2({ operation: "exact" })),
);

export default router;
