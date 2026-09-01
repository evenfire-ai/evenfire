import express from 'express'
import fs from 'fs'
import {
  requireEffectiveV2ContractWithPublicErrors,
  requireExternalSessionLimiterIdentityWithPublicErrors,
} from '../../middleware/externalSessionAuth'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware'
import {
  requireExternalSessionLimiterIdentityWithPublicErrors as requireWrongStageA,
} from '../../middleware/unrelatedMiddleware'

function protectedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-d33', 'value')
  res.sendStatus(204)
}

const safeD33Router = express.Router()
safeD33Router.get(
  '/safe',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  requireEffectiveV2ContractWithPublicErrors,
  protectedWork,
)

const reversedD33Router = express.Router()
reversedD33Router.get(
  '/reversed',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  requireEffectiveV2ContractWithPublicErrors,
  protectedWork,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
)

const missingLimiterRouter = express.Router()
missingLimiterRouter.get(
  '/missing',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  protectedWork,
)

const siblingLimiterRouter = express.Router()
siblingLimiterRouter.get(
  '/unprotected',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  protectedWork,
)
siblingLimiterRouter.get(
  '/protected',
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  protectedWork,
)

const nonDominatingParentRouter = express.Router()
nonDominatingParentRouter.use(
  '/parent',
  requireExternalSessionLimiterIdentityWithPublicErrors,
)
nonDominatingParentRouter.get('/parent/unprotected', protectedWork)
nonDominatingParentRouter.get(
  '/parent/limited',
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  protectedWork,
)

const wrongModuleRouter = express.Router()
wrongModuleRouter.get(
  '/wrong-module',
  requireWrongStageA,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  protectedWork,
)

export {
  missingLimiterRouter,
  nonDominatingParentRouter,
  reversedD33Router,
  safeD33Router,
  siblingLimiterRouter,
  wrongModuleRouter,
}
