import { type DbClient, withTransaction } from '../db.js'
import { type AdminUserRecord, setupInitialAdminCredentials } from './adminAuthService.js'
import {
  type AdminDesktopWorkspaceProvisioningInput,
  provisionAdminDesktopWorkspace,
} from './directory/adminProvisioning.js'

export type InitialAdminSetupInput = Omit<
  AdminDesktopWorkspaceProvisioningInput,
  'controlAdminId'
> & {
  bootstrapUsername: string
  email: string
  username: string
  passwordHash: string
}

/**
 * Completes self-hosted first-run setup as one database transaction. The
 * bootstrap admin is not committed unless the matching Desktop identity,
 * workspace grants, and (when enabled) initial_setup operator link all commit.
 * This leaves a failed first run retryable instead of returning a misleading
 * successful Control UI session with incomplete operator authority.
 */
export async function setupInitialAdminWithDesktopWorkspace(
  input: InitialAdminSetupInput,
  transactionRunner: typeof withTransaction = withTransaction
): Promise<AdminUserRecord | null> {
  return transactionRunner(async (db: DbClient) => {
    const created = await setupInitialAdminCredentials(
      input.bootstrapUsername,
      input.email,
      input.username,
      input.passwordHash,
      db
    )
    if (!created) return null

    await provisionAdminDesktopWorkspace(
      {
        controlAdminId: created.id,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        agentNames: input.agentNames,
        contextIds: input.contextIds,
        linkDesktopOperator: input.linkDesktopOperator,
        requestId: input.requestId,
        seedPassword: input.seedPassword,
      },
      db
    )
    return created
  })
}
