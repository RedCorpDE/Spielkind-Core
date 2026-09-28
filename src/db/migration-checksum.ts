import { createHash } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n?/g, '\n');
}

export function migrationChecksum(sql: string): string {
  return sha256(normalizeMigrationSql(sql));
}

export function compatibleMigrationChecksums(sql: string): ReadonlySet<string> {
  const normalized = normalizeMigrationSql(sql);
  return new Set([
    sha256(normalized),
    sha256(normalized.replace(/\n/g, '\r\n'))
  ]);
}
