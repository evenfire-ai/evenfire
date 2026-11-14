# Per-user GFS homes

This runbook applies after the complete per-user home release is deployed.
The schema alone does not provide the reconciler, operator routes, or UI.
Code references below are relative to the public repository at the S7 starting
commit `1f2d5352e`.

## What the feature does

Each active user in a GFS-enabled cluster is enrolled for one home on the
configured drive, at `/Users/<storage_username>`. Enrollment and backfill do
not require a login or a manual job. The home owner receives an inheritable
grant with `read`, `write`, `delete`, `share`, and `manage_acl`. The reserved
storage name does not change when the user changes their profile name. Homes
are local to each cluster; they are not replicated across clusters.

In Desktop, the user opens **My home** and manages access to the home or its
contents with user authority, including when the user has an operator link.
The user can share with users and teams in their team directory and grant
`read` and `write` to their own first-party agents. Control UI is for operators:
homes appear as ordinary folders under `/Users` in EvenDrive, where the existing
ACL management applies, and each member's Contact tab shows the home folder with
its recovery actions.

The owner manages entries throughout their own home tree for the people and
teams in their teams and for their own agents. Access lists in a home follow
the same rule as every other EvenDrive folder: grant and share lists return no
names or email addresses, Desktop names subjects from the viewer's team
directory and the viewer's own agents, and rows for people and teams outside the
viewer's teams are not listed. One notice says that such members exist
("Members outside your teams aren't listed here. Access can also follow from
parent folders you cannot see."). To remove an entry for a person or team
outside the owner's teams, an operator opens the folder in Control UI EvenDrive,
where every entry is listed with Remove. Grant rows keep their role-change and
remove actions. Share rows keep their remove action, and an Editor share can be
lowered to Read in Desktop; lowering never adds a permission the share did not
have, and a share is never raised. The home owner's own grant is shown as
**Owner**, without role or remove controls, to the owner and to viewers whose
teams include the owner; other viewers do not see it. Only an operator can
change it.

The `/Users` directory and bound home roots cannot be moved, renamed, or
deleted; the guard is in `control-api/src/db.ts:3251`. Contents inside a home
can still be managed according to their permissions.

## Drive requirements

`GFS_HOME_DRIVE` must be `main` for this rollout. The host-context-controller
(HCC) default drive must also remain `main`; its default is defined at
`host-context-controller/src/gfsConfig.ts:90`. Do not set
`CONTEXT_MAPPER_GFS_DRIVE_NAME`. Control UI's file browser uses `main`
(`control-ui/components/GfsBrowser.tsx:233`), so operator home management
depends on this alignment. Desktop carries the drive returned by the server.

The release places `GFS_HOME_DRIVE` in the public base Control API ConfigMap
and the Minikube override. A missing value disables the reconciler and leaves
unprovisioned homes pending; there is no `main` fallback. If the drive root is
not ready, the affected row stays pending with `drive_not_ready`. Do not change
`GFS_HOME_DRIVE` after rollout: a home keeps the drive it was created on,
changing the value does not create a second home or migrate the existing one,
and the reconciler only provisions pending rows with no drive or the configured
drive.

The governed-root guard and the `ancestor_home_exposure` check apply to the
root and a top-level `Users` folder on whichever drive a request targets; they
do not read `GFS_HOME_DRIVE`. The core serves one drive (`main`), so in
practice this is the home drive. A top-level `Users` folder that already exists
on that drive becomes immutable once the migration runs, because it is the
parent of the homes.

## Rollout and per-cluster verification

1. Before deploying to dev, require the release's J1–J8 and access-guard
   journeys to pass on the PR head. Merge the public-repository change through
   the normal release process. The dev and prod infrastructure workflows
   assemble their public base at `base_sha`; they pick up the base ConfigMap
   through that input. No infrastructure-repository change is part of this
   release.
2. Use the existing deployment order: the migration job runs with the new
   Control API image, the overlay is applied, GFS runtime provisioning runs,
   and the services restart. During the migration, old binaries can continue
   serving; enrollment can create pending rows, but the old Control API does
   not provision homes. The governed-root guard is active after migration.
3. When the new Control API starts, it creates `/Users` as needed under the
   drive structure lock, then enrolls and provisions homes. Do not add
   `/Users` to a GFS layout. Backfill and provisioning run automatically; a
   60-second tick is a scheduling interval, not a completion deadline. Each
   tick enrolls up to 200 existing users and provisions up to 50 pending homes
   (`control-api/src/services/gfsUserHomeReconciler.ts`), so 10,000 users take
   about 50 minutes to enroll and about 3.3 hours to provision.
4. In each cluster, read the home inventory API (below) and watch the overall
   `pending` count fall to zero. Review all `conflict` entries separately.
   Production follows dev through the existing promotion.

The inventory counts registry rows, so `pending = 0` alone does not prove that
backfill has discovered every active user. Compare the inventory with the
active-user list after backfill. Where approved read-only database access is
available, this aggregate check also identifies an incomplete enrollment pass:

```sql
SELECT count(*) AS active_users_without_home_rows
FROM users u
WHERE u.lifecycle_state = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM gfs_user_homes h WHERE h.user_id = u.id
  );
```

Repeat the inventory and completeness checks in each cluster. Zero pending
and zero missing rows do not clear conflicts or prove a user's file access;
review conflicts and validate the relevant access separately.

## Inventory and user detail

Control UI has no separate home inventory page. Operators browse homes in
EvenDrive under `/Users/<name>`, including a retained home whose user was
hard-deleted. To list homes by state (for example every `conflict`, or the
`retired` homes of deleted users), use the inventory API below. Its counts
cover the whole registry, not just the returned page. A retained home's
detail API still returns the row; `404 home_not_found` means there is no home
row.

The **Home folder** field is the last field of the Contact tab on
`/users-and-teams/users/<id>`. It shows one line: the home path when it
exists, **Being created…** or **Still pending** while pending, **Not created**
for a home that does not exist yet, or **No home folder yet** when the member
has no home row. A conflict adds its cause, the details needed to fix it, and
the recovery action: **Retry**, **Retry with another name…** (a dialog, only
for a home that was never bound), or **Restore owner access**. After an
action, the field polls for up to 60 seconds. If the home is still pending, it
shows **Still pending** and **Refresh**; this is neither a success nor a
failure.

For an operator using the API, the inventory route is
`GET /api/v1/gfs/user-homes?state=&cursor=&limit=`. It returns `items`,
`nextCursor`, and total `counts` for the four states.
The page limit is 1–100, with a default of 50. Invalid state, limit, or cursor
returns HTTP 400 with `invalid_state`, `invalid_limit`, or `invalid_cursor`.
`GET /api/v1/gfs/user-homes/:userId` returns `{ home }` or 404
`home_not_found`. Errors use `{ error: <code> }`.

## Conflicts and recovery

Use the user detail block as an operator. Never delete a foreign item or adopt
it as the home to make a conflict disappear; renaming or moving it out of the
reserved path in the Control UI GFS browser is allowed.

| Conflict                              | Cause                                                                                                                                                      | Operator action                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path_conflict`, home not yet created | Another item occupies `/Users/<name>`.                                                                                                                     | Rename or move that item in the GFS browser and select **Retry**, or enter a different valid folder name and select **Retry**. The item and its contents are never changed by the reconciler.                      |
| `path_conflict`, home already bound   | The bound home is no longer at `/Users/<name>`. This happens only through a manual database change.                                                        | A bound home root cannot be moved or renamed, even by an operator. An administrator with cluster access corrects the path in the database; move any item occupying the reserved path first, then select **Retry**. |
| `ancestor_grant_conflict`             | A user, team, agent, or context grant or share on the drive root or `/Users` is inheritable (created before this release, or by a direct database change). | Remove the entry or make it non-inheritable with operator authority, then select **Retry**.                                                                                                                        |
| `ownership_conflict`                  | A bound home's owner grant is missing, narrowed, or no longer inheritable.                                                                                 | Select **Restore owner access**, or re-grant the owner all five permissions with inheritance in the grant panel. Retry cannot restore this grant.                                                                  |

A `ready` home is not re-checked against its path. Whoever changes a bound
home's resource or path by hand in the database must also set its
`gfs_user_homes` row to `pending`, or select **Retry** afterwards, so the next
provisioning pass records `path_conflict` and the member's Home folder field
shows it.

Retry accepts an optional storage name. For a home that was never bound
(`path_conflict` or `ancestor_grant_conflict`), a new valid name is reserved;
an invalid name returns 422 `invalid_name` without changing the row. For a
bound home, the name cannot change: a different name returns 409
`home_not_retryable` without changing the row, while no name or the same name
is accepted. An accepted request returns HTTP 202 with a pending home; the next
reconciler tick attempts provisioning. Another non-retryable state returns 409
`home_not_retryable`; an ownership conflict returns 409
`home_owner_grant_requires_operator_restore`. A missing home returns 404.

Restore owner access is available only for `ownership_conflict`. It restores
all five owner permissions with inheritance and returns HTTP 200 with the
ready home. Another state returns 409 `home_not_in_ownership_conflict`; a
missing home returns 404. An operator grant update that gives the owner all
five permissions with inheritance has the same effect and moves the home to
`ready`; an update that leaves the grant narrowed keeps `ownership_conflict`.
A reconciler tick never restores the grant on its own. A non-operator
attempting to revoke or narrow the owner grant receives 403
`home_owner_grant_protected`.

## Ancestor access and delegated permissions

Only operator-subject grants and shares may be created on the drive root or
`/Users`, whether or not they include descendants. Attempts to grant or share
access there to a user, team, agent, or context return 409
`ancestor_home_exposure`, and Control UI explains it in the grant panel.
Operators retain intrinsic access everywhere and can grant or share access on
sub-folders, including individual homes. Existing inheritable non-operator
entries on the root or `/Users` block provisioning as
`ancestor_grant_conflict` until an operator removes them.

Permissions do not cascade when their grantor loses access. If A gives B
`manage_acl`, B grants C access, and A revokes B, C's entry remains until an
authorized owner or operator removes it. Grantor-bound revocation is outside
this release; [issue #761](https://github.com/evenfire-ai/evenfire/issues/761)
remains open. To review existing delegated access, inspect grants and shares
on the home and its descendants with owner or operator authority. This review
is read-only until an authorized person selects an entry to change or remove;
the release does not add a provenance table or infer a revocation cascade.

Moving an item into a home makes it inherit the home owner's grant, including
`manage_acl` and `share`, and drops access it inherited from its old location.
Moving requires `write` and `delete` on the source folder and `write` on the
destination. A Desktop Editor share already carries `manage_acl` and `share`;
the move adds them only for a narrower grant an operator created.

## Retirement and deletion

On retirement or hard deletion, the home and its data remain. Cleanup removes
all user, team, host, and context grants and shares on the home and its
descendants, including entries an operator created. Operator-subject entries
remain. The retired user's own grants and shares elsewhere are also removed,
including any on the drive root or `/Users`; other subjects' entries there are
not touched.
The operator may later grant selected access to the retained home through
EvenDrive in Control UI.

Cleanup also removes grants anywhere for the user's captured first-party
agents when no other active user and no team is associated with that agent.
This includes operator-created grants for those captured agents. An agent
still associated with another active user or a team is not removed by this
agent-specific rule; there is no global orphan sweep.

The result is that only operators can reach the retained home until an
operator grants access again; no inheritable entry on the drive root or
`/Users` can reach it (see the previous section). A retired user's session is
rejected with 401 by Control API session authentication on the next request,
and Desktop returns to its sign-in page; open views are not forcibly closed.

## Rollback and startup repair

Keep the new table and triggers when rolling back to an older Control API
image. During that rollback window the older image does not provision homes,
does not perform the new retirement cleanup, and does not protect the owner
grant. Do not reset the data or automatically re-grant owner access.

An older Control API also ignores the `X-Evenfire-Gfs-Authority` header that
Desktop sends, so during the rollback window the linked initial admin using the
new Desktop has operator authority in Files again. An older Control API has no
`/me/gfs/home`: the new Desktop shows My home as unavailable, while Shared with
me and its row actions keep working with the drive each row reports.

After roll-forward, the planned startup repair runs once per Control API
process start, before its first regular tick, in batches of 50. For ready or
conflict rows, it cleans home entries for users retired or deleted during the
window. It marks a ready home with a missing or narrowed owner grant as
`ownership_conflict`. An operator restores it as described under conflicts;
the repair does not re-grant it. It is not run on every tick.

Startup repair is conditional on its T1 cost gate: a pass over 10,000 ready
homes with nothing to repair must finish in under five seconds using index
scans. If that gate fails, the plan removes the repair and accepts a documented
rollback gap instead. Check the release's T1 evidence before relying on the
repair.

A hard delete during rollback can also remove the user's agent associations
before repair runs: the `user_agents` foreign key cascades on deletion
(`control-api/src/db.ts:321`). The repair may therefore lack the information
needed to identify that user's agent grants outside the home. The repair still
removes the home entries and the user's own grants and shares; review that
user's agent grants outside the home separately using available records, and
do not assume startup repair removed them. Releases before this one leave the
same rows when a user is deleted.
