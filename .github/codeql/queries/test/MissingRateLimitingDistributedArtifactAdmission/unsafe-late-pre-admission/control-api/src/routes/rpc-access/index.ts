import { createRpcAccessUsersRouter } from './users.js'
import { Router } from 'express'

export function createRpcAccessRouter(gateway: unknown, options: { directory?: unknown }) {
  const router = Router()
  router.use(createRpcAccessUsersRouter(gateway, options))
  return router
}
