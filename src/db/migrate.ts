import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_LOCK_KEY = 'spielkind_core_schema_migrations';
const BASELINE_SENTINEL_TABLES = [
  'users',
  'task_kanban_columns',
  'tasks',
  'booking_admin_metadata',
  'regiondo_webhook_events',
  'client_contact_methods',
  'reminder_rules',
  'reminder_deliveries',
  'sync_state',
  'job_runs'
] as const;

interface MigrationFile {
  absolutePath: string;
  relativePath: string;
  checksum: string;
  sql: string;
}

function hashSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function runMigrations(): Promise<void> {
  const baseDir = path.resolve(__dirname, '../../');
  const legacyDir = path.join(baseDir, 'old');
  const extraDir = path.join(baseDir, 'db/migrations');

  const readSqlFiles = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  };

  const trackedFiles = async (dir: string): Promise<MigrationFile[]> => {
    const sqlFiles = await readSqlFiles(dir);
    const migrations: MigrationFile[] = [];

    for (const absolutePath of sqlFiles) {
      const sql = await readFile(absolutePath, 'utf8');
      migrations.push({
        absolutePath,
        relativePath: path.relative(baseDir, absolutePath).replace(/\\/g, '/'),
        checksum: hashSql(sql),
        sql
      });
    }

    return migrations;
  };

  const legacyFiles = await trackedFiles(legacyDir);
  const extraFiles = await trackedFiles(extraDir);
  const migrations = [...legacyFiles, ...extraFiles];

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATION_LOCK_KEY]);

  try {
    const existingAppSchemaResult = await pool.query<{ table_count: string | number }>(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name <> 'schema_migrations'`
    );
    const existingAppTableCount = Number(existingAppSchemaResult.rows[0]?.table_count ?? 0);

    const trackedMigrationResult = await pool.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum
       FROM schema_migrations`
    );
    const trackedMigrations = new Map(
      trackedMigrationResult.rows.map((row) => [row.filename, row.checksum] as const)
    );

    let canBaselineCurrentSchema = false;

    if (trackedMigrations.size === 0 && existingAppTableCount > 0 && migrations.length > 0) {
      const sentinelTableResult = await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [BASELINE_SENTINEL_TABLES]
      );
      const existingSentinelTables = new Set(sentinelTableResult.rows.map((row) => row.table_name));
      canBaselineCurrentSchema = BASELINE_SENTINEL_TABLES.every((tableName) => existingSentinelTables.has(tableName));
    }

    if (trackedMigrations.size === 0 && existingAppTableCount > 0 && migrations.length > 0 && canBaselineCurrentSchema) {
      console.log('Existing application schema detected without migration tracking. Baseline-marking current SQL files.');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const migration of migrations) {
          await client.query(
            `INSERT INTO schema_migrations (filename, checksum)
             VALUES ($1, $2)`,
            [migration.relativePath, migration.checksum]
          );
          trackedMigrations.set(migration.relativePath, migration.checksum);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else if (trackedMigrations.size === 0 && existingAppTableCount > 0 && migrations.length > 0) {
      console.log(
        'Existing application schema detected without migration tracking, but the current sentinel tables are incomplete. Running migrations instead of baseline-marking.'
      );
    }

    for (const migration of migrations) {
      const existingChecksum = trackedMigrations.get(migration.relativePath);

      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Tracked migration checksum mismatch for ${migration.relativePath}. ` +
              'Create a new migration file instead of modifying an applied one.'
          );
        }

        console.log(`Skipping migration: ${migration.relativePath}`);
        continue;
      }

      console.log(`Running migration: ${migration.relativePath}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum)
           VALUES ($1, $2)`,
          [migration.relativePath, migration.checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    console.log('All migrations completed.');
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATION_LOCK_KEY]);
  }
}

runMigrations()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
