import { it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { ContentEngine } from '../src/content/service.js';
import { EngagementManager } from '../src/engagement/service.js';
import { GenerationQueue } from '../src/content/jobs.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { deliverGenerations } from '../src/bot/generation.js';
async function setup(production = false) {
  const f = await fixture();
  let calls = 0;
  const content = new ContentEngine(
    f.db,
    {
      ...testConfig(),
      ...(production ? { APP_MODE: 'production' as const, LLM_API_KEY: 'fixture-only' } : {}),
    },
    {
      generate: async () => {
        calls++;
        return { text: 'ща рынок проверит терпение', inputTokens: 20, outputTokens: 10 };
      },
    },
  );
  const manager = new EngagementManager(
    f.db,
    { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
    content,
  );
  const queue = new GenerationQueue(f.db, content, manager);
  const add = async (id: string, patch: object = {}) =>
    putDocument(f.db, `engagement-candidate-${f.account.id}-${id}`, {
      id,
      accountId: f.account.id,
      author: 'other',
      url: `https://www.threads.com/@other/post/${id}`,
      text: 'трейдинг и торговая стратегия: какой риск на сделку?',
      publishedAt: new Date().toISOString(),
      timestampConfidence: 'EXACT',
      repliesAvailable: true,
      status: 'NEW',
      ...patch,
    });
  return { ...f, content, manager, queue, add, calls: () => calls };
}
it('три задачи при паузе, повторный batch не создаёт повторов, затем честный ноль с черновиками', async () => {
  const f = await setup();
  for (let i = 0; i < 3; i++) await f.add('p' + i);
  await putDocument(f.db, 'factoryPaused', true);
  const first = await f.queue.replySelection(f.account.id, '1', 1);
  expect(first.counts).toMatchObject({ found: 3, eligible: 3, created: 3 });
  const again = await f.queue.replySelection(f.account.id, '1', 1);
  expect(again.counts).toMatchObject({ created: 0, processing: 3 });
  for (let i = 0; i < 3; i++) await f.queue.tick();
  expect(f.calls()).toBe(1); // Same exact source uses the existing account cache.
  expect((await f.queue.list()).every((t) => ['COMPLETED', 'NEEDS_EDIT'].includes(t.status))).toBe(
    true,
  );
  expect((await f.queue.replySelection(f.account.id, '1', 1)).counts).toMatchObject({
    created: 0,
    alreadyDrafted: 3,
    processing: 0,
  });
  expect(await f.db.list('publishJob')).toHaveLength(0);
});
it('свежесть, тематика, пропуск и исчерпанный бюджет отражаются раздельно', async () => {
  const f = await setup(true);
  await f.add('old', { publishedAt: '2024-11-23T11:21:29Z' });
  await f.add('topic', { text: 'сегодня ходили на рынок за овощами' });
  await f.add('skip', { status: 'REJECTED' });
  await f.add('valid');
  await putDocument(f.db, `llm-budget-${f.account.id}-REPLY`, { dailyUsd: 0, monthlyUsd: 0 });
  expect((await f.queue.replySelection(f.account.id, '1', 1)).counts).toMatchObject({
    found: 4,
    freshness: 1,
    thematic: 1,
    skipped: 1,
    blocked: 1,
    created: 0,
  });
  expect(f.calls()).toBe(0);
});
it('повторный клик показывает готовый ответ и не зависит от устаревшего FSM', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!;
    const send = async (payload: object) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload,
        })
      ).json();
    await putDocument(app.db, `engagement-candidate-${a.id}-bound`, {
      id: 'bound',
      accountId: a.id,
      author: 'other',
      url: 'https://www.threads.com/@other/post/bound',
      text: 'трейдинг требует торговой стратегии и стопа',
      publishedAt: new Date().toISOString(),
      timestampConfidence: 'EXACT',
      repliesAvailable: true,
      status: 'NEW',
    });
    await putDocument(app.db, 'v18-flow-1', {
      accountId: a.id,
      candidateId: 'WRONG',
      step: 'candidate',
    });
    const first = JSON.stringify(await send({ callback: 'v18generate:bound' }));
    expect(first).toContain('QUEUED');
    expect(first).toContain('Проверить статус');
    await app.services.generation.tick();
    const before = (await app.db.list('aiRequest')).length;
    const second = JSON.stringify(await send({ callback: 'v18generate:bound' }));
    expect(second).toContain('Готовый сохранённый ответ');
    expect(await app.db.list('aiRequest')).toHaveLength(before);
    expect(await app.services.generation.list()).toHaveLength(1);
    const zero = JSON.stringify(await send({ callback: `v18batch:${a.id}` }));
    expect(zero).toContain('Новых задач создано: 0');
    expect(zero).not.toContain('Генерирую');
    expect(JSON.stringify(await send({ callback: 'v18generate' }))).toContain('Старая кнопка');
  } finally {
    await app.close();
  }
});
it('отказ доставки одной задачи не блокирует остальные, повтор после рестарта без генерации', async () => {
  const f = await setup();
  await f.add('one');
  await f.add('two');
  const t1 = await f.queue.enqueue({
    kind: 'REPLY',
    accountId: f.account.id,
    candidateId: 'one',
    actor: '1',
    chatId: 1,
  });
  await f.queue.enqueue({
    kind: 'REPLY',
    accountId: f.account.id,
    candidateId: 'two',
    actor: '1',
    chatId: 1,
  });
  await f.queue.tick();
  await f.queue.tick();
  let delivered = 0;
  await f.queue.deliver(async (t) => {
    if (t.id === t1.id) throw { error_code: 400 };
    delivered++;
  });
  expect(delivered).toBe(1);
  const failed = (await f.queue.list()).find((t) => t.id === t1.id)!;
  expect(failed.deliveryAttempts).toBe(1);
  expect(failed.deliveredAt).toBeUndefined();
  await putDocument(f.db, `generation-task-${failed.id}`, {
    ...failed,
    deliveryRetryAt: new Date(0).toISOString(),
  });
  const restarted = new GenerationQueue(f.db, f.content, f.manager);
  const before = f.calls();
  await restarted.deliver(async () => {
    delivered++;
  });
  expect(delivered).toBe(2);
  expect(f.calls()).toBe(before);
});
it('recover восстанавливает уже оплаченный ответ из receipt/cache без платного повтора', async () => {
  const f = await setup();
  await f.add('recover');
  const task = await f.queue.enqueue({
    kind: 'REPLY',
    accountId: f.account.id,
    candidateId: 'recover',
    actor: '1',
    chatId: 1,
  });
  await f.queue.tick();
  const done = (await f.queue.list())[0]!;
  const draft = await f.manager.draft(f.account.id, done.results![0]!);
  await f.db.remove('setting', `engagement-draft-${f.account.id}-${draft.id}`);
  await putDocument(f.db, `engagement-candidate-${f.account.id}-recover`, {
    ...(await f.manager.candidate(f.account.id, 'recover')),
    status: 'NEW',
  });
  const cache = (await f.db.list('setting')).find((s) => s.id.startsWith('aux-cache-'))!;
  await f.db.remove('setting', cache.id);
  await putDocument(f.db, `generation-task-${task.id}`, { ...task, status: 'RUNNING' });
  await new GenerationQueue(f.db, f.content, f.manager).recover();
  expect((await f.queue.list())[0]!.status).toBe('COMPLETED');
  expect(f.calls()).toBe(1);
});
it('UNKNOWN сохраняется и не вызывает второй запрос', async () => {
  const f = await setup();
  await f.add('uncertain');
  const task = await f.queue.enqueue({
    kind: 'REPLY',
    accountId: f.account.id,
    candidateId: 'uncertain',
    actor: '1',
    chatId: 1,
  });
  await f.queue.tick();
  const done = (await f.queue.list())[0]!;
  await f.db.remove('setting', `engagement-draft-${f.account.id}-${done.results![0]}`);
  for (const row of await f.db.list('setting'))
    if (row.id.startsWith('aux-cache-')) await f.db.remove('setting', row.id);
  const request = (await f.db.list('aiRequest'))[0]!;
  await f.db.update('aiRequest', request.id, { status: 'UNKNOWN' });
  await putDocument(f.db, `generation-task-${task.id}`, { ...task, status: 'RUNNING' });
  await new GenerationQueue(f.db, f.content, f.manager).recover();
  expect((await f.queue.list())[0]!.status).toBe('UNKNOWN');
  expect(f.calls()).toBe(1);
});
it('NEEDS_EDIT доставляется с причинами и не создаёт публикацию', async () => {
  const f = await setup();
  await f.add('bad');
  const c = new ContentEngine(f.db, testConfig(), {
    generate: async () => ({ text: 'я заработал 99%', inputTokens: 20, outputTokens: 5 }),
  });
  const m = new EngagementManager(
      f.db,
      { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
      c,
    ),
    q = new GenerationQueue(f.db, c, m);
  await q.enqueue({
    kind: 'REPLY',
    accountId: f.account.id,
    candidateId: 'bad',
    actor: '1',
    chatId: 1,
  });
  await q.tick();
  expect((await q.list())[0]!.status).toBe('NEEDS_EDIT');
  expect(await f.db.list('publishJob')).toHaveLength(0);
});
it('перегенерация legacy сама перечитывает именно исходник в READ_ONLY перед LLM', async () => {
  const f = await setup();
  await f.add('legacy', { text: 'other\n1 Std.\nтрейдинг и торговая стратегия\nÜbersetzen\n30' });
  let reads = 0;
  f.manager.port.readPost = async (_a, url) => {
    reads++;
    expect(url).toContain('/legacy');
    return { text: 'трейдинг и торговая стратегия', extractionVersion: 'threads-body-v115' };
  };
  await f.manager.generate(f.account.id, 'legacy', '1', { force: true, nonce: 'one' });
  expect(reads).toBe(1);
  expect(f.calls()).toBe(1);
  expect((await f.manager.candidate(f.account.id, 'legacy')).text).not.toContain('Übersetzen');
  expect(await getDocument(f.db, 'source-extraction-before-legacy')).toBeTruthy();
});
it('двойное нажатие перегенерации объединяется, отказ чтения не тратит LLM', async () => {
  const f = await setup();
  await f.add('legacy', { text: 'other\n1 Std.\nтрейдинг и торговая стратегия\nÜbersetzen\n30' });
  f.manager.port.readPost = async () => {
    throw Error('unavailable');
  };
  const input = {
    kind: 'REPLY' as const,
    accountId: f.account.id,
    candidateId: 'legacy',
    actor: '1',
    chatId: 1,
    force: true,
  };
  const first = await f.queue.enqueue(input, 'first'),
    second = await f.queue.enqueue(input, 'second');
  expect(second.id).toBe(first.id);
  await f.queue.tick();
  expect(f.calls()).toBe(0);
  expect((await f.queue.list())[0]!.status).toBe('FAILED');
});
