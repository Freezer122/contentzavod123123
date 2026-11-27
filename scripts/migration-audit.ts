import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaDatabase } from '../src/db/database.js';
import { tables } from '../src/core/domain.js';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const output =
  process.env.MIGRATION_AUDIT_PATH ?? '/var/lib/content-factory/reports/migration-audit.json';
const data: Record<string, unknown> = { tables: {} };
try {
  for (const table of tables) {
    const rows = (await db.list(table)).sort((a, b) => a.id.localeCompare(b.id));
    (data.tables as Record<string, unknown>)[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  const url = new URL(process.env.DATABASE_URL!);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGOPTIONS: '-c timezone=UTC',
  };
  const { stdout } = await promisify(execFile)(
    'psql',
    [
      '-X',
      '-At',
      '-c',
      'SELECT row_to_json(m) FROM (SELECT id,migration_name,checksum,started_at,finished_at,applied_steps_count FROM _prisma_migrations ORDER BY migration_name) m',
    ],
    { env },
  );
  data.migrations = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  data.logicalHash = createHash('sha256').update(JSON.stringify(data.tables)).digest('hex');
  data.checkedAt = new Date().toISOString();
  await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ auditSaved: true, tables: tables.length, logicalHash: data.logicalHash }),
  );
} finally {
  await db.close();
}
