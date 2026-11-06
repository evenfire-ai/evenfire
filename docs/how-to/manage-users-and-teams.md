# How to: manage users, teams, roles, and agent access

evenfire has two separate kinds of people:

- **Members** are Desktop App users. They belong to **teams**, and each team
  membership has a **team role**. Members and teams decide who can use which
  agents from the [Desktop App](use-the-desktop-app.md).
- **Control admins** are operators who sign in to the
  [Control UI](../surfaces/control-ui.md). They live in a separate account pool
  and are not team members unless you also give them Desktop App access.

Both are managed in **Control UI → Users & Teams**.

## Where it lives

| Screen        | Path                                | What you do there                                                                      |
| ------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Members tab   | `/users-and-teams/users`            | List members and pending member invitations; create, open, or delete a member          |
| Teams tab     | `/users-and-teams/teams`            | List teams; create, open, or delete a team                                             |
| Admins tab    | `/users-and-teams/admins`           | List control admins and pending admin invitations; invite or delete an admin           |
| Invite admin  | `/users-and-teams/admins/new`       | The admin invitation wizard                                                            |
| Member detail | `/users-and-teams/users/<id>/<tab>` | Tabs: **Contact**, **Approval DMs**, **Communication Channels**, **Teams**, **Agents** |
| Team detail   | `/users-and-teams/teams/<id>/<tab>` | Tabs: **Members**, **Agents**                                                          |

`/users-and-teams` opens the Members tab. Older `/profile-admin/*` links
redirect here, and the old `contexts` and `access` tab URLs on member and team
pages redirect to the **Agents** tab.

## Team roles

Every team membership has one of three roles. The API and database store the
value; the Control UI shows a label.

| Stored value | Control UI label | Invite members | Change roles, remove members |
| ------------ | ---------------- | -------------- | ---------------------------- |
| `admin`      | Leader           | Yes            | Yes                          |
| `inviter`    | Inviter          | Yes            | No                           |
| `member`     | Participant      | No             | No                           |

The team detail Members table shows the same thing as two read-only columns,
**Can Invite Members** and **Can Delete Members**. The role editor sets the
role through those two checkboxes: delete implies invite.

These roles govern what a member can do **for their own teams** from the
[profile UI](../surfaces/profile-ui.md). There:

- An `admin` or `inviter` can send, resend, and revoke member invitations for
  teams where they hold that role.
- Only an `admin` can change another member's role or remove them from the
  team. The `/external/members/*` routes reject changes to your own
  membership.
- An `admin` can delete another member's account only if they are `admin` on
  **every** team that member belongs to.

Control admins are not limited by team roles. Every change you make in the
Control UI goes through the control-admin API, whatever team role the target
holds.

### The global `users.role` column

The `users` table also has a global `role` column (`admin`, `operator`,
`reviewer`, `finance`, or `user`; default `user`). No Control UI screen or API
route sets it. It is **not** the team role and **not** control-admin status.
The only code that reads it is a database migration that gives users with
`role = 'admin'` the `mcp-host/standalone` workflow trigger grant.

## Members and teams

**Create a member** (Members tab → **Create member**) creates a pending
invitation and sends the invitation email. You can add the person to teams
with a role per team. The member's Desktop App access starts when they accept
the invitation and set a password.

**Create a team** (Teams tab → **Create team**), then add people on the team's
**Members** tab:

- **Existing member** adds a current member straight away with the role you
  pick.
- **Invite by email** sends a member invitation for this team.

Pending member invitations appear on the Members tab, where you can resend or
cancel them. Member invitations expire after **7 days**.

### Invitations need a registration service

Invitation emails are not sent by control-api itself. control-api hands them
to a member registration service, and that service is **not in this
repository**. By default (`CONTROL_API_MEMBER_REGISTRATION_MODE` unset, which
means `remote`), the base ConfigMap points at
`member-registration-service.registration.svc.cluster.local`, which a
self-hosted install does not have. Until you set up one of these, sending an
invitation fails with an error:

- Set `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` to send through evenfire's
  shared registration hub.
- Run your own member registration service in `remote` mode.

See [Member invitations on a self-hosted deployment](member-invitations-self-hosted.md)
for both paths.

## Control admins

Control admins are stored in their own table (`control_admin_users`), separate
from members. Each one has the single role `admin` and a status of `active` or
`disabled`.

### Invite a control admin

Admins tab → **Invite admin** opens `/users-and-teams/admins/new`:

1. Enter the email. The email link opens the Control UI, where the invitee
   chooses a username and password.
2. Optionally tick **Create access to Desktop App** (`createDesktopAccess`).
   Pick teams and a role for each. evenfire then also creates a member
   invitation for those teams, and one email covers both.
3. Send. Admin invitations expire after **7 days**.

You can also start from a member: a member's row menu has **Create
administrator access**, which opens the same wizard for that email. It skips
the Desktop App step because the person is already a member.

Admin invitations go through the same registration service as member
invitations.

### Hand over an admin seat with `replaceInviter` (API only)

`POST /api/v1/admin/control-admin-invitations` accepts an optional boolean
`replaceInviter`. No Control UI screen sets it.

When `replaceInviter` is `true` and the invitee accepts, the inviting admin's
seat is handed over in the same transaction:

- If the inviter also has a member account, their team roles are copied to
  the invitee's member account or pending Desktop App invitation. The higher
  role wins, so the invitee is never downgraded. The inviter's member account
  is then retired.
- The inviter's control-admin account is retired, the same way **Delete admin**
  does it.
- The inviter's other pending admin invitations, and their paired Desktop App
  invitations, are revoked.

Acceptance is refused with `replace_inviter_receiver_missing` if the inviter's
member account holds team roles and nobody can receive them. For example, the invitee has no
member account and no pending Desktop App invitation. If the inviter is no
longer active when the invitee accepts, the hand-over is skipped and the
invitee simply becomes a new admin.

## Agent access

An agent (Host) is usable from the Desktop App only by people who have been
given access. Grant it from either side:

- **Agent detail → Access tab** (`/agents/<name>/access`). It has two
  sub-tabs: **Members** and **Teams**. Use **Add member** or **Add team** to
  grant access, and the row menu's **Revoke access** to remove it.
- **Member or team detail → Agents tab.** This is the same grant, seen from
  the person or the team.

A member can use an agent if it is granted to them directly, or to the team
they are currently working in. control-api checks the grant when it resolves
the agent for that member. For a team grant it also checks that the member is
still in that team.

The grant APIs are `PUT /api/v1/admin/users/<id>/agents` and
`PUT /api/v1/admin/teams/<id>/agents`. They replace the full list and need
`expectedCurrentAgentNames` (the list you read). Without it the call fails with
`428`. If the list changed since you read it, the call is rejected instead of
overwriting another admin's change.

## Removing people and teams

There is no "deactivate" for members. The options are:

- **Remove from a team** (team detail → member row → **Remove member**). This
  ends that one membership. The account stays.
- **Delete member** (Members tab or member detail). Team memberships are
  removed first. If the member was the only person on some teams, you can tick
  **Delete empty teams too**. The account is hard-deleted, or kept as a
  retired record if it was ever linked to a control admin. Its approval DM
  accounts are disabled either way.
- **Delete a team** (Teams tab → **Delete**). The API only deletes a team with
  no active members, and returns `team_not_empty` otherwise. Remove or delete
  its members first. A team referenced by workflow audit history is kept, and
  the API returns `team_has_audit_history`. Deleting the team also removes its
  pending invitations and its agent and Context grants.
- **Delete admin** (Admins tab). This removes the admin's Control UI access
  immediately: their sessions end and their EvenDrive operator link is
  revoked. It also revokes their pending or opened Control Admin invitations
  and any pending paired Desktop invitations. The record is kept as `disabled`
  for audit and is hidden from the list. You cannot delete your own admin
  account. Deleting an admin does not delete a member account they also hold.

## Related

- [Member invitations on a self-hosted deployment](member-invitations-self-hosted.md)
- [Use the Desktop App](use-the-desktop-app.md)
- [Control UI](../surfaces/control-ui.md)
- [Profile UI](../surfaces/profile-ui.md)
- [Configure approvals](configure-approvals.md)
