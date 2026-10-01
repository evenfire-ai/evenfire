import { requireValidRpcAccessToken } from '../../middleware/rpcAccessAuth.js'
import { respondWithAuthorizedHostConnection } from '../../services/hostConnection.js'
import {
  admitHostMessage,
  respondHostMessageAdmissionFailure,
} from '../../services/hostMessageAdmission.js'

const router = { post: (_path: string, ..._handlers: any[]) => undefined }

const hostAccessPath = '/rpc/access/users/:userId/mcp-hosts/:hostRef'
router.post(
  `${hostAccessPath}/message-resolution`,
  requireValidRpcAccessToken('host:message:invoke'),
  async (req: any, res: any) => {
    const claims = req.rpcAuth
    if (!claims) return
    const admission = await admitHostMessage(claims.sub)
    if (admission.status !== 'allowed') {
      respondHostMessageAdmissionFailure(res, admission)
      return
    }
    return respondWithAuthorizedHostConnection(req, res)
  }
)
