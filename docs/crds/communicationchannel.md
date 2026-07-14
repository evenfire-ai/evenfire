# CommunicationChannel CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Short name:** `channel`
**Watched by:** channel-reader (filtered by `hostRef`)

## Purpose

CommunicationChannel defines one or more communication channel groups (Telegram,
Email, Slack) with their allowed user identifiers. The channel-reader service
watches these CRDs, polls each configured channel for new messages from
authorized senders, and forwards them to the mcp-host.
Telegram personal approval accounts are verified separately from Profile UI.

## Spec Fields

### Core

| Field          | Type   | Required | Description                                                                                                                      |
| -------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `spec.hostRef` | string | yes      | Reference to the Host this channel configuration belongs to. The channel-reader uses this to filter which channels it processes. |

### Telegram

| Field                                    | Type                                | Required | Description                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.telegram`                          | object[]                            | no       | List of Telegram channel groups.                                                                                                                                                                                                                                                             |
| `spec.telegram[].channelId`              | string                              | yes      | Identifier for this Telegram private chat, group, or supergroup.                                                                                                                                                                                                                             |
| `spec.telegram[].chatType`               | `private`, `group`, or `supergroup` | yes      | Explicit Telegram chat type for this operational channel. `channel` cannot identify a personal approver and remains unsupported.                                                                                                                                                             |
| `spec.telegram[].userIds`                | string[]                            | no       | Optional transport pre-filter for Telegram user IDs. This does not verify personal accounts or authorize workflow actions.                                                                                                                                                                   |
| `spec.telegram[].replyOnlyWhenMentioned` | boolean                             | no       | If `true`, in groups and supergroups the bot only processes messages that @mention the bot, use a `text_mention` entity for the bot, or reply to the bot. Private chats are unaffected. `/approve` and `/deny` commands are always accepted from verified users after backend authorization. |

### Email

| Field                    | Type     | Required | Description                                                                               |
| ------------------------ | -------- | -------- | ----------------------------------------------------------------------------------------- |
| `spec.email`             | object[] | no       | List of Email channel groups.                                                             |
| `spec.email[].channelId` | string   | yes      | Mailbox/folder to read from (e.g. `INBOX`).                                               |
| `spec.email[].emails`    | string[] | yes      | Allowed email addresses for this group. Only messages from these addresses are processed. |

### Slack

| Field                                 | Type     | Required                   | Description                                                                                                                                                                                                                                           |
| ------------------------------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.slack`                          | object[] | no                         | List of Slack channel groups.                                                                                                                                                                                                                         |
| `spec.slack[].channelId`              | string   | yes                        | Slack channel identifier. When `userIds` are configured, must be a stable Slack channel ID, not a display name (e.g. `C0123456789`, `D0123456789`, or `G0123456789`). Legacy `userNames`-only groups may retain an existing channel display name.     |
| `spec.slack[].workspaceId`            | string   | with userIds               | Slack workspace/team ID (e.g. `T0123456789`). Required when `userIds` are configured so provider-originated workflow approval decisions bind to stable workspace identity; not required for legacy `userNames`-only groups.                           |
| `spec.slack[].userIds`                | string[] | yes for workflow approvals | Allowed Slack user IDs for this group (e.g. `U0123456789`). Workflow approval decisions use this stable identity.                                                                                                                                     |
| `spec.slack[].userNames`              | string[] | legacy                     | Legacy allowed Slack usernames for non-workflow chat filtering. Usernames are not accepted as workflow approval identity.                                                                                                                             |
| `spec.slack[].replyOnlyWhenMentioned` | boolean  | no                         | If `true`, only process messages that include an app mention of this bot (`<@USER_ID>`). Non-approval messages are dropped until Slack `auth.test` returns a bot `user_id`. `/approve` and `/deny` commands are always accepted from allowed senders. |

> **Schema constraint (`anyOf`).** `channelId` alone is not a valid Slack group.
> Every `slack[]` entry must additionally supply **either** `userIds` **and**
> `workspaceId` (the modern form — required for workflow approvals), **or**
> `userNames` (the legacy chat-allowlist form). An entry with only `channelId` is
> rejected at admission.

At least one channel group (`telegram`, `email`, or `slack`) should be defined for the
CRD to be useful, though the schema does not enforce this.

### Telegram Upgrade Note

`spec.telegram[].chatType` is required for Telegram entries. Existing Telegram
CommunicationChannels created before this field must be updated to `private`,
`group`, or `supergroup`. The channel-reader skips entries with a missing or
unsupported `chatType` and logs a warning instead of guessing the chat boundary.

Workflow approval authorization now requires Telegram entries created by the
Profile UI verification flow with `confirmedByUserId`. Legacy Telegram entries
that only set `userIds` remain valid as channel-reader transport pre-filters,
but they do not verify users for workflow approvals. Users who previously relied
on `userIds` for Telegram approvals must re-verify the relevant conversation
after this change so the CommunicationChannel receives a `confirmedByUserId`
entry for that user.

## Additional Printer Columns

`kubectl get channels` displays: Host, Telegram Groups, Email Groups, Slack Groups.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: all-channels
spec:
  hostRef: chatllm
  telegram:
    - channelId: telegram1
      chatType: private
      userIds:
        - '111222333'
        - '444555666'
    - channelId: support-bot
      chatType: group
      userIds:
        - '123456789'
      replyOnlyWhenMentioned: true
    - channelId: supergroup-chat
      chatType: supergroup
      replyOnlyWhenMentioned: true
  email:
    - channelId: INBOX
      emails:
        - alice@example.com
        - bob@example.com
  slack:
    - channelId: C0123456789
      workspaceId: T0123456789
      userIds:
        - U0123456789
        - U0987654321
```

## Related

- [Host CRD](host.md) -- references this channel via `spec.channels[]`
- [CRD Index](README.md)
- [Example](../../charts/clerum-crds/examples/channels.yaml)
