import { Pool } from 'pg';
import { PrismaDatabase } from '../src/db/database.js';
import { writeFile } from 'node:fs/promises';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const pg = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=UTC',
  max: 1,
});
try {
  const posts = await db.list('post');
  const physical = (
    await pg.query(
      'SELECT id, extract(epoch from "publishedAt") * 1000 AS ms FROM published_posts ORDER BY id',
    )
  ).rows;
  const matches =
    physical.length === posts.length &&
    physical.every(
      (row) => posts.find((p) => p.id === row.id)?.publishedAt.getTime() === Number(row.ms),
    );
  if (!matches) throw new Error('PHYSICAL_UTC_MISMATCH');
  const timestamps = (
    await pg.query(
      "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone'",
    )
  ).rows[0].count;
  if (timestamps) throw new Error('LEGACY_TIMESTAMP_TYPE');
  const report = {
    physicalEpochEqualsPrisma: matches,
    postsChecked: posts.length,
    timestampWithoutTimezoneColumns: timestamps,
    posts: posts.map((p) => ({ id: p.id, publishedAt: p.publishedAt.toISOString() })),
  };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-utc.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await db.close();
  await pg.end();
}
