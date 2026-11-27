import 'dotenv/config';
import { mkdir, chmod, rename, unlink, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { statfs } from 'node:fs/promises';
const u = new URL(process.env.DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(u.protocol))
  throw new Error('Нужен DATABASE_URL PostgreSQL');
const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const disk = await statfs(dir);
if (disk.bavail / disk.blocks < 0.1) throw new Error('DISK_CRITICAL: backup requires free space');
const filename = join(dir, `content-factory-${new Date().toISOString().replaceAll(':', '-')}.dump`),
  partial = filename + '.partial';
const env = {
  ...process.env,
  PGHOST: u.hostname,
  PGPORT: u.port || '5432',
  PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
};
try {
  await new Promise((ok, fail) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', partial], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`pg_dump завершился с кодом ${code}`)),
    );
  });
  await chmod(partial, 0o600);
  await rename(partial, filename);
  const names = (await readdir(dir))
    .filter((name) => /^content-factory-.*\.dump$/.test(name))
    .sort()
    .reverse();
  const keep = Math.max(2, Number(process.env.BACKUP_KEEP_COUNT ?? 7));
  for (const name of names.slice(keep)) {
    const path = join(dir, name);
    if (Date.now() - (await stat(path)).mtimeMs > 86400000) await unlink(path);
  }
  console.log('Резервная копия создана:', filename);
} catch (e) {
  await unlink(partial).catch(() => {});
  throw e;
}
