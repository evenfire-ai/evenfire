import { type Page, expect } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  UUID_RE,
  firstDataLine,
  kubectlOut,
  runControlPostgresSql,
  sqlLiteral,
} from '../../../tests/e2e/gfsFixtureCore'
import { ControlUiUserHomeBlock } from './pages/ControlUiUserHomeBlock'

export type HomeFixtureUser = { id: string; email: string; name: string; password: string }
export type HomeFixtureSnapshot = {
  state: string
  conflictCode: string | null
  storageUsername: string | null
  resourceId: string | null
  path: string | null
  drive: string | null
}

export function newHomeFixtureUser(): HomeFixtureUser {
  const name = `e2e-gfs-home-${randomBytes(8).toString('hex')}`
  return {
    id: randomUUID(),
    name,
    email: `${name}@example.invalid`,
    password: randomBytes(24).toString('base64url'),
  }
}

function assertFixtureUser(user: HomeFixtureUser): void {
  if (
    !UUID_RE.test(user.id) ||
    !/^e2e-gfs-home-[a-f0-9]{16}$/.test(user.name) ||
    user.email !== `${user.name}@example.invalid`
  ) {
    throw new Error('Refusing to alter an identity outside this E2E fixture')
  }
}

export function createHomeFixtureUser(user: HomeFixtureUser): void {
  assertFixtureUser(user)
  if (!process.env.E2E_K8S_CONTEXT) throw new Error('E2E_K8S_CONTEXT is required')
  const hash = kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      '-i',
      'deploy/control-api',
      '--',
      'node',
      '-e',
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>process.stdout.write(await require('bcryptjs').hash(s,12)))",
    ],
    20_000,
    user.password
  ).trim()
  if (!/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(hash))
    throw new Error('Could not create the fixture password hash')
  const pod = kubectlOut([
    '-n',
    'control-plane',
    'get',
    'pod',
    '-l',
    'app=control-postgres',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]).trim()
  if (!pod) throw new Error('Control PostgreSQL pod is unavailable')
  const sql = `BEGIN;
    INSERT INTO users(id,email,name,password_hash,password_set_at)
      VALUES (${sqlLiteral(user.id)}::uuid,${sqlLiteral(user.email)},${sqlLiteral(user.name)},${sqlLiteral(hash)},now());
    INSERT INTO profiles(user_id,display_name) VALUES (${sqlLiteral(user.id)}::uuid,${sqlLiteral(user.name)});
    COMMIT;`
  try {
    kubectlOut(
      [
        '-n',
        'control-plane',
        'exec',
        '-i',
        pod,
        '--',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'profiles',
        '-f',
        '-',
      ],
      20_000,
      sql
    )
  } catch {
    throw new Error(`Could not create E2E identity ${user.id}`)
  }
}

export function createForeignHomeDirectory(user: HomeFixtureUser): string {
  assertFixtureUser(user)
  const id = firstDataLine(
    runControlPostgresSql(`
    INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
    SELECT 'main', users.resource_id, ${sqlLiteral(user.name)}, 'directory', ${sqlLiteral(`/Users/${user.name}`)}
      FROM gfs_resources users JOIN gfs_resources root ON root.resource_id=users.parent_resource_id
     WHERE users.drive='main' AND users.name='Users' AND users.kind='directory'
       AND users.deleted_at IS NULL AND root.drive='main' AND root.parent_resource_id IS NULL AND root.deleted_at IS NULL
    RETURNING resource_id::text;
  `)
  )
  if (!UUID_RE.test(id)) throw new Error('Could not create the foreign home-path fixture')
  return id
}

export function removeForeignHomeDirectory(user: HomeFixtureUser, resourceId: string): void {
  assertFixtureUser(user)
  if (!UUID_RE.test(resourceId)) throw new Error('Invalid foreign directory ID')
  const deleted = firstDataLine(
    runControlPostgresSql(`
    DELETE FROM gfs_resources
     WHERE resource_id=${sqlLiteral(resourceId)}::uuid AND drive='main'
       AND name=${sqlLiteral(user.name)} AND path_cache=${sqlLiteral(`/Users/${user.name}`)}
       AND NOT EXISTS (SELECT 1 FROM gfs_user_homes WHERE resource_id=${sqlLiteral(resourceId)}::uuid)
    RETURNING resource_id::text;
  `)
  )
  if (deleted !== resourceId)
    throw new Error('Foreign directory was not removed; inspect its ownership')
}

export function associateFixtureAgent(user: HomeFixtureUser, agentName: string): void {
  assertFixtureUser(user)
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(agentName)) throw new Error('Invalid agent name')
  const id = firstDataLine(
    runControlPostgresSql(`
    INSERT INTO user_agents(user_id,agent_name)
    SELECT id,${sqlLiteral(agentName)} FROM users
     WHERE id=${sqlLiteral(user.id)}::uuid AND email=${sqlLiteral(user.email)}
    RETURNING user_id::text;
  `)
  )
  if (id !== user.id) throw new Error('Could not associate the fixture agent')
}

export function getExistingAgentAssociation(agentName: string): {
  kind: 'user' | 'team'
  id: string
} {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(agentName)) throw new Error('Invalid agent name')
  const row = firstDataLine(
    runControlPostgresSql(`
    SELECT kind || '|' || id FROM (
      SELECT 'user' AS kind, u.id::text AS id FROM user_agents a JOIN users u ON u.id=a.user_id
       WHERE a.agent_name=${sqlLiteral(agentName)} AND u.lifecycle_state='active'
      UNION ALL
      SELECT 'team' AS kind, team_id::text AS id FROM team_agents WHERE agent_name=${sqlLiteral(agentName)}
    ) associations ORDER BY kind, id LIMIT 1;
  `)
  )
  const [kind, id] = row.split('|')
  if ((kind !== 'user' && kind !== 'team') || !UUID_RE.test(id ?? '')) {
    throw new Error(
      'Select an agent with a pre-existing active user or team association so fixture retirement cannot remove unrelated grants'
    )
  }
  return { kind, id }
}

export function assertAgentAssociation(
  agentName: string,
  association: { kind: 'user' | 'team'; id: string }
): void {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(agentName) || !UUID_RE.test(association.id)) {
    throw new Error('Invalid agent association witness')
  }
  const condition =
    association.kind === 'user'
      ? `SELECT 1 FROM user_agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=${sqlLiteral(association.id)}::uuid AND a.agent_name=${sqlLiteral(agentName)} AND u.lifecycle_state='active'`
      : `SELECT 1 FROM team_agents WHERE team_id=${sqlLiteral(association.id)}::uuid AND agent_name=${sqlLiteral(agentName)}`
  if (firstDataLine(runControlPostgresSql(`SELECT EXISTS (${condition})::text;`)) !== 'true') {
    throw new Error('The pre-existing agent association changed; refusing fixture retirement')
  }
}

export function readHome(userId: string): HomeFixtureSnapshot | null {
  if (!UUID_RE.test(userId)) throw new Error('Invalid fixture user ID')
  const row = firstDataLine(
    runControlPostgresSql(`
    SELECT json_build_object('state',h.state,'conflictCode',h.conflict_code,
      'storageUsername',h.storage_username,'resourceId',h.resource_id,
      'path',r.path_cache,'drive',h.drive)::text
      FROM gfs_user_homes h LEFT JOIN gfs_resources r ON r.resource_id=h.resource_id
     WHERE h.user_id=${sqlLiteral(userId)}::uuid;
  `)
  )
  return row ? (JSON.parse(row) as HomeFixtureSnapshot) : null
}

export function readHomeGrant(
  resourceId: string,
  subjectType: 'user' | 'host',
  subjectId: string
): { permissions: string[]; inherit: boolean } | null {
  if (!UUID_RE.test(resourceId)) throw new Error('Invalid fixture resource ID')
  const row = firstDataLine(
    runControlPostgresSql(`
    SELECT json_build_object('permissions',permissions,'inherit',inherit)::text
      FROM gfs_grants WHERE resource_id=${sqlLiteral(resourceId)}::uuid
       AND subject_type=${sqlLiteral(subjectType)} AND subject_id=${sqlLiteral(subjectId)};
  `)
  )
  return row ? (JSON.parse(row) as { permissions: string[]; inherit: boolean }) : null
}

/** Grants plus shares a user holds directly on `/Users` of drive main (D45). */
export function userAccessOnUsersFolder(userId: string): number {
  if (!UUID_RE.test(userId)) throw new Error('Invalid fixture user ID')
  const row = firstDataLine(
    runControlPostgresSql(`
    WITH target AS (
      SELECT resource_id FROM gfs_resources
       WHERE drive='main' AND path_cache='/Users' AND deleted_at IS NULL
    )
    SELECT (SELECT count(*) FROM target)::text || '|' ||
           ((SELECT count(*) FROM gfs_grants WHERE resource_id IN (SELECT resource_id FROM target)
              AND subject_type='user' AND subject_id=${sqlLiteral(userId)}) +
            (SELECT count(*) FROM gfs_shares WHERE resource_id IN (SELECT resource_id FROM target)
              AND subject_type='user' AND subject_id=${sqlLiteral(userId)}))::text;
  `)
  )
  const [folders, access] = row.split('|')
  if (folders !== '1' || !/^\d+$/.test(access ?? '')) {
    throw new Error(`Expected one live /Users folder, read ${row}`)
  }
  return Number(access)
}

export function resourceIdAtPath(path: string): string {
  if (!/^\/Users\/e2e-gfs-home-[a-f0-9]{16}\/e2e-gfs-[a-z0-9-]+\.txt$/.test(path))
    throw new Error('Unsafe fixture file path')
  const id = firstDataLine(
    runControlPostgresSql(
      `SELECT resource_id::text FROM gfs_resources WHERE drive='main' AND path_cache=${sqlLiteral(path)} AND deleted_at IS NULL;`
    )
  )
  if (!UUID_RE.test(id)) throw new Error(`Fixture file was not found at ${path}`)
  return id
}

export function nonOperatorAccessCount(resourceId: string): number {
  if (!UUID_RE.test(resourceId)) throw new Error('Invalid fixture resource ID')
  const value = firstDataLine(
    runControlPostgresSql(`
    WITH RECURSIVE tree AS (
      SELECT resource_id FROM gfs_resources WHERE resource_id=${sqlLiteral(resourceId)}::uuid
      UNION ALL SELECT child.resource_id FROM gfs_resources child JOIN tree parent ON child.parent_resource_id=parent.resource_id
    )
    SELECT ((SELECT count(*) FROM gfs_grants WHERE resource_id IN (SELECT resource_id FROM tree) AND subject_type IN ('user','team','host','context')) +
            (SELECT count(*) FROM gfs_shares WHERE resource_id IN (SELECT resource_id FROM tree) AND subject_type IN ('user','team','host','context')))::text;
  `)
  )
  if (!/^\d+$/.test(value)) throw new Error('Could not read home access count')
  return Number(value)
}

export async function deleteHomeFixtureUser(page: Page, user: HomeFixtureUser): Promise<void> {
  assertFixtureUser(user)
  const existingEmail = firstDataLine(
    runControlPostgresSql(`SELECT email FROM users WHERE id=${sqlLiteral(user.id)}::uuid;`)
  )
  if (!existingEmail) return
  if (existingEmail !== user.email)
    throw new Error('Fixture user identity changed; refusing cleanup')
  const block = new ControlUiUserHomeBlock(page)
  await block.open(user.id)
  const deletion = page.waitForResponse(
    response =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname.endsWith(`/admin/users/${user.id}`)
  )
  await block.deleteUser()
  expect((await deletion).ok()).toBe(true)
}
