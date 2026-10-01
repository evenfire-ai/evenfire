import { requireActionCheckpointCaller } from '../../middleware/actionCheckpointCaller.js'
import { checkpointActionAuthority } from '../../services/access/actionAuthorityCheckpoint.js'
import {
  admitHostMessage,
  respondHostMessageAdmissionFailure,
} from '../../services/hostMessageAdmission.js'
import {
  admitHostRpc,
  requiresHostRpcAdmission,
  respondHostRpcAdmissionFailure,
} from '../../services/hostRpcAdmission.js'

const router = { post: (_path: string, ..._handlers: any[]) => undefined }

router.post(
  '/internal/action-authority/checkpoint',
  requireActionCheckpointCaller,
  async (req: any, res: any) => {
    const parsed = req.parsed
    const caller = req.caller
    const chargesHostMessageAdmission =
      parsed.operationId === 'chat.message.invoke' && caller.service === 'rpc-proxy'
    if (chargesHostMessageAdmission) {
      const messageAdmission = await admitHostMessage(parsed.principal.sub)
      if (messageAdmission.status !== 'allowed') {
        respondHostMessageAdmissionFailure(res, messageAdmission)
        return
      }
    }
    if (requiresHostRpcAdmission(parsed.operationId)) {
      const admission = await admitHostRpc(parsed.principal.sub)
      if (admission.status !== 'allowed') {
        respondHostRpcAdmissionFailure(res, admission)
        return
      }
    }
    return checkpointActionAuthority(parsed)
  }
)
