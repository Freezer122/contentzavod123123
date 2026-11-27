import { it, expect } from 'vitest';
import { fixture, testConfig, fastClock } from './helpers.js';
import { ManualPolicy } from '../src/policy/manual.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { ContentEngine, validateDetailed } from '../src/content/service.js';
import { EngagementManager, type EngagementPort } from '../src/engagement/service.js';
import { EngagementQueue } from '../src/engagement/queue.js';
import { tradingRelevance } from '../src/engagement/relevance.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { GenerationQuality } from '../src/content/quality.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { postCard, replyCard } from '../src/bot/manual-card.js';
async function setup() {
  const f = await fixture(),
    policy = new ManualPolicy(f.db, ['1'], '1', true);
  await policy.migrate();
  await putDocument(f.db, 'factoryPaused', true);
  await policy.setEnabled(f.account.id, '1', true);
  let sends = 0,
    calls = 0;
  const content = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      calls++;
      return { text: 'риск проще соблюдать по плану', inputTokens: 20, outputTokens: 10 };
    },
  });
  const port: EngagementPort = {
    search: async () => [],
    reply: async (_j, _d, _c, commit, before) => {
      if (commit) {
        await before();
        sends++;
        return { url: 'https://www.threads.com/@test_account/post/manual' };
      }
      return { url: null };
    },
    like: async () => {
      throw Error('no likes');
    },
  };
  const manager = new EngagementManager(f.db, port, content),
    queue = new EngagementQueue(manager, false, undefined, policy);
  await manager.configure(f.account.id, { enabled: true }, '1');
  const candidate = async (
    id: string,
    text = 'моя торговая стратегия в трейдинге: сначала план, потом вход',
  ) => {
    const c = {
      id,
      accountId: f.account.id,
      url: `https://www.threads.com/@other/post/${id}`,
      author: 'other',
      text,
      language: 'ru',
      category: 'трейдинг',
      repliesAvailable: true,
      discoveredAt: new Date().toISOString(),
      publishedAt: new Date(Date.now() - 3600000).toISOString(),
      timestampConfidence: 'EXACT' as const,
      status: 'NEW' as const,
    };
    await putDocument(f.db, `engagement-candidate-${f.account.id}-${id}`, c);
    return c;
  };
  const c = await candidate('one'),
    d = await manager.edit(f.account.id, c.id, 'без плана даже хороший вход не спасает', '1');
  const card = await policy.card({
    kind: 'REPLY',
    entityId: d.id,
    accountId: d.accountId,
    hash: d.hash,
    version: d.version ?? 1,
    sourceUrl: c.url,
    actor: '1',
  });
  const grant = async () => {
    const job = await manager.approve(d.accountId, d.id, d.hash, '1');
    return queue.permissions.issueManual(
      card.id,
      '1',
      job,
      await manager.draft(d.accountId, d.id),
      c,
    );
  };
  return {
    ...f,
    policy,
    content,
    manager,
    queue,
    c,
    d,
    card,
    grant,
    port,
    candidate,
    counts: () => ({ sends, calls }),
  };
}
it('MANUAL_LIVE сохраняется после рестарта, независим от PAUSED и автоматического DRY_RUN', async () => {
  const f = await setup();
  expect((await new ManualPolicy(f.db).settings(f.account.id)).manualLiveEnabled).toBe(true);
  expect(await getDocument(f.db, 'automationPaused')).toBe(true);
  expect(await getDocument(f.db, 'factoryPaused')).toBe(true);
});
it('ручное разрешение не требует переменных на job; один submit и сохранённый permalink', async () => {
  const f = await setup(),
    p = await f.grant();
  await f.queue.publishSelected(p.id, '1');
  await f.queue.publishSelected(p.id, '1');
  expect(f.counts().sends).toBe(1);
  expect((await f.manager.jobView(p.jobId)).job.url).toContain('/post/manual');
  expect((await f.queue.permissions.get(p.id)).state).toBe('CONSUMED');
});
it('разрешение для выбранного ответа оставляет старый backlog неподвижным', async () => {
  const f = await setup(),
    c = await f.candidate('backlog'),
    d = await f.manager.edit(f.account.id, c.id, 'свой риск лучше записать до сделки', '1'),
    j = await f.manager.approve(d.accountId, d.id, d.hash, '1'),
    p = await f.grant();
  await f.queue.publishSelected(p.id, '1');
  await f.queue.tick();
  expect((await f.manager.jobView(j.id)).executionStatus).toBe('WAITING');
  expect(f.counts().sends).toBe(1);
});
it('emergencyStop проверяется непосредственно перед submit', async () => {
  const f = await setup(),
    p = await f.grant();
  f.port.reply = async (_j, _d, _c, commit, before) => {
    await putDocument(f.db, 'emergencyStop', true);
    if (commit) await before();
    return { url: null };
  };
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toMatchObject({
    code: 'EMERGENCY_STOP',
  });
  expect(f.counts().sends).toBe(0);
  expect((await f.queue.permissions.get(p.id)).state).toBe('CONFIRMED');
});
it('отзыв и повторное включение политики не оживляют старые разрешения', async () => {
  const f = await setup(),
    p = await f.grant();
  await f.policy.setEnabled(f.account.id, '1', false);
  await f.policy.setEnabled(f.account.id, '1', true);
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toMatchObject({
    code: 'MANUAL_DISABLED',
  });
  expect(f.counts().sends).toBe(0);
});
it('чужой владелец, просроченная сессия и отмена блокируют отправку', async () => {
  const f = await setup();
  await expect(f.policy.setEnabled(f.account.id, '2', true)).rejects.toThrow();
  await expect(f.policy.readCard(f.card.id, '2')).rejects.toThrow();
  await f.policy.cancel(f.card.id, '1');
  await expect(f.grant()).rejects.toMatchObject({ code: 'STALE_CARD' });
  expect(f.counts().sends).toBe(0);
});
it('истечение сессии блокирует выдачу разрешения', async () => {
  const f = await setup();
  await putDocument(f.db, 'manual-session-1', {
    id: f.card.sessionId,
    expiresAt: new Date(0).toISOString(),
  });
  await expect(f.grant()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
});
it('редактирование аннулирует старую версию и её карточку', async () => {
  const f = await setup(),
    p = await f.grant();
  await f.manager.edit(f.d.accountId, f.c.id, 'план лучше составлять до входа', '1', f.d.id);
  await f.queue.publishSelected(p.id, '1');
  expect(f.counts().sends).toBe(0);
  expect((await f.manager.jobView(p.jobId)).executionStatus).toBe('FAILED');
});
it('UNCERTAIN исключает повторный submit даже после перезапуска', async () => {
  const f = await setup(),
    p = await f.grant();
  let clicked = 0;
  f.port.reply = async (_j, _d, _c, _commit, before) => {
    await before();
    clicked++;
    throw Error('disconnect');
  };
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toThrow();
  await f.queue.recover();
  await f.queue.publishSelected(p.id, '1');
  expect(clicked).toBe(1);
  expect((await f.manager.jobView(p.jobId)).executionStatus).toBe('UNCERTAIN');
});
it('3 слова, три слова и в трёх словах эквивалентны', async () => {
  const f = await fixture(),
    style = (await f.db.get('style', 'style-1'))!;
  for (const text of [
    'опиши стратегию: три слова',
    'опиши стратегию в трёх словах',
    'можешь описать свою торговую стратегию в трёх словах? три - потолок. не укладываешься - ты пока любитель',
  ])
    expect(
      validateDetailed(text, 'попробуй описать свою торговую стратегию. максимум 3 слова', style)
        .status,
    ).toBe('PASS');
});
it('2%→20%, BTC→ETH, дата и регистрозависимый ID блокируются с конкретной разницей', async () => {
  const f = await fixture(),
    s = (await f.db.get('style', 'style-1'))!;
  for (const [a, b] of [
    ['риск 2%', 'риск 20%'],
    ['покупаю BTC', 'покупаю ETH'],
    ['дата 01.12.2026', 'дата 02.12.2026'],
    ['ключ API_Key', 'ключ api_key'],
  ]) {
    const r = validateDetailed(b!, a!, s);
    expect(r.status).toBe('BLOCKED');
    expect(r.issues[0]!.source).not.toBe(r.issues[0]!.generated);
  }
});
it('WARNING остаётся доступным, ручная правка и GOOD не вызывают LLM и не отклоняют текст', async () => {
  const f = await fixture();
  await f.db.update('source', f.source.id, { text: 'у меня 3 слова' });
  const engine = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      throw Error('no paid call');
    },
  });
  const edited = await engine.edit(f.generated.id, 'у меня четыре слова', '1');
  expect(edited.valid).toBe(true);
  expect(edited.validationErrors?.join()).toContain('WARNING');
  await new GenerationQuality(f.db).rate(edited.id, 'GOOD', '1');
  expect((await f.db.get('generated', edited.id))?.approved).toBe(false);
  expect(await getDocument(f.db, `rejected-${edited.id}`)).toBeNull();
  expect(await f.db.list('aiRequest')).toHaveLength(0);
});
it.each([
  ['водители должны соблюдать правила дорожного движения и учитывать риск', false],
  ['продаю квартиру, рынок недвижимости растёт, звоните', false],
  ['моя торговая стратегия: сначала план, потом вход', true],
  ['торгую BTC, выставил стоп-лосс до входа', true],
  ['рынок меняется, риск есть везде и деньги решают всё', false],
  ['котировки акций строительных компаний растут на бирже', true],
  ['акция на одежду, скидки и доставка по городу', false],
  ['покупаю акции строительных компаний, сравниваю котировки и брокеров', true],
])('строгая фильтрация: %s', (text, pass) => {
  expect(tradingRelevance(text).accepted).toBe(pass);
});
it('кандидат ниже порога не передаётся Terra', async () => {
  const f = await setup(),
    c = await f.candidate('bad', 'рынок недвижимости: продажа квартиры, деньги и риск');
  await expect(f.manager.generate(c.accountId, c.id, '1')).rejects.toMatchObject({
    code: 'IRRELEVANT_CANDIDATE',
  });
  expect(f.counts().calls).toBe(0);
});
it('дедупликация URL работает между сессиями, отказы сохраняются с причинами', async () => {
  const f = await setup();
  f.port.search = async () => [
    { ...f.c, category: 'трейдинг' },
    {
      ...f.c,
      url: 'https://www.threads.com/@other/post/bad',
      text: 'водители и риск на дороге, правила дорожного движения',
    },
  ];
  await f.manager.search(f.account.id, '1', { manual: true });
  await f.manager.search(f.account.id, '1', { manual: true });
  expect(await f.manager.candidates(f.account.id)).toHaveLength(2);
  expect(
    (await f.manager.candidates(f.account.id)).find((c) => c.status === 'REJECTED')
      ?.rejectionReasons?.length,
  ).toBeGreaterThan(0);
});
it('собственный ручной пост исполняется под автоматическим DRY_RUN, backlog остаётся', async () => {
  const f = await setup(),
    cta = await new (await import('../src/cta/service.js')).CtaService(f.db).ensure(f.account.id);
  const card = await f.policy.card({
    kind: 'POST',
    entityId: f.generated.id,
    accountId: f.account.id,
    hash: hashDocument(f.generated.text),
    version: f.generated.version,
    sourceUrl: hashDocument({
      text: cta.text,
      url: cta.url,
      enabled: cta.enabled,
      media: cta.mediaSha256,
    }),
    actor: '1',
  });
  const job = (await f.scheduler.publishManual(card.id, '1', f.policy))!;
  const same = await f.scheduler.publishManual(card.id, '1', f.policy);
  expect(same?.id).toBe(job.id);
  const worker = new PublishingWorker(
    f.db,
    f.providers,
    f.publisher,
    undefined,
    1,
    fastClock(),
    false,
    f.policy,
  );
  await worker.execute(job.id);
  await worker.execute(job.id);
  expect(await f.db.list('post')).toHaveLength(1);
  expect((await f.db.get('publishJob', job.id))?.postStatus).toBe('PUBLISHED');
  expect(await getDocument(f.db, 'factoryPaused')).toBe(true);
});
it('Telegram включает ручной режим один раз, кнопка выбранного ответа сразу создаёт отправку, save не отправляет', async () => {
  const cfg = { ...testConfig(), MANUAL_LIVE_ALLOWED: '1' as const },
    app = await createApplication(cfg, new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!;
    const send = async (callback: string) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload: { callback },
        })
      ).json();
    const result = await send(`v112enable:${a.id}`),
      m = result.messages.find((m: any) => m.method === 'sendMessage');
    const confirm = m.reply_markup.inline_keyboard
      .flat()
      .find((b: any) => b.text === 'Разрешить').callback_data;
    await send(confirm);
    expect((await app.services.manual.settings(a.id)).manualLiveEnabled).toBe(true);
    await app.services.engagement.configure(a.id, { enabled: true }, '1');
    await putDocument(app.db, `engagement-candidate-${a.id}-ui`, {
      id: 'ui',
      accountId: a.id,
      url: 'https://www.threads.com/@other/post/ui',
      author: 'other',
      text: 'торговая стратегия: сначала план, потом вход',
      repliesAvailable: true,
      status: 'NEW',
    });
    const d = await app.services.engagement.edit(
      a.id,
      'ui',
      'без плана даже хороший вход не спасает',
      '1',
    );
    const card = await replyCard(app.services, d, '1');
    const buttons = card.reply_markup.inline_keyboard.flat() as {
      text: string;
      callback_data: string;
    }[];
    await send(buttons.find((b) => 'text' in b && b.text === 'Сохранить на потом')!.callback_data!);
    expect(await app.services.generation.list()).toHaveLength(0);
    await send(buttons.find((b) => 'text' in b && b.text === 'Опубликовать')!.callback_data!);
    expect(
      (await app.services.generation.list()).filter((t) => t.kind === 'REPLY_SEND'),
    ).toHaveLength(1);
    expect((await app.services.manual.settings(a.id)).automaticEnabled).toBe(false);
  } finally {
    await app.close();
  }
});
it('снятие паузы не активирует старую автоматическую очередь V1.12', async () => {
  const f = await setup();
  const [job] = await f.scheduler.createBatch([f.generated.id], '1');
  await putDocument(f.db, 'factoryPaused', false);
  await putDocument(f.db, 'automationPaused', false);
  const worker = new PublishingWorker(
    f.db,
    f.providers,
    f.publisher,
    undefined,
    1,
    fastClock(),
    true,
    f.policy,
  );
  await worker.execute(job!.id);
  expect((await f.db.get('publishJob', job!.id))?.status).toBe('QUEUED');
  expect(await f.db.list('post')).toHaveLength(0);
});
it('кнопка GOOD сохраняет одобрение и не мешает выбранной публикации', async () => {
  const f = await setup();
  await f.db.update('generated', f.generated.id, { approved: true });
  await new GenerationQuality(f.db).rate(f.generated.id, 'GOOD', '1');
  expect((await f.db.get('generated', f.generated.id))?.approved).toBe(true);
  const p = await f.grant();
  await f.queue.publishSelected(p.id, '1');
  expect(f.counts().sends).toBe(1);
  expect(f.counts().calls).toBe(0);
});
it('предпросмотр BLOCKED содержит исходное и новое значение, ручное исправление не вызывает Sol', async () => {
  const f = await fixture();
  await f.db.update('source', f.source.id, { text: 'риск 2%' });
  const engine = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      throw Error('no call');
    },
  });
  await expect(engine.edit(f.generated.id, 'риск 20%', '1')).rejects.toThrow('2%');
  const g = await engine.edit(f.generated.id, 'мой риск 2%', '1');
  expect(g.valid).toBe(true);
  expect(await f.db.list('aiRequest')).toHaveLength(0);
});
it.each([
  'покупаю опционы, ограничиваю риск размером премии',
  'цена вернулась на уровень поддержки после пробоя',
])('добавленная торговая тема проходит: %s', (text) => {
  expect(tradingRelevance(text).accepted).toBe(true);
});
it('инвесторы, доходность и риск без конкретного торгового контекста не обходят строгий фильтр', () => {
  expect(
    tradingRelevance(
      'инвесторы ищут доходность, но риск есть везде',
      'STRICT',
      [],
      ['инвесторы', 'доходность', 'риск'],
    ).accepted,
  ).toBe(false);
});
it('поисковые сессии учитывают все настроенные слова в ограниченной ротации', async () => {
  const { tradingSearchQueries } = await import('../src/engagement/relevance.js');
  const words = [
    'инвесторы',
    'доходность',
    'риск',
    'технический анализ',
    'уровень поддержки',
    'опционы',
  ];
  const queries = Array.from({ length: 12 }, (_, i) => tradingSearchQueries(words, i));
  expect(queries.every((q) => q.length <= 3)).toBe(true);
  for (const word of words) expect(queries.flat().some((q) => q.includes(word))).toBe(true);
  expect(queries.flat()).not.toContain('риск');
});
it('отклонённое задание не выдаётся за выполненный браузерный DRY_RUN', async () => {
  const f = await setup(),
    job = await f.manager.approve(f.d.accountId, f.d.id, f.d.hash, '1');
  await f.manager.reject(f.d.accountId, f.d.id, '1');
  const { GenerationQueue } = await import('../src/content/jobs.js');
  const queue = new GenerationQueue(f.db, f.content, f.manager, f.queue);
  const task = await queue.enqueue({
    kind: 'REPLY_DRY',
    replyJobId: job.id,
    accountId: f.d.accountId,
    actor: '1',
    chatId: 1,
  });
  await queue.tick();
  const result = (await queue.list()).find((t) => t.id === task.id)!;
  expect(result.status).toBe('FAILED');
  expect(result.error).toContain('Проверка не выполнена');
  expect((await f.manager.jobView(job.id)).job.dryRunAt).toBeUndefined();
});
