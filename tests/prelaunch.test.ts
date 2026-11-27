import { describe, it, expect, vi } from 'vitest';
import { upgradePrelaunch } from '../src/db/upgrade.js';
import { fixture, testConfig, fastClock } from './helpers.js';
import { base, MemoryDatabase } from '../src/db/database.js';
import { ContentEngine, type Llm } from '../src/content/service.js';
import { TemplateService } from '../src/content/templates.js';
import { GenerationQuality } from '../src/content/quality.js';
import { CtaService } from '../src/cta/service.js';
import { PerformanceRating } from '../src/analytics/performance.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { BrowserDiagnostics, DIAGNOSTIC_SCENARIOS } from '../src/browser/diagnostics.js';
import { AppError } from '../src/core/errors.js';
import { createApplication } from '../src/app.js';
import { deliverGenerations } from '../src/bot/generation.js';
function model() {
  const calls: { system: string; user: string }[] = [];
  const llm: Llm = {
    generate: async (system, user) => {
      calls.push({ system, user });
      return {
        text: 'Иногда рынок может подождать. Сначала проверяю риск.',
        inputTokens: 120,
        outputTokens: 36,
      };
    },
  };
  return { llm, calls };
}
describe('Правки перед запуском: CTA и слоты', () => {
  it('обновление старого демохранилища сохраняет исторический CTA и не фиксирует ожидающий', async () => {
    const f = await fixture(),
      [old] = await f.scheduler.createBatch([f.generated.id], 'test'),
      [waiting] = await f.scheduler.createBatch([f.generated.id], 'test');
    await f.db.update('publishJob', old!.id, {
      status: 'COMPLETED',
      postStatus: 'PUBLISHED',
      startedAt: new Date(),
      ctaText: 'Исторический CTA',
      ctaCapturedAt: null,
      ctaVersion: 1,
    });
    await upgradePrelaunch(f.db);
    expect((await f.db.get('publishJob', old!.id))!).toMatchObject({
      ctaText: 'Исторический CTA',
      ctaVersion: 1,
    });
    expect((await f.db.get('publishJob', old!.id))!.ctaCapturedAt).toBeInstanceOf(Date);
    expect((await f.db.get('publishJob', waiting!.id))!.ctaCapturedAt).toBeNull();
  });

  it('распределяет 10 стартов по 12-минутным слотам и оставляет 12 минут резерва', async () => {
    const f = await fixture(),
      ids = [f.generated.id];
    for (let i = 1; i < 10; i++) {
      const p = await f.db.insert('browserProfile', {
          ...f.profile,
          ...base(),
          externalId: `slot-${i}`,
        }),
        a = await f.db.insert('account', {
          ...f.account,
          ...base(),
          username: `slot_${i}`,
          profileId: p.id,
          ctaId: null,
        }),
        g = await f.db.insert('generated', { ...f.generated, ...base(), accountId: a.id });
      ids.push(g.id);
    }
    const jobs = await f.scheduler.createBatch(ids, 'test', 'MANUAL_APPROVAL', undefined, {
      mode: 'BROADCAST',
    });
    expect(jobs.at(-1)!.plannedAt!.getTime() - jobs[0]!.plannedAt!.getTime()).toBe(108 * 60000);
    for (let i = 1; i < jobs.length; i++)
      expect(jobs[i]!.plannedAt!.getTime() - jobs[i - 1]!.plannedAt!.getTime()).toBe(12 * 60000);
    expect((await f.db.get('batch', jobs[0]!.batchId))!.cycleSeconds).toBe(7200);
    const [next] = await f.scheduler.createBatch([f.generated.id], 'test');
    expect(next!.plannedAt!.getTime()).toBeGreaterThanOrEqual(
      jobs[0]!.plannedAt!.getTime() + 120 * 60000,
    );
    expect(await f.db.list('aiRequest')).toHaveLength(0);
  });
  it('отключение CTA применяется к ожидающей задаче без отмены основного поста', async () => {
    const f = await fixture(),
      [job] = await f.scheduler.createBatch([f.generated.id], 'test'),
      ctas = new CtaService(f.db);
    await ctas.setEnabled(f.account.id, false, 'test');
    await new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock()).execute(
      job!.id,
    );
    expect(f.publisher.posts.size).toBe(1);
    expect(f.publisher.comments.size).toBe(0);
    expect((await f.db.get('publishJob', job!.id))!).toMatchObject({
      status: 'COMPLETED',
      postStatus: 'PUBLISHED',
      commentStatus: 'DISABLED',
      ctaEnabled: false,
    });
    expect(await f.db.list('cta', { accountId: f.account.id })).toHaveLength(1);
    await ctas.setEnabled(f.account.id, true, 'test');
    expect((await f.db.get('publishJob', job!.id))!.ctaEnabled).toBe(false);
  });
  it('повтор после начала задачи сохраняет первый снимок CTA', async () => {
    const f = await fixture(),
      ctas = new CtaService(f.db);
    await ctas.ensure(f.account.id);
    const [job] = await f.scheduler.createBatch([f.generated.id], 'test');
    const original = (await ctas.ensure(f.account.id)).text,
      clock = fastClock();
    let attempt = 0;
    const publisher = {
      open: async (...args: Parameters<typeof f.publisher.open>) => {
        const s = await f.publisher.open(...args);
        return {
          ...s,
          publish: async (...params: Parameters<typeof s.publish>) => {
            if (++attempt === 1) {
              await ctas.update(
                f.account.id,
                'Новая версия для следующих задач',
                'https://t.me/future',
                'test',
              );
              throw new AppError('PROVIDER_NETWORK', 'Сеть недоступна', true);
            }
            return s.publish(...params);
          },
        };
      },
    };
    const worker = new PublishingWorker(f.db, f.providers, publisher, undefined, 1, clock);
    await worker.execute(job!.id);
    const retry = (await f.db.get('publishJob', job!.id))!;
    expect(retry.status).toBe('QUEUED');
    await clock.sleep(
      Math.max(0, retry.scheduledAt.getTime() - clock.now()),
      new AbortController().signal,
    );
    await worker.execute(job!.id);
    const done = (await f.db.get('publishJob', job!.id))!;
    expect(done.ctaVersion).toBe(1);
    expect(done.ctaText).toBe(original);
    expect(f.publisher.comments.get(job!.id)).toContain(original);
  });
});
describe('Правки перед запуском: шаблоны и качество', () => {
  it('создаёт восемь шаблонов, назначает их и снимает закрепление без ИИ', async () => {
    const f = await fixture(),
      templates = new TemplateService(f.db);
    await templates.seed();
    await templates.seed();
    expect(await templates.list()).toHaveLength(8);
    const custom = await templates.create('Мой шаблон', 'Одна мысль и простой вопрос.', 'test');
    await templates.addExample(custom.id, 'Бывает, лучший вход — подождать.', 'test');
    await templates.assign(f.account.id, custom.id, 'test');
    expect((await f.db.get('account', f.account.id))!.templateId).toBe(custom.id);
    await templates.assign(f.account.id, null, 'test');
    expect((await f.db.get('account', f.account.id))!.templateId).toBeNull();
    expect(await f.db.list('aiRequest')).toHaveLength(0);
  });
  it('кэш учитывает шаблон, примеры и версию промпта; запрос остаётся один', async () => {
    const f = await fixture(),
      templates = new TemplateService(f.db);
    await templates.seed();
    const id = 'template-life-observation';
    await templates.assign(f.account.id, id, 'test');
    const m = model(),
      engine = new ContentEngine(f.db, testConfig(), m.llm);
    const g = await engine.generate(f.source.id, f.account.id);
    await engine.generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.system).toContain('не буквальный перевод');
    expect(m.calls[0]!.system).toContain('личного опыта');
    expect(g).toMatchObject({
      templateId: id,
      model: 'DEMO',
      inputTokens: 120,
      outputTokens: 36,
      tokenScope: 'SINGLE_REQUEST',
    });
    expect(g.promptVersion).toBe('threads-ru-v1.14-human-sol');
    await templates.update(id, { instruction: 'Новая разговорная подача.' }, 'test');
    const next = await engine.generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(2);
    expect(next.cacheKey).not.toBe(g.cacheKey);
    expect(JSON.parse(g.templateSnapshot!).version).toBe(1);
    await templates.addExample(id, 'Сначала риск, потом всё остальное.', 'test');
    await engine.generate(f.source.id, f.account.id);
    expect(m.calls).toHaveLength(3);
  });
  it('сохраняет оценку и происхождение текста, позволяет изменить оценку без LLM', async () => {
    const f = await fixture(),
      templates = new TemplateService(f.db);
    await templates.seed();
    await templates.assign(f.account.id, 'template-story', 'test');
    const m = model(),
      g = await new ContentEngine(f.db, testConfig(), m.llm).generate(f.source.id, f.account.id),
      quality = new GenerationQuality(f.db);
    await f.db.update('style', 'style-1', { instruction: 'Правка после генерации' });
    await templates.update(
      'template-story',
      { instruction: 'Правка шаблона после генерации' },
      'test',
    );
    const good = await quality.rate(g.id, 'GOOD', 'admin'),
      bad = await quality.rate(g.id, 'BAD', 'admin');
    expect(bad.id).toBe(good.id);
    expect(bad).toMatchObject({
      sourceText: f.source.text,
      finalText: g.text,
      rating: 'BAD',
      accountId: f.account.id,
      styleId: g.styleId,
      templateId: 'template-story',
      promptVersion: g.promptVersion,
      model: 'DEMO',
      inputTokens: 120,
      outputTokens: 36,
      aiRequestId: g.aiRequestId,
    });
    expect(JSON.parse(bad.templateSnapshot!).version).toBe(1);
    expect(bad.styleSnapshot).not.toContain('Правка после генерации');
    expect((await quality.report()).approvalRate).toBe(0);
    await quality.rate(g.id, 'GOOD', 'admin');
    expect((await quality.report()).approvalRate).toBe(100);
    expect(await f.db.list('generationFeedback')).toHaveLength(1);
    expect(m.calls).toHaveLength(1);
  });
  it('не включает шаблон в основной рейтинг раньше 10 сопоставимых замеров одной версии', async () => {
    const f = await fixture(),
      templates = new TemplateService(f.db);
    await templates.seed();
    const id = 'template-trading-psychology';
    await f.db.update('generated', f.generated.id, {
      templateId: id,
      templateSnapshot: JSON.stringify({ id, version: 1 }),
    });
    let missing = '';
    for (let i = 1; i <= 10; i++) {
      const p = await f.db.insert('post', {
          ...base(),
          jobId: base().id,
          accountId: f.account.id,
          generatedId: f.generated.id,
          url: `https://fixture.test/template-${i}`,
          externalId: null,
          publishedAt: new Date(Date.now() - 48 * 3600000),
        }),
        snapshot = await f.db.insert('postMetric', {
          ...base(),
          postId: p.id,
          targetHours: 24,
          measuredAt: new Date(p.publishedAt.getTime() + 24 * 3600000),
          source: 'TEST',
          status: 'TEST',
          views: i === 10 ? null : i,
          likes: 1,
          replies: 0,
          reposts: 0,
          quotes: 0,
        });
      if (i === 10) missing = snapshot.id;
    }
    const rating = new PerformanceRating(f.db);
    const parallel = await Promise.all([rating.report(24), rating.report(24)]);
    expect(parallel[1]!.rows).toHaveLength(10);
    let result = parallel[0]!;
    expect(result.templates).toHaveLength(0);
    expect(result.templateStats.find((t) => t.id === id)).toMatchObject({
      publishedPosts: 10,
      measuredPosts: 9,
      rankEligible: false,
    });
    await f.db.update('postMetric', missing, { views: 10 });
    result = await rating.report(24);
    expect(result.templates.find((t) => t.id === id)).toMatchObject({
      measuredPosts: 10,
      rankEligible: true,
      average: 5.5,
      median: 5.5,
      max: 10,
      min: 1,
    });
    expect(result.bottomByViews[0]!.comparisonViews).toBe(1);
    expect(result.topByViews[0]!.comparisonViews).toBe(10);
    await templates.update(id, { instruction: 'Новая версия' }, 'test');
    result = await rating.report(24);
    expect(result.templates).toHaveLength(0);
    expect(result.templateStats.find((t) => t.id === id)).toMatchObject({
      totalPublishedPosts: 10,
      measuredPosts: 0,
      version: 2,
    });
  });
  it('в Telegram есть оценки, сохранение CTA и независимые стили аккаунтов', async () => {
    const app = await createApplication(testConfig(), new MemoryDatabase(), { clock: fastClock() });
    try {
      const accounts = await app.db.list('account');
      expect(new Set(accounts.map((a) => a.styleId)).size).toBe(10);
      const first = accounts[0]!,
        second = accounts[1]!,
        original = (await app.db.get('style', second.styleId))!.instruction;
      await app.db.update('style', first.styleId, { instruction: 'Только стиль первого аккаунта' });
      expect((await app.db.get('style', second.styleId))!.instruction).toBe(original);
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
      const added = await send({ text: 'A prelaunch UI example.' }),
        rights = added.messages.find((m: any) => m.reply_markup)?.reply_markup.inline_keyboard[0][0]
          .callback_data;
      await send({ callback: rights });
      await send({ callback: 'bind:' + first.id });
      await send({ callback: 'generate_selected' });
      await app.services.generation.tick();
      const delivered: any[] = [];
      app.bot!.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'sendMessage') delivered.push(payload);
        return prev(method, payload, signal);
      });
      await deliverGenerations(app.bot!, app.services);
      const vote = delivered
        .flatMap((m: any) => m.reply_markup?.inline_keyboard.flat() ?? [])
        .find((b: any) => b.text === '👍 Хорошо');
      expect(vote).toBeDefined();
      await send({ callback: vote.callback_data });
      expect((await app.services.quality.report()).good).toBe(1);
      await send({ callback: vote.callback_data.replace('GOOD', 'BAD') });
      expect((await app.services.quality.report()).bad).toBe(1);
      await send({ callback: 'cta_edit:' + first.id });
      await send({ text: 'Новый CTA через форму' });
      await send({ text: 'https://t.me/form' });
      expect((await app.services.ctas.ensure(first.id)).text).not.toBe('Новый CTA через форму');
      await send({ callback: 'cta_save' });
      expect((await app.services.ctas.ensure(first.id)).text).toBe('Новый CTA через форму');
      await send({ callback: 'cta_toggle:' + first.id });
      // Disabled autopilot opens the saved CTA preview; it does not silently toggle consent.
      expect((await app.services.autopilotPolicy.settings(first.id)).config.allowCTA).toBe(false);
      const enable = delivered
        .flatMap((m: any) => m.reply_markup?.inline_keyboard.flat() ?? [])
        .find((b: any) => b.callback_data?.startsWith('ac:enable:'));
      expect(enable).toBeDefined();
      await send({ callback: enable.callback_data });
      expect((await app.services.autopilotPolicy.settings(first.id)).config.allowCTA).toBe(true);
      await send({ callback: 'cta_toggle:' + first.id });
      expect((await app.services.ctas.ensure(first.id)).enabled).toBe(false);
    } finally {
      await app.close();
    }
  }, 30000);
});
describe('DRY_RUN: без VPS, AdsPower, Threads и LLM', () => {
  const expected: Record<string, string> = {
    OK: 'COMPLETED',
    PROFILE_START_ERROR: 'FAILED',
    CDP_ERROR: 'FAILED',
    TIMEOUT: 'FAILED',
    CONNECTION_LOST: 'NEEDS_REVIEW',
    AUTH_REQUIRED: 'PAUSED',
    PUBLISH_FAILED: 'FAILED',
    COMMENT_FAILED: 'COMPLETED',
    UNCERTAIN_POST: 'NEEDS_REVIEW',
    UNCERTAIN_COMMENT: 'COMPLETED',
  };
  for (const scenario of DIAGNOSTIC_SCENARIOS)
    it(scenario, async () => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Сеть запрещена в диагностике'));
      try {
        const result = await new BrowserDiagnostics().run(scenario, 'saved-profile-Threads-02');
        expect(result).toMatchObject({
          mode: 'DRY_RUN',
          simulated: true,
          savedProfileId: 'saved-profile-Threads-02',
          provider: 'MockBrowserProvider',
          status: expected[scenario],
          realBrowserStarted: false,
          externalRequests: 0,
          llmRequests: 0,
          activeSessions: 0,
          profileLeases: 0,
        });
        expect(result.attempts).toBeLessThanOrEqual(3);
        expect(network).not.toHaveBeenCalled();
        if (scenario === 'COMMENT_FAILED')
          expect(result).toMatchObject({
            postStatus: 'PUBLISHED',
            commentStatus: 'COMMENT_FAILED',
          });
        if (scenario === 'UNCERTAIN_POST' || scenario === 'CONNECTION_LOST')
          expect(result.postStatus).toBe('UNCERTAIN');
        if (scenario === 'UNCERTAIN_COMMENT')
          expect(result).toMatchObject({ postStatus: 'PUBLISHED', commentStatus: 'UNCERTAIN' });
      } finally {
        network.mockRestore();
      }
    });
  it('по умолчанию выбран DRY_RUN, а выключенный исполнитель не запускает провайдер', async () => {
    expect(testConfig().BROWSER_EXECUTION_MODE).toBe('DRY_RUN');
    const f = await fixture(),
      start = vi.spyOn(f.provider, 'start'),
      [j] = await f.scheduler.createBatch([f.generated.id], 'test');
    await expect(
      new PublishingWorker(
        f.db,
        f.providers,
        f.publisher,
        undefined,
        1,
        fastClock(),
        false,
      ).execute(j!.id),
    ).rejects.toMatchObject({ code: 'DRY_RUN_ONLY' });
    expect(start).not.toHaveBeenCalled();
    expect((await f.db.get('publishJob', j!.id))!.status).toBe('QUEUED');
  });
});
