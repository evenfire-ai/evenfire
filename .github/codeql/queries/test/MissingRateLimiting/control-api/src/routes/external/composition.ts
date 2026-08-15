import express from 'express'
import fs from 'fs'
import {
  requireExternalSessionRateLimitContext,
  requireExternalTeamParamMatch,
  requireValidExternalSessionToken,
  requireValidExternalSessionTokenWithPublicErrors,
} from '../../middleware/externalSessionAuth'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware'

function sameRouteWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-same-route', 'value')
  res.sendStatus(204)
}

const sameRouteRouter = express.Router()
sameRouteRouter.post(
  '/same-route',
  requireExternalSessionRateLimitContext({ purpose: 'protected' }),
  rateLimitMiddleware({ type: 'external_member_mutation', max: 10 }),
  sameRouteWork,
)

function completeRead(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-complete-read', 'value')
  res.sendStatus(204)
}

function completeWrite(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-complete-write', 'value')
  res.sendStatus(204)
}

const completeParentRouter = express.Router()
completeParentRouter.use('/complete', requireValidExternalSessionToken)
completeParentRouter.get(
  '/complete/read',
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
  completeRead,
)
completeParentRouter.post(
  '/complete/write',
  rateLimitMiddleware({ type: 'external_member_mutation', max: 10 }),
  completeWrite,
)

function incompleteProtected(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-incomplete-protected', 'value')
  res.sendStatus(204)
}

function incompleteUnprotected(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-incomplete-unprotected', 'value')
  res.sendStatus(204)
}

const incompleteParentRouter = express.Router()
incompleteParentRouter.use(
  '/incomplete',
  requireValidExternalSessionTokenWithPublicErrors,
)
incompleteParentRouter.get(
  '/incomplete/protected',
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
  incompleteProtected,
)
incompleteParentRouter.get('/incomplete/unprotected', incompleteUnprotected)

function globalWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-global', 'value')
  res.sendStatus(204)
}

const globalRouter = express.Router()
globalRouter.use('/global', requireValidExternalSessionToken)
globalRouter.use(
  '/global',
  rateLimitMiddleware({ type: 'external_shared_filesystem_read', max: 60 }),
)
globalRouter.get('/global', globalWork)

function lateGlobalWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-late-global', 'value')
  res.sendStatus(204)
}

const lateGlobalRouter = express.Router()
lateGlobalRouter.use('/late-global', requireValidExternalSessionToken)
lateGlobalRouter.get('/late-global', lateGlobalWork)
lateGlobalRouter.use(
  '/late-global',
  rateLimitMiddleware({ type: 'external_shared_filesystem_read', max: 60 }),
)

function sameModuleAuthorizationWork(_req: express.Request, res: express.Response) {
  res.sendStatus(204)
}

const sameModuleAuthorizationRouter = express.Router()
sameModuleAuthorizationRouter.get(
  '/same-module-authorization',
  requireExternalTeamParamMatch,
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
  sameModuleAuthorizationWork,
)

function unrelatedPathWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-unrelated-path', 'value')
  res.sendStatus(204)
}

const unrelatedPathRouter = express.Router()
unrelatedPathRouter.use('/sensitive', requireValidExternalSessionToken)
unrelatedPathRouter.get(
  '/other',
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
  unrelatedPathWork,
)

function lateSameRouteWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-late-same-route', 'value')
  res.sendStatus(204)
}

const lateSameRouteRouter = express.Router()
lateSameRouteRouter.get(
  '/late-same-route',
  requireValidExternalSessionToken,
  lateSameRouteWork,
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
)

function lateChildWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-late-child', 'value')
  res.sendStatus(204)
}

const lateChildRouter = express.Router()
lateChildRouter.use('/late-child', requireValidExternalSessionToken)
lateChildRouter.get(
  '/late-child/read',
  lateChildWork,
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
)

function nestedProtectedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-nested-protected', 'value')
  res.sendStatus(204)
}

function nestedUnprotectedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-nested-unprotected', 'value')
  res.sendStatus(204)
}

const nestedChildRouter = express.Router()
nestedChildRouter.get(
  '/protected',
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
  nestedProtectedWork,
)
nestedChildRouter.get('/unprotected', nestedUnprotectedWork)

const nestedGlobalRouter = express.Router()
nestedGlobalRouter.use('/nested-global', requireValidExternalSessionToken)
nestedGlobalRouter.use('/nested-global', nestedChildRouter)

const nestedContextChildRouter = express.Router()
nestedContextChildRouter.use('/', requireValidExternalSessionToken)

const nestedContextParentRouter = express.Router()
nestedContextParentRouter.use('/nested-context', nestedContextChildRouter)
nestedContextParentRouter.use(
  '/nested-context',
  rateLimitMiddleware({ type: 'external_member_read', max: 60 }),
)

export {
  completeParentRouter,
  globalRouter,
  incompleteParentRouter,
  lateChildRouter,
  lateGlobalRouter,
  lateSameRouteRouter,
  nestedContextParentRouter,
  nestedGlobalRouter,
  sameRouteRouter,
  sameModuleAuthorizationRouter,
  unrelatedPathRouter,
}
