import { PrismaDatabase, base } from '../src/db/database.js';
import { diskSnapshot } from '../src/maintenance/disk.js';
import { cleanupArtifacts } from '../src/maintenance/retention.js';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  const disk = await diskSnapshot('/var/lib/content-factory');
  await db.transaction(async (tx) => {
    const old = await tx.get('setting', 'disk-alert-state');
    const previous = old ? JSON.parse(old.value) : {};
    const notify =
      disk.level !== 'OK' &&
      (previous.level !== disk.level || Date.now() - (previous.notifiedAt ?? 0) > 86400000);
    if (notify) {
      const message = `${disk.level === 'CRITICAL' ? 'Критически мало места' : 'Предупреждение о диске'}: свободно ${disk.percent.toFixed(1)}%, ${(disk.free / 1024 ** 3).toFixed(2)} ГиБ`;
      await tx.insert('systemEvent', {
        ...base(),
        level: disk.level === 'CRITICAL' ? 'ERROR' : 'WARN',
        code: 'DISK_SPACE',
        message,
      });
      await tx.insert('systemEvent', { ...base(), level: 'INFO', code: 'NOTIFICATION', message });
    }
    const value = JSON.stringify({
      level: disk.level,
      notifiedAt: notify ? Date.now() : (previous.notifiedAt ?? 0),
    });
    if (old) await tx.update('setting', old.id, { value });
    else await tx.insert('setting', { ...base('disk-alert-state'), value });
  });
  const cleanup = await cleanupArtifacts(db, [
    '/var/lib/content-factory/artifacts',
    '/var/lib/content-factory/reports',
    '/var/lib/content-factory/tmp',
    '/tmp/content-factory-browser-evidence',
  ]);
  console.log(
    JSON.stringify({
      event: 'maintenance',
      disk,
      removed: cleanup.removed.length,
      protected: cleanup.kept.length,
    }),
  );
} finally {
  await db.close();
}
