import { attachAccessExecutionBudget } from '../../../middleware/accessExecutionBudget.js'
import { requireValidExternalSessionTokenWithPublicErrors } from '../../../middleware/externalSessionAuth.js'
import { bindCompletedExternalWorkflowCaller } from '../../workflows/shared/auth.js'
import { workflowTriggerRateLimit } from '../../workflows/shared/rateLimit.js'

// One session validation per request, as in dev and on every other protected
// route: no limiter sits between identity and policy here.
export const externalWorkflowReadAdmission = Object.freeze([
  attachAccessExecutionBudget,
  requireValidExternalSessionTokenWithPublicErrors,
  bindCompletedExternalWorkflowCaller,
])

// The trigger limiter runs before any live session work, as in dev: it keys on
// the signature-verified user (or the source IP), so rejected sessions still pay.
export const externalWorkflowTriggerAdmission = Object.freeze([
  attachAccessExecutionBudget,
  workflowTriggerRateLimit(),
  requireValidExternalSessionTokenWithPublicErrors,
  bindCompletedExternalWorkflowCaller,
])
