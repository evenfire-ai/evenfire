import express from 'express'
import fs from 'fs'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware'
import { unrelatedMiddleware } from '../../middleware/unrelatedMiddleware'

const router = express.Router()

function protectedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-protected', 'value')
  res.sendStatus(204)
}

function unprotectedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-unprotected', 'value')
  res.sendStatus(204)
}

function orderedWrongWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-ordered-wrong', 'value')
  res.sendStatus(204)
}

function unrelatedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-unrelated', 'value')
  res.sendStatus(204)
}

function specializedWork(_req: express.Request, res: express.Response) {
  fs.writeFileSync('/tmp/evenfire-codeql-specialized', 'value')
  res.sendStatus(204)
}

router.post(
  '/protected',
  rateLimitMiddleware({ type: 'external_member_mutation', max: 10 }),
  protectedWork,
)

router.post('/unprotected', unrelatedMiddleware(), unprotectedWork)

router.post(
  '/ordered-wrong',
  orderedWrongWork,
  rateLimitMiddleware({ type: 'external_member_mutation', max: 10 }),
)

router.post('/unrelated', unrelatedMiddleware(), unrelatedWork)

router.post(
  '/specialized',
  rateLimitMiddleware({ type: 'external_credential_authentication', max: 5 }),
  specializedWork,
)

const assignedRateLimit = rateLimitMiddleware({
  type: 'external_member_read',
  max: 60,
})

router.get('/assigned', assignedRateLimit, specializedWork)

export default router
