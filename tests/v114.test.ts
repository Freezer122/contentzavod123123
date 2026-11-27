import { it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import { GenerationQuality } from '../src/content/quality.js';
import { ContentEngine } from '../src/content/service.js';
import { EngagementManager } from '../src/engagement/service.js';
import {
  replyPrompt,
  checkReply,
  normalizeReply,
  defaultReplyVoice,
  REPLY_PROMPT_VERSION,
} from '../src/engagement/reply-style.js';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { getDocument, putDocument } from '../src/db/documents.js';
const cases = [
  {
    name: 'Падение BTC',
    source: 'BTC упал на 30% от сентябрьских хаев',
    answer: 'рынок опять устроил проверку на прочность',
  },
  {
    name: 'Фад',
    source: 'на рынке фад, толпу загнали в шорты',
    answer: 'там фада нагнали, людей в шорты загнали ща выебут всех',
  },
  {
    name: 'Ликвидации',
    source: 'шортистов вынесли после отскока на рынке',
    answer: 'ща ещё лонгусты поверят, что всё поняли',
  },
  {
    name: 'Шутка об AI',
    source: 'в 2030-м все устанут от нейросетей и вернутся в аську',
    answer: 'в аське также мертвый нейросеточный интернет построят',
  },
  {
    name: 'Вопрос',
    source: 'как не открывать позы на похуй в пробой?',
    answer: 'хотя бы не жать кнопку от скуки',
  },
  {
    name: 'Риск',
    source: 'риск на сделку 2%, без увеличения плеча после убытка',
    answer: 'самое сложное тут не переписать правила после первого стопа',
  },
  {
    name: 'Числа',
    source: 'BTC по 100000, риск 2%, контракт API_Key',
    answer: 'риск 2% приятнее записывать до входа, чем после',
  },
  { name: 'Неоднозначность', source: 'ну и что теперь делать?', answer: 'бывает' },
];
it.each(cases)('фикстура голоса: $name, один запрос, формат без цензуры сленга', async (c) => {
  const f = await fixture();
  let calls = 0;
  const engine = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      calls++;
      return { text: c.answer, inputTokens: 80, outputTokens: 25 };
    },
  });
  const manager = new EngagementManager(
    f.db,
    { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
    engine,
  );
  const first = await manager.previewReply(f.account.id, c.source, '1'),
    again = await manager.previewReply(f.account.id, c.source, '1');
  expect(calls).toBe(1);
  expect(again.requestId).toBe(first.requestId);
  expect(first.errors).toEqual([]);
  expect(first.text).toBe(c.answer);
  expect(first.promptVersion).toBe(REPLY_PROMPT_VERSION);
  expect(await manager.jobs()).toHaveLength(0);
});
it('короткий ответ, сленг, мат и неидеальная грамматика не считаются ошибкой', () => {
  for (const text of [
    'жиза',
    'этож ваще лоховозка',
    'ща шортистов выебут',
    'типо в аське станет лучше',
  ])
    expect(checkReply(normalizeReply(text), 'трейдинг и риск', 'SHORT')).toEqual([]);
});
it('настройки ограничивают мат; шутки и мат не обязательны', () => {
  const off = { ...defaultReplyVoice, replyProfanity: false, replyHumor: false, replySlang: false };
  expect(replyPrompt('SHORT', off)).toContain('мат выключен');
  expect(replyPrompt('SHORT', off)).toContain('без шуток');
  expect(replyPrompt('SHORT', off)).toContain('без трейдерского');
  expect(checkReply('ща шортистов выебут', 'шортисты', 'SHORT', off)).toContain(
    'Мат выключен в настройках аккаунта',
  );
  expect(checkReply('план важнее эмоций', 'план', 'SHORT', off)).toEqual([]);
});
it('финансовые числа, тикеры и идентификаторы продолжают проверяться', () => {
  for (const [source, text] of [
    ['риск 2%', 'мой риск 20%'],
    ['покупаю BTC', 'покупаю ETH'],
    ['контракт API_Key', 'контракт api_key'],
  ])
    expect(checkReply(text!, source!, 'SHORT').length).toBeGreaterThan(0);
  expect(normalizeReply('ЩА API_Key BTC 2% — на похуй.')).toContain('API_Key BTC 2% - на похуй');
  expect(checkReply('я заработал на этом падении', 'рынок упал', 'SHORT')).toContain(
    'Выдуманный личный финансовый результат',
  );
});
it('скопированный человеческий ответ под другим исходником требует редактирования, без перегенерации', async () => {
  const f = await fixture(),
    q = new GenerationQuality(f.db);
  await q.saveHuman(
    { source: 'рынок и фад', answer: 'ща шортистов побреют', accountIds: [f.account.id] },
    '1',
  );
  let calls = 0;
  const content = new ContentEngine(f.db, testConfig(), {
    generate: async () => {
      calls++;
      return { text: 'ща шортистов побреют', inputTokens: 10, outputTokens: 5 };
    },
  });
  const manager = new EngagementManager(
    f.db,
    { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
    content,
  );
  const preview = await manager.previewReply(
    f.account.id,
    'шортисты ждут продолжения падения рынка',
    '1',
  );
  expect(preview.errors).toContain('Дословное повторение человеческого примера');
  expect(calls).toBe(1);
});
it('Sol применяет собственные настройки разговорности отдельно от Terra', async () => {
  const f = await fixture();
  await f.db.update('style', f.account.styleId, { slang: true, profanity: true });
  let prompt = '';
  const content = new ContentEngine(f.db, testConfig(), {
    generate: async (system) => {
      prompt = system;
      return { text: 'ща рынок снова проверяет наш план', inputTokens: 40, outputTokens: 10 };
    },
  });
  const generated = await content.generate(f.source.id, f.account.id);
  expect(prompt).toContain('Мат допустим по смыслу');
  expect(prompt).toContain('Трейдерский сленг');
  expect(generated.text).toContain('ща');
  expect(await f.db.list('post')).toHaveLength(0);
});
it('мои примеры: CRUD, назначение, soft delete и отдельное происхождение', async () => {
  const f = await fixture(),
    quality = new GenerationQuality(f.db);
  const e = await quality.saveHuman(
    { source: 'исходный пост про трейдинг', answer: 'ща разберёмся', accountIds: [f.account.id] },
    '1',
  );
  expect(e.origin).toBe('HUMAN');
  expect(e.positive).toBe(true);
  expect(await quality.humanExamples(f.account.id)).toHaveLength(1);
  const next = await quality.saveHuman(
    { ...e, answer: 'без позы тоже позиция', accountIds: [] },
    '1',
    e.id,
  );
  expect(next.version).toBe(2);
  expect(await quality.humanExamples(f.account.id)).toHaveLength(0);
  await quality.deleteHuman(e.id, '1');
  expect(await quality.humanExamples()).toHaveLength(0);
  expect(await getDocument(f.db, `quality-human-${e.id}`)).toBeTruthy();
});
it('примеры выбираются по теме и стилю, не случайно и не всей библиотекой', async () => {
  const f = await fixture(),
    q = new GenerationQuality(f.db);
  for (let i = 0; i < 6; i++)
    await q.saveHuman(
      {
        source: 'BTC фад трейдинг шортисты ' + i,
        answer: 'ща на похуй позы открывать ' + i,
        accountIds: [f.account.id],
      },
      '1',
    );
  await q.saveHuman(
    {
      source: 'нейросети и аська',
      answer: 'в аське тоже интернет построят',
      accountIds: [f.account.id],
    },
    '1',
  );
  const selected = await q.selectHuman(
    f.account.id,
    'фад и шортисты в трейдинге',
    defaultReplyVoice,
  );
  expect(selected.length).toBeLessThanOrEqual(4);
  expect(selected.every((e) => !e.source.includes('аська'))).toBe(true);
  expect(
    await q.selectHuman(f.account.id, 'фад и шортисты в трейдинге', {
      ...defaultReplyVoice,
      replyProfanity: false,
    }),
  ).toHaveLength(0);
});
it('новая версия не удаляет старый кеш и изменение стиля создаёт отдельный ключ', async () => {
  const f = await fixture();
  let calls = 0;
  const c = new ContentEngine(f.db, testConfig(), {
      generate: async () => {
        calls++;
        return { text: 'план важнее эмоций', inputTokens: 50, outputTokens: 10 };
      },
    }),
    m = new EngagementManager(
      f.db,
      { search: async () => [], reply: async () => ({ url: null }), like: async () => {} },
      c,
    );
  await putDocument(f.db, 'aux-cache-legacy', { text: 'старый ответ', requestId: 'legacy' });
  await m.previewReply(f.account.id, 'торговая стратегия требует плана', '1');
  await m.configure(f.account.id, { replyManner: 'RESTRAINED', replyProfanity: false }, '1');
  await m.previewReply(f.account.id, 'торговая стратегия требует плана', '1');
  expect(calls).toBe(2);
  expect(await getDocument(f.db, 'aux-cache-legacy')).toMatchObject({ text: 'старый ответ' });
});
it('оценка ответа не подтверждает публикацию и не переносит AI в человеческую библиотеку', async () => {
  const f = await fixture(),
    q = new GenerationQuality(f.db);
  await putDocument(f.db, 'reply-preview-test', {
    id: 'test',
    accountId: f.account.id,
    text: 'мой ответ',
    promptVersion: REPLY_PROMPT_VERSION,
    requestId: 'mock',
  });
  await q.rateReply('test', 'GOOD', '1');
  expect(await q.humanExamples()).toHaveLength(0);
  expect(await f.db.list('publishJob')).toHaveLength(0);
  expect(await getDocument<any>(f.db, 'quality-reply-rating-test-1')).toMatchObject({
    rating: 'GOOD',
  });
});
it('Telegram: настройки, ручная пара, изменение, назначение и удаление без LLM', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!,
      send = async (payload: object) =>
        (
          await app.server!.inject({
            method: 'POST',
            url: '/api/demo/telegram',
            headers: { authorization: 'Bearer demo-local-token' },
            payload,
          })
        ).json();
    expect(JSON.stringify(await send({ callback: `v111style:${a.id}` }))).toContain('Живая');
    await send({ callback: `v114manner:HARSH:${a.id}` });
    await putDocument(app.db, `engagement-candidate-${a.id}-v114-flag-change`, {
      id: 'v114-flag-change',
      accountId: a.id,
      text: 'шортисты на рынке',
      url: 'https://www.threads.com/@other/post/flags',
      status: 'NEW',
    });
    const beforeFlagChange = await app.services.engagement.edit(
      a.id,
      'v114-flag-change',
      'ща шортистов выебут',
      '1',
    );
    await send({ callback: `v114flag:MAT:${a.id}` });
    expect((await app.services.engagement.settings(a.id)).replyProfanity).toBe(false);
    await expect(
      app.services.engagement.approve(a.id, beforeFlagChange.id, beforeFlagChange.hash, '1'),
    ).rejects.toMatchObject({ code: 'NEEDS_EDIT' });
    await putDocument(app.db, 'flow-1', { step: 'source' });
    await send({ callback: `v114add:${a.id}` });
    await send({ text: 'исходный пост про BTC' });
    await send({ text: 'ща посмотрим, кто кого побреет' });
    const e = (await app.services.quality.humanExamples(a.id))[0]!;
    expect(e.answer).toContain('ща');
    expect((await getDocument<any>(app.db, 'flow-1')).step).toBe('');
    await send({ callback: `v114edit:${e.id}:answer` });
    await send({ text: 'на рынке без сюрпризов никак' });
    expect((await app.services.quality.humanExample(e.id)).version).toBe(2);
    await send({ callback: `v114toggle:${e.id}:${a.id}` });
    expect(await app.services.quality.humanExamples(a.id)).toHaveLength(0);
    await send({ callback: `v114delete:${e.id}` });
    expect(await app.services.quality.humanExamples()).toHaveLength(0);
    expect(await app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    await app.close();
  }
});
