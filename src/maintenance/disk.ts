import { statfs } from 'node:fs/promises';
import { AppError } from '../core/errors.js';
export function diskLevel(free: number, total: number) {
  return free / total < 0.1 ? 'CRITICAL' : free / total < 0.2 ? 'WARNING' : 'OK';
}
export async function diskSnapshot(path: string) {
  const s = await statfs(path);
  const total = Number(s.blocks) * Number(s.bsize),
    free = Number(s.bavail) * Number(s.bsize);
  return { total, free, percent: (free / total) * 100, level: diskLevel(free, total) };
}
export async function requireHeavyDiskSpace(path: string) {
  const d = await diskSnapshot(path);
  if (d.level === 'CRITICAL' || d.free < 2 * 1024 ** 3)
    throw new AppError(
      'DISK_CRITICAL',
      'Недостаточно места на диске: тяжёлая задача не запущена',
      true,
    );
}
