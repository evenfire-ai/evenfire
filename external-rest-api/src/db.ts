import { Pool } from 'pg'
import { DbClient } from './repositories/dbClient.js'

export const pool = new Pool({
  connectionString:
    process.env.EXTERNAL_REST_API_PG_CONNECTION_STRING ||
    'postgres://postgres:postgres@localhost:5432/profiles',
})

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      password_hash TEXT,
      password_set_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT,
      channels JSONB NOT NULL DEFAULT '{"emails":[],"slackUserNames":[],"telegramIds":[]}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'inviter', 'member')),
      token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invitations_email_status ON invitations(email, status);
  `)

  const roleConstraint = await pool.query(`
    SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'team_members'
       AND c.conname = 'team_members_role_check'
     LIMIT 1;
  `)
  const definition = String(
    (roleConstraint.rows[0] as { definition?: string } | undefined)?.definition || ''
  )
  if (!definition.includes("'admin'") || definition.includes("'owner'")) {
    await pool.query(`
      UPDATE team_members
         SET role = 'admin',
             updated_at = NOW()
       WHERE role = 'owner';

      ALTER TABLE team_members
        DROP CONSTRAINT IF EXISTS team_members_role_check;

      ALTER TABLE team_members
        ADD CONSTRAINT team_members_role_check
        CHECK (role IN ('admin', 'inviter', 'member'));
    `)
  }

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;

    ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE invitations
      ALTER COLUMN team_id DROP NOT NULL;

    ALTER TABLE invitations DROP COLUMN IF EXISTS invited_by;
  `)
}

export async function withTransaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
