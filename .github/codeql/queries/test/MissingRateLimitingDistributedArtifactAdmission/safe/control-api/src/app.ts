import express from 'express'
import { requireInternalService, requireInternalToken } from './middleware/internalServiceAuth.js'
import { createRpcAccessRouter } from './routes/rpc-access/index.js'

export function createApp() {
  const api = express.Router()
  api.use(requireInternalToken)
  api.use('/rpc', requireInternalService('rpc-proxy'))
  api.use(createRpcAccessRouter())
  return api
}
