/**
 * Generic key/value bag for user-editable app-level settings.
 *
 * Plaintext storage; this is a single-developer tool and the DB lives at
 * ~/.archon/archon.db (same trust boundary as the user's home directory).
 * If multi-tenant ever happens, layer encryption on top.
 *
 * First user (Phase D): Jira credentials (jira.host / jira.email / jira.token).
 */
import { pool, getDialect } from './connection';

export async function getAppSetting(key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    'SELECT value FROM remote_agent_app_settings WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const dialect = getDialect();
  // Postgres uses ON CONFLICT for upsert; SQLite supports the same syntax
  // since 3.24, and Bun ships a recent SQLite. We deliberately don't use
  // dialect.upsert() because both engines accept this exact statement.
  await pool.query(
    `INSERT INTO remote_agent_app_settings (key, value, updated_at)
     VALUES ($1, $2, ${dialect.now()})
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ${dialect.now()}`,
    [key, value]
  );
}

export async function deleteAppSetting(key: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_app_settings WHERE key = $1', [key]);
}

/**
 * Read multiple keys at once. Useful when a feature has 3+ related settings
 * (Jira host/email/token) and you want one round-trip.
 */
export async function getAppSettings(
  keys: readonly string[]
): Promise<Record<string, string | null>> {
  if (keys.length === 0) return {};
  const placeholders = keys.map((_, i) => `$${String(i + 1)}`).join(',');
  const result = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM remote_agent_app_settings WHERE key IN (${placeholders})`,
    [...keys]
  );
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  for (const row of result.rows) out[row.key] = row.value;
  return out;
}
