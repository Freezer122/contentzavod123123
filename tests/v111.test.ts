import { it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { ContentEngine } from '../src/content/service.js';
import { EngagementManager, type EngagementPort } from '../src/engagement/service.js';
import { EngagementQueue } from '../src/engagement/queue.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import {
  checkReply,
  normalizeReply,
  replyPrompt,
  REPLY_PROMPT_VERSION,
} from '../src/engagement/reply-style.js';
import { replyJobCard } from '../src/bot/reply-card.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { deliverGenerations } from '../src/bot/generation.js';
async function setup(output = 'точки входа проще выучить, чем соблюдать риск в моменте') {
  const f = await fixture();
  let sends = 0,
    calls = 0,
    dry = 0;
  const prompts: string[] = [];
  const content = new ContentEngine(f.db, testConfig(), {
    generate: async (system) => {
      calls++;
      prompts.push(system);
      return { text: output, inputTokens: 40, outputTokens: 20 };
    },
  });
  const port: EngagementPort = {
    search: async () => [],
    reply: async (_j, _d, _c, commit, before) => {
      if (commit) {
        await before();
        sends++;
        return { url: 'https://www.threads.com/@test_account/post/result' };
      }
      dry++;
      return { url: null };
    },
    like: async () => {
      throw Error('not allowed');
    },
  };
  const manager = new EngagementManager(f.db, port, content);
  await manager.configure(f.account.id, { enabled: true }, '1');
  const candidate = async (id: string) => {
    const c = {
      id,
      accountId: f.account.id,
      url: `https://www.threads.com/@other/post/${id}`,
      author: 'other',
      text: 'трейдинг проще обсуждать, чем соблюдать риск, когда цена идёт против тебя',
      language: 'ru',
      category: 'трейдинг',
      discoveredAt: new Date().toISOString(),
      publishedAt: new Date(Date.now() - 3600000).toISOString(),
      timestampConfidence: 'EXACT' as const,
      repliesAvailable: true,
      status: 'NEW',
    };
    await putDocument(f.db, `engagement-candidate-${f.account.id}-${id}`, c);
    return c;
  };
  const c = await candidate('first'),
    d = await manager.edit(f.account.id, c.id, 'соблюдать свой риск сложнее, чем найти вход', '1'),
    j = await manager.approve(f.account.id, d.id, d.hash, '1');
  const queue = new EngagementQueue(manager, false, {
    jobId: j.id,
    actor: '1',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const grant = async () => {
    const p = await queue.prepareSelected(j.id, '1');
    await queue.permissions.confirm(p.id, '1');
    return p;
  };
  return {
    ...f,
    manager,
    queue,
    grant,
    c,
    d,
    j,
    port,
    content,
    candidate,
    prompts,
    counts: () => ({ sends, calls, dry }),
  };
}
it('одобрение и DRY_RUN не означают публикацию и сохраняют WAITING', async () => {
  const f = await setup();
  expect(f.counts().sends).toBe(0);
  await f.queue.execute(f.j.id, true);
  const v = await f.manager.jobView(f.j.id);
  expect(v.approvalStatus).toBe('APPROVED');
  expect(v.executionStatus).toBe('WAITING');
  expect(v.job.status).toBe('QUEUED');
  expect(v.job.dryRunAt).toBeTruthy();
  const restarted = new EngagementQueue(f.manager);
  await restarted.recover();
  expect((await f.manager.jobView(f.j.id)).executionStatus).toBe('WAITING');
});
it('адресное подтверждение под PAUSED отправляет только выбранное; backlog не активируется', async () => {
  const f = await setup();
  const c = await f.candidate('second'),
    d = await f.manager.edit(
      f.account.id,
      c.id,
      'план помогает не менять правила во время сделки',
      '1',
    ),
    other = await f.manager.approve(f.account.id, d.id, d.hash, '1');
  await putDocument(f.db, 'factoryPaused', true);
  const p = await f.grant();
  await f.queue.publishSelected(p.id, '1');
  expect(f.counts().sends).toBe(1);
  expect((await f.manager.jobView(other.id)).executionStatus).toBe('WAITING');
  expect(await getDocument<any>(f.db, 'factoryPaused')).toBe(true);
  await putDocument(f.db, 'factoryPaused', false);
  await new EngagementQueue(f.manager, true).tick();
  expect(f.counts().sends).toBe(1);
});
it('повторное нажатие и использованное разрешение не создают второго submit', async () => {
  const f = await setup(),
    p = await f.grant();
  await f.queue.publishSelected(p.id, '1');
  await f.queue.publishSelected(p.id, '1');
  expect(f.counts().sends).toBe(1);
  expect((await f.queue.permissions.get(p.id)).state).toBe('CONSUMED');
  await expect(f.queue.publishSelected(p.id, '2')).rejects.toMatchObject({
    code: 'PERMISSION_ACTOR',
  });
  await expect(f.queue.permissions.confirm(p.id, '1')).rejects.toMatchObject({
    code: 'PERMISSION_USED',
  });
  const card = await replyJobCard(f.manager, f.j.id);
  expect(JSON.stringify(card.reply_markup)).not.toContain('Опубликовать сейчас');
  expect(card.text).toContain('PUBLISHED');
});
it('без оператора, без финального подтверждения и с чужим actor отправка закрыта', async () => {
  const f = await setup(),
    queue = new EngagementQueue(f.manager);
  const p = await queue.prepareSelected(f.j.id, '1');
  await expect(queue.permissions.confirm(p.id, '1')).rejects.toMatchObject({
    code: 'OPERATOR_PERMISSION_REQUIRED',
  });
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toMatchObject({
    code: 'PERMISSION_USED',
  });
  await expect(f.queue.permissions.confirm(p.id, '2')).rejects.toMatchObject({
    code: 'PERMISSION_ACTOR',
  });
  await expect(new EngagementQueue(f.manager, true).execute(f.j.id, false)).rejects.toMatchObject({
    code: 'ONE_SHOT_REQUIRED',
  });
  expect(f.counts().sends).toBe(0);
});
it('истёкшее или отменённое разрешение отклоняется', async () => {
  const f = await setup(),
    p = await f.queue.prepareSelected(f.j.id, '1');
  await putDocument(f.db, `reply-permission-${p.id}`, {
    ...p,
    expiresAt: new Date(0).toISOString(),
  });
  await expect(f.queue.permissions.confirm(p.id, '1')).rejects.toMatchObject({
    code: 'PERMISSION_EXPIRED',
  });
  const next = await f.grant();
  await f.queue.permissions.revoke(next.id, '1');
  await expect(f.queue.publishSelected(next.id, '1')).rejects.toMatchObject({
    code: 'PERMISSION_USED',
  });
  expect(f.counts().sends).toBe(0);
});
it('изменение версии снимает одобрение и не позволяет использовать старое разрешение', async () => {
  const f = await setup(),
    p = await f.grant();
  const d = await f.manager.edit(
    f.account.id,
    f.c.id,
    'риск лучше записать до сделки',
    '1',
    f.d.id,
  );
  expect(d.approvalStatus).toBe('DRAFT');
  expect(d.version).toBe(2);
  expect((await f.queue.publishSelected(p.id, '1')).status).toBe('FAILED');
  expect(f.counts().sends).toBe(0);
});
it('UNCERTAIN сохраняет SENDING barrier и запрещает повтор', async () => {
  const f = await setup(),
    p = await f.grant();
  let clicked = 0;
  f.port.reply = async (_j, _d, _c, commit, before) => {
    if (!commit) return { url: null };
    await before();
    clicked++;
    throw Error('connection lost');
  };
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toThrow();
  expect((await f.manager.jobView(f.j.id)).executionStatus).toBe('UNCERTAIN');
  await f.queue.publishSelected(p.id, '1');
  expect(clicked).toBe(1);
  const card = await replyJobCard(f.manager, f.j.id);
  expect(JSON.stringify(card.reply_markup)).toContain('Проверить результат');
  expect(JSON.stringify(card.reply_markup)).not.toContain('Опубликовать сейчас');
  await f.queue.recover();
  expect((await f.manager.jobView(f.j.id)).executionStatus).toBe('UNCERTAIN');
});
it('адресное разрешение не снимает блокировку аккаунта', async () => {
  const f = await setup(),
    p = await f.grant();
  await f.db.update('account', f.account.id, { status: 'PAUSED' });
  await expect(f.queue.publishSelected(p.id, '1')).rejects.toMatchObject({
    code: 'ACCOUNT_PAUSED',
  });
  expect(f.counts().sends).toBe(0);
});
it('Terra: один короткий запрос, версия/usage сохраняются, без оценочной LLM', async () => {
  const f = await setup();
  const c = await f.candidate('generate');
  const d = await f.manager.generate(f.account.id, c.id, '1');
  await f.manager.generate(f.account.id, c.id, '1');
  expect(f.counts().calls).toBe(1);
  expect(d.generationState).toBe('READY');
  expect(d.promptVersion).toBe(REPLY_PROMPT_VERSION);
  expect(d.inputTokens).toBe(40);
  expect(d.outputTokens).toBe(20);
  expect(d.text.length).toBeLessThanOrEqual(220);
  expect(f.prompts[0]!.length).toBeLessThan(1100);
});
it('длинный/лекционный ответ сохраняется для ручной правки без платного повтора', async () => {
  const f = await setup('важно понимать, что ' + 'риск нужно учитывать в торговле. '.repeat(15));
  const c = await f.candidate('long'),
    d = await f.manager.generate(f.account.id, c.id, '1');
  expect(d.generationState).toBe('NEEDS_EDIT');
  await expect(f.manager.approve(f.account.id, d.id, d.hash, '1')).rejects.toMatchObject({
    code: 'NEEDS_EDIT',
  });
  expect(f.counts().calls).toBe(1);
});
it('нормализатор сохраняет финансовые значения, ticker, URL и идентификаторы', () => {
  const source = 'РИСК 3.5% В $AAPL И BTC. https://Example.com/AbC123 API_Key';
  const normalized = normalizeReply(
    '\u200bРИСК\u00a0 3.5% В $AAPL И BTC.\nhttps://Example.com/AbC123 API_Key. 😀',
  );
  expect(normalized).toContain('3.5%');
  expect(normalized).toContain('$AAPL');
  expect(normalized).toContain('https://Example.com/AbC123');
  expect(normalized).not.toMatch(/[\u00a0\u2013\u2014\u200b]| {2}/);
  expect(checkReply(normalized, source, 'SHORT')).not.toContain('Добавлена новая ссылка');
  expect(replyPrompt('SHORT')).toContain('1–3');
});
it('старый одобренный текст не сокращается при миграции или смене стиля', async () => {
  const f = await setup();
  const before = await f.manager.draft(f.account.id, f.d.id);
  await f.manager.migrateStates();
  await f.manager.configure(f.account.id, { replyLength: 'VERY_SHORT' }, '1');
  const after = await f.manager.draft(f.account.id, f.d.id);
  expect(after.text).toBe(before.text);
  expect(after.hash).toBe(before.hash);
  expect(after.approvedAt).toBe(before.approvedAt);
});
it('Telegram: точные статусы, разовый preflight, подтверждение без оператора не активирует очередь', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!;
    await app.services.engagement.configure(a.id, { enabled: true }, '1');
    await putDocument(app.db, `engagement-candidate-${a.id}-ui`, {
      id: 'ui',
      accountId: a.id,
      url: 'https://www.threads.com/@other/post/ui',
      author: 'other',
      text: 'трейдинг и риск',
      status: 'NEW',
    });
    const d = await app.services.engagement.edit(
      a.id,
      'ui',
      'риск проще соблюдать с записанным планом',
      '1',
    );
    const j = await app.services.engagement.approve(a.id, d.id, d.hash, '1');
    const send = async (callback: string) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload: { callback },
        })
      ).json();
    const card = await send(`v111job:${j.id}`);
    expect(JSON.stringify(card)).toContain('WAITING');
    const msg = card.messages.find((m: any) => m.method === 'sendMessage');
    const callback = msg.reply_markup.inline_keyboard
      .flat()
      .find((b: any) => b.text === 'Опубликовать').callback_data;
    const result = await send(callback);
    expect(JSON.stringify(result)).toContain('Ручные публикации выключены');
    expect((await app.services.generation.list()).some((t) => t.kind === 'REPLY_SEND')).toBe(false);
    expect((await app.services.engagement.jobView(j.id)).executionStatus).toBe('WAITING');
  } finally {
    await app.close();
  }
});
