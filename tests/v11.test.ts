import { describe, it, expect } from 'vitest';
import { fixture, fastClock, testConfig } from './helpers.js';
import { base, MemoryDatabase } from '../src/db/database.js';
import { ContentEngine, protectedTokens, type Llm } from '../src/content/service.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { CtaService } from '../src/cta/service.js';
import { Tracking } from '../src/tracking/service.js';
import { Retention } from '../src/tracking/retention.js';
import { PerformanceRating } from '../src/analytics/performance.js';
import { AnalyticsCollector } from '../src/analytics/collector.js';
import { createApplication } from '../src/app.js';
async function second(f: Awaited<ReturnType<typeof fixture>>) {
  const profile = await f.db.insert('browserProfile', {
    ...f.profile,
    ...base(),
    externalId: 'second',
  });
  return f.db.insert('account', {
    ...f.account,
    ...base(),
    profileId: profile.id,
    username: 'second_user',
    styleId: 'style-2',
    ctaId: null,
  });
}
function countingLlm() {
  const calls: { system: string; user: string }[] = [];
  const llm: Llm = {
    generate: async (system, user) => {
      calls.push({ system, user });
      const text = (source: string) =>
        `Сначала проверяю риск.${protectedTokens(source).length ? ' Уровни: ' + protectedTokens(source).join(', ') : ''}`;
      return {
        text: user.startsWith('---BATCH---')
          ? JSON.stringify({
              variants: (JSON.parse(user.slice('---BATCH---'.length)).targets as any[]).map(
                (r) => ({
                  key: r.key,
                  text: text(JSON.parse(user.slice('---BATCH---'.length)).source),
                }),
              ),
            })
          : text(user),
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
  return { llm, calls };
}
describe('V1.1: подготовка и токены', () => {
  it('ACCOUNT_SPECIFIC распределяет разные исходники строго по указанным аккаунтам', async () => {
    const f = await fixture(),
      a2 = await second(f),
      s2 = await f.db.insert('source', {
        ...f.source,
        ...base(),
        fingerprint: 'other',
        text: 'A different thought.',
      }),
      m = countingLlm(),
      engine = new ContentEngine(f.db, testConfig(), m.llm);
    const variants = await engine.prepare({
      mode: 'ACCOUNT_SPECIFIC',
      mappings: [
        { accountId: f.account.id, sourceId: f.source.id },
        { accountId: a2.id, sourceId: s2.id },
      ],
    });
    expect(variants.map((g) => [g.accountId, g.sourceId])).toEqual([
      [f.account.id, f.source.id],
      [a2.id, s2.id],
    ]);
    expect(m.calls).toHaveLength(2);
    expect(await f.db.list('publishJob')).toHaveLength(0);
    await expect(
      engine.prepare({
        mode: 'ACCOUNT_SPECIFIC',
        mappings: [
          { accountId: f.account.id, sourceId: f.source.id },
          { accountId: a2.id, sourceId: f.source.id },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SOURCE' });
  });
  it('BROADCAST COMMON использует одну адаптацию и один запрос для выбранных аккаунтов', async () => {
    const f = await fixture(),
      a2 = await second(f),
      m = countingLlm(),
      engine = new ContentEngine(f.db, testConfig(), m.llm);
    const result = await engine.prepare({
      mode: 'BROADCAST',
      adaptation: 'COMMON',
      sourceId: f.source.id,
      accountIds: [f.account.id, a2.id],
    });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((g) => g.text)).size).toBe(1);
    expect(m.calls).toHaveLength(1);
    expect(result.every((g) => g.valid)).toBe(true);
  });
  it('BROADCAST PER_ACCOUNT передаёт разные стили одним пакетным запросом', async () => {
    const f = await fixture(),
      a2 = await second(f),
      m = countingLlm(),
      engine = new ContentEngine(f.db, testConfig(), m.llm);
    const result = await engine.prepare({
      mode: 'BROADCAST',
      adaptation: 'PER_ACCOUNT',
      sourceId: f.source.id,
      accountIds: [f.account.id, a2.id],
    });
    expect(result.map((g) => g.styleId)).toEqual(['style-1', 'style-2']);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.user).toContain('---BATCH---');
    const jobs = await f.scheduler.createBatch(
      result.map((g) => g.id),
      'test',
      'MANUAL_APPROVAL',
      'broadcast',
      { mode: 'BROADCAST' },
    );
    expect(new Set(jobs.map((j) => j.accountId))).toEqual(new Set([f.account.id, a2.id]));
  });
  it('кэш переживает новый экземпляр движка и меняется при смене модели или стиля', async () => {
    const f = await fixture(),
      m = countingLlm();
    await new ContentEngine(f.db, testConfig(), m.llm).generate(f.source.id, f.account.id);
    await new ContentEngine(f.db, testConfig(), m.llm).generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(1);
    await f.db.update('style', 'style-1', { instruction: 'Новая инструкция' });
    await new ContentEngine(f.db, testConfig(), m.llm).generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(2);
    await new ContentEngine(
      f.db,
      { ...testConfig(), APP_MODE: 'production', LLM_MODEL: 'changed' },
      m.llm,
    ).generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(3);
  });
  it('браузерная публикация и CTA не вызывают ИИ', async () => {
    const f = await fixture(),
      m = countingLlm(),
      g = await new ContentEngine(f.db, testConfig(), m.llm).generate(f.source.id, f.account.id),
      [job] = await f.scheduler.createBatch([g.id], 'test');
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      job!.id,
    );
    expect(m.calls).toHaveLength(1);
    expect(f.publisher.posts.size).toBe(1);
    expect(f.publisher.comments.size).toBe(1);
  });
});
describe('V1.1: время и CTA', () => {
  it('адаптирует 120 минут к числу выбранных аккаунтов; одиночный старт без интервала', async () => {
    const f = await fixture(),
      a2 = await second(f),
      g2 = await f.db.insert('generated', { ...f.generated, ...base(), accountId: a2.id });
    const jobs = await f.scheduler.createBatch(
      [f.generated.id, g2.id],
      'test',
      'MANUAL_APPROVAL',
      undefined,
      { mode: 'BROADCAST' },
    );
    expect(jobs[1]!.scheduledAt.getTime() - jobs[0]!.scheduledAt.getTime()).toBe(60 * 60000);
    const single = await f.scheduler.createBatch([f.generated.id], 'test');
    expect((await f.db.get('batch', single[0]!.batchId))!.intervalSeconds).toBe(0);
  });
  it('выдерживает не меньше 20 секунд между фактическими barrier отправками', async () => {
    const f = await fixture(),
      [j] = await f.scheduler.createBatch([f.generated.id], 'test'),
      clock = fastClock();
    let sentAt = 0;
    const publisher = {
      open: async (...args: Parameters<typeof f.publisher.open>) => {
        const session = await f.publisher.open(...args);
        return {
          ...session,
          comment: async (...p: Parameters<typeof session.comment>) => {
            return session.comment(p[0], p[1], async () => {
              await p[2]();
              sentAt = clock.now();
            });
          },
        };
      },
    };
    await new PublishingWorker(f.db, f.providers, publisher, undefined, 1, clock).execute(j!.id);
    const post = (await f.db.list('post'))[0]!;
    expect(sentAt - post.publishedAt.getTime()).toBeGreaterThanOrEqual(20000);
    expect((await f.db.get('publishJob', j!.id))!.commentStatus).toBe('PUBLISHED');
  });
  it('ожидающая задача берёт свежий CTA при первом старте', async () => {
    const f = await fixture(),
      service = new CtaService(f.db),
      [job] = await f.scheduler.createBatch([f.generated.id], 'test');
    expect(job!.ctaCapturedAt).toBeNull();
    await service.update(
      f.account.id,
      'Новый индивидуальный CTA',
      'https://t.me/new_target',
      'test',
    );
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      job!.id,
    );
    const done = (await f.db.get('publishJob', job!.id))!;
    expect(done.ctaVersion).toBe(2);
    expect(done.ctaText).toBe('Новый индивидуальный CTA');
    await service.update(f.account.id, 'Следующий CTA', 'https://t.me/next', 'test');
    expect((await f.db.get('publishJob', job!.id))!.ctaVersion).toBe(2);
  });
  it('редактирует CTA текст и URL прямо через Telegram', async () => {
    const app = await createApplication(testConfig(), new MemoryDatabase(), { clock: fastClock() });
    try {
      const headers = { authorization: 'Bearer demo-local-token' };
      const send = async (body: object) =>
        app.server!.inject({ method: 'POST', url: '/api/demo/telegram', headers, payload: body });
      await send({ callback: 'accounts' });
      await send({ callback: 'account:demo-account-1' });
      await send({ callback: 'cta_edit:demo-account-1' });
      await send({ text: 'Мои новые разборы' });
      await send({ text: 'https://t.me/new_target' });
      await send({ callback: 'cta_save' });
      const cta = await app.services.ctas.ensure('demo-account-1');
      expect(cta.text).toBe('Мои новые разборы');
      expect(cta.url).toBe('https://t.me/new_target');
      expect(cta.version).toBe(2);
      expect((await app.db.list('cta')).filter((c) => c.accountId)).toHaveLength(10);
    } finally {
      await app.close();
    }
  }, 30000);
  it('постоянный tracking URL и приглашение не создаются заново', async () => {
    const f = await fixture(),
      tracking = new Tracking(f.db, 'secret');
    const a = await tracking.create(f.account.id, 'https://t.me/one'),
      b = await tracking.create(f.account.id, 'https://t.me/two');
    expect(a.code).toBe(b.code);
    let created = 0;
    const invite = () => {
      created++;
      return Promise.resolve('https://t.me/+personal');
    };
    const first = await tracking.ensureInvite(f.account.id, '-100', invite),
      again = await tracking.ensureInvite(f.account.id, '-100', invite);
    expect(created).toBe(1);
    expect(first.invite.id).toBe(again.invite.id);
    expect(first.link.code).toBe(a.code);
    await expect(
      tracking.create(f.account.id, 'https://t.me/two', null, 'post-id'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ATTRIBUTION_ONLY' });
  });
});
describe('V1.1: когорты и рейтинг', () => {
  for (const day of [7, 30] as const)
    it(`Retention D${day} использует зрелые когорты, выходы и отдельные повторные вступления`, async () => {
      const f = await fixture(),
        tracking = new Tracking(f.db, 'secret'),
        now = Date.now(),
        joined = new Date(now - day * 86400000 - 300000);
      await tracking.registerInvite(f.account.id, 'https://t.me/+personal', '-100');
      const join = async (id: string, key: string, at: Date, known = true) =>
        tracking.membership({
          eventKey: key,
          channelId: '-100',
          userId: id,
          kind: 'JOIN',
          inviteUrl: known ? 'https://t.me/+personal' : undefined,
          occurredAt: at,
        });
      await join('111111111', 'one', joined);
      await tracking.membership({
        eventKey: 'leave-one',
        channelId: '-100',
        userId: '111111111',
        kind: 'LEAVE',
        occurredAt: new Date(joined.getTime() + 86400000),
      });
      await join('111111111', 'rejoin', new Date(now - 86400000));
      await join('222222222', 'two', joined);
      await join('333333333', 'unknown', joined, false);
      const retention = new Retention(
        f.db,
        'secret',
        async () => true,
        () => now,
      );
      await retention.tick();
      const r = await retention.report(new Date(0), new Date(now), f.account.id),
        m = day === 7 ? r.d7 : r.d30;
      expect(m.eligible).toBe(2);
      expect(m.retained).toBe(1);
      expect(m.churned).toBe(1);
      expect(m.retention).toBe(50);
      expect(m.churn).toBe(50);
      expect(r.joins).toBe(3);
      expect(r.uniqueMembers).toBe(2);
      expect((await retention.report()).unknownSource).toBe(1);
      expect(JSON.stringify(await f.db.list('memberIdentity'))).not.toContain('111111111');
    });
  it('поздняя проверка текущего членства не выдаётся за Retention D7', async () => {
    const f = await fixture(),
      t = new Tracking(f.db, 'secret'),
      now = Date.now();
    await t.membership({
      eventKey: 'late',
      channelId: '-100',
      userId: '222222222',
      kind: 'JOIN',
      occurredAt: new Date(now - 9 * 86400000),
    });
    const r = new Retention(
      f.db,
      'secret',
      async () => true,
      () => now,
    );
    await r.tick();
    const report = await r.report();
    expect(report.d7.unknown).toBe(1);
    expect(report.d7.retention).toBeNull();
  });
  it('рейтинг сравнивает одинаковый возраст и не повышает старый пост за накопительные просмотры', async () => {
    const f = await fixture(),
      now = Date.now();
    await f.db.update('source', f.source.id, { topic: 'Риск', format: 'Разбор', hook: 'Вопрос' });
    for (const [age, views, latest] of [
      [48, 150, 300],
      [1000, 50, 1000000],
      [6, 999, null],
    ] as const) {
      const post = await f.db.insert('post', {
        ...base(),
        jobId: base().id,
        accountId: f.account.id,
        generatedId: f.generated.id,
        url: `https://threads.test/${age}`,
        externalId: null,
        publishedAt: new Date(now - age * 3600000),
      });
      await f.db.insert('postMetric', {
        ...base(),
        postId: post.id,
        measuredAt: new Date(post.publishedAt.getTime() + 24 * 3600000),
        targetHours: 24,
        source: 'TEST',
        status: 'OK',
        views,
        likes: 5,
        replies: 1,
        reposts: 0,
        quotes: 0,
      });
      if (latest)
        await f.db.insert('postMetric', {
          ...base(),
          postId: post.id,
          measuredAt: new Date(now),
          targetHours: null,
          source: 'TEST',
          status: 'OK',
          views: latest,
          likes: 6,
          replies: 1,
          reposts: 0,
          quotes: 0,
        });
    }
    const report = await new PerformanceRating(f.db).report(24, undefined, new Date(now));
    expect(report.topByViews.map((p) => p.comparisonViews)).toEqual([150, 50]);
    expect(report.topBy24.map((p) => p.viewsByHour[24])).toEqual([150, 50]);
    expect(report.topics[0]!.average).toBe(100);
    expect(report.topics[0]!.median).toBe(100);
    expect(report.excluded).toBe(1);
    expect(
      report.rows.every(
        (r) => r.postClicks === null && r.accountContext.attribution === 'ACCOUNT_ONLY',
      ),
    ).toBe(true);
  });
  it('сохраняет контрольный снимок шести часов без ИИ', async () => {
    const f = await fixture(),
      post = await f.db.insert('post', {
        ...base(),
        jobId: base().id,
        accountId: f.account.id,
        generatedId: f.generated.id,
        url: 'https://threads.test/six',
        externalId: null,
        publishedAt: new Date(Date.now() - 6.1 * 3600000),
      });
    const collector = new AnalyticsCollector(f.db, {
      post: async () => ({
        views: null,
        likes: null,
        replies: null,
        reposts: null,
        quotes: null,
        source: 'UNAVAILABLE',
        status: 'UNAVAILABLE',
      }),
      followers: async () => null,
    });
    await collector.tick();
    expect(
      (await f.db.list('postMetric', { postId: post.id })).some(
        (s) => s.targetHours === 6 && s.views === null,
      ),
    ).toBe(true);
  });
});
