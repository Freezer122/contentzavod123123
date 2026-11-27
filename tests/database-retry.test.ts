import { afterEach, expect, it, vi } from 'vitest';
import { PrismaDatabase } from '../src/db/database.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('serialization conflict waits for concurrent work instead of exhausting retries in the same millisecond', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const starts: number[] = [];
  const client = {
    $transaction: vi.fn(async (fn: any) => {
      starts.push(Date.now());
      if (Date.now() < 350) throw { code: 'P2034' };
      return fn({});
    }),
  };
  const db = new PrismaDatabase(client as any);
  const run = db.transaction(async () => 'committed');
  await vi.advanceTimersByTimeAsync(700);
  await expect(run).resolves.toBe('committed');
  expect(starts).toEqual([0, 100, 300, 700]);
});
it('retries remain bounded and ordinary errors are never retried', async () => {
  const fatal = new Error('not a serialization conflict'),
    client = {
      $transaction: vi.fn(async () => {
        throw fatal;
      }),
    },
    db = new PrismaDatabase(client as any);
  await expect(db.transaction(async () => {})).rejects.toBe(fatal);
  expect(client.$transaction).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  client.$transaction.mockImplementation(async () => {
    throw { code: 'P2034' };
  });
  const run = db.transaction(async () => {});
  const checked = expect(run).rejects.toMatchObject({ code: 'P2034' });
  await vi.advanceTimersByTimeAsync(700);
  await checked;
  expect(client.$transaction).toHaveBeenCalledTimes(5); // one fatal call + four bounded attempts
});
