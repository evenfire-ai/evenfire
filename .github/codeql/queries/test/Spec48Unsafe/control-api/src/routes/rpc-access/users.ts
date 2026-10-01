import express from 'express'
import fs from 'node:fs'
import { requireValidRpcAccessTokenAny } from '../../middleware/rpcAccessAuth.js'

const router = express.Router()
const buckets = new Map<string, number>()
const hostAccessPath = '/rpc/access/users/:userId/mcp-hosts/:hostRef'

router.get(
  `${hostAccessPath}/artifact-read`,
  requireValidRpcAccessTokenAny(['host:task:read']),
  async (req: any, res: any) => {
    // Unsafe: wrong hostRef key and process-local accounting; protected work runs first.
    fs.readFileSync('/tmp/control-api-artifact-metadata')
    buckets.set(req.params.hostRef, Date.now())
    res.status(200).json({ host: req.params.hostRef })
  }
)
