import { describe, it, expect } from 'vitest';
import { fixture, fastClock } from './helpers.js';
import { base } from '../src/db/database.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { withProfileLease } from '../src/scheduler/lease.js';
import type { PublishingSession, Publisher } from '../src/browser/publisher.js';
async function queued() {
  const f = await fixture();
  const [job] = await f.scheduler.createBatch([f.generated.id], 'test');
  return { ...f, job: job! };
}
const failing = (stage: 'post' | 'comment', send: boolean): Publisher => ({
  open: async () =>
    ({
      check: async () => {},
      publish: async (_text, before) => {
        if (stage === 'post') {
          if (send) await before();
          throw new Error('network');
        }
        await before();
        return { url: 'https://www.threads.com/@test_account/post/one', externalId: null };
      },
      comment: async (_url, _text, before) => {
        if (send) await before();
        throw new Error('network');
      },
      find: async () => null,
      close: async () => {},
      evidence: async () => {},
    }) satisfies PublishingSession,
});
describe('Планировщик и безопасное восстановление', () => {
  it('проверяет права заново непосредственно перед отправкой', async () => {
    const f = await queued();
    await f.db.update('source', f.source.id, { rights: 'REVIEW' });
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      f.job.id,
    );
    expect(f.publisher.posts.size).toBe(0);
    expect((await f.db.get('publishJob', f.job.id))!).toMatchObject({
      status: 'FAILED',
      postStatus: 'FAILED',
    });
  });
  it('запрещает материал с неподтверждёнными правами', async () => {
    const f = await fixture();
    await f.db.update('source', f.source.id, { rights: 'REVIEW' });
    await expect(f.scheduler.createBatch([f.generated.id], 'test')).rejects.toMatchObject({
      code: 'RIGHTS_REQUIRED',
    });
    expect(await f.db.list('batch')).toHaveLength(0);
  });
  it('повтор подтверждения не создаёт дубли', async () => {
    const f = await fixture();
    const a = await f.scheduler.createBatch([f.generated.id], 'test', 'MANUAL_APPROVAL', 'same');
    const b = await f.scheduler.createBatch([f.generated.id], 'test', 'MANUAL_APPROVAL', 'same');
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(await f.db.list('publishJob')).toHaveLength(1);
  });
  it('разводит независимые партии без наложения плановых стартов', async () => {
    const f = await fixture();
    const [a] = await f.scheduler.createBatch([f.generated.id], 'test');
    const [b] = await f.scheduler.createBatch([f.generated.id], 'test');
    expect(b!.scheduledAt.getTime() - a!.scheduledAt.getTime()).toBeGreaterThanOrEqual(1000);
  });
  it('планирует десять аккаунтов 12-минутными слотами с резервом', async () => {
    const f = await fixture();
    const ids = [f.generated.id];
    for (let i = 1; i < 10; i++) {
      const profile = await f.db.insert('browserProfile', {
        ...f.profile,
        ...base(),
        externalId: String(i),
      });
      const a = await f.db.insert('account', {
        ...f.account,
        ...base(),
        profileId: profile.id,
        username: `u${i}`,
      });
      const g = await f.db.insert('generated', { ...f.generated, ...base(), accountId: a.id });
      ids.push(g.id);
    }
    const jobs = await f.scheduler.createBatch(ids, 'test', 'MANUAL_APPROVAL', undefined, {
      mode: 'BROADCAST',
    });
    for (let i = 1; i < jobs.length; i++) {
      const gap = (jobs[i]!.scheduledAt.getTime() - jobs[i - 1]!.scheduledAt.getTime()) / 60000;
      expect(gap * 60).toBeCloseTo(720);
      expect(jobs.at(-1)!.scheduledAt.getTime() - jobs[0]!.scheduledAt.getTime()).toBe(108 * 60000);
    }
  });
  it('не восстанавливает отменённую задачу', async () => {
    const f = await queued();
    await f.scheduler.cancel(f.job.id, 'test');
    const worker = new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock());
    await worker.execute(f.job.id);
    await worker.recover();
    expect((await f.db.get('publishJob', f.job.id))!.status).toBe('CANCELLED');
    expect(f.publisher.posts.size).toBe(0);
  });
  it('блокирует профиль параллельно и освобождает после ошибки', async () => {
    const f = await fixture();
    await withProfileLease(f.db, f.profile.id, async () => {
      await expect(withProfileLease(f.db, f.profile.id, async () => {})).rejects.toMatchObject({
        code: 'PROFILE_BUSY',
      });
    });
    await expect(
      withProfileLease(f.db, f.profile.id, async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await f.db.get('lease', f.profile.id)).toBeNull();
  });
  it('публикует один раз даже при повторном исполнении', async () => {
    const f = await queued();
    const w = new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock());
    await Promise.all([w.execute(f.job.id), w.execute(f.job.id)]);
    await w.execute(f.job.id);
    expect(await f.db.list('post')).toHaveLength(1);
    expect(f.provider.sessions.size).toBe(0);
  });
  it('не повторяет отправку с неопределённым результатом', async () => {
    const f = await queued();
    const w = new PublishingWorker(
      f.db,
      f.providers,
      failing('post', true),
      undefined,
      1,
      fastClock(),
    );
    await w.execute(f.job.id);
    expect((await f.db.get('publishJob', f.job.id))!).toMatchObject({
      status: 'NEEDS_REVIEW',
      postStatus: 'UNCERTAIN',
    });
    await w.execute(f.job.id);
    expect(await f.db.list('post')).toHaveLength(0);
  });
  it('сбой CTA сохраняет основной пост и не повторяет его', async () => {
    const f = await queued();
    await f.db.update('publishJob', f.job.id, {
      ctaText: 'Привет в Telegram',
      commentStatus: 'PENDING',
    });
    const w = new PublishingWorker(
      f.db,
      f.providers,
      failing('comment', false),
      undefined,
      1,
      fastClock(),
    );
    await w.execute(f.job.id);
    expect((await f.db.get('publishJob', f.job.id))!).toMatchObject({
      status: 'COMPLETED',
      postStatus: 'PUBLISHED',
      commentStatus: 'COMMENT_FAILED',
    });
    await f.scheduler.retryComment(f.job.id, 'test');
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      f.job.id,
    );
    expect(await f.db.list('post')).toHaveLength(1);
    expect(f.publisher.posts.size).toBe(0);
    expect(await f.db.list('comment')).toHaveLength(1);
  });
  it('после аварии барьер отправки требует ручной проверки', async () => {
    const f = await queued();
    await f.db.update('publishJob', f.job.id, {
      status: 'RUNNING',
      postStatus: 'SENDING',
      updatedAt: new Date(0),
    });
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).recover();
    expect((await f.db.get('publishJob', f.job.id))!).toMatchObject({
      status: 'NEEDS_REVIEW',
      postStatus: 'UNCERTAIN',
    });
  });
  it('фиксирует отклонение фактического старта от сохранённого плана', async () => {
    const f = await queued();
    await f.db.update('publishJob', f.job.id, {
      scheduledAt: new Date(Date.now() - 60000),
      plannedAt: new Date(Date.now() - 60000),
    });
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      f.job.id,
    );
    const job = (await f.db.get('publishJob', f.job.id))!;
    expect(job.delayMs).toBeGreaterThanOrEqual(60000);
    expect(job.delayReason).toBe('WORKER_LATE');
    expect(job.startedAt).toBeInstanceOf(Date);
  });
  it('неизвестный CTA требует проверки при уже опубликованном посте', async () => {
    const f = await queued();
    await f.db.update('publishJob', f.job.id, { ctaText: 'Комментарий', commentStatus: 'PENDING' });
    const w = new PublishingWorker(
      f.db,
      f.providers,
      failing('comment', true),
      undefined,
      1,
      fastClock(),
    );
    await w.execute(f.job.id);
    expect((await f.db.get('publishJob', f.job.id))!).toMatchObject({
      status: 'COMPLETED',
      postStatus: 'PUBLISHED',
      commentStatus: 'UNCERTAIN',
    });
    await expect(f.scheduler.retryComment(f.job.id, 'test')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(await f.db.list('post')).toHaveLength(1);
  });
  it('устаревшая ревизия Redis не запускает перенесённую задачу', async () => {
    const f = await queued();
    await f.db.update('publishJob', f.job.id, { revision: 1 });
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      f.job.id,
      0,
    );
    expect(f.publisher.posts.size).toBe(0);
  });
});
