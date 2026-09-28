import { describe, expect, it } from 'vitest';
import {
  compatibleMigrationChecksums,
  migrationChecksum,
  normalizeMigrationSql
} from '../../src/db/migration-checksum.js';

describe('migration checksums', () => {
  const lfSql = 'CREATE TABLE example (\n  id uuid PRIMARY KEY\n);\n';
  const crlfSql = lfSql.replace(/\n/g, '\r\n');

  it('uses LF as the canonical representation', () => {
    expect(normalizeMigrationSql(crlfSql)).toBe(lfSql);
    expect(migrationChecksum(crlfSql)).toBe(migrationChecksum(lfSql));
  });

  it('accepts legacy checksums recorded from either line-ending style', () => {
    const lfCompatible = compatibleMigrationChecksums(lfSql);
    const crlfCompatible = compatibleMigrationChecksums(crlfSql);

    expect([...lfCompatible]).toEqual([...crlfCompatible]);
    expect(lfCompatible.size).toBe(2);
  });

  it('still rejects actual SQL changes', () => {
    const changedSql = lfSql.replace('id uuid', 'id text');
    expect(compatibleMigrationChecksums(changedSql).has(migrationChecksum(lfSql))).toBe(false);
  });
});
