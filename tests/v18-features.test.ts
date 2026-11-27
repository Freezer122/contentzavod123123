import { it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { ContentEngine } from '../src/content/service.js';
import { ProfileManager, type ProfilePort } from '../src/profile/service.js';
import { EngagementManager, type EngagementPort } from '../src/engagement/service.js';
import { EngagementQueue } from '../src/engagement/queue.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { AppError } from '../src/core/errors.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
async function setup() {
  const f = await fixture();
  let llm = 0,
    saves = 0,
    sends = 0;
  const engine = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      llm++;
      return {
        text: 'сначала нужно определить допустимый риск',
        inputTokens: 50,
        outputTokens: 20,
      };
    },
  });
  let profile = { bio: 'старое био', links: ['https://t.me/example'], linkCapacity: 5 };
  const port: ProfilePort = {
    read: async () => structuredClone(profile),
    change: async (_id, before, after, commit, barrier) => {
      if (JSON.stringify(before) !== JSON.stringify(profile))
        throw new AppError('STALE_PROFILE', 'stale');
      if (commit) {
        await barrier();
        saves++;
        profile = structuredClone(after);
      }
      return structuredClone(profile);
    },
  };
  const raw = [
    {
      url: 'https://www.threads.com/@other/post/a',
      author: 'other',
      text: 'трейдинг требует контроля риска',
      language: 'ru',
      category: 'трейдинг',
      discoveredAt: new Date().toISOString(),
      publishedAt: new Date(Date.now() - 3600000).toISOString(),
      timestampConfidence: 'EXACT' as const,
      repliesAvailable: true,
    },
  ];
  const engagementPort: EngagementPort = {
    search: async () => [
      ...raw,
      ...raw,
      { ...raw[0]!, url: 'https://www.threads.com/@test_account/post/own', author: 'test_account' },
      {
        ...raw[0]!,
        url: 'https://www.threads.com/@english/post/en',
        author: 'english',
        text: 'Trading risk',
      },
      { ...raw[0]!, url: 'https://evil.test/@fake/post/a', author: 'fake' },
    ],
    reply: async (_j, _d, _c, commit, beforeSend) => {
      if (commit) {
        await beforeSend();
        sends++;
      }
      return { url: commit ? 'https://www.threads.com/@test_account/post/reply' : null };
    },
    like: async () => {},
  };
  const profiles = new ProfileManager(f.db, port, engine, true),
    manager = new EngagementManager(f.db, engagementPort, engine);
  await manager.configure(f.account.id, { enabled: true }, '1');
  return {
    ...f,
    engine,
    profiles,
    manager,
    port,
    engagementPort,
    counts: () => ({ llm, saves, sends }),
    raw,
  };
}
async function authorize(manager: EngagementManager, jobId: string) {
  const queue = new EngagementQueue(manager, false, {
    jobId,
    actor: '1',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const p = await queue.prepareSelected(jobId, '1');
  await queue.permissions.confirm(p.id, '1');
  return { queue, p };
}
it('ручное био и ссылки требуют точного одобрения, DRY_RUN не сохраняет', async () => {
  const f = await setup(),
    d = await f.profiles.draft(
      f.account.id,
      { bio: 'моё новое био', links: ['https://t.me/a', 'https://t.me/b'] },
      '1',
    );
  await expect(f.profiles.apply(d.id, d.hash, '1', false)).rejects.toMatchObject({
    code: 'APPROVAL_REQUIRED',
  });
  await expect(f.profiles.approve(d.id, 'bad', '1')).rejects.toMatchObject({
    code: 'STALE_APPROVAL',
  });
  await f.profiles.approve(d.id, d.hash, '1');
  expect(await f.profiles.apply(d.id, d.hash, '1', true)).toMatchObject({ dryRun: true });
  expect(f.counts()).toEqual({ llm: 0, saves: 0, sends: 0 });
  await f.profiles.apply(d.id, d.hash, '1', false);
  expect(f.counts().saves).toBe(1);
  await expect(f.profiles.apply(d.id, d.hash, '1', false)).rejects.toMatchObject({
    code: 'APPROVAL_REQUIRED',
  });
});
it('не повторяет сохранение после неопределённого результата', async () => {
  const f = await setup();
  f.port.change = async (_a, _b, _c, _commit, barrier) => {
    await barrier();
    throw new Error('lost');
  };
  const d = await f.profiles.draft(f.account.id, { bio: 'новое' }, '1');
  await f.profiles.approve(d.id, d.hash, '1');
  await expect(f.profiles.apply(d.id, d.hash, '1', false)).rejects.toThrow();
  expect((await f.profiles.get(d.id)).status).toBe('UNCERTAIN');
  await expect(f.profiles.apply(d.id, d.hash, '1', false)).rejects.toMatchObject({
    code: 'APPROVAL_REQUIRED',
  });
});
it('ограничивает ссылки, фильтрует дубли и собственные/иностранные посты без LLM', async () => {
  const f = await setup();
  await expect(
    f.profiles.draft(
      f.account.id,
      { links: Array.from({ length: 6 }, (_, i) => 'https://t.me/x' + i) },
      '1',
    ),
  ).rejects.toMatchObject({ code: 'LINK_LIMIT' });
  expect(await f.manager.search(f.account.id, '1')).toMatchObject({
    found: 5,
    added: 1,
    eligible: 1,
  });
  expect(await f.manager.eligibleCandidates(f.account.id)).toHaveLength(1);
  expect((await f.manager.candidates(f.account.id)).some((c) => c.status === 'REJECTED')).toBe(
    true,
  );
  expect(f.counts().llm).toBe(0);
  await expect(f.manager.search(f.account.id, '1')).rejects.toMatchObject({
    code: 'SEARCH_INTERVAL',
  });
});
it('ответ генерируется одним запросом, кэшируется, редактирование сбрасывает одобрение', async () => {
  const f = await setup();
  await f.manager.search(f.account.id, '1');
  const c = (await f.manager.candidates(f.account.id))[0]!;
  const d = await f.manager.generate(f.account.id, c.id, '1');
  await f.manager.generate(f.account.id, c.id, '1');
  expect(f.counts().llm).toBe(1);
  expect((await f.db.list('aiRequest'))[0]?.purpose).toBe('REPLY');
  const j = await f.manager.approve(f.account.id, d.id, d.hash, '1');
  await f.manager.edit(f.account.id, c.id, 'РУЧНОЙ ответ о риске.', '1', d.id);
  expect((await new EngagementQueue(f.manager).execute(j.id, true)).status).toBe('FAILED');
  expect(f.counts().sends).toBe(0);
});
it('очередь DRY_RUN не отправляет, LIVE сохраняет барьер и защищает от повторов', async () => {
  const f = await setup();
  await f.manager.search(f.account.id, '1');
  const c = (await f.manager.candidates(f.account.id))[0]!,
    d = await f.manager.edit(f.account.id, c.id, 'разумно ограничить риск заранее', '1');
  const j = await f.manager.approve(f.account.id, d.id, d.hash, '1');
  const queue = new EngagementQueue(f.manager, true);
  expect((await queue.execute(j.id, true)).status).toBe('PREVIEWED');
  expect(f.counts().sends).toBe(0);
  const d2 = await f.manager.edit(f.account.id, c.id, 'разумно ограничить риск заранее', '1', d.id);
  const j2 = await f.manager.approve(f.account.id, d2.id, d2.hash, '1');
  const single = await authorize(f.manager, j2.id);
  expect((await single.queue.publishSelected(single.p.id, '1')).status).toBe('PUBLISHED');
  await single.queue.publishSelected(single.p.id, '1');
  expect(f.counts().sends).toBe(1);
  await expect(f.manager.edit(f.account.id, c.id, 'ещё другой ответ', '1')).rejects.toMatchObject({
    code: 'HANDLED',
  });
});
it('не повторяет отправку при обрыве и после рестарта SENDING', async () => {
  const f = await setup();
  await f.manager.search(f.account.id, '1');
  const c = (await f.manager.candidates(f.account.id))[0]!,
    d = await f.manager.edit(f.account.id, c.id, 'разумно ограничить риск заранее', '1'),
    j = await f.manager.approve(f.account.id, d.id, d.hash, '1');
  let calls = 0;
  f.engagementPort.reply = async (_j, _d, _c, _commit, barrier) => {
    if (!_commit) return { url: null };
    await barrier();
    calls++;
    throw new Error('network');
  };
  const single = await authorize(f.manager, j.id),
    queue = single.queue;
  await expect(queue.publishSelected(single.p.id, '1')).rejects.toThrow();
  expect((await f.manager.jobs())[0]!.status).toBe('UNCERTAIN');
  await queue.execute(j.id, false);
  expect(calls).toBe(1);
  await putDocument(f.db, `engagement-job-${j.id}`, { ...j, status: 'SENDING' });
  await queue.recover();
  expect((await f.manager.jobs())[0]!.status).toBe('UNCERTAIN');
});
it('PAUSED, приоритет публикаций и лимит бюджета блокируют отправки', async () => {
  const f = await setup();
  await f.manager.configure(f.account.id, { dailyLlmUsd: 0, monthlyLlmUsd: 0 }, '1');
  await f.manager.search(f.account.id, '1');
  const c = (await f.manager.candidates(f.account.id))[0]!;
  const config = {
    ...testConfig(),
    APP_MODE: 'production' as const,
    LLM_INPUT_PRICE_PER_MILLION: 1,
    LLM_OUTPUT_PRICE_PER_MILLION: 1,
  };
  const engine = new ContentEngine(f.db, config, {
    generate: async () => {
      throw new Error('must not call');
    },
  });
  await expect(engine.auxiliary(f.account.id, 'REPLY', c.text, 'ответ')).rejects.toMatchObject({
    code: 'AI_BUDGET',
  });
  const d = await f.manager.edit(f.account.id, c.id, 'разумно ограничить риск заранее', '1'),
    j = await f.manager.approve(f.account.id, d.id, d.hash, '1');
  await putDocument(f.db, 'factoryPaused', true);
  await expect(new EngagementQueue(f.manager, true).execute(j.id, false)).rejects.toMatchObject({
    code: 'ONE_SHOT_REQUIRED',
  });
  expect(f.counts().sends).toBe(0);
});
it('Telegram показывает профиль, ручное био, настройки и не расходует LLM', async () => {
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
      ).json().messages as any[];
    const a = (await app.db.list('account'))[0]!;
    const messages = await send({ callback: `v18p:${a.id}` });
    expect(messages.some((m) => m.text?.includes('Био:'))).toBe(true);
    for (const m of messages)
      for (const row of m.reply_markup?.inline_keyboard ?? [])
        for (const b of row)
          if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    await send({ callback: `v18bio:${a.id}` });
    const preview = await send({ text: 'новое био' });
    expect(preview.some((m) => m.text?.includes('Предпросмотр'))).toBe(true);
    await send({ callback: `v18e:${a.id}` });
    expect(await app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    await app.close();
  }
});
it('лайк требует своего подтверждения, DRY_RUN не кликает и лимит сохраняется', async () => {
  const f = await setup();
  await f.manager.search(f.account.id, '1');
  const c = (await f.manager.candidates(f.account.id))[0]!;
  const { hashDocument } = await import('../src/db/documents.js');
  const hash = hashDocument({ kind: 'LIKE', url: c.url });
  await expect(f.manager.approveLike(f.account.id, c.id, hash, '1')).rejects.toMatchObject({
    code: 'LIKES_DISABLED',
  });
  await f.manager.configure(f.account.id, { likes: true, dailyLikes: 1 }, '1');
  await expect(f.manager.approveLike(f.account.id, c.id, 'bad', '1')).rejects.toMatchObject({
    code: 'STALE_APPROVAL',
  });
  const job = await f.manager.approveLike(f.account.id, c.id, hash, '1');
  let clicks = 0;
  f.engagementPort.like = async (_j, _c, commit, barrier) => {
    if (commit) {
      await barrier();
      clicks++;
    }
  };
  expect((await new EngagementQueue(f.manager, true).execute(job.id, true)).status).toBe(
    'PREVIEWED',
  );
  expect(clicks).toBe(0);
  await expect(new EngagementQueue(f.manager, true).execute(job.id, false)).rejects.toMatchObject({
    code: 'ONE_SHOT_REQUIRED',
  });
  expect(clicks).toBe(0);
  await expect(f.manager.approveLike(f.account.id, c.id, hash, '1')).rejects.toMatchObject({
    code: 'DUPLICATE_LIKE',
  });
});
it('дневной лимит и интервалы ответов проверяются до постановки в очередь', async () => {
  const f = await setup();
  f.raw.push({
    ...f.raw[0]!,
    url: 'https://www.threads.com/@other/post/b',
    text: 'трейдинг и риск другой сделки',
  });
  await f.manager.configure(
    f.account.id,
    { dailyReplies: 1, minIntervalMinutes: 20, maxIntervalMinutes: 20 },
    '1',
  );
  await f.manager.search(f.account.id, '1');
  const candidates = await f.manager.candidates(f.account.id),
    d1 = await f.manager.edit(
      f.account.id,
      candidates[0]!.id,
      'сначала проверю риск первой сделки',
      '1',
    ),
    d2 = await f.manager.edit(
      f.account.id,
      candidates[1]!.id,
      'сначала проверю риск второй сделки',
      '1',
    );
  const j1 = await f.manager.approve(f.account.id, d1.id, d1.hash, '1');
  await expect(f.manager.approve(f.account.id, d2.id, d2.hash, '1')).rejects.toMatchObject({
    code: 'DAILY_LIMIT',
  });
  await f.manager.configure(f.account.id, { dailyReplies: 2 }, '1');
  const j2 = await f.manager.approve(f.account.id, d2.id, d2.hash, '1');
  expect(Date.parse(j2.scheduledAt) - Date.parse(j1.scheduledAt)).toBe(20 * 60000);
});
