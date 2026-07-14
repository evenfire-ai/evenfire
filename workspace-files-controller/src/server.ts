/**
 * Express app composition for workspace-files-controller. main.ts wraps this
 * in an http server; tests construct the app directly via supertest.
 */
import express, { type Express } from 'express'
import pinoHttp from 'pino-http'
import { JwtVerifier } from './auth/jwtVerifier'
import type { Config } from './config'
import { logger } from './logger'
import { createFilesRouter } from './routes/files'
import { createHealthRouter } from './routes/health'

export function createApp(config: Config): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(pinoHttp({ logger }))
  app.use(express.json({ limit: '64kb' }))

  // Health/ready before auth — kubelet probes are unauthenticated.
  app.use(createHealthRouter({ mountPath: config.mountPath }))

  const verifier = new JwtVerifier({
    publicKeyPem: config.jwtPublicKey,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    expectedSharedFileSystem: config.sharedFileSystemName,
    expectedSharedFileSystemNamespace: config.sharedFileSystemNamespace,
  })

  app.use(
    '/v1',
    createFilesRouter({
      mountPath: config.mountPath,
      maxListEntries: config.maxListEntries,
      maxPathDepth: config.maxPathDepth,
      maxUploadBytes: config.maxUploadBytes,
      verifier,
    })
  )

  // 404 catch-all in the standard envelope.
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: 'not_found', message: `route not found: ${req.method} ${req.path}` },
    })
  })

  return app
}
