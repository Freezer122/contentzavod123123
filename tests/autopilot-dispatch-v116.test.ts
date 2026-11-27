import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { putDocument } from '../src/db/documents.js';
const calls = vi.hoisted(() => [] as any[]);
vi.mock('ioredis', () => ({
  Redis: class {
    ping() {
      return 'PONG';
    }
    async quit() {}
  },
}));
vi.mock('bullmq', () => ({
  Queue: class {
    async getJob() {
      return null;
    }
    async add(...args: any[]) {
      calls.push(args);
    }
    async close() {}
  },
  Worker: class {},
}));
import { QueueRuntime } from '../src/scheduler/queue.js';
it('явный MANUAL_LIVE не блокируется старым AUTOPILOT scope, автономный scope остаётся обязательным', async () => {
  const f = await fixture();
  const [a] = await f.scheduler.createBatch([f.generated.id], '1');
  expect(a).toBeTruthy();
  await putDocument(f.db, 'publishing-policy-v112', true);
  await putDocument(f.db, 'factoryPaused', true);
  await putDocument(f.db, `autopilot-grant-${a!.id}`, { mode: 'LIVE' });
  const policy = {
      validate: vi.fn(async () => {
        throw Error('old scope');
      }),
    },
    executor = { recover: async () => {} };
  const runtime = new QueueRuntime(
    f.db,
    executor as any,
    'redis://fixture',
    1,
    false,
    'fixture',
    policy as any,
  );
  try {
    await runtime.tick();
    expect(calls).toHaveLength(0);
    expect(policy.validate).toHaveBeenCalledTimes(1);
    await putDocument(f.db, `manual-post-${a!.id}`, { actor: '1' });
    await runtime.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0][2].priority).toBe(1);
    expect(policy.validate).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
  }
});
