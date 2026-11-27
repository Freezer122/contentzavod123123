import { it, expect } from 'vitest';
import { mkdtemp, writeFile, utimes, access, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskLevel } from '../src/maintenance/disk.js';
import { cleanupArtifacts } from '../src/maintenance/retention.js';
import { MemoryDatabase } from '../src/db/database.js';
it('различает пороги диска 20 и 10 процентов', () => {
  expect(diskLevel(21, 100)).toBe('OK');
  expect(diskLevel(19, 100)).toBe('WARNING');
  expect(diskLevel(9, 100)).toBe('CRITICAL');
});
it('соблюдает retention, KEEP и незавершённый UNCERTAIN; не идёт по симлинкам', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-retention-'));
  const external = await mkdtemp(join(tmpdir(), 'cf-retention-external-'));
  const db = new MemoryDatabase();
  const now = Date.now();
  const old = new Date(now - 10 * 86400000);
  const older = new Date(now - 40 * 86400000);
  try {
    await writeFile(join(external, 'outside.png'), 'image');
    await utimes(join(external, 'outside.png'), older, older);
    await symlink(external, join(dir, 'outside-link'));
    for (const name of ['normal.png', 'KEEP-test.png', 'critical.png']) {
      await writeFile(join(dir, name), 'image');
      await utimes(join(dir, name), old, old);
    }
    await writeFile(join(dir, 'critical.json'), JSON.stringify({ critical: true }));
    await utimes(join(dir, 'critical.json'), older, older);
    const protectedDir = join(dir, 'protected');
    await mkdir(protectedDir);
    await writeFile(join(protectedDir, 'KEEP'), '');
    await writeFile(join(protectedDir, 'old.png'), 'image');
    await utimes(join(protectedDir, 'old.png'), older, older);
    const id = '12345678-1234-1234-1234-123456789012';
    await db.insert('publishJob', {
      id,
      createdAt: new Date(),
      status: 'NEEDS_REVIEW',
      postStatus: 'UNCERTAIN',
      commentStatus: 'PENDING',
    } as any);
    const unresolved = join(dir, id + '-old.png');
    await writeFile(unresolved, 'image');
    await utimes(unresolved, older, older);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ errorCode: 'AUTH_REQUIRED' }));
    await utimes(join(dir, 'auth.json'), old, old);
    const result = await cleanupArtifacts(db, [dir], now);
    expect(result.removed).toContain(join(dir, 'normal.png'));
    await cleanupArtifacts(db, [dir], now + 86400000);
    await expect(access(join(external, 'outside.png'))).resolves.toBeUndefined();
    await expect(access(join(dir, 'critical.json'))).resolves.toBeUndefined();
    await expect(access(join(dir, 'auth.json'))).resolves.toBeUndefined();
    for (const path of [
      join(dir, 'KEEP-test.png'),
      join(dir, 'critical.png'),
      join(protectedDir, 'old.png'),
      unresolved,
    ])
      await expect(access(path)).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
