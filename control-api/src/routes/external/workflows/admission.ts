import { attachAccessExecutionBudget } from '../../../middleware/accessExecutionBudget.js'
import {
  requireCompletedExternalSessionAuthenticationWithPublicErrors,
  requireExternalSessionLimiterIdentityWithPublicErrors,
} from '../../../middleware/externalSessionAuth.js'
import { requireAuthenticatedExternalUserRateLimitContext } from '../../../middleware/externalUserRateLimitPolicy.js'
import { bindCompletedExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { workflowTriggerRateLimit } from '../../workflows/shared/rateLimit.js'

export const externalWorkflowReadAdmission = Object.freeze([
  attachAccessExecutionBudget,
  requireExternalSessionLimiterIdentityWithPublicErrors,
  requireAuthenticatedExternalUserRateLimitContext,
  requireCompletedExternalSessionAuthenticationWithPublicErrors,
  bindCompletedExternalWorkflowCaller,
])

// The trigger limiter runs before any live session work, as in dev: it keys on
// the signature-verified user (or the source IP), so rejected sessions still pay.
export const externalWorkflowTriggerAdmission = Object.freeze([
  attachAccessExecutionBudget,
  workflowTriggerRateLimit(),
  requireExternalSessionLimiterIdentityWithPublicErrors,
  requireAuthenticatedExternalUserRateLimitContext,
  requireCompletedExternalSessionAuthenticationWithPublicErrors,
  bindCompletedExternalWorkflowCaller,
])
