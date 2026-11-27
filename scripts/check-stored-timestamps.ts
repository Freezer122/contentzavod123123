import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaDatabase } from '../src/db/database.js';
import { tables } from '../src/core/domain.js';
import { writeFile, readFile } from 'node:fs/promises';

const legacy = process.env.TIMESTAMP_CHECK_MODE === 'before';
const db = new PrismaDatabase(
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
      options: `-c timezone=${legacy ? 'Europe/Moscow' : 'UTC'}`,
      max: 2,
    }),
  }),
);
const snapshot: Record<string, unknown> = {};
try {
  for (const table of tables)
    snapshot[table] = (await db.list(table)).sort((a, b) => a.id.localeCompare(b.id));
  const path = '/var/lib/content-factory/backups/v15-timestamp-logical-snapshot.json';
  if (legacy) {
    await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
    console.log(JSON.stringify({ snapshotSaved: true, tables: tables.length }));
  } else {
    const old = JSON.parse(await readFile(path, 'utf8'));
    const differences = [];
    for (const table of tables)
      if (JSON.stringify(old[table]) !== JSON.stringify(snapshot[table])) differences.push(table);
    console.log(
      JSON.stringify({
        logicalTimestampsPreserved: differences.length === 0,
        differentTables: differences,
      }),
    );
    if (differences.length) process.exitCode = 1;
  }
} finally {
  await db.close();
}
