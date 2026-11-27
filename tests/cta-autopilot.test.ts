import { it, expect, vi, afterEach } from 'vitest';
import { fixture, fastClock } from './helpers.js';
import { putDocument, getDocument, hashDocument } from '../src/db/documents.js';
import { AutopilotPolicy, type AutoWork } from '../src/autopilot/policy.js';
import { qualityGate } from '../src/autopilot/quality.js';
import { CtaService, renderCta } from '../src/cta/service.js';
import { ctaKey, ctaStats, type CtaTask, createCtaTask } from '../src/cta/tasks.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { AppError } from '../src/core/errors.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverCtaStatus } from '../src/bot/cta-autopilot.js';
afterEach(() => vi.useRealTimers());
async function setup(enabled = true, media = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-21T10:00:00Z'));
  const f = await fixture(),
    policy = new AutopilotPolicy(f.db, '1'),
    ctas = new CtaService(f.db),
    clock = fastClock();
  await putDocument(f.db, 'autopilot-readiness-v116', { passed: true });
  await ctas.update(f.account.id, 'готовый CTA без новой генерации', '', '1');
  let dir: string | undefined;
  if (media) {
    dir = await mkdtemp(join(tmpdir(), 'cf-cta-'));
    const p = join(dir, 'photo.png');
    await writeFile(p, Buffer.from('89504e470d0a1a0a', 'hex'));
    await ctas.attachment(f.account.id, p, '1', dir);
  }
  await policy.configure(f.account.id, { allowCTA: enabled }, '1');
  await policy.start(await policy.launchCard(f.account.id, '1', 'LIVE'), '1');
  const state = await policy.settings(f.account.id),
    text =
      'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
    source =
      'трейдинг: стоп-лосс ограничивает убыток, но дисциплина исполнения плана важнее красивого входа';
  await f.db.update('source', f.source.id, { text: source });
  await f.db.update('generated', f.generated.id, { text });
  const w: AutoWork = {
    id: 'test-cta-work',
    accountId: f.account.id,
    kind: 'POST',
    epoch: state.epoch,
    version: state.version,
    enabledAt: state.enabledAt!,
    createdAt: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
    mode: 'LIVE',
    status: 'QUEUED',
  };
  const grant = {
    accountId: f.account.id,
    kind: 'POST' as const,
    epoch: w.epoch,
    version: w.version,
    enabledAt: w.enabledAt,
    createdAt: w.createdAt,
    mode: 'LIVE' as const,
    hash: hashDocument(text),
    textVersion: 1,
    sourceUrl: 'https://www.threads.com/@source/post/topic',
    sourceText: source,
    sourcePublishedAt: new Date().toISOString(),
    sourceConfidence: 'EXACT' as const,
    sourceId: f.source.id,
    quality: qualityGate('POST', text, source, []),
    generatedId: f.generated.id,
    format: 'OBSERVATION',
    topic: 'трейдинг',
  };
  const [job] = await f.scheduler.createBatch(
    [f.generated.id],
    '1',
    'MANUAL_APPROVAL',
    'cta-test',
    { autopilot: { policy, work: w, grant } },
  );
  const worker = () =>
    new PublishingWorker(
      f.db,
      f.providers,
      f.publisher,
      undefined,
      1,
      clock,
      false,
      undefined,
      policy,
    );
  return {
    ...f,
    policy,
    ctas,
    clock,
    job: job!,
    worker: worker(),
    restart: worker,
    task: () => getDocument<CtaTask>(f.db, ctaKey(job!.id)),
    cleanup: async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}
it('автоматический дочерний CTA: сохранённый текст без ссылки, версия/хеш/parent/URL, интервал 20 с, отдельно от реплаев', async () => {
  const f = await setup();
  await f.worker.execute(f.job.id);
  const j = (await f.db.get('publishJob', f.job.id))!,
    t = (await f.task())!;
  expect(j.postStatus).toBe('PUBLISHED');
  expect(t.status).toBe('PUBLISHED');
  expect(t.parentPermalink).toContain('@test_account/post/');
  expect(t.contentHash).toBe(hashDocument('готовый CTA без новой генерации'));
  expect(t.permalink).toBeTruthy();
  expect(j.ctaSubmitAt!.getTime() - j.postSubmitAt!.getTime()).toBeGreaterThanOrEqual(20000);
  expect((await f.db.list('comment'))[0]!.text).toBe('готовый CTA без новой генерации');
  expect((await f.policy.sent(f.account.id)).replies).toBe(0);
  expect((await ctaStats(f.db, f.account.id)).published).toBe(1);
});
it('CTA OFF не создаёт отправку; включение после подготовки действует без перезапуска автопилота', async () => {
  const off = await setup(false);
  await off.worker.execute(off.job.id);
  expect(await off.task()).toBeNull();
  expect(off.publisher.comments.size).toBe(0);
  const f = await setup(false),
    before = await f.policy.settings(f.account.id);
  await f.policy.setCta(f.account.id, true, '1');
  expect((await f.policy.settings(f.account.id)).epoch).toBe(before.epoch);
  await f.worker.execute(f.job.id);
  expect((await f.task())?.status).toBe('PUBLISHED');
});
it('долгое подтверждение: CTA после подтверждения, без ожидания ещё 20 с, причина >45 с сохранена', async () => {
  const f = await setup(),
    open = f.publisher.open.bind(f.publisher);
  f.publisher.open = async (...args) => {
    const s = await open(...args),
      publish = s.publish.bind(s);
    s.publish = async (...a) => {
      const r = await publish(...a);
      await f.clock.sleep(65000, new AbortController().signal);
      return r;
    };
    return s;
  };
  await f.worker.execute(f.job.id);
  const j = (await f.db.get('publishJob', f.job.id))!;
  expect(j.ctaSubmitAt!.getTime() - j.postSubmitAt!.getTime()).toBe(65000);
  expect(j.ctaSubmitAt!.getTime()).toBeGreaterThanOrEqual(j.postConfirmedAt!.getTime());
  expect(j.ctaDelayNotifiedAt).toBeTruthy();
});
it('фотография сохраняется через новый worker, ссылка необязательна, при повторном execute дубля нет', async () => {
  const f = await setup(true, true);
  try {
    await f.restart().execute(f.job.id);
    const t = (await f.task())!;
    expect(t.imagePath).toBeTruthy();
    expect(t.imageHash).toBe(f.job.ctaMediaSha256);
    await f.restart().execute(f.job.id);
    expect(f.publisher.comments.size).toBe(1);
    expect(f.publisher.posts.size).toBe(1);
  } finally {
    await f.cleanup();
  }
});
it('ошибка/потеря фотографии CTA не блокирует пост и не останавливает автопилот', async () => {
  const f = await setup(true, true);
  try {
    await rm(f.job.ctaMediaPath!);
    await f.worker.execute(f.job.id);
    expect((await f.db.get('publishJob', f.job.id))?.postStatus).toBe('PUBLISHED');
    expect((await f.task())?.status).toBe('FAILED');
    expect((await f.policy.settings(f.account.id)).state).toBe('RUNNING');
  } finally {
    await f.cleanup();
  }
});
it('занятый браузер до CTA submit ждёт; restart исполняет только ребёнка без повторного поста', async () => {
  const f = await setup(),
    open = f.publisher.open.bind(f.publisher);
  let busy = true;
  f.publisher.open = async (...args) => {
    const s = await open(...args),
      comment = s.comment.bind(s);
    s.comment = async (...a) => {
      if (busy) {
        busy = false;
        throw new AppError('PROFILE_BUSY', 'занят');
      }
      return comment(...a);
    };
    return s;
  };
  await f.worker.execute(f.job.id);
  expect((await f.task())?.status).toBe('WAITING');
  await f.restart().execute(f.job.id);
  expect((await f.task())?.status).toBe('PUBLISHED');
  expect(f.publisher.posts.size).toBe(1);
  expect(f.publisher.comments.size).toBe(1);
});
it('UNCERTAIN ребёнка не останавливает фабрику и не получает повторный submit', async () => {
  const f = await setup(),
    open = f.publisher.open.bind(f.publisher);
  let clicks = 0;
  f.publisher.open = async (...args) => {
    const s = await open(...args);
    s.comment = async (_p, _t, barrier) => {
      await barrier();
      clicks++;
      throw new Error('lost confirmation');
    };
    return s;
  };
  await f.worker.execute(f.job.id);
  expect((await f.task())?.status).toBe('UNCERTAIN');
  expect((await f.policy.settings(f.account.id)).state).toBe('RUNNING');
  expect((await f.db.get('publishJob', f.job.id))?.postStatus).toBe('PUBLISHED');
  await f.restart().execute(f.job.id);
  expect(clicks).toBe(1);
});
it('после аварии SENDING CTA сохраняется UNCERTAIN, основной пост остаётся опубликованным', async () => {
  const f = await setup();
  await f.worker.execute(f.job.id);
  await f.db.update('publishJob', f.job.id, {
    status: 'RUNNING',
    commentStatus: 'SENDING',
    updatedAt: new Date(Date.now() - 181000),
  });
  await f.restart().recover();
  expect((await f.db.get('publishJob', f.job.id))?.commentStatus).toBe('UNCERTAIN');
  expect((await f.task())?.status).toBe('UNCERTAIN');
  await f.restart().execute(f.job.id);
  expect(f.publisher.comments.size).toBe(1);
});
it('исторические DISABLED не досылаются recovery; ручной CTA требует проверки и того же owner/snapshot', async () => {
  const f = await setup(false);
  await f.worker.execute(f.job.id);
  await f.restart().recover();
  expect(f.publisher.comments.size).toBe(0);
  await expect(f.worker.requestMissingCta(f.job.id, '2', 'bad')).rejects.toMatchObject({
    code: 'OWNER_REQUIRED',
  });
  await expect(f.worker.requestMissingCta(f.job.id, '1', 'bad')).rejects.toMatchObject({
    code: 'CTA_VERIFY_REQUIRED',
  });
  const proof = await f.worker.previewCta(f.job.id);
  expect(proof.submit).toBe(false);
  await f.worker.requestMissingCta(f.job.id, '1', proof.signature);
  await f.restart().execute(f.job.id);
  expect(f.publisher.posts.size).toBe(1);
  expect(f.publisher.comments.size).toBe(1);
});
it('дочерняя задача не создаётся под чужим или неподтверждённым постом', async () => {
  const f = await setup();
  await expect(
    createCtaTask(f.db, f.job, {
      id: 'fake',
      jobId: f.job.id,
      accountId: f.account.id,
      url: 'https://www.threads.com/@other/post/one',
      publishedAt: new Date(),
    } as any),
  ).rejects.toMatchObject({ code: 'CTA_PARENT' });
});
it.each([false, true])(
  'готовый CTA со ссылкой, фото=%s: текст и URL сохранены без генерации',
  async (photo) => {
    const f = await setup(true, photo);
    try {
      await f.ctas.update(f.account.id, 'готовый текст', 'https://t.me/example', '1');
      await f.worker.execute(f.job.id);
      expect((await f.db.list('comment'))[0]?.text).toBe('готовый текст\nhttps://t.me/example');
      expect((await f.task())?.status).toBe('PUBLISHED');
      expect((await f.task())?.imageHash != null).toBe(photo);
    } finally {
      await f.cleanup();
    }
  },
);
it('уведомление Telegram не откатывает состояние CTA при параллельном завершении worker', async () => {
  const f = await setup();
  await f.worker.execute(f.job.id);
  const bot = {
    api: {
      sendMessage: async () => {
        const current = (await f.task())!;
        await putDocument(f.db, current.id, {
          ...current,
          status: 'UNCERTAIN',
          reason: 'concurrent transition',
        });
        return { message_id: 42 };
      },
    },
  };
  await deliverCtaStatus(bot as any, { db: f.db, autopilotPolicy: f.policy } as any);
  expect((await f.task())?.status).toBe('UNCERTAIN');
  expect((await f.task())?.reason).toBe('concurrent transition');
});
