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

export const externalWorkflowTriggerAdmission = Object.freeze([
  attachAccessExecutionBudget,
  requireExternalSessionLimiterIdentityWithPublicErrors,
  requireAuthenticatedExternalUserRateLimitContext,
  workflowTriggerRateLimit(),
  requireCompletedExternalSessionAuthenticationWithPublicErrors,
  bindCompletedExternalWorkflowCaller,
])
