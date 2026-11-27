import { Redis } from 'ioredis';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assert } from '../src/core/errors.js';
const client = new Redis(process.env.REDIS_URL!);
const path =
  process.env.REDIS_SNAPSHOT_PATH ?? '/var/lib/content-factory/reports/v18-redis-snapshot.json';
const prefix = 'bull:' + (process.env.PUBLISH_QUEUE_NAME ?? 'publishing') + ':';
try {
  if (process.env.REDIS_MIGRATION_MODE === 'export') {
    const keys = [];
    let cursor = '0';
    do {
      const result = await client.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    const entries = [];
    for (const key of [...new Set(keys)].sort()) {
      const value = await client.dumpBuffer(key);
      const ttl = await client.pttl(key);
      if (!value || ttl === -2) continue;
      entries.push({
        key,
        data: value.toString('base64'),
        sha256: createHash('sha256').update(value).digest('hex'),
        ttl,
      });
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ prefix, capturedAt: Date.now(), entries }), {
      mode: 0o600,
    });
    console.log(JSON.stringify({ exported: entries.length, prefix }));
  } else if (process.env.REDIS_MIGRATION_MODE === 'import') {
    const data = JSON.parse(await readFile(path, 'utf8'));
    assert(data.prefix === prefix, 'WRONG_QUEUE', 'Queue name changed');
    let restored = 0,
      expired = 0;
    for (const entry of data.entries) {
      assert(entry.key.startsWith(prefix), 'WRONG_KEY', 'Unexpected Redis namespace');
      const value = Buffer.from(entry.data, 'base64');
      assert(
        createHash('sha256').update(value).digest('hex') === entry.sha256,
        'CORRUPT_BACKUP',
        'Redis dump checksum differs',
      );
      const ttl = entry.ttl < 0 ? 0 : entry.ttl - (Date.now() - data.capturedAt);
      if (entry.ttl >= 0 && ttl <= 0) {
        expired++;
        continue;
      }
      await client.restore(entry.key, Math.ceil(ttl), value, 'REPLACE');
      restored++;
    }
    console.log(JSON.stringify({ restored, expired, prefix }));
  } else throw new Error('REDIS_MIGRATION_MODE required');
} finally {
  await client.quit();
}
