import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations(): Promise<void> {
  const baseDir = path.resolve(__dirname, '../../');
  const legacyDir = path.join(baseDir, 'old');
  const extraDir = path.join(baseDir, 'db/migrations');

  const legacyFiles = (await readdir(legacyDir)).filter((name) => name.endsWith('.sql')).sort();
  const extraFiles = (await readdir(extraDir)).filter((name) => name.endsWith('.sql')).sort();

  for (const fileName of [...legacyFiles.map((n) => path.join(legacyDir, n)), ...extraFiles.map((n) => path.join(extraDir, n))]) {
    const sql = await readFile(fileName, 'utf8');
    console.log(`Running migration: ${path.relative(baseDir, fileName)}`);
    await pool.query(sql);
  }

  console.log('All migrations completed.');
}

runMigrations()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
