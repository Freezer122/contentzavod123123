import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { base } from '../db/database.js';
import { AppError } from '../core/errors.js';
export async function withProfileLease<T>(
  db: Database,
  profileId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  ttl = 90000,
): Promise<T> {
  const token = randomUUID(),
    controller = new AbortController();
  await db.transaction(async (tx) => {
    const lease = await tx.get('lease', profileId);
    if (lease && lease.expiresAt.getTime() > Date.now())
      throw new AppError('PROFILE_BUSY', 'Браузерный профиль занят', true);
    if (lease) await tx.remove('lease', profileId);
    await tx.insert('lease', { ...base(profileId), token, expiresAt: new Date(Date.now() + ttl) });
  });
  let renewal: Promise<unknown> = Promise.resolve();
  const timer = setInterval(
    () => {
      renewal = renewal
        .then(() =>
          db.transaction(async (tx) => {
            const lease = await tx.get('lease', profileId);
            if (lease?.token !== token || lease.expiresAt.getTime() < Date.now())
              throw new AppError('LEASE_LOST', 'Блокировка профиля потеряна');
            await tx.update('lease', profileId, { expiresAt: new Date(Date.now() + ttl) });
          }),
        )
        .catch((e) => {
          controller.abort(e);
        });
    },
    Math.floor(ttl / 3),
  );
  timer.unref();
  try {
    return await fn(controller.signal);
  } finally {
    clearInterval(timer);
    await renewal;
    await db.transaction(async (tx) => {
      if ((await tx.get('lease', profileId))?.token === token) await tx.remove('lease', profileId);
    });
  }
}
