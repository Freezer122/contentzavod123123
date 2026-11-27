import { it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { ContentEngine } from '../src/content/service.js';
import { OpenAiResponses } from '../src/content/openai.js';
import { GenerationQuality, type ModelExperiment } from '../src/content/quality.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { engagementSettings, type Candidate } from '../src/engagement/service.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
async function fixtureAB(mode = 'ok') {
  const f = await fixture(),
    calls: any[] = [];
  const cfg = {
    ...testConfig(),
    APP_MODE: 'production' as const,
    LLM_PROVIDER: 'openai' as const,
    OPENAI_API_KEY: 'fixture-only',
  };
  const client = new OpenAiResponses(cfg, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    calls.push(body);
    if (mode === 'unknown') throw Error('network');
    return new Response(
      JSON.stringify({
        id: 'resp_ab_fixture_' + calls.length,
        model: body.model,
        status: mode === 'incomplete' ? 'incomplete' : 'completed',
        service_tier: 'default',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: body.model === 'gpt-6.2-sol' ? 10 : 0 },
        },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text:
                  body.model === 'gpt-6.2-sol'
                    ? 'ну вот, опять стопы собирают'
                    : 'ща рынок проверит терпение',
              },
            ],
          },
        ],
      }),
    );
  });
  const content = new ContentEngine(f.db, cfg, client),
    q = new GenerationQuality(f.db),
    settings = engagementSettings.parse({});
  const candidate = (id: string, patch: Partial<Candidate> = {}): Candidate => ({
    id,
    accountId: f.account.id,
    author: 'other' + id,
    url: 'https://www.threads.com/@other' + id + '/post/' + id,
    text: 'трейдинг: торговая стратегия и стоп-лосс ограничивают риск сделки ' + id,
    language: 'ru',
    category: 'трейдинг',
    publishedAt: new Date().toISOString(),
    timestampConfidence: 'EXACT',
    discoveredAt: new Date().toISOString(),
    repliesAvailable: true,
    status: 'NEW',
    extractionVersion: 'threads-body-v115',
    ...patch,
  });
  const finish = async (id: string) => {
    for (let i = 0; i < 45; i++) {
      const e = await q.experimentStep(id, content);
      if (['READY', 'STOPPED'].includes(e.status)) return e;
    }
    throw Error('loop');
  };
  return { ...f, calls, cfg, content, q, settings, candidate, finish };
}
it('одинаковые исходник, инструкции и примеры, нужные модели/effort, реальные usage, без смены production', async () => {
  const f = await fixtureAB();
  await f.q.saveHuman(
    {
      source: 'трейдинг: торговая стратегия',
      answer: 'ща стопы соберут',
      accountIds: [f.account.id],
    },
    '1',
  );
  const e = await f.q.createExperiment(f.account.id, '1', [f.candidate('one')], f.settings);
  await f.q.saveHuman(
    { source: 'другой рынок', answer: 'другой пример', accountIds: [f.account.id] },
    '1',
  );
  await f.finish(e.id);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].instructions).toBe(f.calls[1].instructions);
  expect(f.calls[0].input).toBe(f.calls[1].input);
  expect(f.calls.map((c) => [c.model, c.reasoning.effort]).sort()).toEqual([
    ['gpt-6.1-terra', 'none'],
    ['gpt-6.2-sol', 'low'],
  ]);
  expect(f.calls.every((c) => c.max_output_tokens === 1024)).toBe(true);
  expect(f.cfg.REPLY_MODEL).toBe('gpt-6.1-terra');
  const stats = await f.q.experimentStats(e.id);
  expect(stats.SOL.reasoningTokens).toBe(10);
  expect(stats.costUsd).toBeGreaterThan(0);
  expect(await f.db.list('publishJob')).toHaveLength(0);
  expect(await f.db.list('post')).toHaveLength(0);
});
it('выборка: только STRICT/48ч/чистый текст, уникальные URL и смысл, максимум два от автора', async () => {
  const f = await fixtureAB();
  const c = f.candidate('one');
  const rows = [
    c,
    c,
    { ...c, id: 'duplicate', url: 'https://www.threads.com/@other/post/different' },
    f.candidate('old', { publishedAt: '2024-01-01T00:00:00Z' }),
    f.candidate('unknown', { timestampConfidence: 'UNKNOWN' }),
    f.candidate('theme', { text: 'сегодня сходили за овощами на рынок и купили картошку' }),
    f.candidate('legacy', { extractionVersion: undefined }),
    f.candidate('rejected', { status: 'REJECTED' }),
    f.candidate('two', { author: c.author }),
    f.candidate('three', { author: c.author }),
  ];
  const e = await f.q.createExperiment(f.account.id, '1', rows, f.settings);
  expect(e.pairs).toHaveLength(2);
  expect(
    e.pairs.every(
      (p) => p.source.publishedAt && p.source.extractionVersion === 'threads-body-v115',
    ),
  ).toBe(true);
});
it('положение меняется между парами и сохраняется после перезапуска', async () => {
  const f = await fixtureAB(),
    e = await f.q.createExperiment(
      f.account.id,
      '1',
      [f.candidate('one'), f.candidate('two')],
      f.settings,
    );
  expect(e.pairs[0]!.order).not.toEqual(e.pairs[1]!.order);
  expect((await new GenerationQuality(f.db).experiment(e.id)).pairs.map((p) => p.order)).toEqual(
    e.pairs.map((p) => p.order),
  );
});
it('20 исходников означают максимум 40 запросов, повторный запуск не платный', async () => {
  const f = await fixtureAB(),
    e = await f.q.createExperiment(
      f.account.id,
      '1',
      Array.from({ length: 30 }, (_, i) => f.candidate('p' + i)),
      f.settings,
    );
  expect(e.pairs).toHaveLength(20);
  await f.finish(e.id);
  await f.finish(e.id);
  expect(f.calls).toHaveLength(40);
  expect((await getDocument<any>(f.db, 'llm-scope-' + e.id)).entries).toHaveLength(40);
});
it('предел бюджета проверяется до запроса и атомарный лимит не обходится конкурентными вызовами', async () => {
  const f = await fixtureAB();
  await expect(
    f.content.auxiliary(f.account.id, 'REPLY', 'трейдинг и стопы', 'короткий ответ', {
      scope: { id: 'tiny', label: 'one', limitUsd: 0.000001, maxRequests: 40 },
    }),
  ).rejects.toMatchObject({ code: 'AB_BUDGET' });
  expect(f.calls).toHaveLength(0);
  const results = await Promise.allSettled(
    ['one', 'two'].map((label) =>
      f.content.auxiliary(f.account.id, 'REPLY', 'трейдинг и стопы ' + label, 'короткий ответ', {
        scope: { id: 'one-call', label, limitUsd: 0.25, maxRequests: 1 },
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
});
it('INCOMPLETE сохраняет текст и расход, без автоматической перегенерации', async () => {
  const f = await fixtureAB('incomplete'),
    e = await f.q.createExperiment(f.account.id, '1', [f.candidate('one')], f.settings);
  const final = await f.finish(e.id);
  expect(f.calls).toHaveLength(2);
  expect(final.pairs[0]!.results.SOL).toMatchObject({
    status: 'FAILED',
    rawText: 'ну вот, опять стопы собирают',
  });
  expect((await f.q.experimentStats(e.id)).SOL.needsEditPercent).toBe(100);
});
it('UNKNOWN останавливает эксперимент и сохраняет запрет повтора', async () => {
  const f = await fixtureAB('unknown'),
    e = await f.q.createExperiment(f.account.id, '1', [f.candidate('one')], f.settings);
  const final = await f.finish(e.id);
  expect(final.status).toBe('STOPPED');
  await f.finish(e.id);
  expect(f.calls).toHaveLength(1);
});
it('восстановление RUNNING читает receipt/cache, не оплачивает второй ответ', async () => {
  const f = await fixtureAB(),
    e = await f.q.createExperiment(f.account.id, '1', [f.candidate('one')], f.settings);
  const first = await f.q.experimentStep(e.id, f.content),
    model = first.pairs[0]!.order[0]!;
  first.pairs[0]!.results[model]!.status = 'RUNNING';
  await putDocument(f.db, 'model-experiment-' + e.id, first);
  for (const row of await f.db.list('setting'))
    if (row.id.startsWith('aux-cache-')) await f.db.remove('setting', row.id);
  await new GenerationQuality(f.db).experimentStep(e.id, f.content);
  expect(f.calls).toHaveLength(1);
});
it('оценки/курсор сохраняются отдельно, двойной next не пропускает пару, публикаций нет', async () => {
  const f = await fixtureAB(),
    e = await f.q.createExperiment(
      f.account.id,
      '1',
      [f.candidate('one'), f.candidate('two')],
      f.settings,
    );
  await f.finish(e.id);
  await f.q.voteExperiment(e.id, 0, 'A', '1');
  await f.q.experimentNext(e.id, 0, '1');
  await f.q.experimentNext(e.id, 0, '1');
  const q = new GenerationQuality(f.db);
  expect(await q.experimentCursor(e.id, '1')).toBe(1);
  const stats = await q.experimentStats(e.id);
  expect(stats.rated).toBe(1);
  expect(stats.wins[e.pairs[0]!.order[0]!]).toBe(1);
  await expect(q.voteExperiment(e.id, 0, 'B', '999')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await f.db.list('publishJob')).toHaveLength(0);
});
it('настоящий обработчик Telegram скрывает модели в карточке и сохраняет голос без одобрения', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const beforeJobs = (await app.db.list('publishJob')).length;
    const a = (await app.db.list('account'))[0]!,
      f = await fixtureAB(),
      c = { ...f.candidate('one'), accountId: a.id };
    const e = await app.services.quality.createExperiment(a.id, '1', [c], f.settings);
    e.pairs[0]!.results = {
      SOL: {
        status: 'VALID',
        text: 'ну вот, опять стопы собирают',
        errors: [],
        model: 'gpt-6.2-sol',
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        costUsd: 0.001,
        elapsedMs: 1,
        startedAt: new Date().toISOString(),
      },
      TERRA: {
        status: 'VALID',
        text: 'ща рынок проверит терпение',
        errors: [],
        model: 'gpt-6.1-terra',
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        costUsd: 0.001,
        elapsedMs: 1,
        startedAt: new Date().toISOString(),
      },
    };
    e.status = 'READY';
    await putDocument(app.db, 'model-experiment-' + e.id, e);
    const send = async (callback: string) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload: { callback },
        })
      ).json();
    const card = JSON.stringify(await send('v115abopen:' + e.id));
    expect(card).toContain('Лучше A');
    expect(card).toContain('Лучше B');
    expect(card).not.toContain('gpt-6.');
    expect(card).not.toContain('v112send');
    await send(`v115abvote:${e.id}:0:A`);
    expect((await app.services.quality.experimentStats(e.id)).rated).toBe(1);
    expect(await app.db.list('publishJob')).toHaveLength(beforeJobs);
    expect(await app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    await app.close();
  }
});
