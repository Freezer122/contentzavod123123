import { it, expect, vi, afterEach } from 'vitest';
import { fixture, testConfig, fastClock } from './helpers.js';
import { MemoryDatabase, base } from '../src/db/database.js';
import {
  AutopilotPolicy,
  autopilotConfig,
  type AutoWork,
  type AutoGrant,
} from '../src/autopilot/policy.js';
import { AutopilotService } from '../src/autopilot/service.js';
import { dailySlots, localTime, zonedMinute } from '../src/autopilot/schedule.js';
import { qualityGate } from '../src/autopilot/quality.js';
import { observe, rankViral, visibleNumber } from '../src/autopilot/viral.js';
import { getDocument, putDocument, hashDocument, listDocuments } from '../src/db/documents.js';
import { ContentEngine } from '../src/content/service.js';
import { EngagementManager, type Candidate } from '../src/engagement/service.js';
import { EngagementQueue } from '../src/engagement/queue.js';
import { GenerationQueue } from '../src/content/jobs.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { AnalyticsCollector, DemoInsights } from '../src/analytics/collector.js';
import { InlineKeyboard } from '../src/bot/keyboard.js';
import { createApplication } from '../src/app.js';
import { autopilotCard } from '../src/bot/autopilot.js';
import { AppError } from '../src/core/errors.js';
const day = '2026-11-21',
  begin = Date.parse(day + 'T06:00:00Z');
afterEach(() => vi.useRealTimers());
async function setup(mode: 'LIVE' | 'DRY_RUN' = 'DRY_RUN') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(begin);
  const f = await fixture(),
    calls: string[] = [],
    previews: string[] = [],
    sent: string[] = [],
    texts = new Map<string, string>();
  const engine = new ContentEngine(f.db, testConfig(), {
    generate: async (_s, user) => {
      calls.push(user);
      return {
        text: texts.get(user) ?? 'трейдинг без плана превращается в платное развлечение',
        inputTokens: 50,
        outputTokens: 20,
      };
    },
  });
  const policy = new AutopilotPolicy(f.db, '1', ['one']);
  await putDocument(f.db, 'autopilot-readiness-v116', { passed: true });
  const engagement = new EngagementManager(
    f.db,
    {
      search: async () => [],
      reply: async (j, _d, _c, commit, barrier) => {
        if (commit) {
          await barrier();
          sent.push(j.id);
          return { url: `https://www.threads.com/@test_account/post/${j.id}` };
        }
        previews.push(j.id);
        return { url: null };
      },
      like: async () => {},
    },
    engine,
  );
  const replies = new EngagementQueue(engagement, false, undefined, undefined, policy),
    generation = new GenerationQueue(f.db, engine, engagement, replies),
    publisher = new PublishingWorker(
      f.db,
      f.providers,
      f.publisher,
      undefined,
      1,
      fastClock(),
      false,
      undefined,
      policy,
    ),
    collector = new AnalyticsCollector(f.db, new DemoInsights());
  const autopilot = new AutopilotService(
    f.db,
    policy,
    engine,
    engagement,
    replies,
    f.scheduler,
    publisher,
    generation,
    collector,
  );
  generation.setAutopilot((id, send) => (send ? autopilot.sendReply(id) : autopilot.process(id)));
  await putDocument(f.db, 'factoryPaused', true);
  await putDocument(f.db, 'automationPaused', true);
  await policy.start(await policy.launchCard(f.account.id, '1', mode), '1');
  const state = await policy.settings(f.account.id);
  const candidate = async (
    id: string,
    text = 'трейдинг: стоп-лосс ограничивает убыток, но дисциплина исполнения плана важнее красивого входа',
    patch: Partial<Candidate> = {},
  ) => {
    const c: Candidate = {
      id,
      accountId: f.account.id,
      url: `https://www.threads.com/@author${id}/post/${id}`,
      author: `author${id}`,
      text,
      language: 'ru',
      category: 'трейдинг',
      discoveredAt: new Date().toISOString(),
      publishedAt: new Date(begin - 3600000).toISOString(),
      timestampConfidence: 'EXACT',
      extractionVersion: 'threads-body-v115',
      repliesAvailable: true,
      status: 'NEW',
      ...patch,
    };
    await putDocument(f.db, `engagement-candidate-${f.account.id}-${id}`, c);
    return c;
  };
  const work = (id: string, kind: AutoWork['kind'], candidateId?: string): AutoWork => ({
    id,
    kind,
    candidateId,
    accountId: f.account.id,
    epoch: state.epoch,
    version: state.version,
    enabledAt: state.enabledAt!,
    createdAt: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
    mode,
    status: 'QUEUED',
  });
  return {
    ...f,
    engine,
    policy,
    engagement,
    replies,
    generation,
    autopilot,
    state,
    candidate,
    work,
    calls,
    texts,
    previews,
    sent,
    worker: publisher,
  };
}
it('09–22 МСК, границы дня, UTC и переход DST, 5/20 разнесённых слотов', () => {
  const c = autopilotConfig.parse({});
  expect(c).toMatchObject({
    start: '09:00',
    end: '22:00',
    timezone: 'Europe/Moscow',
    posts: 5,
    replies: 20,
  });
  const slots = dailySlots('x', day, c);
  expect(slots.filter((s) => s.kind === 'POST')).toHaveLength(5);
  expect(slots.filter((s) => s.kind === 'REPLY')).toHaveLength(20);
  expect(
    slots.every((s) => {
      const p = localTime(Date.parse(s.at), c.timezone);
      return p.day === day && p.minute >= 540 && p.minute < 1320;
    }),
  ).toBe(true);
  expect(localTime(Date.parse('2026-11-20T21:01:00Z'), c.timezone).day).toBe(day);
  expect(zonedMinute('2026-03-29', 10 * 60, 'Europe/Berlin')).toBe(
    Date.parse('2026-03-29T08:00:00Z'),
  );
  expect(() => zonedMinute('2026-03-29', 2 * 60 + 30, 'Europe/Berlin')).toThrow();
});
it('OFF по умолчанию; владелец, подтверждение, версия и эпоха, настройки после рестарта', async () => {
  const f = await fixture(),
    p = new AutopilotPolicy(f.db, '1');
  expect((await p.settings(f.account.id)).state).toBe('OFF');
  await expect(p.launchCard(f.account.id, '2', 'LIVE')).rejects.toThrow();
  const card = await p.launchCard(f.account.id, '1', 'LIVE');
  await expect(p.start(card, '1')).rejects.toThrow('DRY_RUN');
  await p.configure(f.account.id, { posts: 3 }, '1');
  await expect(p.start(card, '1')).rejects.toThrow('изменились');
  expect((await new AutopilotPolicy(f.db, '1').settings(f.account.id)).config.posts).toBe(3);
});
it('реальный Bot API style: красная навигация, зелёный запуск, синие настройки', () => {
  const k = new InlineKeyboard()
    .text('Назад', 'x')
    .text('К аккаунту', 'a')
    .text('Главное меню', 'menu')
    .text('Отмена', 'c')
    .row()
    .text('Запустить', 'go')
    .text('Настройки', 's');
  expect(k.inline_keyboard.flat().map((b) => b.style)).toEqual([
    'danger',
    'danger',
    'danger',
    'danger',
    'success',
    'primary',
  ]);
});
it('viralScore: реальная дата, старый/неторговый отсекаются, null не превращается в ноль', async () => {
  const f = await setup(),
    c = await f.candidate('viral', undefined, {
      domMetadata: {
        interfaceText: [],
        counts: [
          { label: 'Like', text: '1,2K' },
          { label: 'Reply', text: '50' },
          { label: 'Repost', text: '10' },
        ],
      },
    }),
    o = observe(c);
  expect(o.views).toBeNull();
  expect(o.likes).toEqual({ value: 1200, raw: '1,2K', precision: 'ROUNDED' });
  expect(visibleNumber('нравится').value).toBeNull();
  let r = rankViral([c], [o], 40, 48)[0]!;
  expect(r.accepted).toBe(true);
  expect(r.provisional).toBe(true);
  expect(r.growth).toBeNull();
  r = rankViral(
    [{ ...c, publishedAt: new Date(begin - 72 * 3600000).toISOString() }],
    [o],
    0,
    48,
  )[0]!;
  expect(r.accepted).toBe(false);
  expect(rankViral([{ ...c, text: 'продаю квартиру недорого' }], [o], 0, 48)[0]!.accepted).toBe(
    false,
  );
  expect(
    rankViral(
      [c],
      [
        {
          ...o,
          at: new Date(begin - 3600000).toISOString(),
          likes: { value: 100, raw: '100', precision: 'EXACT' },
        },
        o,
      ],
      0,
      48,
    )[0]!.growth,
  ).toBeGreaterThan(0);
});
it.each([
  ['REPLY', 'согласен', 'EMPTY_OR_LECTURE'],
  ['REPLY', 'я заработал 900% на трейдинге', 'UNSUPPORTED_NUMBER_OR_TICKER'],
  ['REPLY', 'убью тебя за трейдинг', 'THREAT'],
  ['REPLY', 'на кухне закончился чай и чашки', 'LOW_CONTEXT_RELEVANCE'],
  ['POST', 'трейдинг стоп-лосс ограничивает убыток', 'COSMETIC_REWRITE_OR_QUOTE'],
] as const)('qualityGate %s / %s', (kind, text, reason) => {
  expect(qualityGate(kind, text, 'трейдинг стоп-лосс ограничивает убыток').reasons).toContain(
    reason,
  );
});
it('глобальные повторы текста, URL, идей и задач между аккаунтами', async () => {
  const f = await setup(),
    c = await f.candidate('a'),
    w = f.work('first', 'POST', c.id);
  await f.policy.claim(w, c);
  await f.policy.claim(w, c);
  await expect(f.policy.claim({ ...w, id: 'second', accountId: 'other' }, c)).rejects.toThrow(
    'Источник',
  );
  const c2 = await f.candidate('b', c.text);
  await expect(f.policy.claim({ ...w, id: 'third' }, c2)).rejects.toThrow('идея');
  expect(
    qualityGate('REPLY', 'трейдинг стоп-лосс ограничивает убыток', c.text, [
      'трейдинг стоп-лосс ограничивает убыток',
    ]).reasons,
  ).toContain('GLOBAL_TEXT_DUPLICATE');
});
it('полный DRY_RUN: ContentEngine→оригинал→Scheduler→редактор, без submit, закрывает профиль', async () => {
  const f = await setup(),
    c = await f.candidate('post');
  f.texts.set(
    c.text,
    'трейдинг порой похож на спор с будильником: правила дисциплины неприятны именно тогда, когда они нужны',
  );
  const w = f.work('dryown', 'POST', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const result = (await getDocument<AutoWork>(f.db, `autopilot-work-${w.id}`))!;
  expect(result.status).toBe('PREVIEWED');
  expect(f.calls).toHaveLength(1);
  expect(f.publisher.posts.size).toBe(0);
  expect(await f.db.list('post')).toHaveLength(0);
  expect(await f.provider.status('one')).toBe(false);
  const j = (await f.db.list('publishJob'))[0]!;
  expect(j.status).toBe('PAUSED');
  expect(j.postSubmitAt).toBeUndefined();
  expect(j.ctaEnabled).toBe(false);
  expect(await getDocument(f.db, `autopilot-preview-${j.id}`)).toMatchObject({
    barrierReached: true,
    submit: false,
  });
  await f.worker.execute(j.id).catch(() => {});
  expect(f.publisher.posts.size).toBe(0);
  await f.generation.tick();
  expect(f.calls).toHaveLength(1);
});
it('полный DRY_RUN реплая, без влияния старых лимитов UTC и фабричной паузы', async () => {
  const f = await setup(),
    c = await f.candidate('reply');
  f.texts.set(
    c.text,
    'дисциплина как раз заканчивается там, где стоп-лосс внезапно становится необязательным',
  );
  const w = f.work('dryreply', 'REPLY', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  expect((await getDocument<AutoWork>(f.db, `autopilot-work-${w.id}`))?.status).toBe('PREVIEWED');
  expect(f.previews).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
});
it('не исполняет старую эпоху/черновик/задачу; смена настройки отзывает разрешение', async () => {
  const f = await setup(),
    w = f.work('old', 'POST', 'a');
  await f.policy.assertWork(w, f.db, begin + 3600000);
  await expect(
    f.policy.assertWork(
      { ...w, createdAt: new Date(begin - 1).toISOString() },
      f.db,
      begin + 3600000,
    ),
  ).rejects.toThrow('до запуска');
  await f.policy.configure(f.account.id, { posts: 4 }, '1');
  await expect(f.policy.assertWork(w)).rejects.toThrow('отозвано');
});
it('аварийная остановка действует и в DRY_RUN, и у LIVE перед кликом', async () => {
  const f = await setup(),
    c = await f.candidate('stop');
  await putDocument(f.db, 'emergencyStop', true);
  await expect(f.policy.assertWork(f.work('stop', 'POST', c.id))).rejects.toThrow('Аварийная');
  await f.autopilot.enqueueWork(f.work('stop', 'POST', c.id));
  await f.generation.tick();
  expect(f.calls).toHaveLength(0);
  expect((await f.policy.settings(f.account.id)).state).toBe('ERROR');
});
it('запуск в середине дня не поднимает старые слоты, рестарт не создаёт дубли', async () => {
  const f = await setup();
  vi.setSystemTime(begin + 7 * 3600000);
  await f.autopilot.tick();
  await f.autopilot.tick();
  const plans = await listDocuments<any>(f.db, 'autopilot-plan-');
  expect(plans).toHaveLength(2);
  expect(
    plans[0].slots.filter(
      (s: any) => s.status === 'SKIPPED' || s.skipped === 'MISSED_SLOT_NO_CATCHUP',
    ).length,
  ).toBeGreaterThan(10);
  expect((await f.policy.works()).filter((w) => w.kind === 'DISCOVER').length).toBeLessThanOrEqual(
    1,
  );
});
it('повторяющиеся ошибки и challenge останавливают, уведомление критическое', async () => {
  const f = await setup();
  for (let i = 0; i < 3; i++) await f.policy.failure(f.account.id, Error('fixture'));
  expect((await f.policy.settings(f.account.id)).state).toBe('ERROR');
  expect((await f.db.list('systemEvent', { code: 'NOTIFICATION' })).length).toBe(1);
});
it('Telegram: реальные обработчики, сохранение окна и навигации; установка OFF', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const id = 'demo-account-1',
      card = await autopilotCard(app.services, id);
    expect(card.text).toContain('OFF');
    const buttons = card.reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.text === 'К аккаунту')?.style).toBe('danger');
    expect(buttons.find((b) => b.text === 'Включить автопилот LIVE')?.style).toBe('success');
    const telegram = async (callback: string) => {
      const r = await app.server!.inject({
        method: 'POST',
        url: '/api/demo/telegram',
        headers: { authorization: 'Bearer demo-local-token' },
        payload: { callback },
      });
      return r.json().messages as any[];
    };
    expect((await telegram(`ap:home:${id}`)).some((m) => m.text?.includes('09:00–22:00'))).toBe(
      true,
    );
    await telegram(`ap:set:${id}:posts=3`);
    expect((await app.services.autopilotPolicy.settings(id)).config.posts).toBe(3);
    await telegram(`ap:schedule:${id}`);
    expect((await app.services.autopilotPolicy.settings(id)).state).toBe('OFF');
  } finally {
    await app.close();
  }
});
it('24 часа существующего планировщика: максимум 5/20, без догоняющих пачек, дубли после рестарта исключены', async () => {
  const f = await setup(),
    c = f.state.config,
    slots = dailySlots(f.account.id, day, c);
  // Exercise actual durable outbox dispatch through every minute of one local day.
  const ownTexts = [
    'трейдинг иногда напоминает спор с будильником: дисциплина особенно бесит, когда пора вставать',
    'трейдинг забавный: участники ищут волшебный вход, а выход из убыточной позиции обсуждать скучно',
    'опционы выглядят как хитрый конструктор, пока внезапно не выясняется, что инструкция была обязательной',
    'технический анализ начинается бодро, а потом уровень поддержки приходится защищать надеждой',
    'скальпинг проверяет скорость пальцев, но терпение к отсутствию сигнала проверяет намного жёстче',
  ];
  for (let i = 0; i < 5; i++) {
    const source = [
      'трейдинг: дисциплина исполнения защитного стопа важнее поиска идеальной точки входа, иначе план торговли не работает',
      'трейдинг: выход из позиции, фиксация убытка и поведение после закрытия сделки обсуждаются реже красивых графиков',
      'опционы требуют понимания экспирации и ценообразования, сложная конструкция не отменяет необходимости разбираться в риске',
      'технический анализ: уровень поддержки не обязан удержать котировки, сценарий пробоя должен учитываться до открытия сделки',
      'скальпинг требует ожидания подходящего сигнала, активное движение котировок само по себе не причина входить в рынок',
    ][i]!;
    const can = await f.candidate('own' + i, source, {
      repliesAvailable: false,
      domMetadata: {
        interfaceText: [],
        counts: [
          { label: 'Like', text: '10000' },
          { label: 'Reply', text: '500' },
        ],
      },
    });
    f.texts.set(source, ownTexts[i]!);
    const o = observe(can);
    await putDocument(f.db, 'autopilot-observation-' + i, o);
  }
  const topics = [
    'проскальзывание',
    'экспирация',
    'маржинколл',
    'дивергенция',
    'волатильность',
    'дельта',
    'ликвидность',
    'фандинг',
    'комиссии',
    'корреляция',
    'бэктест',
    'усреднение',
    'диверсификация',
    'гэп',
    'спред',
    'эквити',
    'безубыток',
    'переторговка',
    'контртренд',
    'ребалансировка',
  ];
  for (const [i, topic] of topics.entries()) {
    const source = `трейдинг: ${topic} влияет на исполнение торговой стратегии, это приходится учитывать заранее, а не после неожиданного движения котировок`;
    // Deliberately distinct fixture vocabulary; the live quality gate still checks the shared topic.
    const endings = [
      'исполнение получается неприятным сюрпризом',
      'календарь неожиданно оказывается полезнее гадания',
      'плечо умеет завершать споры очень быстро',
      'расхождение сигналов требует разбирать контекст',
      'размах свечи отлично лечит самоуверенность',
      'чувствительность позиции легко недооценить',
      'пустой стакан превращает выход в приключение',
      'плата за ожидание умеет съедать идею',
      'брокер получает своё даже без красивого графика',
      'одинаковое движение активов портит диверсификацию',
      'история выглядит гораздо убедительнее будущего',
      'средняя цена становится утешением вместо аргумента',
      'корзина может оказаться общим огромным риском',
      'ночной разрыв отлично умеет будить',
      'разница цен незаметно портит частые входы',
      'кривая счёта бывает честнее воспоминаний',
      'нулевой итог не означает бесплатную сделку',
      'лишний клик не добавляет преимущества',
      'ловля разворота требует терпения к ошибке',
      'пересборка портфеля тоже имеет цену',
    ][i]!;
    const answer = `${topic}: ${endings}, в торговой стратегии такое лучше учитывать заранее`;
    await f.candidate('reply' + i, source);
    f.texts.set(source, answer);
  }
  for (let m = 0; m < 1440; m++) {
    const at = zonedMinute(day, m, 'Europe/Moscow');
    if (at < begin) continue;
    vi.setSystemTime(at);
    await f.autopilot.tick();
    await f.generation.tick();
    // Simulate clean process reconstruction against the same durable documents every hour.
    if (m % 60 === 0) await f.generation.recover();
  }
  const works = await f.policy.works(),
    posts = works.filter((w) => w.kind === 'POST'),
    replies = works.filter((w) => w.kind === 'REPLY');
  expect(posts.length).toBeLessThanOrEqual(5);
  expect(replies.length).toBeLessThanOrEqual(20);
  expect(
    posts
      .filter((w) => w.status !== 'PREVIEWED')
      .map((w) => ({ text: w.text, reasons: w.reasons, error: w.error })),
  ).toEqual([]);
  expect(posts.filter((w) => w.status === 'PREVIEWED')).toHaveLength(5);
  expect(
    replies
      .filter((w) => w.status !== 'PREVIEWED')
      .map((w) => ({ text: w.text, reasons: w.reasons, error: w.error })),
  ).toEqual([]);
  expect(replies.filter((w) => w.status === 'PREVIEWED')).toHaveLength(20);
  expect(f.previews).toHaveLength(20);
  expect(f.sent).toHaveLength(0);
  expect(f.publisher.posts.size).toBe(0);
  expect(new Set(works.map((w) => w.id)).size).toBe(works.length);
  expect(await f.autopilot.summaries()).toHaveLength(1);
  await f.autopilot.tick();
  expect(await f.autopilot.summaries()).toHaveLength(1);
}, 30000);
it('LIVE на фикстуре: отдельный scope, SENDING, permalink; UNCERTAIN не повторяется', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('live');
  f.texts.set(c.text, 'дисциплина испаряется, когда стоп-лосс внезапно становится необязательным');
  const w = f.work('live', 'REPLY', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const prepared = (await getDocument<AutoWork>(f.db, 'autopilot-work-live'))!;
  expect(prepared.status).toBe('SCHEDULED');
  await f.autopilot.sendReply(w.id);
  expect(f.sent).toHaveLength(1);
  const job = (await f.engagement.jobs())[0]!;
  expect(job.status).toBe('PUBLISHED');
  expect(job.submittedAt).toBeTruthy();
  expect(job.url).toContain('@test_account');
  await f.replies.execute(job.id, false, { autopilot: true, actor: '1' });
  expect(f.sent).toHaveLength(1);
  await putDocument(f.db, `engagement-job-${job.id}`, { ...job, status: 'SENDING' });
  await f.replies.recover();
  expect((await f.engagement.jobs())[0]?.status).toBe('UNCERTAIN');
  await f.replies.execute(job.id, false, { autopilot: true, actor: '1' });
  expect(f.sent).toHaveLength(1);
});
it('дневной предел использует местную дату и включает SENDING/UNCERTAIN ручных отправок', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  await f.policy.configure(f.account.id, { replies: 1 }, '1');
  await f.policy.start(await f.policy.launchCard(f.account.id, '1', 'LIVE'), '1');
  const c = await f.candidate('cap');
  f.texts.set(c.text, 'дисциплина исчезает, если стоп-лосс внезапно становится необязательным');
  const state = await f.policy.settings(f.account.id),
    w = {
      ...f.work('cap', 'REPLY', c.id),
      epoch: state.epoch,
      version: state.version,
      enabledAt: state.enabledAt!,
    };
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const work = (await getDocument<AutoWork>(f.db, 'autopilot-work-cap'))!;
  await putDocument(f.db, 'engagement-job-manual-uncertain', {
    id: 'manual-uncertain',
    accountId: f.account.id,
    candidateId: 'different',
    kind: 'REPLY',
    hash: 'x',
    actor: '1',
    status: 'UNCERTAIN',
    scheduledAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
  });
  expect((await f.policy.sent(f.account.id)).replies).toBe(1);
  await expect(f.policy.validate(work.resultId!, 'REPLY')).rejects.toThrow('Суточный');
});
it('LIVE собственный пост на фикстуре: scoped разрешение отдельно от MANUAL_LIVE и подтверждение URL', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('ownlive');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  const w = f.work('ownlive', 'POST', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const prepared = (await getDocument<AutoWork>(f.db, 'autopilot-work-ownlive'))!;
  expect(prepared.status).toBe('SCHEDULED');
  await f.worker.execute(prepared.resultId!);
  const job = (await f.db.list('publishJob'))[0]!;
  expect(job.status).toBe('COMPLETED');
  expect(job.postStatus).toBe('PUBLISHED');
  expect(job.ctaEnabled).toBe(false);
  expect(await f.provider.status('one')).toBe(false);
  await f.worker.execute(job.id);
  expect(f.publisher.posts.size).toBe(1);
  expect(await f.db.list('post')).toHaveLength(1);
});
it('неопределённая отправка собственного поста блокирует автопилот без повторного клика', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('uncertain');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  const w = f.work('uncertain', 'POST', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const prepared = (await getDocument<AutoWork>(f.db, 'autopilot-work-uncertain'))!;
  const original = f.publisher.open.bind(f.publisher);
  let clicks = 0;
  f.publisher.open = async (...args) => {
    const p = await original(...args);
    p.publish = async (_text, before) => {
      await before();
      clicks++;
      throw Error('lost confirmation');
    };
    return p;
  };
  await f.worker.execute(prepared.resultId!);
  await f.worker.execute(prepared.resultId!);
  expect(clicks).toBe(1);
  expect((await f.db.list('publishJob'))[0]?.postStatus).toBe('UNCERTAIN');
  expect((await f.policy.settings(f.account.id)).state).toBe('ERROR');
  expect(await f.provider.status('one')).toBe(false);
});
it('CTA автопилота: отдельное разрешение, 20 секунд от submit, не входит в дневные собственные посты', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  await f.policy.configure(f.account.id, { allowCTA: true }, '1');
  const state = await f.policy.settings(f.account.id);
  const c = await f.candidate('cta');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  const w = {
    ...f.work('cta', 'POST', c.id),
    epoch: state.epoch,
    version: state.version,
    enabledAt: state.enabledAt!,
  };
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const prepared = (await getDocument<AutoWork>(f.db, 'autopilot-work-cta'))!;
  await f.worker.execute(prepared.resultId!);
  const job = (await f.db.list('publishJob'))[0]!;
  expect(job.status).toBe('COMPLETED');
  expect(job.commentStatus).toBe('PUBLISHED');
  expect(job.ctaSubmitAt!.getTime() - job.postSubmitAt!.getTime()).toBeGreaterThanOrEqual(20000);
  expect((await f.policy.sent(f.account.id)).posts).toBe(1);
  expect(await f.db.list('comment')).toHaveLength(1);
  expect(f.publisher.comments.size).toBe(1);
});
it('нет автоматического повторного платного вызова при восстановлении незавершённого запроса', async () => {
  const f = await setup(),
    c = await f.candidate('recover');
  const w = { ...f.work('recover', 'POST', c.id), generationStartedAt: new Date().toISOString() };
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  expect(f.calls).toHaveLength(0);
  expect((await getDocument<AutoWork>(f.db, 'autopilot-work-recover'))?.status).toBe(
    'NEEDS_REVIEW',
  );
  expect(f.publisher.posts.size).toBe(0);
});
it('устаревший источник и косметический рерайт не доходят до автоматической отправки', async () => {
  const f = await setup(),
    stale = await f.candidate('stale', undefined, {
      publishedAt: new Date(begin - 49 * 3600000).toISOString(),
    });
  await f.autopilot.enqueueWork(f.work('stale', 'REPLY', stale.id));
  await f.generation.tick();
  expect(f.calls).toHaveLength(0);
  const c = await f.candidate('copy');
  f.texts.set(c.text, c.text);
  await f.autopilot.enqueueWork(f.work('copy', 'POST', c.id));
  await f.generation.tick();
  expect((await getDocument<AutoWork>(f.db, 'autopilot-work-copy'))?.status).toBe('NEEDS_REVIEW');
  expect(await f.db.list('publishJob')).toHaveLength(0);
});
it('qualityGate: конкретные связи контекста без второго LLM, generic market reaction всё ещё требует review', () => {
  const source =
    'кто-то работает со стопом и тейками, кто-то ставит тейк и закрывает всю позицию, а кто-то вообще не использует стоп-лосс';
  const post =
    'до входа: если сценарий сломается, выхожу\n\nпосле входа: а давай на недельке посмотрим\n\nудобно, когда у позиции есть право обжаловать решение на старшем таймфрейме';
  expect(qualityGate('POST', post, source).reasons).not.toContain('LOW_CONTEXT_RELEVANCE');
  const funds =
    'трейдеры боятся FOMO, управляющие фондов опасаются отстать от рынка: если все утонули, то все в одной лодке, а если проиграл растущему рынку, спросят персонально';
  expect(
    qualityGate(
      'REPLY',
      'безопаснее ошибиться вместе со всеми, чем оказаться правым в одиночку и недосчитаться клиентов',
      funds,
    ).status,
  ).toBe('PASS');
  expect(qualityGate('REPLY', 'рынок вообще сложная штука и трейдинг тоже', funds).status).toBe(
    'NEEDS_REVIEW',
  );
});
it('сохранённый NEEDS_REVIEW можно перепроверить только в новом DRY_RUN, без нового платного запроса', async () => {
  const f = await setup(),
    c = await f.candidate('recheck');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  const first = f.work('original-check', 'POST', c.id);
  await f.autopilot.enqueueWork(first);
  await f.generation.tick();
  const old = (await getDocument<AutoWork>(f.db, 'autopilot-work-original-check'))!;
  await putDocument(f.db, 'autopilot-work-original-check', { ...old, status: 'NEEDS_REVIEW' });
  const second = { ...f.work('revalidation', 'POST', c.id), dryRevalidateFrom: old.id };
  await f.autopilot.enqueueWork(second);
  await f.generation.tick();
  // Existing generated text is a duplicate and remains reviewable; importantly, there is no paid regeneration.
  expect(f.calls).toHaveLength(1);
  expect((await getDocument<AutoWork>(f.db, 'autopilot-work-revalidation'))?.mode).toBe('DRY_RUN');
});
it('пауза/смена эпохи убирает старую несданную очередь из dispatch, не трогает SENDING/UNCERTAIN', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('pause-old');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  await f.autopilot.enqueueWork(f.work('pause-old', 'POST', c.id));
  await f.generation.tick();
  const job = (await f.db.list('publishJob'))[0]!;
  expect(job.status).toBe('QUEUED');
  await f.policy.pause(f.account.id, '1');
  expect((await f.db.get('publishJob', job.id))?.status).toBe('PAUSED');
  await f.policy.start(await f.policy.launchCard(f.account.id, '1', 'LIVE'), '1');
  await expect(f.policy.validate(job.id, 'POST')).rejects.toThrow('отозвано');
  // A previously submitted uncertain row survives subsequent stops untouched.
  await f.db.update('publishJob', job.id, {
    status: 'NEEDS_REVIEW',
    postStatus: 'UNCERTAIN',
    postSubmitAt: new Date(),
  });
  await f.policy.pause(f.account.id, '1');
  expect((await f.db.get('publishJob', job.id))?.postStatus).toBe('UNCERTAIN');
});
it('дневной отчёт DRY_RUN не подавляет будущий реальный отчёт того же дня', async () => {
  const f = await setup();
  await f.autopilot.queueSummary(f.account.id, day);
  await f.autopilot.queueSummary(f.account.id, day);
  expect(await f.autopilot.summaries()).toHaveLength(1);
  await f.policy.pause(f.account.id, '1');
  await f.policy.start(await f.policy.launchCard(f.account.id, '1', 'LIVE'), '1');
  await f.autopilot.queueSummary(f.account.id, day);
  expect(await f.autopilot.summaries()).toHaveLength(2);
});
it('повторная доставка outbox не перезаписывает завершённый результат устаревшим QUEUED', async () => {
  const f = await setup(),
    w = f.work('outbox-race', 'STATS');
  await f.autopilot.enqueueWork(w);
  await putDocument(f.db, `autopilot-work-${w.id}`, { ...w, status: 'PREVIEWED' });
  await f.autopilot.enqueueWork(w);
  expect((await getDocument<AutoWork>(f.db, `autopilot-work-${w.id}`))?.status).toBe('PREVIEWED');
});

it('статистика считает уникальные реальные генерации, а не повторные DRY_RUN-проверки одного receipt', async () => {
  const f = await setup(),
    w = f.work('usage-original', 'POST', 'sample');
  await putDocument(f.db, `autopilot-work-${w.id}`, {
    ...w,
    status: 'NEEDS_REVIEW',
    requestId: 'same-receipt',
  });
  await putDocument(f.db, 'autopilot-work-usage-rechecked', {
    ...w,
    id: 'usage-rechecked',
    status: 'PREVIEWED',
    requestId: 'same-receipt',
    dryRevalidateFrom: w.id,
  });
  expect((await f.autopilot.stats(f.account.id)).generated).toBe(1);
});
it('scope привязан к конкретной версии и ссылке job→generated, замена ссылки не разрешает публикацию', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('binding');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  await f.autopilot.enqueueWork(f.work('binding', 'POST', c.id));
  await f.generation.tick();
  const j = (await f.db.list('publishJob'))[0]!;
  await f.db.update('publishJob', j.id, { generatedId: f.generated.id });
  await expect(f.policy.validate(j.id, 'POST')).rejects.toThrow('Ссылка задачи');
});
it('отключение CTA аккаунта после подготовки закрывает CTA-барьер', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  await f.policy.configure(f.account.id, { allowCTA: true }, '1');
  const ap = await f.policy.settings(f.account.id),
    c = await f.candidate('ctastop');
  f.texts.set(
    c.text,
    'трейдинг иногда похож на спор с будильником: дисциплина бесит именно тогда, когда пора вставать',
  );
  await f.autopilot.enqueueWork({
    ...f.work('ctastop', 'POST', c.id),
    epoch: ap.epoch,
    version: ap.version,
    enabledAt: ap.enabledAt!,
  });
  await f.generation.tick();
  const j = (await f.db.list('publishJob'))[0]!,
    account = (await f.db.get('account', f.account.id))!;
  await f.policy.setCta(f.account.id, false, '1');
  await f.worker.execute(j.id);
  expect(f.publisher.posts.size).toBe(1);
  expect(f.publisher.comments.size).toBe(0);
  await f.autopilot.tick();
  expect((await getDocument<AutoWork>(f.db, 'autopilot-work-ctastop'))?.status).toBe('PUBLISHED');
  expect((await f.db.get('publishJob', j.id))?.commentStatus).toBe('DISABLED');
});
it('V1.17: сразу создаёт стабильное расписание сегодня/завтра, готовит до срока и не отправляет раньше', async () => {
  const f = await setup('LIVE');
  const before = await f.autopilot.schedule(f.account.id);
  expect(before.filter((s) => s.kind === 'POST' && s.localDate === day)).toHaveLength(5);
  expect(before.filter((s) => s.kind === 'POST' && s.localDate !== day)).toHaveLength(5);
  expect((await f.autopilot.schedule(f.account.id)).map((s) => s.at)).toEqual(
    before.map((s) => s.at),
  );
  // Supply a clean fresh candidate for the first reply, then own topic fallback. Preparation precedes all deadlines.
  const c = await f.candidate('early');
  f.texts.set(c.text, 'дисциплина испаряется, когда стоп-лосс внезапно становится необязательным');
  for (let i = 0; i < 6; i++) {
    await f.autopilot.tick();
    await f.generation.tick();
  }
  const ready = (await f.autopilot.schedule(f.account.id)).filter((s) => s.status === 'READY');
  expect(ready.length).toBeGreaterThan(0);
  const reply = ready.find((s) => s.kind === 'REPLY')!;
  expect(reply.publishingJobId).toBeTruthy();
  expect(Date.parse(reply.at)).toBeGreaterThan(Date.now());
  await expect(f.policy.validate(reply.publishingJobId!, 'REPLY')).rejects.toThrow(
    'ещё не наступило',
  );
  expect(f.sent).toHaveLength(0);
  const original = (await f.autopilot.schedule(f.account.id)).find(
    (s) => s.kind === 'POST' && s.status === 'READY',
  );
  expect(original).toBeTruthy();
  expect(f.publisher.posts.size).toBe(0);
});
it('V1.17: количество доступных слотов реально ограничено окном; явная группа ответов имеет точные интервалы', async () => {
  const f = await setup('LIVE');
  const group = await f.autopilot.requestReplies(f.account.id, 3, '1');
  expect(group).toHaveLength(3);
  expect(group.every((s) => s.prepareNow)).toBe(true);
  expect(Date.parse(group[1]!.at) - Date.parse(group[0]!.at)).toBeGreaterThanOrEqual(30 * 60000);
  vi.setSystemTime(Date.parse(day + 'T18:50:00Z'));
  await f.policy.pause(f.account.id, '1');
  await f.policy.start(await f.policy.launchCard(f.account.id, '1', 'LIVE'), '1');
  const slots = await f.autopilot.schedule(f.account.id);
  expect(slots.filter((s) => s.kind === 'POST' && s.localDate === day).length).toBeLessThanOrEqual(
    1,
  );
  expect(slots.filter((s) => s.kind === 'POST' && s.localDate !== day)).toHaveLength(5);
});

it('V1.17: задержка предыдущего submit переносит исполнение ответа, без FAILED, LLM и повторной отправки', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('interval');
  f.texts.set(c.text, 'дисциплина испаряется, когда стоп-лосс внезапно становится необязательным');
  const w = f.work('interval', 'REPLY', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const prepared = (await getDocument<AutoWork>(f.db, 'autopilot-work-interval'))!;
  await putDocument(f.db, 'engagement-job-previous-delayed', {
    id: 'previous-delayed',
    accountId: f.account.id,
    candidateId: 'other',
    kind: 'REPLY',
    status: 'PUBLISHED',
    submittedAt: new Date(Date.now() - 30 * 60000 + 15000).toISOString(),
    scheduledAt: new Date(Date.now() - 30 * 60000).toISOString(),
  });
  const calls = f.calls.length;
  expect((await f.autopilot.sendReply(w.id)).status).toBe('QUEUED');
  expect((await f.engagement.jobView(prepared.resultId!)).job.status).toBe('QUEUED');
  expect(f.sent).toHaveLength(0);
  vi.setSystemTime(Date.now() + 15000);
  expect((await f.autopilot.sendReply(w.id)).status).toBe('PUBLISHED');
  expect(f.sent).toHaveLength(1);
  expect(f.calls.length).toBe(calls);
});

it('V1.17: занятый профиль ждёт до submit; та же ошибка после барьера остаётся UNCERTAIN', async () => {
  const f = await setup('LIVE');
  vi.setSystemTime(begin + 3600000);
  const c = await f.candidate('busy');
  f.texts.set(c.text, 'дисциплина испаряется, когда стоп-лосс внезапно становится необязательным');
  const w = f.work('busy', 'REPLY', c.id);
  await f.autopilot.enqueueWork(w);
  await f.generation.tick();
  const original = f.engagement.port.reply;
  f.engagement.port.reply = async () => {
    throw new AppError('PROFILE_BUSY', 'Профиль занят');
  };
  expect((await f.autopilot.sendReply(w.id)).status).toBe('QUEUED');
  expect((await f.engagement.jobs())[0]!.status).toBe('QUEUED');
  const calls = f.calls.length;
  f.engagement.port.reply = async (_j, _d, _c, _commit, barrier) => {
    await barrier();
    throw new AppError('PROFILE_BUSY', 'Сбой после барьера');
  };
  await expect(f.autopilot.sendReply(w.id)).rejects.toBeTruthy();
  expect((await f.engagement.jobs())[0]!.status).toBe('UNCERTAIN');
  f.engagement.port.reply = original;
  await f.replies.execute((await f.engagement.jobs())[0]!.id, false, {
    autopilot: true,
    actor: '1',
  });
  expect(f.sent).toHaveLength(0);
  expect(f.calls.length).toBe(calls);
});

it('V1.17: новая группа не накладывается на уже готовые автоматические ответы', async () => {
  const f = await setup('LIVE'),
    before = await f.autopilot.schedule(f.account.id),
    existing = before.filter((x) => x.kind === 'REPLY' && x.localDate === day).slice(0, 2),
    plan: any = await getDocument(f.db, existing[0]!.scheduleId);
  plan.slots = plan.slots.map((x: any) =>
    existing.some((s) => s.id === x.id) ? { ...x, status: 'READY' } : x,
  );
  await putDocument(f.db, existing[0]!.scheduleId, plan);
  const chosen = await f.autopilot.requestReplies(f.account.id, 3, '1'),
    after = await f.autopilot.schedule(f.account.id);
  expect(chosen).toHaveLength(3);
  for (const slot of chosen)
    for (const other of after.filter(
      (x) => x.kind === 'REPLY' && x.id !== slot.id && x.localDate === day,
    ))
      expect(Math.abs(Date.parse(slot.at) - Date.parse(other.at))).toBeGreaterThanOrEqual(
        30 * 60000,
      );
  expect(after.filter((x) => existing.some((s) => s.id === x.id)).map((x) => x.at)).toEqual(
    existing.map((x) => x.at),
  );
  expect((await f.autopilot.requestReplies(f.account.id, 3, '1')).map((x) => x.id)).toEqual(
    chosen.map((x) => x.id),
  );
  expect(f.calls).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});
