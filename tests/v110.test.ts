import { it, expect, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { createBot } from '../src/bot/bot.js';
import { deliverGenerations } from '../src/bot/generation.js';
import { MemoryDatabase, base } from '../src/db/database.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { fixture, testConfig } from './helpers.js';
import { ContentEngine } from '../src/content/service.js';
import { GenerationQueue } from '../src/content/jobs.js';
import { EngagementManager, type EngagementPort } from '../src/engagement/service.js';
import { EngagementQueue } from '../src/engagement/queue.js';

async function appFixture() {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  const account = (await app.db.list('account'))[0]!;
  await app.db.update('account', account.id, { status: 'PAUSED' });
  await app.services.scheduler.pause(true, 'test');
  const send = async (payload: object) =>
    (
      await app.server!.inject({
        method: 'POST',
        url: '/api/demo/telegram',
        headers: { authorization: 'Bearer demo-local-token' },
        payload,
      })
    ).json();
  await send({ callback: 'create' });
  const accounts = await send({ callback: 'publication:ACCOUNT_SPECIFIC' });
  expect(JSON.stringify(accounts)).toContain(`assign:${account.id}`);
  await send({ callback: `assign:${account.id}` });
  return { app, account, send };
}
it.each([
  'короткий русский исходник',
  'первая строка\n\nвторая строка\nтретья строка',
  'длинный русский исходник о контроле риска и торговом плане. '.repeat(60),
])('сохраняет русский исходник и подтверждает получение: %s', async (text) => {
  const f = await appFixture();
  try {
    const result = await f.send({ text });
    expect(JSON.stringify(result)).toContain(`Исходник сохранён для ${f.account.name}`);
    const flow = (await getDocument<any>(f.app.db, 'flow-1'))!;
    expect((await f.app.db.get('source', flow.assignments[f.account.id]))?.text).toBe(text.trim());
    expect(await f.app.db.list('aiRequest')).toHaveLength(0);
    expect(JSON.stringify(result)).toContain('source_prepare:');
    await f.send({ text: '/start' });
    expect((await getDocument<any>(f.app.db, 'flow-1')).assignments).toEqual(flow.assignments);
  } finally {
    await f.app.close();
  }
});
it('восстанавливает два FSM после рестарта и не передаёт текст старому модулю', async () => {
  const f = await appFixture();
  try {
    await putDocument(f.app.db, 'v18-flow-1', { accountId: f.account.id, step: 'candidate' });
    await f.send({ callback: `assign:${f.account.id}` });
    // New Bot instance over the same durable database; no timers or real API.
    const restarted = createBot(
      { ...testConfig(), TELEGRAM_BOT_TOKEN: '123456:DEMO' },
      f.app.services,
    );
    restarted.api.config.use(
      async (_prev, method, payload) =>
        ({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 123456, is_bot: true, first_name: 'test', username: 'test_bot' }
              : {
                  message_id: 1,
                  date: 1,
                  chat: { id: 1, type: 'private', first_name: 'test' },
                  text: (payload as any).text,
                },
        }) as any,
    );
    await restarted.init();
    await restarted.handleUpdate({
      update_id: 1101,
      message: {
        message_id: 1101,
        date: 1,
        from: { id: 1, is_bot: false, first_name: 'test' },
        chat: { id: 1, type: 'private', first_name: 'test' },
        text: 'сохранить после перезапуска',
      },
    });
    const state = (await getDocument<any>(f.app.db, 'flow-1'))!;
    expect((await f.app.db.get('source', state.assignments[f.account.id]))?.text).toBe(
      'сохранить после перезапуска',
    );
  } finally {
    await f.app.close();
  }
});
it('лимит исходника показывает 20 000, update не игнорируется', async () => {
  const f = await appFixture();
  try {
    expect(JSON.stringify(await f.send({ text: 'я'.repeat(20001) }))).toContain('20 000');
    expect(await f.app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
it('генерация фоновая, /ping отвечает, ошибка LLM доставляется без повтора', async () => {
  const f = await appFixture();
  try {
    await f.send({ text: 'русский исходник о риске' });
    await f.send({ callback: `source_prepare:${f.account.id}` });
    expect((await f.app.services.generation.list())[0]?.status).toBe('QUEUED');
    const prepare = vi
      .spyOn(f.app.services.content, 'prepare')
      .mockRejectedValue(new Error('sensitive data'));
    expect(JSON.stringify(await f.send({ text: '/ping' }))).toContain('pong');
    await f.app.services.generation.tick();
    await f.app.services.generation.tick();
    expect(prepare).toHaveBeenCalledTimes(1);
    const sent: any[] = [];
    f.app.bot!.api.config.use(async (prev, method, payload, signal) => {
      sent.push({ method, payload });
      return prev(method, payload, signal);
    });
    await deliverGenerations(f.app.bot!, f.app.services);
    expect(JSON.stringify(sent)).toContain('Исходник сохранён');
    expect(JSON.stringify(sent)).not.toContain('sensitive data');
  } finally {
    await f.app.close();
  }
});
it('успешный предпросмотр не одобряет и не публикует, два клика не дублируют задачу', async () => {
  const f = await appFixture();
  try {
    const jobsBefore = (await f.app.db.list('publishJob')).length;
    const postsBefore = (await f.app.db.list('post')).length;
    await f.send({ text: 'план торговли помогает ограничить риск' });
    await f.send({ callback: `source_prepare:${f.account.id}` });
    await f.send({ callback: `source_prepare:${f.account.id}` });
    expect(await f.app.services.generation.list()).toHaveLength(1);
    await f.app.services.generation.tick();
    const task = (await f.app.services.generation.list())[0]!;
    expect(task.status).toBe('COMPLETED');
    const generated = (await f.app.db.get('generated', task.results![0]!))!;
    const flow = (await getDocument<any>(f.app.db, 'flow-1'))!;
    await putDocument(f.app.db, 'flow-1', { ...flow, draftIds: [generated.id] });
    await f.send({ callback: 'approve' });
    expect(await f.app.db.list('publishJob')).toHaveLength(jobsBefore);
    await f.send({ callback: `post_ok:${generated.id}` });
    expect(await f.app.db.list('publishJob')).toHaveLength(jobsBefore);
    expect(JSON.stringify(await f.send({ callback: `post_send:${generated.id}` }))).toContain(
      'Ручные публикации: выключены',
    );
    expect(await f.app.db.list('post')).toHaveLength(postsBefore);
  } finally {
    await f.app.close();
  }
});
it('удаление исходника отменяет ещё не начатую генерацию без LLM', async () => {
  const f = await appFixture();
  try {
    await f.send({ text: 'исходник для отменённой подготовки' });
    const flow = (await getDocument<any>(f.app.db, 'flow-1'))!;
    await f.send({ callback: `source_prepare:${f.account.id}` });
    await f.send({ callback: `source_delete:${f.account.id}` });
    await f.app.services.generation.tick();
    expect((await f.app.services.generation.list())[0]?.status).toBe('FAILED');
    expect(await f.app.db.get('source', flow.assignments[f.account.id])).toBeNull();
    expect(await f.app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
async function engagementFixture() {
  const f = await fixture();
  let searches = 0,
    sends = 0;
  const content = new ContentEngine(f.db, testConfig(), {
    generate: async () => ({
      text: 'разумно заранее определить допустимый риск',
      inputTokens: 10,
      outputTokens: 10,
    }),
  });
  const port: EngagementPort = {
    search: async () => {
      searches++;
      return [
        {
          url: 'https://www.threads.com/@other/post/read',
          author: 'other',
          text: 'трейдинг требует заранее ограничить риск сделки',
          language: 'ru',
          category: 'трейдинг',
          discoveredAt: new Date().toISOString(),
          publishedAt: new Date(Date.now() - 3600000).toISOString(),
          timestampConfidence: 'EXACT' as const,
          repliesAvailable: true,
        },
      ];
    },
    reply: async (_j, _d, _c, commit) => {
      if (commit) sends++;
      return { url: null };
    },
    like: async (_j, _c, commit) => {
      if (commit) sends++;
    },
  };
  const manager = new EngagementManager(f.db, port, content);
  await manager.configure(f.account.id, { enabled: true }, 'test');
  return { ...f, manager, content, port, counts: () => ({ searches, sends }) };
}
it('PAUSED и DRY_RUN допускают ручной read-only поиск, генерацию и предпросмотр', async () => {
  const f = await engagementFixture();
  await f.db.insert('setting', { ...base('factoryPaused'), value: 'true' });
  await f.db.update('account', f.account.id, { status: 'PAUSED' });
  const r = await f.manager.search(f.account.id, 'test', { manual: true });
  expect(r).toMatchObject({ found: 1, added: 1, eligible: 1 });
  const next = (await f.manager.schedule(f.account.id)).nextSearchAt;
  expect(Date.parse(next!)).toBeGreaterThan(Date.now());
  const recovered = new EngagementQueue(f.manager, false);
  await recovered.recover();
  expect((await f.manager.schedule(f.account.id)).nextSearchAt).toBe(next);
  await recovered.tick();
  expect(f.counts().searches).toBe(1);
  const c = (await f.manager.candidates(f.account.id))[0]!;
  const d = await f.manager.generate(f.account.id, c.id, 'test');
  const j = await f.manager.approve(f.account.id, d.id, d.hash, 'test');
  await recovered.execute(j.id, true);
  expect(f.counts().sends).toBe(0);
  expect((await f.manager.diagnostics(f.account.id)).factoryPaused).toBe(true);
});
it('восстанавливает QUEUED, прерванную генерацию не повторяет за деньги', async () => {
  const f = await engagementFixture(),
    queue = new GenerationQueue(f.db, f.content, f.manager);
  const t = await queue.enqueue({
    actor: 'test',
    chatId: 1,
    kind: 'POST',
    preparation: {
      mode: 'ACCOUNT_SPECIFIC',
      mappings: [{ accountId: f.account.id, sourceId: f.source.id }],
    },
  });
  const second = new GenerationQueue(f.db, f.content, f.manager);
  await second.recover();
  expect((await second.list())[0]?.status).toBe('QUEUED');
  await putDocument(f.db, `generation-task-${t.id}`, { ...t, status: 'RUNNING' });
  await second.recover();
  await second.tick();
  expect((await second.list())[0]?.status).toBe('NEEDS_REVIEW');
  expect(await f.db.list('aiRequest')).toHaveLength(0);
});
it('не догоняет все пропущенные поиски и не расходует слот при ошибке браузера', async () => {
  const f = await engagementFixture();
  await putDocument(f.db, `engagement-schedule-${f.account.id}`, {
    nextSearchAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  });
  const queue = new EngagementQueue(f.manager, false);
  await queue.tick();
  await queue.tick();
  expect(f.counts().searches).toBe(1);
  f.port.search = async () => {
    throw new Error('browser failed');
  };
  await expect(f.manager.search(f.account.id, 'test', { manual: true })).rejects.toThrow();
  expect(
    (
      await getDocument<any>(
        f.db,
        `engagement-search-${f.account.id}-${new Date().toISOString().slice(0, 10)}`,
      )
    ).times,
  ).toHaveLength(1);
  expect((await f.manager.schedule(f.account.id)).lastErrorCode).toBe('SEARCH_FAILED');
});
