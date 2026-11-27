import { it, expect, vi } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { confirmSourceRights, sourceRights, assertSourceRights } from '../src/content/rights.js';
import { freshness, exactTimestamp } from '../src/engagement/freshness.js';
import { ContentEngine } from '../src/content/service.js';
import { EngagementManager } from '../src/engagement/service.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { deliverGenerations } from '../src/bot/generation.js';
import { publicationProgress } from '../src/bot/publication-status.js';
it.each(['OWN', 'PERMITTED'] as const)(
  'права %s сохраняют все поля и повторно не требуют Sol',
  async (kind) => {
    const f = await fixture();
    await f.db.update('source', f.source.id, { rights: 'REVIEW' });
    await expect(assertSourceRights(f.db, f.source.id)).rejects.toMatchObject({
      code: 'RIGHTS_REQUIRED',
    });
    const r = await confirmSourceRights(f.db, f.source.id, kind, '1');
    expect(r).toMatchObject({
      sourceId: f.source.id,
      sourceType: kind,
      rightsStatus: 'CONFIRMED',
      confirmedBy: '1',
    });
    expect(r.rightsConfirmedAt).toBeTruthy();
    expect(await sourceRights(f.db, f.source.id)).toEqual(r);
    await assertSourceRights(f.db, f.source.id);
    expect(await f.db.list('aiRequest')).toHaveLength(0);
    expect((await f.scheduler.createBatch([f.generated.id], '1'))[0]!.generatedId).toBe(
      f.generated.id,
    );
  },
);
it('чужой материал не получает фиктивных прав и не публикуется', async () => {
  const f = await fixture();
  const r = await confirmSourceRights(f.db, f.source.id, 'THIRD_PARTY', '1');
  expect(r.rightsStatus).toBe('UNCONFIRMED');
  expect(r.rightsConfirmedAt).toBeNull();
  await expect(f.scheduler.createBatch([f.generated.id], '1')).rejects.toMatchObject({
    code: 'RIGHTS_REQUIRED',
  });
});
it('отзыв прав действует и на уже подготовленный исходник', async () => {
  const f = await fixture();
  await confirmSourceRights(f.db, f.source.id, 'OWN', '1');
  await confirmSourceRights(f.db, f.source.id, 'THIRD_PARTY', '1');
  await expect(assertSourceRights(f.db, f.source.id)).rejects.toThrow();
});
it.each([24, 48, 72, 168])('порог свежести %s ч проверяется по UTC', (hours) => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  expect(
    freshness(
      {
        publishedAt: new Date(now - (hours - 0.1) * 3600000).toISOString(),
        timestampConfidence: 'EXACT',
      },
      hours,
      now,
    ).accepted,
  ).toBe(true);
  expect(
    freshness(
      {
        publishedAt: new Date(now - (hours + 0.1) * 3600000).toISOString(),
        timestampConfidence: 'EXACT',
      },
      hours,
      now,
    ).accepted,
  ).toBe(false);
});
it('исходная публикация 23 ноября 2024 отклоняется в ноябре 2026', () => {
  const r = freshness(
    { publishedAt: '2024-11-23T11:21:29.000Z', timestampConfidence: 'EXACT' },
    48,
    Date.parse('2026-11-20T12:00:00Z'),
  );
  expect(r.accepted).toBe(false);
  expect(r.ageHours).toBeGreaterThan(17000);
  expect(r.reason).toContain('старше 48');
});
it('неизвестная/относительная дата и discovery time не заменяют опубликованный timestamp', () => {
  expect(exactTimestamp('2h')).toBeNull();
  expect(exactTimestamp('20 November 2026')).toBeNull();
  expect(freshness({}).accepted).toBe(false);
  expect(
    freshness({ publishedAt: new Date().toISOString(), timestampConfidence: 'UNKNOWN' }).accepted,
  ).toBe(false);
});
it('дата с UTC offset приводится к UTC; будущее отвергается', () => {
  expect(exactTimestamp('2026-11-20T15:00:00+03:00')).toBe('2026-11-20T12:00:00.000Z');
  expect(
    freshness({
      publishedAt: new Date(Date.now() + 3600000).toISOString(),
      timestampConfidence: 'EXACT',
    }).accepted,
  ).toBe(false);
});
it('старый/неизвестный кандидат не передаётся Terra, даже при наличии темы', async () => {
  const f = await fixture();
  let calls = 0;
  const c = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      calls++;
      throw Error('no request');
    },
  });
  const manager = new EngagementManager(
    f.db,
    { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
    c,
  );
  for (const id of ['old', 'unknown']) {
    await putDocument(f.db, `engagement-candidate-${f.account.id}-${id}`, {
      id,
      accountId: f.account.id,
      url: `https://www.threads.com/@other/post/${id}`,
      author: 'other',
      text: 'торговая стратегия и стоп-лосс помогают управлять риском',
      repliesAvailable: true,
      status: 'NEW',
      ...(id === 'old'
        ? { publishedAt: '2024-11-23T11:21:29Z', timestampConfidence: 'EXACT' }
        : {}),
    });
    await expect(manager.generate(f.account.id, id, '1')).rejects.toMatchObject({
      code: 'IRRELEVANT_CANDIDATE',
    });
  }
  expect(calls).toBe(0);
});
it('Telegram: происхождение видно до публикации, подтверждение возвращает готовый пост без Sol', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const send = async (payload: object) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload,
        })
      ).json();
    await send({ callback: 'publication:ACCOUNT_SPECIFIC' });
    const a = (await app.db.list('account'))[0]!;
    await send({ callback: `assign:${a.id}` });
    const receipt = await send({ text: 'мой исходник о торговом плане' });
    expect(JSON.stringify(receipt)).toContain('Мой авторский текст');
    const flow = await getDocument<any>(app.db, 'flow-1');
    const id = flow.assignments[a.id];
    await send({ callback: `v113right:OWN:${id}` });
    expect((await sourceRights(app.db, id)).rightsStatus).toBe('CONFIRMED');
    expect(await app.db.list('aiRequest')).toHaveLength(0);
    await send({ callback: `v113age:${a.id}:72` });
    expect((await app.services.engagement.settings(a.id)).maxAgeHours).toBe(72);
    await send({ callback: `v113limit:${a.id}:40` });
    expect((await app.services.engagement.settings(a.id)).viewLimit).toBe(40);
  } finally {
    await app.close();
  }
});
it('Telegram: задержка больше 30 секунд видна, итог UNCERTAIN доставляется после рестарта', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!;
    await putDocument(app.db, `engagement-candidate-${a.id}-p`, {
      id: 'p',
      accountId: a.id,
      url: 'https://www.threads.com/@other/post/p',
      author: 'other',
      text: 'торговая стратегия требует терпения',
      repliesAvailable: true,
      status: 'NEW',
    });
    const d = await app.services.engagement.edit(
      a.id,
      'p',
      'план легче составить, чем соблюдать',
      '1',
    );
    const j = await app.services.engagement.approve(a.id, d.id, d.hash, '1');
    const t = await app.services.generation.enqueue({
      kind: 'REPLY_SEND',
      replyJobId: j.id,
      accountId: a.id,
      actor: '1',
      chatId: 1,
    });
    await putDocument(app.db, `generation-task-${t.id}`, {
      ...t,
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 31000).toISOString(),
    });
    const messages: any[] = [];
    const api = {
      sendMessage: async (_id: number, text: string) => {
        messages.push(text);
        return { message_id: 1 };
      },
      editMessageText: async (_chat: number, _msg: number, text: string) => {
        messages.push(text);
      },
    };
    await publicationProgress({ api } as any, app.services);
    expect(messages.join()).toContain('Отправка выполняется, проверяю результат');
    await putDocument(app.db, `engagement-job-${j.id}`, {
      ...j,
      status: 'UNCERTAIN',
      executionStatus: 'UNCERTAIN',
      phase: 'UNCERTAIN',
    });
    await app.services.generation.recover();
    await deliverGenerations({ api } as any, app.services);
    expect(messages.join()).toContain('Отправка могла выполниться');
    expect(
      (await app.services.generation.list()).find((x) => x.id === t.id)?.deliveredAt,
    ).toBeTruthy();
    expect((await app.services.engagement.jobView(j.id)).executionStatus).toBe('UNCERTAIN');
  } finally {
    await app.close();
  }
});
it('старый API не может оставить действующим подтверждение после отзыва source.rights', async () => {
  const f = await fixture();
  await confirmSourceRights(f.db, f.source.id, 'OWN', '1');
  await f.db.update('source', f.source.id, { rights: 'REVIEW' });
  await expect(assertSourceRights(f.db, f.source.id)).rejects.toMatchObject({
    code: 'RIGHTS_REQUIRED',
  });
});
it('отдельное подтверждение CTA не отправляет основной пост повторно и повторный клик идемпотентен', async () => {
  const f = await fixture(),
    app = await createApplication({ ...testConfig(), MANUAL_LIVE_ALLOWED: '1' }, f.db);
  try {
    await app.services.manual.setEnabled(f.account.id, '1', true);
    const postsBefore = (await f.db.list('post')).length;
    const [job] = await app.services.scheduler.createBatch([f.generated.id], '1');
    const post = await f.db.insert('post', {
      id: 'already-published',
      createdAt: new Date(),
      jobId: job!.id,
      accountId: f.account.id,
      generatedId: f.generated.id,
      url: 'https://www.threads.com/@test_account/post/existing',
      externalId: null,
      publishedAt: new Date(Date.now() - 60000),
    });
    await f.db.update('publishJob', job!.id, {
      postStatus: 'PUBLISHED',
      status: 'PAUSED',
      commentStatus: 'PENDING',
      ctaEnabled: true,
      ctaText: 'подробнее в профиле',
      ctaVersion: 1,
      ctaCapturedAt: new Date(),
      ctaUrl: null,
    });
    const send = async (callback: string) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload: { callback },
        })
      ).json();
    const preview = await send(`v113cta:${job!.id}`),
      message = preview.messages.find((m: any) => m.method === 'sendMessage');
    const button = message.reply_markup.inline_keyboard
      .flat()
      .find((b: any) => b.text === 'Опубликовать этот CTA');
    await send(button.callback_data);
    const rev = (await f.db.get('publishJob', job!.id))!.revision;
    await send(button.callback_data);
    expect((await f.db.get('publishJob', job!.id))!.revision).toBe(rev);
    expect((await f.db.get('publishJob', job!.id))?.postStatus).toBe('PUBLISHED');
    await app.executor.execute(job!.id);
    expect(await f.db.list('post')).toHaveLength(postsBefore + 1);
    expect((await f.db.list('post', { jobId: job!.id }))[0]!.url).toBe(post.url);
    expect(await f.db.list('comment', { postId: post.id })).toHaveLength(1);
  } finally {
    await app.close();
  }
});
