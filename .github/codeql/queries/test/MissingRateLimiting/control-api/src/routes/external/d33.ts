import express from 'express'
import fs from 'fs'
import { asyncHandler } from '../../http/asyncHandler'
import {
  requireEffectiveV2ContractWithPublicErrors,
  requireExternalSessionLimiterIdentityWithPublicErrors,
  requireValidExternalSessionTokenWithPublicErrors,
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

async function protectedAsyncWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-d33-async', 'value')
  res.sendStatus(204)
}

const safeAsyncD33Router = express.Router()
safeAsyncD33Router.get(
  '/safe-async',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(requireEffectiveV2ContractWithPublicErrors),
  asyncHandler(protectedAsyncWork),
)

const reversedAsyncD33Router = express.Router()
reversedAsyncD33Router.get(
  '/reversed-async',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  asyncHandler(requireEffectiveV2ContractWithPublicErrors),
  asyncHandler(protectedAsyncWork),
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
)

const missingAsyncLimiterRouter = express.Router()
missingAsyncLimiterRouter.get(
  '/missing-async',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  asyncHandler(protectedAsyncWork),
)

const siblingAsyncLimiterRouter = express.Router()
siblingAsyncLimiterRouter.get(
  '/unprotected-async',
  requireExternalSessionLimiterIdentityWithPublicErrors,
  asyncHandler(protectedAsyncWork),
)
siblingAsyncLimiterRouter.get(
  '/protected-async',
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(protectedAsyncWork),
)

const nonDominatingAsyncParentRouter = express.Router()
nonDominatingAsyncParentRouter.use(
  '/parent-async',
  requireExternalSessionLimiterIdentityWithPublicErrors,
)
nonDominatingAsyncParentRouter.get(
  '/parent-async/unprotected',
  asyncHandler(protectedAsyncWork),
)
nonDominatingAsyncParentRouter.get(
  '/parent-async/limited',
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(protectedAsyncWork),
)

const wrongModuleAsyncRouter = express.Router()
wrongModuleAsyncRouter.get(
  '/wrong-module-async',
  requireWrongStageA,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(protectedAsyncWork),
)

const fullAuthLaterLimiterRouter = express.Router()
fullAuthLaterLimiterRouter.get(
  '/full-auth-later-limiter',
  requireValidExternalSessionTokenWithPublicErrors,
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(protectedAsyncWork),
)

const asyncFullAuthLaterLimiterRouter = express.Router()
asyncFullAuthLaterLimiterRouter.get(
  '/async-full-auth-later-limiter',
  asyncHandler(requireValidExternalSessionTokenWithPublicErrors),
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  asyncHandler(protectedAsyncWork),
)

const limiterDominatesFullAuthRouter = express.Router()
limiterDominatesFullAuthRouter.get(
  '/limiter-dominates-full-auth',
  rateLimitMiddleware({ type: 'external_access_catalog', max: 10 }),
  requireValidExternalSessionTokenWithPublicErrors,
  asyncHandler(protectedAsyncWork),
)

export {
  asyncFullAuthLaterLimiterRouter,
  fullAuthLaterLimiterRouter,
  limiterDominatesFullAuthRouter,
  missingLimiterRouter,
  missingAsyncLimiterRouter,
  nonDominatingAsyncParentRouter,
  nonDominatingParentRouter,
  reversedAsyncD33Router,
  reversedD33Router,
  safeAsyncD33Router,
  safeD33Router,
  siblingAsyncLimiterRouter,
  siblingLimiterRouter,
  wrongModuleAsyncRouter,
  wrongModuleRouter,
}
