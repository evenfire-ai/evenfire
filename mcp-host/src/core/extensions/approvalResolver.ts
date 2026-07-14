/**
 * ApprovalResolver - Permission resolution for tool approval.
 *
 * Phase 6: Implements the hierarchical permission model:
 *
 * Resolution order:
 *   1. No config -> false (cli_only default -- safest)
 *   2. Policy is cli_only -> false for channel users
 *   3. Channel type disabled -> false
 *   4. Policy is channel_users -> true for any user
 *   5. Policy is designated_approvers -> check approvers list
 */

import type { ApprovalConfig } from "./approvalTypes";

export class ApprovalResolver {
  /**
   * Determine whether a user can approve a tool via their channel.
   *
   * @param userId - The user requesting to approve
   * @param channelType - The channel type (telegram/email/slack), undefined for CLI
   * @param channelId - The channel ID (unused in current resolution, reserved for future)
   * @param config - The approval configuration from Host CRD
   * @returns true if the user is allowed to approve
   */
  canUserApprove(
    userId: string,
    channelType: string | undefined,
    _channelId: string | undefined,
    config: ApprovalConfig | undefined,
  ): boolean {
    // 1. No config -> default to cli_only (safest)
    if (!config) {
      return false;
    }

    // CLI users (no channelType) always allowed -- they use /approve /deny endpoints directly
    if (!channelType) {
      return true;
    }

    // 2. Policy is cli_only -> block all channel users
    if (config.defaultPolicy === "cli_only") {
      return false;
    }

    // 3. Check channel-level enabled flag
    const channelKey = channelType as "telegram" | "email" | "slack";
    const channelConfig = config.channels[channelKey];

    // If channel config exists and is explicitly disabled -> block
    if (channelConfig && !channelConfig.enabled) {
      return false;
    }

    // If channel config not specified -> treated as enabled (opt-out model)

    // 4. Policy is channel_users -> any user can approve
    if (config.defaultPolicy === "channel_users") {
      return true;
    }

    // 5. Policy is designated_approvers -> check approvers list
    if (config.defaultPolicy === "designated_approvers") {
      if (!channelConfig || !channelConfig.approvers) {
        // No approvers list defined -> block all
        return false;
      }

      if (channelConfig.approvers.length === 0) {
        // Empty approvers list -> block all
        return false;
      }

      return channelConfig.approvers.includes(userId);
    }

    // Unknown policy -> block by default
    return false;
  }
}
