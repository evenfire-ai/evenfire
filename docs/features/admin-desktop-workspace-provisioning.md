# Auto-provision the admin's desktop workspace at first-run setup

**Date:** 2026-06-09
**Status:** Design — awaiting review
**Repo:** clerum
**Base branch:** `origin/feat/multiple-admins` (the only branch where first-run Control-UI setup collects the admin _email_; not yet in `dev`)
**Related:** commit `0c4a95c8d` (feat: add Control UI admin setup and invitations), PR #412 (teamless invitations), PR #300 (desktop initial team-directory load)

---

## Problem

A freshly onboarded tenant admin can log into the **Control UI** with their
credentials but the **desktop app is dead** — even though login "succeeds".

There are two **separate** identity systems:

|            | Control UI admin                                  | Desktop user                                  |
| ---------- | ------------------------------------------------- | --------------------------------------------- |
| Table      | `control_admin_users` (username/email + password) | `users` + `team_members` (email + password)   |
| Created by | First-run setup (`POST /admin/auth/setup`)        | "Invite desktop member" flow, or Google login |

First-run setup only creates a `control_admin_users` row. It never creates a
desktop `users` identity. For an email to actually use the desktop app, the
tenant's `control-api` needs **all five** of:

1. a `users` row (the desktop identity)
2. a desktop password (`users.password_hash`) — in prod only settable via the
   invitation / password-setup flow; direct DB seeding is deliberately
   prod-blocked (`scripts/e2e/seed-e2e-data.sh`)
3. a **team** with the user as `owner` — without it, `POST /external/rpc/token`
   returns `403 team_membership_required` (`control-api/src/routes/external/auth.ts:135`),
   so the desktop app cannot obtain an RPC token and is unusable
4. ≥1 **agent grant** (e.g. `chatllm`) at user- or team-level, else the desktop
   shows "No agents available" (`docs/agents-display-issue-analysis.md`)
5. ≥1 **context grant** (e.g. `context1`) at user- or team-level

### Why it breaks today

- **Google login self-heals** — `googleLoginData()` auto-creates a personal team
  (`"<name> team"`, role `owner`) when the user has no membership
  (`control-api/src/services/directory/login.ts`).
- **Password login does NOT** — `passwordLoginData()` returns
  `membership: { team_id: null, ... }` when there is no membership; the Control
  UI tolerates a null team, the desktop app cannot.
- Invitations can be **teamless** (PR #412), and brand-new teams have **zero**
  `team_contexts` / `team_agents` — `createTeamForUser` only inserts the team +
  owner row.

Net: the onboarded admin is a Control-UI operator with no desktop identity,
team, or grants.

---

## Goals

- After the admin completes first-run Control-UI setup, the **same
  email + password** logs into the **desktop app** and lands in a ready
  workspace (team + working agent + context) with **zero extra steps**.
- Fully **idempotent** — safe to re-run; reuses an existing desktop user/team if
  one already exists for the email.
- Onboarding is **never blocked** by desktop-provisioning failure: the Control
  UI must stay usable.

## Non-goals

- No change to **MCC**. Its `tenant.adminEmail` stays informational.
- Admins added later via the **admin-invitation** flow are out of scope (their
  desktop provisioning is a separate operator-vs-user policy decision — see
  Future work).
- No changes to the desktop app or Control UI front-ends (server-side only).
  An optional Control-UI success hint is listed under Future work.

---

## Approach (chosen: "first-run setup provisions the workspace" + login backstop)

### Decisions locked during brainstorming

1. **One credential** — copy the bcrypt hash produced at setup into
   `users.password_hash`, so the same email+password works in both apps
   immediately. (`bcryptjs` is used by both `adminAuthService` and `login.ts`,
   so the hash is directly compatible.)
2. **Login self-heal backstop included** — also make `passwordLoginData`
   create a default team + grants on first login if the user has none. Closes
   the gap if setup-time provisioning was skipped/failed and repairs any
   pre-existing team-less users.
3. **Config-driven defaults** for the granted agent/context names.

---

## Detailed design

### 1. Hook point — `POST /admin/auth/setup`

File: `control-api/src/routes/admin/auth.ts` (on `feat/multiple-admins`).

The handler already validates `email`, `username`, `password`, computes
`passwordHash = await bcrypt.hash(password, 12)`, and calls
`setupInitialAdminCredentials(config.adminBootstrapUsername, email, username, passwordHash)`.

After that call succeeds (the control-admin row is committed), add:

```ts
// best-effort: never block onboarding on desktop provisioning
try {
  await provisionAdminDesktopWorkspace({
    email,
    displayName: username,
    passwordHash, // SAME hash → one credential for both apps
    agentNames: config.adminDefaultAgentNames,
    contextIds: config.adminDefaultContextIds,
  })
} catch (err) {
  logger.error(
    { err, email },
    'admin desktop workspace provisioning failed; control admin still created'
  )
}
```

The control-admin row is already committed before this runs, so a failure here
leaves the Control UI fully usable; the login backstop (§3) will repair the
desktop side on first desktop login.

### 2. New service — `provisionAdminDesktopWorkspace`

New file: `control-api/src/services/directory/adminProvisioning.ts`.
One `withTransaction`, fully idempotent, reusing existing SQL patterns.

```ts
export async function provisionAdminDesktopWorkspace(input: {
  email: string
  displayName: string
  passwordHash: string
  agentNames: string[]
  contextIds: string[]
}): Promise<void> {
  const email = input.email.trim().toLowerCase()
  return withTransaction(async db => {
    // (a) ensure users row (reuse if it already exists for this email)
    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email])
    let userId = existing.rows[0]?.id as string | undefined
    if (!userId) {
      const ins = await db.query(`INSERT INTO users(email, name) VALUES($1, $2) RETURNING id`, [
        email,
        input.displayName || null,
      ])
      userId = ins.rows[0].id as string
    }

    // ensure a profile row exists (mirrors createAdminUser)
    await db.query(
      `INSERT INTO profiles(user_id, display_name) VALUES($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, input.displayName || null]
    )

    // (b) set desktop password from the setup hash (one credential)
    await db.query(
      `UPDATE users SET password_hash = $2, password_set_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [userId, input.passwordHash]
    )

    // (c) + (d) + (e): default team + grants (shared helper, see §4)
    await ensureDefaultTeamAndGrants(
      db,
      userId,
      input.displayName,
      input.agentNames,
      input.contextIds
    )
  })
}
```

Idempotency: re-running finds the existing user (no duplicate; `users.email` is
`UNIQUE`), re-sets the same password hash (harmless), and `ensureDefaultTeamAndGrants`
skips team creation when the user already owns a team and PUT-replaces grants
with the same values.

### 3. Login self-heal backstop — `passwordLoginData`

File: `control-api/src/services/directory/login.ts`.

In `passwordLoginData`, replace the "no membership → return `team_id: null`"
branch with the same self-heal `googleLoginData` already performs: create a
personal team (owner) + default grants, then return that membership.

```ts
const membership = await findFirstActiveMembership(db, user.id)
if ((membership.rowCount ?? 0) === 0) {
  const teamId = await ensureDefaultTeamAndGrants(
    db,
    user.id,
    user.name || user.email,
    config.adminDefaultAgentNames,
    config.adminDefaultContextIds
  )
  // re-read membership for the freshly created team and return it
}
```

This runs inside the existing `withTransaction` in `passwordLoginData`. It only
fires for an already-authenticated user with no team, so it cannot create
workspaces for arbitrary emails.

### 4. Shared helper — `ensureDefaultTeamAndGrants`

Also in `adminProvisioning.ts`, exported and used by both §2 and §3 so defaults
stay consistent.

```ts
export async function ensureDefaultTeamAndGrants(
  db: Tx,
  userId: string,
  displayName: string,
  agentNames: string[],
  contextIds: string[]
): Promise<string> {
  // find an existing active team this user owns
  const owned = await db.query(
    `SELECT t.id FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1 AND tm.status = 'active' AND tm.role = 'owner'
      ORDER BY t.created_at ASC LIMIT 1`,
    [userId]
  )
  let teamId = owned.rows[0]?.id as string | undefined
  if (!teamId) {
    const t = await db.query(`INSERT INTO teams(name) VALUES($1) RETURNING id`, [
      `${displayName} team`,
    ])
    teamId = t.rows[0].id as string
    await db.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $2, 'owner', 'active')
       ON CONFLICT (team_id, user_id) DO UPDATE SET role='owner', status='active', updated_at=NOW()`,
      [teamId, userId]
    )
  }
  // grant defaults at BOTH team and user level (full-set replace = idempotent)
  for (const a of agentNames) {
    await db.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [teamId, a]
    )
    await db.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [userId, a]
    )
  }
  for (const c of contextIds) {
    await db.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [teamId, c]
    )
    await db.query(
      `INSERT INTO user_contexts(user_id, context_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [userId, c]
    )
  }
  return teamId
}
```

> Implementation note: the existing `setTeamAgents` / `setUserAgents` /
> `setTeamContexts` / `setUserContexts` (in `agentAccess.ts` / `contextAccess.ts`)
> use the pool, not a passed-in `db`/transaction. To keep everything in one
> transaction we inline the inserts here. If those helpers are refactored to
> accept an optional `db`, prefer reusing them.

### 5. Config additions

File: `control-api/src/config.ts`.

```ts
adminDefaultAgentNames:  parseCsvList(process.env.CONTROL_API_ADMIN_DEFAULT_AGENT_NAMES  || 'chatllm'),
adminDefaultContextIds:  parseCsvList(process.env.CONTROL_API_ADMIN_DEFAULT_CONTEXT_IDS  || 'context1'),
```

Defaults `chatllm` / `context1` are the canonical deployed names
(`scripts/bootstrap-cluster.sh`, `scripts/e2e/e2e-prod-lib.sh`,
`docs/crds/context.md`). Per-tenant deploys override via the ConfigMap
(`deploy/.../configmaps/control-api-config.yaml`) if their deployed agent/context
names differ.

---

## Data model touched

No schema migration. Writes to existing tables only: `users`
(incl. `password_hash`, `password_set_at`), `profiles`, `teams`,
`team_members`, `team_agents`, `user_agents`, `team_contexts`, `user_contexts`.

---

## Edge cases

- **Email already a desktop user** (previously invited): reuse the row; set
  password from the setup hash (admin re-claims it); ensure team/grants. No
  duplicate (`users.email UNIQUE`).
- **User already owns a team**: reuse it; only top up missing grants.
- **Re-run of setup**: `setupInitialAdminCredentials` is a no-op after the first
  admin exists (returns `null`), so provisioning won't re-run from setup; the
  login backstop remains idempotent.
- **Password drift**: if the admin later changes the Control-UI password via
  Settings, the desktop `users.password_hash` is **not** updated. Documented
  limitation; see Future work for optional sync.
- **Empty config lists**: if an operator sets the default agent/context env to
  empty, a team is still created but with no grants (desktop will show empty
  catalog) — `log.warn` when the resolved default lists are empty.

---

## Testing

**Unit / integration (control-api, vitest + testcontainers Postgres):**

- `provisionAdminDesktopWorkspace` creates user + password + owner team + grants;
  re-run is idempotent (no dup user/team, grants stable).
- Reuse path: pre-existing user / pre-existing owned team.
- `passwordLoginData` backstop: team-less user → first login creates team +
  grants and returns non-null `team_id`; second login is stable.
- Setup route: after `POST /admin/auth/setup`, the email can `password-login`
  (desktop path) AND `POST /external/rpc/token` returns a token (no
  `team_membership_required`).
- Failure isolation: stub provisioning to throw → setup still returns `200`
  with an admin token.

**E2E (desktop-app Playwright):** onboard via setup → desktop password-login →
team directory + agents (`chatllm`) + context (`context1`) load; can open the
RPC-backed surface.

---

## Rollout

- Server-side only; no migration; no front-end change. Ships with the
  `feat/multiple-admins` line.
- Existing tenants: the login backstop repairs any current team-less password
  users on their next desktop login. New tenants get it at first-run setup.
- Config defaults are safe for current prod (agent `chatllm`, context
  `context1`); override per tenant only if their deployed names differ.

---

## Future work (out of scope)

- **Admin-invitation desktop provisioning**: optionally give invited
  control-admins the same desktop workspace (needs an operator-vs-user policy).
- **Password sync on change**: keep `users.password_hash` in sync when the admin
  changes the Control-UI password in Settings (removes the drift caveat).
- **Refactor grant helpers** to accept an optional `db` so
  `setTeamAgents`/`setUserAgents`/`setTeamContexts`/`setUserContexts` can be
  reused inside a transaction instead of inlining inserts.
- **Control-UI hint**: show "Desktop access ready for `<email>`" on setup
  completion.
